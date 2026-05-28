import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import {
  canonicalGeometryToIfcNurbs,
  canonicalGeometryToIfcNurbsSurfaces,
  canonicalOrSidecarIfcNurbsSurfaces,
  surfaceToIfcNurbs,
} from "../src/ifc/canonical-ifc";
import { buildIfcScene } from "../src/ifc/ifc-build";
import { extrude } from "../src/nurbs/brep-extrude";
import type { PolylineCurve } from "../src/nurbs/nurbs-curves";
import { surfaceOfRevolution } from "../src/nurbs/nurbs-surface-algorithms";
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

function expectVecClose(actual: readonly number[] | undefined, expected: readonly number[]): void {
  expect(actual).toBeDefined();
  if (!actual) return;
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], 12);
  }
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

  test("IFC NURBS surface lookup does not fall back to stale sidecars when canonical geometry is linked", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({
      kind: "point",
      point: { x: 1, y: 2, z: 3 },
      source: "command",
      createdBy: "SdDatum",
    });

    const surfaces = canonicalOrSidecarIfcNurbsSurfaces(record, surface);

    expect(surfaces).toEqual([]);
  });

  test("IFC NURBS surface lookup keeps sidecar fallback for legacy unlinked objects", () => {
    const surfaces = canonicalOrSidecarIfcNurbsSurfaces(undefined, surface);

    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].controlPoints[0]).toEqual([0, 0, 0]);
  });

  test("resolves canonical BRep face surfaces for NURBS-capable export", () => {
    const profile: PolylineCurve = {
      kind: "polyline",
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { x: 2, y: 1, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 0 },
      ],
      parameters: [0, 2, 3, 5, 6],
    };
    const store = createCanonicalGeometryStore();
    const record = store.create({
      kind: "brep",
      brep: extrude(profile, { x: 0, y: 0, z: 1 }, 3),
      source: "command",
      createdBy: "SdExtrude",
    });

    const surfaces = canonicalGeometryToIfcNurbsSurfaces(record, new THREE.Matrix4().makeTranslation(10, 20, 30));

    expect(surfaces).toHaveLength(6);
    expect(surfaces.every((s) => s.degreeU === 1 && s.degreeV === 1)).toBe(true);
    expect(surfaces[0].controlPoints[0]).toEqual([10, 20, 30]);
    expect(canonicalGeometryToIfcNurbs(record)?.controlPoints[0]).toEqual([0, 0, 0]);
  });

  test("converts full Z-axis line RevSurface to exact rational IFC NURBS", () => {
    const rev = surfaceOfRevolution({
      kind: "line",
      from: { x: 2, y: 0, z: -1.5 },
      to: { x: 2, y: 0, z: 1.5 },
      domain: { min: 0, max: 3 },
    }, { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 1 } }, 0, Math.PI * 2);

    const nurbs = surfaceToIfcNurbs(rev, new THREE.Matrix4().makeTranslation(10, 20, 30));

    expect(nurbs).toBeDefined();
    expect(nurbs?.degreeU).toBe(1);
    expect(nurbs?.degreeV).toBe(2);
    expect(nurbs?.countU).toBe(2);
    expect(nurbs?.countV).toBe(9);
    expect(nurbs?.knotsU).toEqual([0, 0, 1, 1]);
    expect(nurbs?.knotsV).toEqual([0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1]);
    expect(nurbs?.controlPoints[0]).toEqual([12, 20, 28.5]);
    expect(nurbs?.controlPoints[1]).toEqual([12, 22, 28.5]);
    expect(nurbs?.controlPoints[8]).toEqual([12, 20, 28.5]);
    expect(nurbs?.controlPoints[9]).toEqual([12, 20, 31.5]);
    expect(nurbs?.weights[1]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  test("converts full Z-axis arc RevSurface to exact rational IFC NURBS", () => {
    const rev = surfaceOfRevolution({
      kind: "arc",
      center: { x: 0, y: 0, z: 0 },
      radius: 2,
      startAngle: -Math.PI / 2,
      endAngle: Math.PI / 2,
      plane: {
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 0, z: 1 },
        normal: { x: 0, y: -1, z: 0 },
      },
      domain: { min: 0, max: Math.PI * 2 },
    }, { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 1 } }, 0, Math.PI * 2);

    const nurbs = surfaceToIfcNurbs(rev);

    expect(nurbs).toBeDefined();
    expect(nurbs?.degreeU).toBe(2);
    expect(nurbs?.degreeV).toBe(2);
    expect(nurbs?.countU).toBe(5);
    expect(nurbs?.countV).toBe(9);
    expect(nurbs?.knotsU).toEqual([0, 0, 0, 0.5, 0.5, 1, 1, 1]);
    expectVecClose(nurbs?.controlPoints[0], [0, 0, -2]);
    expectVecClose(nurbs?.controlPoints[9], [2, 0, -2]);
    expectVecClose(nurbs?.controlPoints[18], [2, 0, 0]);
    expectVecClose(nurbs?.controlPoints[36], [0, 0, 2]);
    expect(nurbs?.weights[10]).toBeCloseTo(0.5, 12);
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

  test("buildIfcScene emits every canonical BRep face surface as SurfaceModel body items", () => {
    const profile: PolylineCurve = {
      kind: "polyline",
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { x: 2, y: 1, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 0 },
      ],
      parameters: [0, 2, 3, 5, 6],
    };
    const record = createCanonicalGeometryStore().create({
      kind: "brep",
      brep: extrude(profile, { x: 0, y: 0, z: 1 }, 3),
      source: "command",
      createdBy: "SdExtrude",
    });
    const nurbsSurfaces = canonicalGeometryToIfcNurbsSurfaces(record);

    const bytes = buildIfcScene([{ mesh: minimalMesh(), creator: "IfcWall", nurbsSurfaces }]);
    const text = new TextDecoder().decode(bytes);

    expect(nurbsSurfaces).toHaveLength(6);
    expect(text.match(/IFCSHELLBASEDSURFACEMODEL/g)).toHaveLength(6);
    expect(text).toContain("'SurfaceModel'");
    expect(text).not.toContain("IFCFACETEDBREP");
  });
});
