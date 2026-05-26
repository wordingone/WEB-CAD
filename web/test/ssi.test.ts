// ssi.test.ts — Surface-Surface Intersection unit tests (#114).
import { describe, test, expect } from "bun:test";
import { ssi } from "../src/nurbs/ssi";
import type { PlaneSurface, Surface } from "../src/nurbs/nurbs-surfaces";
import { Plane, Interval, Point3, Vector3 } from "../src/nurbs/nurbs-primitives";
import { pointAtUV } from "../src/nurbs/nurbs-surfaces";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** XY plane (z = 0), domain [0,1]² mapping to [-2,2]². */
function xyPlane(): PlaneSurface {
  return {
    kind: "plane",
    plane: Plane.worldXY(),
    uDomain: Interval.create(0, 1),
    vDomain: Interval.create(0, 1),
    uExtent: Interval.create(-2, 2),
    vExtent: Interval.create(-2, 2),
  };
}

/**
 * XZ plane (y = 0), domain [0,1]² mapping to [-2,2]².
 * xAxis = (1,0,0), yAxis = (0,0,1) → normal = (0,-1,0) (or 0,1,0 depending on cross direction).
 */
function xzPlane(): PlaneSurface {
  return {
    kind: "plane",
    plane: Plane.create(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
    ),
    uDomain: Interval.create(0, 1),
    vDomain: Interval.create(0, 1),
    uExtent: Interval.create(-2, 2),
    vExtent: Interval.create(-2, 2),
  };
}

/** Plane at z = 3 (parallel to xyPlane, no intersection). */
function xyPlaneAtZ3(): PlaneSurface {
  return {
    kind: "plane",
    plane: Plane.create(
      { x: 0, y: 0, z: 3 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    ),
    uDomain: Interval.create(0, 1),
    vDomain: Interval.create(0, 1),
    uExtent: Interval.create(-2, 2),
    vExtent: Interval.create(-2, 2),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ssi — plane/plane", () => {
  test("two orthogonal planes produce one intersection curve", () => {
    const a: Surface = xyPlane();
    const b: Surface = xzPlane();

    const curves = ssi(a, b, { tolerance: 1e-3, marchStep: 0.2, maxMarchSteps: 200 });

    expect(curves.length).toBeGreaterThanOrEqual(1);
    const curve = curves[0];
    expect(curve.pts3d.length).toBeGreaterThan(2);
  });

  test("intersection curve pts lie on both surfaces within tolerance", () => {
    const a: Surface = xyPlane();
    const b: Surface = xzPlane();
    const tol = 1e-3;

    const curves = ssi(a, b, { tolerance: tol, marchStep: 0.2, maxMarchSteps: 200 });
    expect(curves.length).toBeGreaterThanOrEqual(1);

    const curve = curves[0];
    for (const { s0, s1 } of curve.params) {
      const pA = pointAtUV(a, s0.u, s0.v);
      const pB = pointAtUV(b, s1.u, s1.v);
      const dist = Point3.distance(pA, pB);
      expect(dist).toBeLessThan(tol * 50); // generous bound for convergence
    }
  });

  test("intersection curve pts are near z=0 and y=0 (the expected intersection line)", () => {
    const a: Surface = xyPlane();
    const b: Surface = xzPlane();

    const curves = ssi(a, b, { tolerance: 1e-3, marchStep: 0.2, maxMarchSteps: 200 });
    expect(curves.length).toBeGreaterThanOrEqual(1);

    const curve = curves[0];
    for (const pt of curve.pts3d) {
      // On XY plane: z ≈ 0; on XZ plane: y ≈ 0
      expect(Math.abs(pt.z)).toBeLessThan(0.05);
      expect(Math.abs(pt.y)).toBeLessThan(0.05);
    }
  });

  test("two parallel non-intersecting planes return no curves", () => {
    const a: Surface = xyPlane();
    const b: Surface = xyPlaneAtZ3();

    const curves = ssi(a, b, { tolerance: 1e-3 });
    expect(curves.length).toBe(0);
  });
});

describe("ssi — no crash on degenerate cases", () => {
  test("identical planes (fully overlapping) returns at most trivial result without throw", () => {
    const a: Surface = xyPlane();
    const b: Surface = xyPlane();

    // Should not throw — fully coincident surfaces are a degenerate case
    let threw = false;
    try {
      ssi(a, b, { tolerance: 1e-3, maxSubdivDepth: 3 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
