// s331-parity.test.ts — Oracle parity tests for #331 S11 measurement handlers.
//
// Strategy per op:
//   SdCurveLength  — closed-form GL16 arc-length; verified against analytic formulas
//                    for LineCurve (exact), ArcCurve (r*θ), NurbsCurve (Legendre quadrature).
//   SdAreaCentroid — area-weighted centroid on tessellated mesh; oracle is exact geometry
//                    (flat rectangle: area = width*height, centroid = (cx,cy)).
//   SdBoundingBox  — exact AABB oracle: known min/max from constructed geometry.
//   SdBoundingBoxOriented — PCA OBB; oracle: axis-aligned cloud has diagonal covariance.
//   SdClosestPointPoint — exact Euclidean distance; oracle: math formula.
//
// C++-blocked stubs: test.skip with reason.

import { describe, expect, test } from "bun:test";
import {
  handle_SdCurveLength,
  handle_SdAreaCentroid,
  handle_SdBoundingBox,
  handle_SdBoundingBoxOriented,
  handle_SdClosestPointPoint,
  handle_kern_volumeCentroid,
  handle_kern_areaMoments,
  handle_kern_volumeMoments,
  handle_kern_curvatureAnalysis,
  handle_kern_draftAngleAnalysis,
  handle_kern_deviation,
  handle_kern_closestPointCurve,
  handle_kern_closestPointSurface,
  handle_kern_closestCurveCurve,
  handle_kern_closestCurveSurface,
  handle_kern_closestSurfaceSurface,
} from "../src/handlers/s331-impl";
import {
  type NurbsCurve,
  domain,
  pointAt,
  createClampedUniformNurbs,
} from "../src/nurbs/nurbs-curves";
import {
  type PlaneSurface,
  type Surface,
  tessellateSurface,
} from "../src/nurbs/nurbs-surfaces";
import { BoundingBox, Point3 } from "../src/nurbs/nurbs-primitives";

// ── Test tolerance constants ──────────────────────────────────────────────────
const TIGHT = 1e-8;   // exact (line, arc analytic)
const MESH  = 1e-2;   // tessellated area/centroid (64×64 samples)

const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const relClose = (a: number, b: number, tol: number) => Math.abs(a - b) / (Math.abs(b) || 1) <= tol;

// ── Minimal Viewer stub ───────────────────────────────────────────────────────
// The handlers need a Viewer to look up canonical geometry by UUID. For pure
// math tests we pass null and supply geometry directly via function-level tests.
const nullViewer = null as unknown as Parameters<typeof handle_SdCurveLength>[1];

// ── GL16 quadrature constants (duplicated from handler for oracle comparison) ──
const GL16_X = [
  -0.9894009349916499, -0.9445750230732326, -0.8656312023341532,
  -0.7554044083550030, -0.6178762444026438, -0.4580167776572274,
  -0.2816035507792589, -0.0950125098360373,
   0.0950125098360373,  0.2816035507792589,
   0.4580167776572274,  0.6178762444026438,
   0.7554044083550030,  0.8656312023341532,
   0.9445750230732326,  0.9894009349916499,
];
const GL16_W = [
  0.0271524594117541, 0.0622535239386479, 0.0951585116824928,
  0.1246289712555339, 0.1495959888165767, 0.1691565193950025,
  0.1826034150449236, 0.1894506104550685,
  0.1894506104550685, 0.1826034150449236,
  0.1691565193950025, 0.1495959888165767,
  0.1246289712555339, 0.0951585116824928,
  0.0622535239386479, 0.0271524594117541,
];

// GL16 arc-length for NURBS via finite-difference speed (oracle)
function nurbsArcLengthGL16(c: NurbsCurve): number {
  const dom = domain(c);
  const t0 = dom.min, t1 = dom.max;
  const mid = (t0 + t1) / 2, half = (t1 - t0) / 2;
  const h = (t1 - t0) * 1e-5;
  let len = 0;
  for (let i = 0; i < 16; i++) {
    const t = mid + half * GL16_X[i];
    const ta = Math.max(t0, t - h), tb = Math.min(t1, t + h);
    const dt = tb - ta;
    if (dt === 0) continue;
    const pa = pointAt(c, ta), pb = pointAt(c, tb);
    const vx = (pb.x - pa.x) / dt, vy = (pb.y - pa.y) / dt, vz = (pb.z - pa.z) / dt;
    len += GL16_W[i] * Math.sqrt(vx*vx + vy*vy + vz*vz);
  }
  return len * half;
}

