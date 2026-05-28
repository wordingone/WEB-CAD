import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
} from "../src/geometry/canonical-geometry";
import { exportDxf, exportObj, exportPdf, exportStl, exportSvg } from "../src/io/exporters";
import { extrude as extrudeBrep } from "../src/nurbs/brep-extrude";

function canonicalLineScene(): {
  line: THREE.Line;
  resolve: (obj: THREE.Object3D) => ReturnType<ReturnType<typeof createCanonicalGeometryStore>["resolveObject"]>;
} {
  const store = createCanonicalGeometryStore();
  const geom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 0, 0),
  ]);
  const line = new THREE.Line(geom, new THREE.LineBasicMaterial());
  line.position.set(10, 20, 0);
  const record = store.create({
    kind: "curve",
    curve: {
      kind: "line",
      from: { x: 0, y: 0, z: 0 },
      to: { x: 3, y: 4, z: 0 },
      domain: { min: 0, max: 5 },
    },
    source: "command",
    createdBy: "SdLine",
    displayMesh: {
      revision: 1,
      generatedAt: 1,
      vertexCount: 2,
      derivation: "tessellated-curve",
    },
  });
  line.userData[CANONICAL_GEOMETRY_USERDATA_KEY] = record.id;
  return { line, resolve: (obj) => store.resolveObject(obj) };
}

describe("canonical vector exports", () => {
  test("DXF emits canonical curve segments for non-mesh sketch lines", () => {
    const { line, resolve } = canonicalLineScene();

    const dxf = exportDxf(line, { getCanonicalGeometryForObject: resolve });

    expect(dxf).toContain("LINE");
    expect(dxf).toContain("10\n10.000000");
    expect(dxf).toContain("20\n20.000000");
    expect(dxf).toContain("11\n13.000000");
    expect(dxf).toContain("21\n24.000000");
  });

  test("SVG emits canonical curve segments for non-mesh sketch lines", () => {
    const { line, resolve } = canonicalLineScene();

    const svg = exportSvg(line, { getCanonicalGeometryForObject: resolve });

    expect(svg).toContain("<line");
    expect(svg).not.toContain("no geometry");
  });

  test("PDF emits drawing content for canonical curve-only objects", () => {
    const { line, resolve } = canonicalLineScene();

    const pdf = new TextDecoder().decode(exportPdf(line, { getCanonicalGeometryForObject: resolve }));

    expect(pdf).toContain("%PDF-1.4");
    expect(pdf).toContain(" m ");
    expect(pdf).toContain(" l S");
    expect(pdf).not.toContain("no geometry");
  });

  test("OBJ emits canonical curve geometry instead of stale display line geometry", () => {
    const { line, resolve } = canonicalLineScene();

    const obj = exportObj(line, { getCanonicalGeometryForObject: resolve });

    expect(obj).toContain("v 10 20 0");
    expect(obj).toContain("v 13 24 0");
    expect(obj).toContain("l 1 2");
  });

  test("STL tessellates linked canonical BReps when display mesh geometry is empty", () => {
    const store = createCanonicalGeometryStore();
    const display = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    const profile = {
      kind: "polyline" as const,
      points: [
        { x: -1, y: -0.5, z: 0 },
        { x: 1, y: -0.5, z: 0 },
        { x: 1, y: 0.5, z: 0 },
        { x: -1, y: 0.5, z: 0 },
        { x: -1, y: -0.5, z: 0 },
      ],
      parameters: [0, 2, 3, 5, 6],
    };
    const record = store.create({
      kind: "brep",
      brep: extrudeBrep(profile, { x: 0, y: 0, z: 1 }, 1),
      source: "command",
      createdBy: "SdBox",
    });
    store.linkObject(display, record.id);

    const stl = exportStl(display, { getCanonicalGeometryForObject: (obj) => store.resolveObject(obj) });

    expect(stl.byteLength).toBeGreaterThan(84);
  });
});
