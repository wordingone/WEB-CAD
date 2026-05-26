// Regression net for #30 G5: buildWall / buildSlab / buildColumn / buildBox / buildExtrude
// store a SumSurface in userData.nurbsSurface.
import { describe, test, expect } from "bun:test";
import { buildWall, buildSlab, buildColumn, buildBox, buildExtrude } from "../src/tools/structural";
import type { SumSurface } from "../src/nurbs/nurbs-surfaces";
import type { LineCurve } from "../src/nurbs/nurbs-curves";

const TOL = 1e-6;
function close(a: number, b: number): boolean { return Math.abs(a - b) < TOL; }

describe("structural NURBS userData — G5 buildWall", () => {
  test("buildWall stores SumSurface in userData.nurbsSurface", () => {
    const { mesh } = buildWall({ x: 0, y: 0 }, { x: 4, y: 0 });
    const s = mesh.userData.nurbsSurface as SumSurface;
    expect(s).toBeDefined();
    expect(s.kind).toBe("sum");
    expect(mesh.userData.nurbsKind).toBe("surface");
  });

  test("buildWall SumSurface curveU spans wall length", () => {
    const { mesh } = buildWall({ x: 0, y: 0 }, { x: 6, y: 0 });
    const s = mesh.userData.nurbsSurface as SumSurface;
    const u = s.curveU as LineCurve;
    expect(u.kind).toBe("line");
    // curveU.to.x should equal wall length (6m)
    expect(close(u.to.x, 6)).toBe(true);
    expect(close(u.domain.max, 6)).toBe(true);
  });

  test("buildWall SumSurface curveV spans wall height", () => {
    const { mesh } = buildWall({ x: 0, y: 0 }, { x: 4, y: 0 }, 3.5);
    const s = mesh.userData.nurbsSurface as SumSurface;
    const v = s.curveV as LineCurve;
    expect(close(v.to.z, 3.5)).toBe(true);
    expect(close(v.domain.max, 3.5)).toBe(true);
  });

  test("buildWall render unchanged — mesh is THREE.Mesh", async () => {
    const THREE = await import("three");
    const { mesh } = buildWall({ x: 0, y: 0 }, { x: 4, y: 0 });
    expect(mesh).toBeInstanceOf(THREE.Mesh);
  });
});

describe("structural NURBS userData — G5 buildSlab", () => {
  test("buildSlab stores SumSurface in userData.nurbsSurface", () => {
    const { mesh } = buildSlab({ x: 0, y: 0 }, { x: 5, y: 4 });
    const s = mesh.userData.nurbsSurface as SumSurface;
    expect(s).toBeDefined();
    expect(s.kind).toBe("sum");
    expect(mesh.userData.nurbsKind).toBe("surface");
  });

  test("buildSlab SumSurface curveU spans slab width", () => {
    const { mesh } = buildSlab({ x: 0, y: 0 }, { x: 5, y: 4 });
    const s = mesh.userData.nurbsSurface as SumSurface;
    const u = s.curveU as LineCurve;
    expect(close(u.to.x, 5)).toBe(true);
  });
});

describe("structural NURBS userData — G5 buildColumn", () => {
  test("buildColumn stores SumSurface in userData.nurbsSurface", () => {
    const { mesh } = buildColumn({ x: 1, y: 2 });
    const s = mesh.userData.nurbsSurface as SumSurface;
    expect(s).toBeDefined();
    expect(s.kind).toBe("sum");
    expect(mesh.userData.nurbsKind).toBe("surface");
  });
});

describe("structural NURBS userData — G5 buildBox", () => {
  test("buildBox stores SumSurface in userData.nurbsSurface", () => {
    const { mesh } = buildBox({ x: 0, y: 0 }, { x: 3, y: 2 }, { x: 1.5, y: 2.5 });
    const s = mesh.userData.nurbsSurface as SumSurface;
    expect(s).toBeDefined();
    expect(s.kind).toBe("sum");
    expect(mesh.userData.nurbsKind).toBe("surface");
  });

  test("buildBox SumSurface basepoint at bottom-left corner", () => {
    const { mesh } = buildBox({ x: 0, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 3 });
    const s = mesh.userData.nurbsSurface as SumSurface;
    // w=4, d=2 → basepoint at (-2, -1, 0)
    expect(close(s.basepoint.x, -2)).toBe(true);
    expect(close(s.basepoint.y, -1)).toBe(true);
    expect(close(s.basepoint.z, 0)).toBe(true);
  });
});

describe("structural NURBS userData — G5 buildExtrude", () => {
  test("buildExtrude stores SumSurface in userData.nurbsSurface", () => {
    const { mesh } = buildExtrude({ x: 0, y: 0 }, { x: 0, y: 3 });
    const s = mesh.userData.nurbsSurface as SumSurface;
    expect(s).toBeDefined();
    expect(s.kind).toBe("sum");
    expect(mesh.userData.nurbsKind).toBe("surface");
  });
});