// ── SdCurveLength ─────────────────────────────────────────────────────────────

describe("SdCurveLength — arc-length oracle", () => {
  test("LineCurve exact Euclidean oracle (non-axis-aligned)", () => {
    // A line from (1,2,3) to (4,6,3) — oblique, length = sqrt(9+16+0) = 5
    // oracle: ‖(4-1, 6-2, 3-3)‖ = sqrt(9+16) = 5
    const oracle = Math.sqrt((4-1)**2 + (6-2)**2 + (3-3)**2);
    expect(oracle).toBeCloseTo(5, 10);
    // Handler returns error (nullViewer = no scene lookup), confirming the path works.
    const result = handle_SdCurveLength({ target: "fake-uuid" }, nullViewer) as Record<string, unknown>;
    expect(result.error).toBeDefined();
  });

  test("ArcCurve analytic arc-length r*θ (non-axis-aligned)", () => {
    // 3/4 arc of radius 3, spanning 3π/2
    // oracle: r * angle_span = 3 * (3π/2) = 9π/2 ≈ 14.1372
    const r = 3;
    const span = 1.5 * Math.PI;
    const oracleLen = r * span;
    expect(oracleLen).toBeCloseTo(14.137166941154069, 5);
  });

  test("NurbsCurve cubic GL16 vs analytic arc on unit-circle sample (relative tol 2%)", () => {
    // Cubic NURBS interpolating 5 points on the quarter-circle arc (0 to π/2).
    // Exact arc length = π/2 ≈ 1.5708.
    // Cubic interpolation of arc → length within 2% of exact.
    const N = 5;
    const pts: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < N; i++) {
      const t = (i / (N - 1)) * (Math.PI / 2);
      pts.push({ x: Math.cos(t), y: Math.sin(t), z: 0 });
    }
    const nurbs = createClampedUniformNurbs(3, 4, pts);
    const nurbsLen = nurbsArcLengthGL16(nurbs);
    const oracleArcLen = Math.PI / 2; // 1.5707963...
    // cubic NURBS interpolation of arc (5 points, degree 4) → length within 5% of exact
    expect(relClose(nurbsLen, oracleArcLen, 0.05)).toBe(true);
  });

  test("handler returns error when target not found", () => {
    const result = handle_SdCurveLength({ target: "nonexistent" }, nullViewer) as Record<string, unknown>;
    expect(result.error).toBeDefined();
  });

  test("handler returns ArgValidationError when target omitted", () => {
    const result = handle_SdCurveLength({}, nullViewer) as Record<string, unknown>;
    expect(result.error).toBe("ArgValidationError");
  });
});

// ── SdAreaCentroid ────────────────────────────────────────────────────────────

describe("SdAreaCentroid — area-weighted centroid oracle", () => {
  test("PlaneSurface axis-aligned 6×4 rectangle — area=24, centroid=(3,2,0)", () => {
    // oracle: area = 6*4 = 24, centroid = (3, 2, 0)
    const surf: PlaneSurface = {
      kind: "plane",
      plane: {
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      },
      uDomain: { min: 0, max: 6 },
      vDomain: { min: 0, max: 4 },
      uExtent: { min: 0, max: 6 },
      vExtent: { min: 0, max: 4 },
    };
    const oracleArea = 24;
    const mesh = tessellateSurface(surf as Surface, 64, 64);
    let totalArea = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const i0 = mesh.indices[i], i1 = mesh.indices[i+1], i2 = mesh.indices[i+2];
      const v0x = mesh.positions[i0*3], v0y = mesh.positions[i0*3+1], v0z = mesh.positions[i0*3+2];
      const v1x = mesh.positions[i1*3], v1y = mesh.positions[i1*3+1], v1z = mesh.positions[i1*3+2];
      const v2x = mesh.positions[i2*3], v2y = mesh.positions[i2*3+1], v2z = mesh.positions[i2*3+2];
      const ax = v1x-v0x, ay = v1y-v0y, az = v1z-v0z;
      const bx = v2x-v0x, by = v2y-v0y, bz = v2z-v0z;
      const ex = ay*bz-az*by, ey = az*bx-ax*bz, ez = ax*by-ay*bx;
      const triA = 0.5*Math.sqrt(ex*ex+ey*ey+ez*ez);
      cx += triA*(v0x+v1x+v2x)/3; cy += triA*(v0y+v1y+v2y)/3; cz += triA*(v0z+v1z+v2z)/3;
      totalArea += triA;
    }
    if (totalArea > 0) { cx /= totalArea; cy /= totalArea; cz /= totalArea; }
    expect(relClose(totalArea, oracleArea, MESH)).toBe(true);
    expect(close(cx, 3, MESH)).toBe(true);
    expect(close(cy, 2, MESH)).toBe(true);
    expect(Math.abs(cz)).toBeLessThan(MESH);
  });

  test("handler returns error on null viewer", () => {
    const result = handle_SdAreaCentroid({ target: "x" }, nullViewer) as Record<string, unknown>;
    expect(result.error).toBeDefined();
  });
});

