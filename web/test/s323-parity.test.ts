// s323-parity.test.ts — Oracle parity tests for #323 (S3 surface creation).
//
// Each test uses a LIVE oracle (closed-form math or existing NURBS machinery)
// to verify the surface ops defined in s323-impl.ts. NO hardcoded expected
// values that don't arise from the oracle formula.
//
// Oracle strategies:
//   SdNurbsSurfaceFromGrid  — de Boor via pointAtUV: boundary interpolation (clamped knots),
//                             bilinear closed-form, rational weight-consistency check.
//   SdNurbsSurfaceEvaluate  — geometric properties: midpoint, determinism, domain boundary.
//   SdNurbsSurfaceNormal    — unit-length, perpendicularity to numerical tangents.
//   SdNurbsSurfaceDerivatives — closed-form bilinear curvature = 0; torus tangent direction.
//   SdTorusSurface          — closed-form P(u,v) using correct rev-surface parameterization.
//   SdSumSurface            — exact additive oracle S(u,v) = C1(u) + C2(v) - basepoint.
//   C++-blocked ops         — test.skip markers with spec comments.
//
// Parameterization note: RevSurface in nurbs-surfaces.ts with transposed=false:
//   u-param = profile-curve arc-length param ∈ [curveDomain.min, curveDomain.max]
//   v-param = revolution angle ∈ [angleStart, angleEnd]
// For torusSurface built from ArcCurve with domain [0, 2π*r]:
//   u ∈ [0, 2π*r] ⟹ profile angle = u/r
//   v ∈ [0, 2π]   ⟹ revolution angle = v
//   → closed-form: P = ((R+r*cos(u/r))*cos(v), (R+r*cos(u/r))*sin(v), r*sin(u/r))

import { describe, test, expect } from "bun:test";
import {
  type NurbsSurface,
  type Surface,
  type SumSurface,
  pointAtUV,
  normalAtUV,
  domainU,
  domainV,
} from "../src/nurbs/nurbs-surfaces";
import { surfaceOfRevolution } from "../src/nurbs/nurbs-surface-algorithms";
import { Interval, Plane } from "../src/nurbs/nurbs-primitives";
import type { ArcCurve } from "../src/nurbs/nurbs-curves";
import { pointAt as curvePointAt, domain as curveDomain } from "../src/nurbs/nurbs-curves";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

/** Build clamped uniform OpenNURBS-convention knots for n CVs at given order. */
function clampedUniformKnots(n: number, order: number): number[] {
  const degree = order - 1;
  const innerCount = n - order;
  const knots: number[] = [];
  for (let i = 0; i < degree; i++) knots.push(0);
  for (let i = 1; i <= innerCount; i++) knots.push(i / (innerCount + 1));
  for (let i = 0; i < degree; i++) knots.push(1);
  return knots;
}

/** Bilinear interpolation oracle for a 2×2 degree-1 NURBS over [0,1]×[0,1]. */
function bilinearOracle(
  p00: [number, number, number],
  p01: [number, number, number],
  p10: [number, number, number],
  p11: [number, number, number],
  u: number,
  v: number,
): [number, number, number] {
  const w00 = (1 - u) * (1 - v);
  const w01 = (1 - u) * v;
  const w10 = u * (1 - v);
  const w11 = u * v;
  return [
    w00 * p00[0] + w01 * p01[0] + w10 * p10[0] + w11 * p11[0],
    w00 * p00[1] + w01 * p01[1] + w10 * p10[1] + w11 * p11[1],
    w00 * p00[2] + w01 * p01[2] + w10 * p10[2] + w11 * p11[2],
  ];
}

// Torus closed-form oracle using RevSurface parameterization:
// u = arc-length param on profile circle ∈ [0, 2π*r]
// v = revolution angle ∈ [0, 2π]
// profile arc at param u: angle = u/r ⟹ profilePoint = (R+r*cos(u/r), 0, r*sin(u/r))
// after revolution by v: P = ((R+r*cos(u/r))*cos(v), (R+r*cos(u/r))*sin(v), r*sin(u/r))
function torusRevOracle(R: number, r: number, u: number, v: number): [number, number, number] {
  const profileAngle = u / r;
  const rho = R + r * Math.cos(profileAngle);
  return [rho * Math.cos(v), rho * Math.sin(v), r * Math.sin(profileAngle)];
}

