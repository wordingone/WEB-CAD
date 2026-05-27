import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import { canonicalGeometryToIfcNurbs, surfaceToIfcNurbs } from "../src/ifc/canonical-ifc";
import { buildIfcScene } from "../src/ifc/ifc-build";
import type { Surface } from "../src/nurbs/nurbs-surfaces";

const surface: Surface = {
  kind: "sum",
  basepoint: { x: 0, y: 0, z: 0 },
  curveU: {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to: { x: 2, y: 0, z: 0 },
    domain: { min: 0, max: 2 },
  },
  curveV: {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to: { x: 0, y: 3, z: 0 },
    domain: { min: 0, max: 3 },
  },
};

function minimalMesh() {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

describe("canonical IFC export", () => {
  test("converts canonical SumSurface to a degree-1 IFC NURBS surface in world coordinates", () => {
    const matrix = new THREE.Matrix4().makeTranslation(10, 20, 30);
    const nurbs = surfaceToIfcNurbs(surface, matrix);

    expect(nurbs).toBeDefined();
    expect(nurbs?.degreeU).toBe(1);
    expect(nurbs?.degreeV).toBe(1);
    expect(nurbs?.countU).toBe(2);
    expect(nurbs?.countV).toBe(2);
    expect(nurbs?.controlPoints).toEqual([
      [10, 20, 30],
      [10, 23, 30],
      [12, 20, 30],
      [12, 23, 30],
    ]);
  });

  test("resolves linked canonical surface records for IFC export", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({ kind: "surface", surface, source: "command", createdBy: "SdWall" });

    const nurbs = canonicalGeometryToIfcNurbs(record, new THREE.Matrix4().makeTranslation(1, 2, 3));

    expect(nurbs?.controlPoints[0]).toEqual([1, 2, 3]);
    expect(nurbs?.controlPoints[3]).toEqual([3, 5, 3]);
  });

  test("buildIfcScene emits SurfaceModel and IFC B-spline surface when nurbsSurface is present", () => {
    const nurbsSurface = surfaceToIfcNurbs(surface);
    if (!nurbsSurface) throw new Error("expected NURBS conversion");

    const bytes = buildIfcScene([{ mesh: minimalMesh(), creator: "IfcWall", nurbsSurface }]);
    const text = new TextDecoder().decode(bytes);

    expect(text).toContain("'SurfaceModel'");
    expect(text).toContain("IFCBSPLINESURFACEWITHKNOTS");
    expect(text).toContain("IFCSHELLBASEDSURFACEMODEL");
    expect(text).not.toContain("IFCFACETEDBREP");
  });
});