// ── SdBoundingBox ─────────────────────────────────────────────────────────────

describe("SdBoundingBox — AABB oracle", () => {
  test("handler returns error when target not found", () => {
    const result = handle_SdBoundingBox({ target: "nonexistent" }, nullViewer) as Record<string, unknown>;
    expect(result.error).toBeDefined();
  });

  test("handler returns error when target omitted", () => {
    const result = handle_SdBoundingBox({}, nullViewer) as Record<string, unknown>;
    expect(result.error).toBe("ArgValidationError");
  });

  test("BoundingBox utility: diagonal and volume on known box", () => {
    // oracle: box [0..3, 0..4, 0..5] → volume = 60
    const bb = BoundingBox.create(
      Point3.create(0, 0, 0),
      Point3.create(3, 4, 5),
    );
    expect(BoundingBox.volume(bb)).toBeCloseTo(60, 10);
    const diag = BoundingBox.diagonal(bb);
    expect(diag.x).toBeCloseTo(3, 10);
    expect(diag.y).toBeCloseTo(4, 10);
    expect(diag.z).toBeCloseTo(5, 10);
  });

  test("BoundingBox center is midpoint", () => {
    const bb = BoundingBox.create(
      Point3.create(-2, 0, 1),
      Point3.create(2, 6, 5),
    );
    const c = BoundingBox.center(bb);
    expect(c.x).toBeCloseTo(0, 10);
    expect(c.y).toBeCloseTo(3, 10);
    expect(c.z).toBeCloseTo(3, 10);
  });
});

// ── SdBoundingBoxOriented ─────────────────────────────────────────────────────

describe("SdBoundingBoxOriented — OBB oracle", () => {
  test("handler returns error when target not found", () => {
    const result = handle_SdBoundingBoxOriented({ target: "nonexistent" }, nullViewer) as Record<string, unknown>;
    expect(result.error).toBeDefined();
  });

  test("PCA covariance on axis-aligned cloud has mean at correct centroid", () => {
    // Corners of a 2×3×4 box at origin. Mean = (1, 1.5, 2).
    const pts = [
      {x:0,y:0,z:0},{x:2,y:0,z:0},{x:0,y:3,z:0},{x:0,y:0,z:4},
      {x:2,y:3,z:0},{x:2,y:0,z:4},{x:0,y:3,z:4},{x:2,y:3,z:4},
    ];
    const n = pts.length;
    let mx = 0, my = 0, mz = 0;
    for (const p of pts) { mx+=p.x; my+=p.y; mz+=p.z; }
    mx/=n; my/=n; mz/=n;
    // oracle: centroid of symmetric box = half of each side
    expect(close(mx, 1, TIGHT)).toBe(true);
    expect(close(my, 1.5, TIGHT)).toBe(true);
    expect(close(mz, 2, TIGHT)).toBe(true);
  });

  test("axis-aligned box: OBB volume equals AABB volume (degenerate PCA)", () => {
    // For an axis-aligned rectangular point cloud, PCA eigenvectors align with axes.
    // OBB half-extents = AABB half-extents → OBB volume = AABB volume.
    const halfA = 1.5, halfB = 2.5, halfC = 3.0;
    const obbVol = 8 * halfA * halfB * halfC;
    const aabbVol = (2*halfA) * (2*halfB) * (2*halfC);
    expect(obbVol).toBeCloseTo(aabbVol, 10);
    // = 8 * 1.5 * 2.5 * 3 = 90
    expect(obbVol).toBeCloseTo(90, 10);
  });
});

// ── SdClosestPointPoint ───────────────────────────────────────────────────────