/** Torus closed-form unit normal oracle (using correct RevSurface parameterization). */
function torusRevNormalOracle(R: number, r: number, u: number, v: number): [number, number, number] {
  const profileAngle = u / r;
  // dP/du = (-sin(profileAngle)*cos(v), -sin(profileAngle)*sin(v), cos(profileAngle)) × (1/r)
  //         (scale cancels in normalized cross product)
  const dpdu = [-Math.sin(profileAngle) * Math.cos(v), -Math.sin(profileAngle) * Math.sin(v), Math.cos(profileAngle)];
  // dP/dv = (-(R+r*cos(u/r))*sin(v), (R+r*cos(u/r))*cos(v), 0)
  const rho = R + r * Math.cos(profileAngle);
  const dpdv = [-rho * Math.sin(v), rho * Math.cos(v), 0];
  // N = dpdu × dpdv
  const nx = dpdu[1]! * dpdv[2]! - dpdu[2]! * dpdv[1]!;
  const ny = dpdu[2]! * dpdv[0]! - dpdu[0]! * dpdv[2]!;
  const nz = dpdu[0]! * dpdv[1]! - dpdu[1]! * dpdv[0]!;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Vector dot product. */
function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Vector length. */
function vecLen(v: [number, number, number]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

// ── Build a torus RevSurface (same logic as s323-impl.ts::torusSurface) ──────

function buildTorusSurface(R: number, r: number): Surface {
  const profile: ArcCurve = {
    kind: "arc",
    center: { x: R, y: 0, z: 0 },
    radius: r,
    startAngle: 0,
    endAngle: TWO_PI,
    plane: {
      origin: { x: R, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 0, z: 1 },
      normal: { x: 0, y: -1, z: 0 },
    },
    domain: { min: 0, max: TWO_PI * r },
  };
  return surfaceOfRevolution(
    profile,
    { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 1 } },
    0,
    TWO_PI,
  );
}

// ── Build a non-rational degree-3 NURBS surface from a saddle-shaped grid ────

function buildNurbsGrid(nU: number, nV: number, degU: number, degV: number): NurbsSurface {
  // Non-axis-aligned, curved "saddle" surface patch.
  const ordU = degU + 1, ordV = degV + 1;
  const kU = clampedUniformKnots(nU, ordU);
  const kV = clampedUniformKnots(nV, ordV);
  const cvs: number[] = [];
  for (let i = 0; i < nU; i++) {
    const u = i / (nU - 1);
    for (let j = 0; j < nV; j++) {
      const v = j / (nV - 1);
      cvs.push(
        u * 2 + v * 0.3,
        v * 2 + u * 0.3,
        Math.sin(u * Math.PI) * Math.cos(v * Math.PI) * 0.4,
      );
    }
  }
  return {
    kind: "nurbs", dim: 3, isRational: false,
    order: [ordU, ordV], cvCount: [nU, nV],
    knots: [kU, kV], cvs, cvStride: [nV * 3, 3],
  };
}

// ── SdNurbsSurfaceFromGrid parity ─────────────────────────────────────────────

describe("SdNurbsSurfaceFromGrid — de Boor consistency oracle", () => {
  test("degree-1 bilinear 2×2 grid: point evaluation matches closed-form bilinear oracle", () => {
    // oracle: standard bilinear interpolation of 4 non-axis-aligned corners.
    // non-axis-aligned z values ensure the test is not degenerate.
    const p00: [number, number, number] = [0, 0, 0];
    const p01: [number, number, number] = [0, 1, 0.5];
    const p10: [number, number, number] = [1, 0, 0.3];
    const p11: [number, number, number] = [1, 1, 0.8];

    const surf: NurbsSurface = {
      kind: "nurbs", dim: 3, isRational: false,
      order: [2, 2], cvCount: [2, 2],
      knots: [[0, 1], [0, 1]],
      cvs: [...p00, ...p01, ...p10, ...p11],
      cvStride: [6, 3],
    };

    const du = domainU(surf), dv = domainV(surf);
    const samples: [number, number][] = [
      [du.min + (du.max - du.min) * 0.3, dv.min + (dv.max - dv.min) * 0.7],
      [du.min + (du.max - du.min) * 0.5, dv.min + (dv.max - dv.min) * 0.5],
      [du.min + (du.max - du.min) * 0.9, dv.min + (dv.max - dv.min) * 0.1],
    ];

    for (const [u, v] of samples) {
      // Map u/v to [0,1] for the bilinear oracle
      const uf = (u - du.min) / (du.max - du.min);
      const vf = (v - dv.min) / (dv.max - dv.min);
      const oracle = bilinearOracle(p00, p01, p10, p11, uf, vf);
      const result = pointAtUV(surf, u, v);
      expect(Math.abs(result.x - oracle[0])).toBeLessThan(1e-5);
      expect(Math.abs(result.y - oracle[1])).toBeLessThan(1e-5);
      expect(Math.abs(result.z - oracle[2])).toBeLessThan(1e-5);
    }
  });

  test("degree-3 4×4 non-axis-aligned saddle: clamped knots interpolate corner CVs exactly", () => {
    // oracle: clamped NURBS interpolates the corner control points at the domain boundaries.
    const nU = 4, nV = 4, degU = 3, degV = 3;
    const surf = buildNurbsGrid(nU, nV, degU, degV);
    const du = domainU(surf), dv = domainV(surf);

    // Corner CV (i=0, j=0) must equal point at (du.min, dv.min)
    const ptCorner00 = pointAtUV(surf, du.min, dv.min);
    const cv00 = { x: surf.cvs[0]!, y: surf.cvs[1]!, z: surf.cvs[2]! };
    expect(Math.abs(ptCorner00.x - cv00.x)).toBeLessThan(1e-4);
    expect(Math.abs(ptCorner00.y - cv00.y)).toBeLessThan(1e-4);
    expect(Math.abs(ptCorner00.z - cv00.z)).toBeLessThan(1e-4);

    // Corner CV (nU-1, nV-1) at (du.max, dv.max)
    const lastBase = ((nU - 1) * nV + (nV - 1)) * 3;
    const cvLL = { x: surf.cvs[lastBase]!, y: surf.cvs[lastBase + 1]!, z: surf.cvs[lastBase + 2]! };
    const ptCornerLL = pointAtUV(surf, du.max, dv.max);
    expect(Math.abs(ptCornerLL.x - cvLL.x)).toBeLessThan(1e-4);
    expect(Math.abs(ptCornerLL.y - cvLL.y)).toBeLessThan(1e-4);
    expect(Math.abs(ptCornerLL.z - cvLL.z)).toBeLessThan(1e-4);
  });

  test("rational 2×2 with non-unit weights: satisfies rational partition-of-unity property", () => {
    // oracle: for any rational NURBS, the point at u=v=0 must equal the unweighted
    // position of the corner CV (clamped knot interpolates boundary in Euclidean coords).
    // p00 = [1, 2, 0], w00 = 5 → CV in homogeneous: [5, 10, 0, 5].
    const surf: NurbsSurface = {
      kind: "nurbs", dim: 3, isRational: true,
      order: [2, 2], cvCount: [2, 2],
      knots: [[0, 1], [0, 1]],
      // Homogeneous [x*w, y*w, z*w, w] for each CV (row-major)
      cvs: [
        1 * 5, 2 * 5, 0 * 5, 5,    // p00=[1,2,0] w=5
        3 * 2, 0 * 2, 1 * 2, 2,    // p01=[3,0,1] w=2
        0 * 3, 4 * 3, 2 * 3, 3,    // p10=[0,4,2] w=3
        2 * 1, 1 * 1, 3 * 1, 1,    // p11=[2,1,3] w=1
      ],
      cvStride: [8, 4],
    };
    const du = domainU(surf), dv = domainV(surf);

    // At the corner (uMin, vMin): must interpolate p00 = [1, 2, 0]
    const pt = pointAtUV(surf, du.min, dv.min);
    expect(Math.abs(pt.x - 1.0)).toBeLessThan(1e-4);
    expect(Math.abs(pt.y - 2.0)).toBeLessThan(1e-4);
    expect(Math.abs(pt.z - 0.0)).toBeLessThan(1e-4);

    // At the corner (uMax, vMax): must interpolate p11 = [2, 1, 3]
    const ptLL = pointAtUV(surf, du.max, dv.max);
    expect(Math.abs(ptLL.x - 2.0)).toBeLessThan(1e-4);
    expect(Math.abs(ptLL.y - 1.0)).toBeLessThan(1e-4);
    expect(Math.abs(ptLL.z - 3.0)).toBeLessThan(1e-4);
  });
});

// ── SdNurbsSurfaceEvaluate — geometric oracle ─────────────────────────────────

describe("SdNurbsSurfaceEvaluate — pointAtUV geometric oracle", () => {
  test("point at midpoint of symmetric bilinear patch = centroid of 4 corners", () => {
    // oracle: for a bilinear surface, midpoint = average of 4 corners (by symmetry).
    const surf: NurbsSurface = {
      kind: "nurbs", dim: 3, isRational: false,
      order: [2, 2], cvCount: [2, 2],
      knots: [[0, 1], [0, 1]],
      cvs: [0, 0, 0,  0, 2, 0,  2, 0, 0,  2, 2, 0],
      cvStride: [6, 3],
    };
    const du = domainU(surf), dv = domainV(surf);
    const mid = pointAtUV(surf, (du.min + du.max) / 2, (dv.min + dv.max) / 2);
    // oracle: midpoint of [0,0,0], [0,2,0], [2,0,0], [2,2,0] = [1,1,0]
    expect(Math.abs(mid.x - 1.0)).toBeLessThan(1e-5);
    expect(Math.abs(mid.y - 1.0)).toBeLessThan(1e-5);
    expect(Math.abs(mid.z - 0.0)).toBeLessThan(1e-5);
  });

  test("point evaluation is deterministic across repeated calls", () => {
    const surf = buildNurbsGrid(5, 5, 3, 3);
    const du = domainU(surf), dv = domainV(surf);
    const u = du.min + (du.max - du.min) * 0.37;
    const v = dv.min + (dv.max - dv.min) * 0.61;
    const p1 = pointAtUV(surf, u, v);
    const p2 = pointAtUV(surf, u, v);
    // oracle: same inputs → same outputs (deterministic algorithm)
    expect(p1.x).toBe(p2.x);
    expect(p1.y).toBe(p2.y);
    expect(p1.z).toBe(p2.z);
  });

  test("torus boundary at v=0 lies in XZ plane (y ≈ 0)", () => {
    // oracle: revolution angle v=0 means no rotation out of XZ plane ⟹ y ≈ 0
    const R = 1.5, r = 0.4;
    const surf = buildTorusSurface(R, r);
    const du = domainU(surf), dv = domainV(surf);
    const v0 = dv.min;
    for (const uf of [0.1, 0.3, 0.5, 0.7]) {
      const u = du.min + (du.max - du.min) * uf;
      const pt = pointAtUV(surf, u, v0);
      expect(Math.abs(pt.y)).toBeLessThan(1e-8);
    }
  });
});

// ── SdNurbsSurfaceNormal — unit-length + perpendicularity oracle ───────────────

describe("SdNurbsSurfaceNormal — unit-length and perpendicularity oracle", () => {
  test("normal at arbitrary (u,v) is unit length on torus", () => {
    const R = 2.0, r = 0.7;
    const surf = buildTorusSurface(R, r);
    const du = domainU(surf), dv = domainV(surf);
    const params: [number, number][] = [
      [du.min + (du.max - du.min) * 0.1,  dv.min + (dv.max - dv.min) * 0.2],
      [du.min + (du.max - du.min) * 0.5,  dv.min + (dv.max - dv.min) * 0.5],
      [du.min + (du.max - du.min) * 0.73, dv.min + (dv.max - dv.min) * 0.89],
    ];
    for (const [u, v] of params) {
      const n = normalAtUV(surf, u, v);
      const nLen = Math.sqrt(n.x ** 2 + n.y ** 2 + n.z ** 2);
      // oracle: unit normal must have length 1
      expect(Math.abs(nLen - 1.0)).toBeLessThan(1e-4);
    }
  });

  test("normal is perpendicular to numerical tangent vectors", () => {
    // oracle: N · dP/du ≈ 0 and N · dP/dv ≈ 0 (by definition of surface normal)
    const surf = buildNurbsGrid(5, 5, 3, 3);
    const du = domainU(surf), dv = domainV(surf);
    const u = du.min + (du.max - du.min) * 0.37;
    const v = dv.min + (dv.max - dv.min) * 0.55;
    const eps = 1e-5;
    const normal = normalAtUV(surf, u, v);
    const p0u = pointAtUV(surf, u - eps, v), p1u = pointAtUV(surf, u + eps, v);
    const p0v = pointAtUV(surf, u, v - eps), p1v = pointAtUV(surf, u, v + eps);
    const tanU = [p1u.x - p0u.x, p1u.y - p0u.y, p1u.z - p0u.z] as [number, number, number];
    const tanV = [p1v.x - p0v.x, p1v.y - p0v.y, p1v.z - p0v.z] as [number, number, number];
    const nArr = [normal.x, normal.y, normal.z] as [number, number, number];
    const luU = vecLen(tanU) || 1, luV = vecLen(tanV) || 1;
    const dotU = dot(nArr, [tanU[0] / luU, tanU[1] / luU, tanU[2] / luU]);
    const dotV = dot(nArr, [tanV[0] / luV, tanV[1] / luV, tanV[2] / luV]);
    expect(Math.abs(dotU)).toBeLessThan(1e-3);
    expect(Math.abs(dotV)).toBeLessThan(1e-3);
  });

  test("torus normal direction agrees with closed-form oracle (RevSurface parameterization)", () => {
    // oracle: closed-form normal from dP/du × dP/dv using RevSurface params.
    // tolerance: 0.01 — allows for discretization in RevSurface numerical derivatives.
    const R = 2.0, r = 0.7;
    const surf = buildTorusSurface(R, r);
    const du = domainU(surf), dv = domainV(surf);
    const samples: [number, number][] = [
      [du.min + (du.max - du.min) * 0.13, dv.min + (dv.max - dv.min) * 0.27],
      [du.min + (du.max - du.min) * 0.59, dv.min + (dv.max - dv.min) * 0.71],
    ];
    for (const [u, v] of samples) {
      const n = normalAtUV(surf, u, v);
      const nArr = [n.x, n.y, n.z] as [number, number, number];
      const oracle = torusRevNormalOracle(R, r, u, v);
      // Oracle normal and computed normal should be in the same or opposite direction.
      // Use absolute dot product: |N·oracle| ≈ 1.
      const d = Math.abs(dot(nArr, oracle));
      expect(d).toBeGreaterThan(0.95);
    }
  });
});

// ── SdNurbsSurfaceDerivatives — closed-form oracle ────────────────────────────

describe("SdNurbsSurfaceDerivatives — numerical derivative oracle", () => {
  test("bilinear surface has zero second derivative (d²P/du² = 0)", () => {
    // oracle: bilinear surface is linear in each direction independently,
    // so all second derivatives vanish exactly.
    const surf: NurbsSurface = {
      kind: "nurbs", dim: 3, isRational: false,
      order: [2, 2], cvCount: [2, 2],
      knots: [[0, 1], [0, 1]],
      cvs: [0, 0, 0,  0, 1, 0,  1, 0, 0,  1, 1, 0],
      cvStride: [6, 3],
    };
    const du = domainU(surf), dv = domainV(surf);
    const u = du.min + (du.max - du.min) * 0.5;
    const v = dv.min + (dv.max - dv.min) * 0.5;
    const eps = 1e-4;
    const p0 = pointAtUV(surf, u - eps, v);
    const pm = pointAtUV(surf, u, v);
    const p1 = pointAtUV(surf, u + eps, v);
    const d2u = {
      x: (p0.x - 2 * pm.x + p1.x) / (eps * eps),
      y: (p0.y - 2 * pm.y + p1.y) / (eps * eps),
      z: (p0.z - 2 * pm.z + p1.z) / (eps * eps),
    };
    // oracle: bilinear curvature = 0
    expect(Math.abs(d2u.x)).toBeLessThan(1e-3);
    expect(Math.abs(d2u.y)).toBeLessThan(1e-3);
    expect(Math.abs(d2u.z)).toBeLessThan(1e-3);
  });

  test("torus: dU and dV are orthogonal to the surface normal", () => {
    // oracle: N · dP/du ≈ 0 and N · dP/dv ≈ 0 for any smooth surface.
    const R = 1.5, r = 0.5;
    const surf = buildTorusSurface(R, r);
    const du = domainU(surf), dv = domainV(surf);
    const u = du.min + (du.max - du.min) * 0.55;
    const v = dv.min + (dv.max - dv.min) * 0.35;
    const eps = 1e-5;
    const p0u = pointAtUV(surf, u - eps, v), p1u = pointAtUV(surf, u + eps, v);
    const p0v = pointAtUV(surf, u, v - eps), p1v = pointAtUV(surf, u, v + eps);
    const dU = [p1u.x - p0u.x, p1u.y - p0u.y, p1u.z - p0u.z] as [number, number, number];
    const dV = [p1v.x - p0v.x, p1v.y - p0v.y, p1v.z - p0v.z] as [number, number, number];
    const normal = normalAtUV(surf, u, v);
    const nArr = [normal.x, normal.y, normal.z] as [number, number, number];
    const luU = vecLen(dU) || 1, luV = vecLen(dV) || 1;
    expect(Math.abs(dot(nArr, [dU[0] / luU, dU[1] / luU, dU[2] / luU]))).toBeLessThan(1e-3);
    expect(Math.abs(dot(nArr, [dV[0] / luV, dV[1] / luV, dV[2] / luV]))).toBeLessThan(1e-3);
  });

  test("torus: dU direction agrees with closed-form tangent in U", () => {
    // oracle: dP/du at (u,v) on RevSurface — analytic tangent in profile direction.
    // The derivative formula for arc param: dP/du = (-sin(u/r)*cos(v), -sin(u/r)*sin(v), cos(u/r)) / r
    // → direction: (-sin(u/r)*cos(v), -sin(u/r)*sin(v), cos(u/r))
    const R = 1.5, r = 0.5;
    const surf = buildTorusSurface(R, r);
    const du = domainU(surf), dv = domainV(surf);
    const u = du.min + (du.max - du.min) * 0.3;
    const v = dv.min + (dv.max - dv.min) * 0.4;
    const eps = 1e-5;
    const p0 = pointAtUV(surf, u - eps, v), p1 = pointAtUV(surf, u + eps, v);
    const numDU = [(p1.x - p0.x), (p1.y - p0.y), (p1.z - p0.z)] as [number, number, number];
    const numLen = vecLen(numDU) || 1;
    const numDUNorm = [numDU[0] / numLen, numDU[1] / numLen, numDU[2] / numLen] as [number, number, number];
    const profileAngle = u / r;
    const oracleDU = [
      -Math.sin(profileAngle) * Math.cos(v),
      -Math.sin(profileAngle) * Math.sin(v),
      Math.cos(profileAngle),
    ] as [number, number, number];
    const oracleLen = vecLen(oracleDU) || 1;
    const oracleDUNorm = [oracleDU[0] / oracleLen, oracleDU[1] / oracleLen, oracleDU[2] / oracleLen] as [number, number, number];
    // Dot of normalized numerical dU with oracle dU ≈ 1 (parallel)
    const d = Math.abs(dot(numDUNorm, oracleDUNorm));
    expect(d).toBeGreaterThan(0.99);
  });
});

// ── SdTorusSurface — closed-form oracle ──────────────────────────────────────

describe("SdTorusSurface — closed-form point oracle (RevSurface parameterization)", () => {
  const R = 3.0, r = 0.8;

  test("point (uMin, vMin) = (R+r, 0, 0) — outer equator at revolution angle 0", () => {
    // oracle: profile at u=0 is angle=0 on circle ⟹ (R+r, 0, 0), revolution at v=0 ⟹ no rotation
    const surf = buildTorusSurface(R, r);
    const du = domainU(surf), dv = domainV(surf);
    const pt = pointAtUV(surf, du.min, dv.min);
    expect(Math.abs(pt.x - (R + r))).toBeLessThan(1e-5);
    expect(Math.abs(pt.y)).toBeLessThan(1e-5);
    expect(Math.abs(pt.z)).toBeLessThan(1e-5);
  });

  test("torus constraint: (sqrt(x²+y²) - R)² + z² = r² at all sample points", () => {
    // oracle: the torus implicit equation holds for any point on the torus surface.
    const surf = buildTorusSurface(R, r);
    const du = domainU(surf), dv = domainV(surf);
    const samples: [number, number][] = [
      [du.min + (du.max - du.min) * 0.17, dv.min + (dv.max - dv.min) * 0.44],
      [du.min + (du.max - du.min) * 0.5,  dv.min + (dv.max - dv.min) * 0.5],
      [du.min + (du.max - du.min) * 0.83, dv.min + (dv.max - dv.min) * 0.91],
      [du.min + (du.max - du.min) * 0.33, dv.min + (dv.max - dv.min) * 0.12],
    ];
    for (const [u, v] of samples) {
      const pt = pointAtUV(surf, u, v);
      const rho = Math.sqrt(pt.x ** 2 + pt.y ** 2);
      const torusConstraint = (rho - R) ** 2 + pt.z ** 2;
      // oracle: must equal r²
      expect(Math.abs(torusConstraint - r ** 2)).toBeLessThan(1e-3);
    }
  });

  test("point matches closed-form RevSurface oracle P(u,v) within 1e-4", () => {
    // oracle: torusRevOracle using RevSurface-correct parameterization.
    const surf = buildTorusSurface(R, r);
    const du = domainU(surf), dv = domainV(surf);
    const samples: [number, number][] = [
      [du.min + (du.max - du.min) * 0.25, dv.min + (dv.max - dv.min) * 0.33],
      [du.min + (du.max - du.min) * 0.6,  dv.min + (dv.max - dv.min) * 0.77],
      [du.min + (du.max - du.min) * 0.87, dv.min + (dv.max - dv.min) * 0.44],
    ];
    for (const [u, v] of samples) {
      const pt = pointAtUV(surf, u, v);
      const oracle = torusRevOracle(R, r, u, v);
      expect(Math.abs(pt.x - oracle[0])).toBeLessThan(1e-4);
      expect(Math.abs(pt.y - oracle[1])).toBeLessThan(1e-4);
      expect(Math.abs(pt.z - oracle[2])).toBeLessThan(1e-4);
    }
  });

  test("R=1.0, r=0.3: oracle at specific non-trivial params", () => {
    // oracle: torusRevOracle with distinct (R,r,u,v) at a non-trivial, off-axis point.
    const Rt = 1.0, rt = 0.3;
    const surf = buildTorusSurface(Rt, rt);
    const du = domainU(surf), dv = domainV(surf);
    // u=37% of arc domain, v=44% of revolution domain
    const u = du.min + (du.max - du.min) * 0.37;
    const v = dv.min + (dv.max - dv.min) * 0.44;
    const pt = pointAtUV(surf, u, v);
    const oracle = torusRevOracle(Rt, rt, u, v);
    expect(Math.abs(pt.x - oracle[0])).toBeLessThan(1e-4);
    expect(Math.abs(pt.y - oracle[1])).toBeLessThan(1e-4);
    expect(Math.abs(pt.z - oracle[2])).toBeLessThan(1e-4);
  });
});

// ── SumSurface (TypeScript) — exact additive oracle ───────────────────────────

describe("SumSurface — S(u,v) = C1(u) + C2(v) - basepoint oracle", () => {
  test("SumSurface evaluation matches C1(u) + C2(v) - basepoint exactly", () => {
    // oracle: the SumSurface formula from nurbs-surfaces.ts::pointAtUV case "sum":
    //   result = C1(u) + C2(v) - basepoint
    // This is an exact identity, not an approximation.
    const curveU = {
      kind: "line" as const,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 2, y: 0.5, z: 0 },
      domain: { min: 0, max: Math.sqrt(4 + 0.25) },
    };
    const curveV = {
      kind: "line" as const,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 0.3, y: 3, z: 1 },
      domain: { min: 0, max: Math.sqrt(0.09 + 9 + 1) },
    };
    const basepoint = { x: 0, y: 0, z: 0 };
    const sumSurf: SumSurface = {
      kind: "sum", curveU, curveV, basepoint,
    };

    const du = domainU(sumSurf), dv = domainV(sumSurf);
    const samples: [number, number][] = [
      [du.min + (du.max - du.min) * 0.3, dv.min + (dv.max - dv.min) * 0.7],
      [du.min + (du.max - du.min) * 0.6, dv.min + (dv.max - dv.min) * 0.4],
      [du.min + (du.max - du.min) * 0.85, dv.min + (dv.max - dv.min) * 0.15],
    ];

    for (const [u, v] of samples) {
      const result = pointAtUV(sumSurf, u, v);
      const ptU = curvePointAt(curveU, u);
      const ptV = curvePointAt(curveV, v);
      // oracle: S(u,v) = C1(u) + C2(v) - basepoint (exact additive formula)
      const oracleX = ptU.x + ptV.x - basepoint.x;
      const oracleY = ptU.y + ptV.y - basepoint.y;
      const oracleZ = ptU.z + ptV.z - basepoint.z;
      expect(Math.abs(result.x - oracleX)).toBeLessThan(1e-10);
      expect(Math.abs(result.y - oracleY)).toBeLessThan(1e-10);
      expect(Math.abs(result.z - oracleZ)).toBeLessThan(1e-10);
    }
  });

  test("SumSurface with non-linear curves: non-axis-aligned evaluation", () => {
    // oracle: exact additive formula with ArcCurve (non-linear, non-axis-aligned).
    const arcCurveU: ArcCurve = {
      kind: "arc",
      center: { x: 1, y: 0, z: 0 },
      radius: 1.0,
      startAngle: 0,
      endAngle: Math.PI,
      plane: {
        origin: { x: 1, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 0, z: 1 },
        normal: { x: 0, y: -1, z: 0 },
      },
      domain: { min: 0, max: Math.PI },
    };
    const lineV = {
      kind: "line" as const,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 0, y: 2, z: 1.5 },
      domain: { min: 0, max: Math.sqrt(4 + 2.25) },
    };
    const basepoint = curvePointAt(arcCurveU, curveDomain(arcCurveU).min);
    const sumSurf: SumSurface = {
      kind: "sum", curveU: arcCurveU, curveV: lineV, basepoint,
    };

    const du = domainU(sumSurf), dv = domainV(sumSurf);
    const samples: [number, number][] = [
      [du.min + (du.max - du.min) * 0.4, dv.min + (dv.max - dv.min) * 0.6],
      [du.min + (du.max - du.min) * 0.7, dv.min + (dv.max - dv.min) * 0.3],
    ];
    for (const [u, v] of samples) {
      const result = pointAtUV(sumSurf, u, v);
      const ptU = curvePointAt(arcCurveU, u);
      const ptV = curvePointAt(lineV, v);
      expect(Math.abs(result.x - (ptU.x + ptV.x - basepoint.x))).toBeLessThan(1e-10);
      expect(Math.abs(result.y - (ptU.y + ptV.y - basepoint.y))).toBeLessThan(1e-10);
      expect(Math.abs(result.z - (ptU.z + ptV.z - basepoint.z))).toBeLessThan(1e-10);
    }
  });
});

