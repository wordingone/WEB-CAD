import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { createCanonicalGeometryStore, type CanonicalGeometry } from "../src/geometry/canonical-geometry";
import { SAMPLES } from "../src/io/sample-files";
import { __sceneSerializationForTests } from "../src/viewer/viewer";

type ProjectPayload = {
  format?: string;
  version?: number;
  meta?: { sourceIfc?: string; conversion?: string; totalTriangles?: number; totalCanonicalFaces?: number; convertedObjects?: number };
  canonicalGeometry?: Array<{
    id?: string;
    kind?: string;
    metadata?: { conversion?: string; sourceBasis?: string; facePolicy?: string; sourceTriangleCount?: number; canonicalFaceCount?: number; coplanarMergedTriangleCount?: number; sourceGlobalId?: string; sourceExpressId?: number; sourceName?: string };
    displayMesh?: { triangleCount?: number };
    brep?: {
      shells?: Array<{
        isClosed?: boolean;
        faces?: Array<{
          surface?: { kind?: string; order?: [number, number]; cvCount?: [number, number]; cvs?: number[] };
          outerLoop?: { curves?: Array<{ kind?: string; points?: Array<unknown> }> };
        }>;
        edges?: Array<{ faceIndex1: number; faceIndex2?: number | null }>;
      }>;
    };
  }>;
  objects?: Array<{ displaySource?: string; userData?: Record<string, unknown> }>;
};

type FzkRecord = NonNullable<ProjectPayload["canonicalGeometry"]>[number];
type FzkShell = NonNullable<NonNullable<FzkRecord["brep"]>["shells"]>[number];
type FzkFace = NonNullable<FzkShell["faces"]>[number];

function nurbsFacePlane(face: FzkFace) {
  const surface = face.surface;
  const cvs = surface?.cvs ?? [];
  if (surface?.kind !== "nurbs" || cvs.length < 12) return null;
  const p0 = new THREE.Vector3(cvs[0], cvs[1], cvs[2]);
  const p1 = new THREE.Vector3(cvs[3], cvs[4], cvs[5]);
  const p2 = new THREE.Vector3(cvs[6], cvs[7], cvs[8]);
  const normal = p1.clone().sub(p0).cross(p2.clone().sub(p0)).normalize();
  if (!Number.isFinite(normal.lengthSq()) || normal.lengthSq() < 0.5) return null;
  return { normal, constant: normal.dot(p0) };
}

function samePlane(a: ReturnType<typeof nurbsFacePlane>, b: ReturnType<typeof nurbsFacePlane>, epsilon = 1e-5): boolean {
  if (!a || !b) return false;
  const alignment = a.normal.dot(b.normal);
  if (Math.abs(alignment) <= 1 - epsilon) return false;
  return (alignment >= 0 ? Math.abs(a.constant - b.constant) : Math.abs(a.constant + b.constant)) < epsilon;
}