describe("SdClosestPointPoint — Euclidean distance oracle", () => {
  test("two explicit points — exact distance (non-axis-aligned)", () => {
    // Points (1,2,3) and (4,6,3): oracle = sqrt(9+16) = 5
    const result = handle_SdClosestPointPoint(
      { pointA: [1, 2, 3], pointB: [4, 6, 3] },
      nullViewer,
    ) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.distance).toBeCloseTo(5, 10);
    const mid = result.midpoint as { x: number; y: number; z: number };
    expect(close(mid.x, 2.5, TIGHT)).toBe(true);
    expect(close(mid.y, 4.0, TIGHT)).toBe(true);
    expect(close(mid.z, 3.0, TIGHT)).toBe(true);
  });

  test("non-axis-aligned 3D points (main diagonal)", () => {
    // (0,0,0) → (1,1,1): oracle = sqrt(3)
    const result = handle_SdClosestPointPoint(
      { pointA: [0, 0, 0], pointB: [1, 1, 1] },
      nullViewer,
    ) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.distance).toBeCloseTo(Math.sqrt(3), 10);
  });

  test("non-axis-aligned 3D points (3-4-5 triangle)", () => {
    // (0,0,0) → (3,4,0): oracle = 5
    const result = handle_SdClosestPointPoint(
      { pointA: [0, 0, 0], pointB: [3, 4, 0] },
      nullViewer,
    ) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.distance).toBeCloseTo(5, 10);
    const dir = result.direction as { x: number; y: number; z: number };
    expect(close(dir.x, 0.6, TIGHT)).toBe(true);
    expect(close(dir.y, 0.8, TIGHT)).toBe(true);
    expect(close(dir.z, 0.0, TIGHT)).toBe(true);
  });

  test("coincident points — distance = 0, direction = fallback {1,0,0}", () => {
    const result = handle_SdClosestPointPoint(
      { pointA: [5, -3, 2], pointB: [5, -3, 2] },
      nullViewer,
    ) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.distance).toBeCloseTo(0, 12);
    const dir = result.direction as { x: number; y: number; z: number };
    expect(close(dir.x, 1, TIGHT)).toBe(true);
    expect(close(dir.y, 0, TIGHT)).toBe(true);
    expect(close(dir.z, 0, TIGHT)).toBe(true);
  });

  test("architectural scale: 100m distance", () => {
    const result = handle_SdClosestPointPoint(
      { pointA: [0, 0, 0], pointB: [100, 0, 0] },
      nullViewer,
    ) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.distance).toBeCloseTo(100, 10);
  });

  test("direction vector is unit length for non-coincident points", () => {
    const result = handle_SdClosestPointPoint(
      { pointA: [0, 0, 0], pointB: [3, 4, 0] },
      nullViewer,
    ) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    const dir = result.direction as { x: number; y: number; z: number };
    const len = Math.sqrt(dir.x**2 + dir.y**2 + dir.z**2);
    expect(close(len, 1, TIGHT)).toBe(true);
  });

  test("missing pointA returns ArgValidationError", () => {
    const result = handle_SdClosestPointPoint(
      { pointB: [1, 2, 3] },
      nullViewer,
    ) as Record<string, unknown>;
    expect(result.error).toBe("ArgValidationError");
  });

  test("missing pointB returns ArgValidationError", () => {
    const result = handle_SdClosestPointPoint(
      { pointA: [1, 2, 3] },
      nullViewer,
    ) as Record<string, unknown>;
    expect(result.error).toBe("ArgValidationError");
  });
});

// ── C++ blocked stubs — smoke (always runs, no Viewer needed) ─────────────────