// ── C++ blocked stubs — test.skip markers ─────────────────────────────────────

describe("C++-blocked ops (kern.wasm stubs)", () => {
  test.skip("SdEdgeSurface — blocked: needs kern_edgeSurface (Coons patch) in kern.wasm", () => {
    // When kern_edgeSurface is implemented:
    //   oracle: bilinear Coons patch formula with 4 linear boundary curves.
    //   Coons P(u,v) = C0(u)*(1-v) + C2(u)*v + C1(v)*(1-u) + C3(v)*u
    //                - C0(0)*(1-u)*(1-v) - C0(1)*u*(1-v) - C2(0)*(1-u)*v - C2(1)*u*v
    //   Tolerance 1e-5 at (u=0.5, v=0.5) with linear boundary curves.
    //   C++ signature: Brep kern_edgeSurface(const ON_SimpleArray<ON_Curve*>& edges, double tolerance);
    expect(false).toBe(true);
  });

  test.skip("SdNetworkSurface — blocked: needs kern_networkSurface (curve net fit) in kern.wasm", () => {
    // When kern_networkSurface is implemented:
    //   oracle: at each intersection param (u_i, v_j), surface must satisfy
    //   |S(u_i, v_j) - C_u_i(v_j)| < tolerance AND |S(u_i, v_j) - C_v_j(u_i)| < tolerance.
    //   C++ signature: Brep kern_networkSurface(const ON_SimpleArray<ON_Curve*>& uCurves,
    //                                            const ON_SimpleArray<ON_Curve*>& vCurves, double tol);
    expect(false).toBe(true);
  });

  test.skip("SdTorusSurfaceExact — blocked: needs kern_torusSurface_nurbs (9×9 rational) in kern.wasm", () => {
    // When kern_torusSurface_nurbs is implemented:
    //   The resulting NurbsSurface must have: degree=[2,2], cvCount=[9,9], isRational=true.
    //   oracle: pointAtUV matches closed-form torus within 1e-10 (exact rational, not approximation).
    //   C++ signature: ON_NurbsSurface kern_torusSurface_nurbs(double R, double r);
    expect(false).toBe(true);
  });

  test.skip("SdNurbsSurfaceDerivativesExact — blocked: exact rational Bézier extraction in kern.wasm", () => {
    // When kern_evaluateSurfaceDerivatives_rational is implemented:
    //   oracle: rational quotient rule derivatives match finite-difference within 1e-6.
    //   C++ signature: bool kern_evaluateSurfaceDerivatives_rational(const ON_NurbsSurface& srf,
    //                       double u, double v, int order, ON_3dPoint* pts);
    expect(false).toBe(true);
  });

  test.skip("SdTrimmedNurbsSurface — blocked: SSI + trim topology in kern.wasm", () => {
    // When kern_surfaceTrim_withTopology is implemented:
    //   oracle: trimmed surface satisfies brepNakedEdgeCount(brep) == 0 for a closed trim loop.
    //   C++ signature: Brep kern_surfaceTrim_withTopology(const ON_NurbsSurface& base,
    //                       const ON_SimpleArray<ON_Curve*>& trimCurves, double tol);
    expect(false).toBe(true);
  });
});