describe("FZK Haus actual IFC-derived canonical project sample", () => {
  test("sample registry routes FZK Haus to a WEB-CAD canonical snapshot, not raw IFC", () => {
    const fzk = SAMPLES.find((sample) => sample.id === "kit-fzk-haus");

    expect(fzk).toBeDefined();
    expect(fzk?.format).toBe("webcad");
    expect(fzk?.path).toBe("samples/AC20-FZK-Haus.webcad");
  });

  test("bundled FZK snapshot carries merged coplanar planar BRep geometry generated from the actual IFC mesh", () => {
    const raw = readFileSync(new URL("../public/samples/AC20-FZK-Haus.webcad", import.meta.url), "utf8");
    const payload = JSON.parse(raw) as ProjectPayload;

    expect(payload.format).toBe("web-cad.canonical-project");
    expect(payload.version).toBe(2);
    expect(payload.meta?.sourceIfc).toBe("samples/AC20-FZK-Haus.ifc");
    expect(payload.meta?.conversion).toBe("actual-ifc-mesh-to-merged-coplanar-planar-brep");
    expect(payload.meta?.totalTriangles).toBeGreaterThan(20_000);
    expect(payload.meta?.convertedObjects).toBeDefined();
    expect(payload.canonicalGeometry?.length).toBe(payload.meta!.convertedObjects!);
    expect(payload.objects?.length).toBe(payload.meta!.convertedObjects!);
    expect(payload.canonicalGeometry?.every((record) => record.kind === "brep")).toBe(true);
    expect(payload.canonicalGeometry?.every((record) => record.metadata?.conversion === "actual-ifc-web-ifc-mesh-to-merged-coplanar-planar-brep")).toBe(true);
    expect(payload.canonicalGeometry?.every((record) => record.metadata?.sourceBasis === "web-ifc placed triangle mesh")).toBe(true);
    expect(payload.canonicalGeometry?.every((record) => record.metadata?.facePolicy?.includes("merge adjacent coplanar source triangles per IFC element"))).toBe(true);
    expect(payload.canonicalGeometry?.every((record) => record.metadata?.facePolicy?.includes("canonical BRep faces are not triangular"))).toBe(true);
    expect(payload.canonicalGeometry?.some((record) => (
      (record.metadata?.sourceTriangleCount ?? 0) > (record.metadata?.canonicalFaceCount ?? Number.MAX_SAFE_INTEGER)
    ))).toBe(true);
    expect(payload.canonicalGeometry?.every((record) => (
      (record.metadata?.canonicalFaceCount ?? 0) <= (record.metadata?.sourceTriangleCount ?? 0)
        && record.displayMesh?.triangleCount === record.metadata?.sourceTriangleCount
    ))).toBe(true);
    expect(payload.canonicalGeometry?.every((record) => (
      record.brep?.shells?.every((shell) => (
        shell.faces?.every((face) => (
          face.surface?.kind === "nurbs"
            && face.surface.order?.[0] === 2
            && face.surface.order?.[1] === 2
            && face.surface.cvCount?.[0] === 2
            && face.surface.cvCount?.[1] === 2
            && face.outerLoop?.curves?.length === 1
            && face.outerLoop.curves[0]?.kind === "polyline"
            && (face.outerLoop.curves[0]?.points?.length ?? 0) >= 4
        )) === true
      )) === true
    ))).toBe(true);
    const faceCount = payload.canonicalGeometry?.reduce((n, record) => (
      n + (record.brep?.shells ?? []).reduce((m, shell) => m + (shell.faces?.length ?? 0), 0)
    ), 0) ?? 0;
    const nurbsFaceCount = payload.canonicalGeometry?.reduce((n, record) => (
      n + (record.brep?.shells ?? []).reduce((m, shell) => m + (shell.faces ?? []).filter((face) => face.surface?.kind === "nurbs").length, 0)
    ), 0) ?? 0;
    const triangleCount = payload.canonicalGeometry?.reduce((n, record) => n + (record.displayMesh?.triangleCount ?? 0), 0) ?? 0;
    const mergedTriangleCount = payload.canonicalGeometry?.reduce((n, record) => n + (record.metadata?.coplanarMergedTriangleCount ?? 0), 0) ?? 0;
    const triangularFaceCount = payload.canonicalGeometry?.reduce((n, record) => (
      n + (record.brep?.shells ?? []).reduce((m, shell) => (
        m + (shell.faces ?? []).filter((face) => {
          const points = face.outerLoop?.curves?.flatMap((curve) => curve.points ?? []) ?? [];
          return points.length === 4;
        }).length
      ), 0)
    ), 0) ?? 0;
    const closedRecords = payload.canonicalGeometry?.filter((record) => record.brep?.shells?.some((shell) => shell.isClosed === true)).length ?? 0;
    expect(payload.meta?.totalTriangles).toBeDefined();
    expect(faceCount).toBe(payload.meta!.totalCanonicalFaces!);
    expect(faceCount).toBeLessThan(payload.meta!.totalTriangles!);
    expect(nurbsFaceCount).toBe(faceCount);
    expect(faceCount).toBeGreaterThan(1_000);
    expect(mergedTriangleCount).toBe(payload.meta!.totalTriangles! - faceCount);
    expect(mergedTriangleCount).toBeGreaterThan(1_000);
    expect(triangularFaceCount).toBe(0);
    expect(triangleCount).toBe(payload.meta!.totalTriangles!);
    expect(closedRecords).toBeGreaterThan(0);
    expect(payload.objects?.every((obj) => obj.displaySource === "canonical")).toBe(true);
    expect(payload.objects?.every((obj) => typeof obj.userData?.canonicalGeometryId === "string")).toBe(true);
  });

  test("canonical BRep display reconstructs merged polygonal BRep faces, not raw IFC triangle faces", () => {
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
    const sourceTriangles = record!.displayMesh?.triangleCount ?? 0;
    if (record?.kind !== "brep") throw new Error("expected BRep record");
    const canonicalFaces = record.brep.shells.reduce((n, shell) => n + shell.faces.length, 0);
    expect(canonicalFaces).toBeLessThanOrEqual(sourceTriangles);
    expect(record.brep.shells.some((shell) => shell.faces.some((face) => (
      (((face.outerLoop.curves[0] as { points?: unknown[] } | undefined)?.points?.length) ?? 0) > 4
    )))).toBe(true);
    expect(mesh.geometry.index?.count).toBeGreaterThanOrEqual(canonicalFaces * 3);
    expect(position.count).toBeGreaterThanOrEqual(canonicalFaces * 3);
  });

  test("FZK BRep elements have no remaining same-plane adjacent faces", () => {
    const raw = readFileSync(new URL("../public/samples/AC20-FZK-Haus.webcad", import.meta.url), "utf8");
    const payload = JSON.parse(raw) as ProjectPayload;
    let adjacentFacePairs = 0;
    const unmergedPairs: string[] = [];

    for (const record of payload.canonicalGeometry ?? []) {
      if (record.kind !== "brep") continue;
      for (const shell of record.brep?.shells ?? []) {
        const planes = (shell.faces ?? []).map(nurbsFacePlane);
        for (const edge of shell.edges ?? []) {
          if (edge.faceIndex2 === null || edge.faceIndex2 === undefined) continue;
          adjacentFacePairs++;
          if (samePlane(planes[edge.faceIndex1], planes[edge.faceIndex2])) {
            const id = record.metadata?.sourceGlobalId ?? record.metadata?.sourceExpressId ?? record.metadata?.sourceName ?? record.id ?? "unknown";
            unmergedPairs.push(`${id}:${edge.faceIndex1}-${edge.faceIndex2}`);
          }
        }
      }
    }

    expect(adjacentFacePairs).toBeGreaterThan(1_000);
    expect(unmergedPairs).toEqual([]);
  });
});