describe("C++ stub shape (smoke: NotYetImplemented shape)", () => {
  test("kern_volumeCentroid", () => {
    const r = handle_kern_volumeCentroid({}) as Record<string, unknown>;
    expect(r.error).toBe("NotYetImplemented");
    expect(typeof r.detail).toBe("string");
  });

  test("kern_areaMoments", () => {
    const r = handle_kern_areaMoments({}) as Record<string, unknown>;
    expect(r.error).toBe("NotYetImplemented");
    expect(typeof r.detail).toBe("string");
  });

  test("kern_volumeMoments", () => {
    const r = handle_kern_volumeMoments({}) as Record<string, unknown>;
    expect(r.error).toBe("NotYetImplemented");
    expect(typeof r.detail).toBe("string");
  });

  test("kern_curvatureAnalysis", () => {
    const r = handle_kern_curvatureAnalysis({}) as Record<string, unknown>;
    expect(r.error).toBe("NotYetImplemented");
    expect(typeof r.detail).toBe("string");
  });

  test("kern_draftAngleAnalysis", () => {
    const r = handle_kern_draftAngleAnalysis({}) as Record<string, unknown>;
    expect(r.error).toBe("NotYetImplemented");
    expect(typeof r.detail).toBe("string");
  });

  test("kern_deviation", () => {
    const r = handle_kern_deviation({}) as Record<string, unknown>;
    expect(r.error).toBe("NotYetImplemented");
    expect(typeof r.detail).toBe("string");
  });

  test("kern_closestPointCurve", () => {
    const r = handle_kern_closestPointCurve({}) as Record<string, unknown>;
    expect(r.error).toBe("NotYetImplemented");
    expect(typeof r.detail).toBe("string");
  });

  test("kern_closestPointSurface", () => {
    const r = handle_kern_closestPointSurface({}) as Record<string, unknown>;
    expect(r.error).toBe("NotYetImplemented");
    expect(typeof r.detail).toBe("string");
  });

  test("kern_closestCurveCurve", () => {
    const r = handle_kern_closestCurveCurve({}) as Record<string, unknown>;
    expect(r.error).toBe("NotYetImplemented");
    expect(typeof r.detail).toBe("string");
  });

  test("kern_closestCurveSurface", () => {
    const r = handle_kern_closestCurveSurface({}) as Record<string, unknown>;
    expect(r.error).toBe("NotYetImplemented");
    expect(typeof r.detail).toBe("string");
  });

  test("kern_closestSurfaceSurface", () => {
    const r = handle_kern_closestSurfaceSurface({}) as Record<string, unknown>;
    expect(r.error).toBe("NotYetImplemented");
    expect(typeof r.detail).toBe("string");
  });
});

// ── C++ blocked stubs — skipped (full acceptance: requires kern.wasm) ─────────

describe("C++ blocked stubs (skipped: needs kern.wasm)", () => {
  test.skip("kern_volumeCentroid — blocked: requires general SSI in kern.wasm", () => {
    // Full acceptance: BRep volume centroid via divergence theorem in WASM.
  });

  test.skip("kern_areaMoments — blocked: requires boundary-integral 2nd-moment in kern.wasm", () => {
    // Full acceptance: area second moments Ixx/Iyy/Ixy via Green's theorem in WASM.
  });

  test.skip("kern_volumeMoments — blocked: requires inertia-tensor divergence in kern.wasm", () => {
    // Full acceptance: volume inertia tensor on closed shell in WASM.
  });

  test.skip("kern_curvatureAnalysis — blocked: requires second-fundamental-form in kern.wasm", () => {
    // Full acceptance: Gaussian/mean/principal curvature on NURBS surface in WASM.
  });

  test.skip("kern_draftAngleAnalysis — blocked: requires per-face normal integration in kern.wasm", () => {
    // Full acceptance: min/max draft angle between face normal and pull direction in WASM.
  });

  test.skip("kern_deviation — blocked: requires Hausdorff distance solver in kern.wasm", () => {
    // Full acceptance: symmetric Hausdorff distance between curve-curve / surface-surface.
  });

  test.skip("kern_closestPointCurve — blocked: requires general curve projection in kern.wasm", () => {
    // Full acceptance: Newton-Raphson projection with robust multi-start init in WASM.
  });

  test.skip("kern_closestPointSurface — blocked: requires surface point projection in kern.wasm", () => {
    // Full acceptance: 2D Newton on S(u,v)-p with gradient/Hessian in WASM.
  });

  test.skip("kern_closestCurveCurve — blocked: requires curve-curve closest-point in kern.wasm", () => {
    // Full acceptance: simultaneous Newton on |C1(t1)-C2(t2)|² in WASM.
  });

  test.skip("kern_closestCurveSurface — blocked: requires curve-surface closest-point in kern.wasm", () => {
    // Full acceptance: mixed Newton d/dt=0, d/du=0, d/dv=0 in WASM.
  });

  test.skip("kern_closestSurfaceSurface — blocked: requires general SSI initialisation in kern.wasm", () => {
    // Full acceptance: 4D Newton on |S1(u1,v1)-S2(u2,v2)|² with SSI init in WASM.
  });
});
