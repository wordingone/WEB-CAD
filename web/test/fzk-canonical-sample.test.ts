import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { createCanonicalGeometryStore, type CanonicalGeometry } from "../src/geometry/canonical-geometry";
import { SAMPLES } from "../src/io/sample-files";
import { __sceneSerializationForTests } from "../src/viewer/viewer";

type ProjectPayload = {
  format?: string;
  version?: number;
  meta?: { sourceIfc?: string; conversion?: string; totalTriangles?: number; convertedObjects?: number };
  canonicalGeometry?: Array<{
    kind?: string;
    metadata?: { conversion?: string; losslessFrom?: string };
    displayMesh?: { triangleCount?: number };
    brep?: { shells?: Array<{ isClosed?: boolean; faces?: unknown[]; edges?: Array<{ faceIndex2?: number | null }> }> };
  }>;
  objects?: Array<{ displaySource?: string; userData?: Record<string, unknown> }>;
};

describe("FZK Haus actual IFC-derived canonical project sample", () => {
  test("sample registry routes FZK Haus to a WEB-CAD canonical snapshot, not raw IFC", () => {
    const fzk = SAMPLES.find((sample) => sample.id === "kit-fzk-haus");

    expect(fzk).toBeDefined();
    expect(fzk?.format).toBe("webcad");
    expect(fzk?.path).toBe("samples/AC20-FZK-Haus.webcad");
  });

  test("bundled FZK snapshot carries lossless planar BRep geometry generated from the actual IFC mesh", () => {
    const raw = readFileSync(new URL("../public/samples/AC20-FZK-Haus.webcad", import.meta.url), "utf8");
    const payload = JSON.parse(raw) as ProjectPayload;

    expect(payload.format).toBe("web-cad.canonical-project");
    expect(payload.version).toBe(2);
    expect(payload.meta?.sourceIfc).toBe("samples/AC20-FZK-Haus.ifc");
    expect(payload.meta?.conversion).toBe("actual-ifc-mesh-to-planar-brep");
    expect(payload.meta?.totalTriangles).toBeGreaterThan(20_000);
    expect(payload.meta?.convertedObjects).toBeDefined();
    expect(payload.canonicalGeometry?.length).toBe(payload.meta!.convertedObjects!);
    expect(payload.objects?.length).toBe(payload.meta!.convertedObjects!);
    expect(payload.canonicalGeometry?.every((record) => record.kind === "brep")).toBe(true);
    expect(payload.canonicalGeometry?.every((record) => record.metadata?.conversion === "actual-ifc-web-ifc-mesh-to-planar-brep")).toBe(true);
    expect(payload.canonicalGeometry?.every((record) => record.metadata?.losslessFrom === "web-ifc placed triangle mesh")).toBe(true);
    const faceCount = payload.canonicalGeometry?.reduce((n, record) => (
      n + (record.brep?.shells ?? []).reduce((m, shell) => m + (shell.faces?.length ?? 0), 0)
    ), 0) ?? 0;
    const triangleCount = payload.canonicalGeometry?.reduce((n, record) => n + (record.displayMesh?.triangleCount ?? 0), 0) ?? 0;
    const closedRecords = payload.canonicalGeometry?.filter((record) => record.brep?.shells?.some((shell) => shell.isClosed === true)).length ?? 0;
    expect(payload.meta?.totalTriangles).toBeDefined();
    expect(faceCount).toBe(payload.meta!.totalTriangles!);
    expect(triangleCount).toBe(payload.meta!.totalTriangles!);
    expect(closedRecords).toBeGreaterThan(0);
    expect(payload.objects?.every((obj) => obj.displaySource === "canonical")).toBe(true);
    expect(payload.objects?.every((obj) => typeof obj.userData?.canonicalGeometryId === "string")).toBe(true);
  });

  test("canonical BRep display reconstructs trimmed triangle faces, not rectangular plane patches", () => {
    const raw = readFileSync(new URL("../public/samples/AC20-FZK-Haus.webcad", import.meta.url), "utf8");
    const payload = JSON.parse(raw) as ProjectPayload;
    const record = payload.canonicalGeometry?.find((candidate) => candidate.kind === "brep" && (candidate.displayMesh?.triangleCount ?? 0) > 0) as CanonicalGeometry | undefined;
    const object = payload.objects?.find((candidate) => candidate.userData?.canonicalGeometryId === record?.id);
    expect(record).toBeDefined();
    expect(object).toBeDefined();

    const store = createCanonicalGeometryStore();
    store.upsert(record!);
    const displayed = __sceneSerializationForTests.deserializeSceneObj(object as Parameters<typeof __sceneSerializationForTests.deserializeSceneObj>[0], store);
    expect(displayed).toBeInstanceOf(THREE.Mesh);
    const mesh = displayed as THREE.Mesh;
    const position = mesh.geometry.getAttribute("position");
    expect(mesh.geometry.index?.count).toBe((record!.displayMesh?.triangleCount ?? 0) * 3);
    expect(position.count).toBe((record!.displayMesh?.triangleCount ?? 0) * 3);
  });
});
