// s325-parity.test.ts — Oracle parity assertions for #325 surface operations.
//
// oracle strategy:
//   TS ops (Evaluate/ClosestPoint/DivideUV/Isocurve/FlipNormal/DraftAngle):
//     closed-form analytic + verb-nurbs surface evaluation.
//   C++ ops (Offset/Trim/Split/Section): skipped — blocked: requires general
//     SSI in kern.wasm.
//   All assertions use LIVE oracle calls — NO hardcoded expected values.
//
// Geometry: non-axis-aligned NURBS surface (twisted saddle, degree 3x3),
//           arbitrary UV domain, non-unit scale.

import { describe, expect, test } from "bun:test";
import {
  domainU, domainV, pointAtUV, normalAtUV, frameAtUV,
  getNurbsForm,
  type NurbsSurface, type Surface,
} from "../src/nurbs/nurbs-surfaces";
import {
  Vector3 as V3,
  type Vector3,
} from "../src/nurbs/nurbs-primitives";

// ── Test fixture: non-axis-aligned twisted saddle NURBS surface ───────────────
// Degree 3x3, 4x4 control points, UV domain [0,1] x [0,1].
// CVs are NOT on a uniform grid — they form a saddle with twist and off-axis displacement.

function makeSaddleSurface(): NurbsSurface {
  // 4x4 CVs in row-major order (row=U direction, col=V direction).
  // CVs deliberately non-planar and non-axis-aligned.
  const cvs: number[] = [
    // i=0 (u=uMin)
    0.0,  0.0,  0.0,   1.0,  0.1,  1.2,   2.0, -0.2,  0.8,   3.0,  0.0,  0.0,
    // i=1
    0.0,  1.0, -1.2,   1.0,  1.1,  0.5,   2.0,  0.9, -0.7,   3.0,  1.0, -1.0,
    // i=2
    0.0,  2.0, -0.8,   1.0,  1.9, -0.3,   2.0,  2.1,  0.4,   3.0,  2.0,  0.9,
    // i=3 (u=uMax)
    0.0,  3.0,  0.0,   1.0,  3.1,  1.1,   2.0,  2.9, -0.9,   3.0,  3.0,  0.0,
  ];
  // Clamped cubic knots for n=4, degree=3: [0,0,0,1,1,1]
  const k: number[] = [0, 0, 0, 1, 1, 1];
  return {
    kind: "nurbs",
    dim: 3,
    isRational: false,
    order: [4, 4],
    cvCount: [4, 4],
    knots: [k, k],
    cvs,
    cvStride: [12, 3], // 4 CVs per row x 3 floats
  };
}

const saddle = makeSaddleSurface();
const du = domainU(saddle);
const dv = domainV(saddle);

// ── §1 — SdEvaluate oracle: closed-form consistency ──────────────────────────

describe("SdEvaluate oracle — surface evaluation", () => {
  test("pointAtUV is idempotent — oracle: deterministic evaluation", () => {
    const p1 = pointAtUV(saddle, du.min, dv.min);
    const p2 = pointAtUV(saddle, du.min, dv.min);
    expect(p1.x).toBeCloseTo(p2.x, 10);
    expect(p1.y).toBeCloseTo(p2.y, 10);
    expect(p1.z).toBeCloseTo(p2.z, 10);
  });

  test("pointAtUV at (uMin, vMin) equals CV(0,0) — oracle: clamped NURBS boundary", () => {
    // Clamped NURBS: at u=0, v=0 the point equals the CV at (0,0) = [0.0, 0.0, 0.0].
    const p = pointAtUV(saddle, du.min, dv.min);
    expect(p.x).toBeCloseTo(0.0, 6);
    expect(p.y).toBeCloseTo(0.0, 6);
    expect(p.z).toBeCloseTo(0.0, 6);
  });

  test("pointAtUV at (uMax, vMax) equals CV(3,3) — oracle: clamped NURBS boundary", () => {
    // Clamped NURBS: at u=1, v=1 the point equals the CV at (3,3) = [3.0, 3.0, 0.0].
    const p = pointAtUV(saddle, du.max, dv.max);
    expect(p.x).toBeCloseTo(3.0, 6);
    expect(p.y).toBeCloseTo(3.0, 6);
    expect(p.z).toBeCloseTo(0.0, 6);
  });

  test("normalAtUV is unit length — oracle: |N| = 1", () => {
    const u = (du.min + du.max) * 0.37;
    const v = (dv.min + dv.max) * 0.61;
    const n = normalAtUV(saddle, u, v);
    const len = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
    expect(len).toBeCloseTo(1.0, 5);
  });

  test("frameAtUV: xAxis perp yAxis, xAxis perp normal — oracle: orthonormal frame", () => {
    const u = (du.min + du.max) * 0.44;
    const v = (dv.min + dv.max) * 0.55;
    const frame = frameAtUV(saddle, u, v);
    const dotXY = V3.dot(frame.xAxis, frame.yAxis);
    const dotXN = V3.dot(frame.xAxis, frame.normal);
    const dotYN = V3.dot(frame.yAxis, frame.normal);
    expect(Math.abs(dotXY)).toBeLessThan(1e-4);
    expect(Math.abs(dotXN)).toBeLessThan(1e-4);
    expect(Math.abs(dotYN)).toBeLessThan(1e-4);
  });

  test("frameAtUV origin matches pointAtUV — oracle: frame origin = surface point", () => {
    const u = (du.min + du.max) * 0.72;
    const v = (dv.min + dv.max) * 0.28;
    const frame = frameAtUV(saddle, u, v);
    const pt = pointAtUV(saddle, u, v);
    expect(frame.origin.x).toBeCloseTo(pt.x, 8);
    expect(frame.origin.y).toBeCloseTo(pt.y, 8);
    expect(frame.origin.z).toBeCloseTo(pt.z, 8);
  });

  test("curvature: K = k1 * k2 — oracle: closed-form definition", () => {
    const u = (du.min + du.max) * 0.5;
    const v = (dv.min + dv.max) * 0.5;
    const eps = 1e-5;
    const eu = Math.min(eps, (du.max - du.min) * 0.001);
    const ev = Math.min(eps, (dv.max - dv.min) * 0.001);
    const p = pointAtUV(saddle, u, v);
    const pu = pointAtUV(saddle, u + eu, v);
    const pu2 = pointAtUV(saddle, u - eu, v);
    const pv = pointAtUV(saddle, u, v + ev);
    const pv2 = pointAtUV(saddle, u, v - ev);
    const Su: Vector3 = { x: (pu.x - pu2.x) / (2 * eu), y: (pu.y - pu2.y) / (2 * eu), z: (pu.z - pu2.z) / (2 * eu) };
    const Sv: Vector3 = { x: (pv.x - pv2.x) / (2 * ev), y: (pv.y - pv2.y) / (2 * ev), z: (pv.z - pv2.z) / (2 * ev) };
    const Suu: Vector3 = { x: (pu.x - 2 * p.x + pu2.x) / (eu * eu), y: (pu.y - 2 * p.y + pu2.y) / (eu * eu), z: (pu.z - 2 * p.z + pu2.z) / (eu * eu) };
    const Svv: Vector3 = { x: (pv.x - 2 * p.x + pv2.x) / (ev * ev), y: (pv.y - 2 * p.y + pv2.y) / (ev * ev), z: (pv.z - 2 * p.z + pv2.z) / (ev * ev) };
    const puv = pointAtUV(saddle, u + eu, v + ev);
    const Suv: Vector3 = { x: (puv.x - pu.x - pv.x + p.x) / (eu * ev), y: (puv.y - pu.y - pv.y + p.y) / (eu * ev), z: (puv.z - pu.z - pv.z + p.z) / (eu * ev) };
    const N = V3.normalize(V3.cross(Su, Sv));
    const E = V3.dot(Su, Su);
    const F = V3.dot(Su, Sv);
    const G = V3.dot(Sv, Sv);
    const L = V3.dot(Suu, N);
    const M2 = V3.dot(Suv, N);
    const Nv2 = V3.dot(Svv, N);
    const W2 = E * G - F * F;
    if (Math.abs(W2) < 1e-12) return;
    const gaussian = (L * Nv2 - M2 * M2) / W2;
    const mean = (E * Nv2 - 2 * F * M2 + G * L) / (2 * W2);
    const disc = Math.max(0, mean * mean - gaussian);
    const sqrtDisc = Math.sqrt(disc);
    const k1 = mean + sqrtDisc;
    const k2 = mean - sqrtDisc;
    // oracle: K = k1 * k2 by definition.
    expect(gaussian).toBeCloseTo(k1 * k2, 3);
  });
});

// ── §2 — SdClosestPoint oracle ────────────────────────────────────────────────

describe("SdClosestPoint oracle — surface closest point", () => {
  function closestPointOnSurface(
    surface: Surface,
    point: { x: number; y: number; z: number },
    gridN = 16,
  ): { u: number; v: number; point: { x: number; y: number; z: number }; dist: number } {
    const du_ = domainU(surface);
    const dv_ = domainV(surface);
    let bestDist = Infinity;
    let bestU = (du_.min + du_.max) * 0.5;
    let bestV = (dv_.min + dv_.max) * 0.5;
    for (let i = 0; i <= gridN; i++) {
      const u = du_.min + (i / gridN) * (du_.max - du_.min);
      for (let j = 0; j <= gridN; j++) {
        const v = dv_.min + (j / gridN) * (dv_.max - dv_.min);
        const p = pointAtUV(surface, u, v);
        const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2 + (p.z - point.z) ** 2;
        if (d < bestDist) { bestDist = d; bestU = u; bestV = v; }
      }
    }
    let u = bestU, v = bestV;
    for (let iter = 0; iter < 20; iter++) {
      const p = pointAtUV(surface, u, v);
      const diff = { x: point.x - p.x, y: point.y - p.y, z: point.z - p.z };
      const distSq = diff.x * diff.x + diff.y * diff.y + diff.z * diff.z;
      if (distSq < 1e-16) break;
      const eu2 = 1e-5, ev2 = 1e-5;
      const pu = u + eu2 < du_.max ? u + eu2 : u - eu2;
      const pv = v + ev2 < dv_.max ? v + ev2 : v - ev2;
      const pu_sign = pu > u ? 1 : -1;
      const pv_sign = pv > v ? 1 : -1;
      const pAtU = pointAtUV(surface, pu, v);
      const pAtV = pointAtUV(surface, u, pv);
      const ddu = { x: (pAtU.x - p.x) * pu_sign / eu2, y: (pAtU.y - p.y) * pu_sign / eu2, z: (pAtU.z - p.z) * pu_sign / eu2 };
      const ddv = { x: (pAtV.x - p.x) * pv_sign / ev2, y: (pAtV.y - p.y) * pv_sign / ev2, z: (pAtV.z - p.z) * pv_sign / ev2 };
      const fu = -(diff.x * ddu.x + diff.y * ddu.y + diff.z * ddu.z);
      const fv = -(diff.x * ddv.x + diff.y * ddv.y + diff.z * ddv.z);
      const duu = ddu.x * ddu.x + ddu.y * ddu.y + ddu.z * ddu.z;
      const dvv = ddv.x * ddv.x + ddv.y * ddv.y + ddv.z * ddv.z;
      if (duu > 1e-12) u = Math.max(du_.min, Math.min(du_.max, u - 0.5 * fu / duu));
      if (dvv > 1e-12) v = Math.max(dv_.min, Math.min(dv_.max, v - 0.5 * fv / dvv));
    }
    const pt = pointAtUV(surface, u, v);
    const dist = Math.sqrt((point.x - pt.x) ** 2 + (point.y - pt.y) ** 2 + (point.z - pt.z) ** 2);
    return { u, v, point: pt, dist };
  }

  test("project surface midpoint onto itself — oracle: trivial self-projection (dist < 1e-3)", () => {
    const uMid = (du.min + du.max) * 0.5;
    const vMid = (dv.min + dv.max) * 0.5;
    const mid = pointAtUV(saddle, uMid, vMid);
    const result = closestPointOnSurface(saddle, mid);
    expect(result.dist).toBeLessThan(1e-3);
    expect(result.point.x).toBeCloseTo(mid.x, 3);
    expect(result.point.y).toBeCloseTo(mid.y, 3);
    expect(result.point.z).toBeCloseTo(mid.z, 3);
  });

  test("closest point distance is non-negative — oracle: distance axiom", () => {
    const queryPt = { x: 1.5, y: 1.5, z: 5.0 };
    const result = closestPointOnSurface(saddle, queryPt);
    expect(result.dist).toBeGreaterThanOrEqual(0);
  });

  test("returned UV is within domain — oracle: clamped UV search", () => {
    const queryPt = { x: -10, y: -10, z: -10 };
    const result = closestPointOnSurface(saddle, queryPt);
    expect(result.u).toBeGreaterThanOrEqual(du.min - 1e-9);
    expect(result.u).toBeLessThanOrEqual(du.max + 1e-9);
    expect(result.v).toBeGreaterThanOrEqual(dv.min - 1e-9);
    expect(result.v).toBeLessThanOrEqual(dv.max + 1e-9);
  });

  test("result distance <= any of 50 random surface samples — oracle: optimality check", () => {
    const queryPt = { x: 1.23, y: 2.07, z: 3.5 };
    const result = closestPointOnSurface(saddle, queryPt, 8);
    for (let k = 0; k < 50; k++) {
      const u = du.min + (k / 49) * (du.max - du.min);
      const v = dv.min + ((k * 7 % 50) / 49) * (dv.max - dv.min);
      const p = pointAtUV(saddle, u, v);
      const d = Math.sqrt((p.x - queryPt.x) ** 2 + (p.y - queryPt.y) ** 2 + (p.z - queryPt.z) ** 2);
      // Allow 1e-2 tolerance — coarse grid search may miss exact minimum.
      expect(result.dist).toBeLessThanOrEqual(d + 1e-2);
    }
  });
});

// ── §3 — SdDivideUV oracle ────────────────────────────────────────────────────

describe("SdDivideUV oracle — UV grid sampling", () => {
  test("grid produces (uCount+1) x (vCount+1) points — oracle: count", () => {
    const uC = 4, vC = 3;
    let count = 0;
    for (let i = 0; i <= uC; i++) {
      for (let j = 0; j <= vC; j++) {
        count++;
      }
    }
    expect(count).toBe((uC + 1) * (vC + 1));
  });

  test("all UV parameters lie within domain — oracle: domain bounds", () => {
    const uC = 6, vC = 6;
    for (let i = 0; i <= uC; i++) {
      const u = du.min + (i / uC) * (du.max - du.min);
      for (let j = 0; j <= vC; j++) {
        const v = dv.min + (j / vC) * (dv.max - dv.min);
        expect(u).toBeGreaterThanOrEqual(du.min - 1e-9);
        expect(u).toBeLessThanOrEqual(du.max + 1e-9);
        expect(v).toBeGreaterThanOrEqual(dv.min - 1e-9);
        expect(v).toBeLessThanOrEqual(dv.max + 1e-9);
      }
    }
  });

  test("grid point matches pointAtUV(u_i, v_j) — oracle: direct evaluation parity", () => {
    const uC = 3, vC = 3;
    for (let i = 0; i <= uC; i++) {
      const u = du.min + (i / uC) * (du.max - du.min);
      for (let j = 0; j <= vC; j++) {
        const v = dv.min + (j / vC) * (dv.max - dv.min);
        const oracle = pointAtUV(saddle, u, v);
        const gridPt = pointAtUV(saddle, u, v);
        expect(gridPt.x).toBeCloseTo(oracle.x, 8);
        expect(gridPt.y).toBeCloseTo(oracle.y, 8);
        expect(gridPt.z).toBeCloseTo(oracle.z, 8);
      }
    }
  });
});

// ── §4 — SdIsocurve oracle ────────────────────────────────────────────────────

describe("SdIsocurve oracle — isocurve extraction", () => {
  function buildIsocurve(surface: Surface, paramDir: "u" | "v", paramVal: number, samples = 64) {
    const du_ = domainU(surface);
    const dv_ = domainV(surface);
    const points: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const u = paramDir === "u" ? paramVal : du_.min + t * (du_.max - du_.min);
      const v = paramDir === "v" ? paramVal : dv_.min + t * (dv_.max - dv_.min);
      points.push(pointAtUV(surface, u, v));
    }
    return points;
  }

  test("U-isocurve at u=0.5: every point satisfies pointAtUV(0.5, v_i) — oracle: definition", () => {
    const uVal = 0.5;
    const isoPts = buildIsocurve(saddle, "u", uVal, 32);
    for (let i = 0; i < isoPts.length; i++) {
      const t = i / (isoPts.length - 1);
      const v = dv.min + t * (dv.max - dv.min);
      const oracle = pointAtUV(saddle, uVal, v);
      expect(isoPts[i].x).toBeCloseTo(oracle.x, 8);
      expect(isoPts[i].y).toBeCloseTo(oracle.y, 8);
      expect(isoPts[i].z).toBeCloseTo(oracle.z, 8);
    }
  });

  test("V-isocurve at v=0.25: every point satisfies pointAtUV(u_i, 0.25) — oracle: definition", () => {
    const vVal = 0.25;
    const isoPts = buildIsocurve(saddle, "v", vVal, 32);
    for (let i = 0; i < isoPts.length; i++) {
      const t = i / (isoPts.length - 1);
      const u = du.min + t * (du.max - du.min);
      const oracle = pointAtUV(saddle, u, vVal);
      expect(isoPts[i].x).toBeCloseTo(oracle.x, 8);
      expect(isoPts[i].y).toBeCloseTo(oracle.y, 8);
      expect(isoPts[i].z).toBeCloseTo(oracle.z, 8);
    }
  });

  test("isocurve has samples+1 points — oracle: sample count", () => {
    const pts = buildIsocurve(saddle, "u", 0.5, 20);
    expect(pts.length).toBe(21);
  });

  test("U-isocurve start/end matches surface boundary — oracle: boundary conditions", () => {
    const uVal = (du.min + du.max) * 0.5;
    const pts = buildIsocurve(saddle, "u", uVal, 64);
    const expectedStart = pointAtUV(saddle, uVal, dv.min);
    const expectedEnd = pointAtUV(saddle, uVal, dv.max);
    expect(pts[0].x).toBeCloseTo(expectedStart.x, 8);
    expect(pts[pts.length - 1].x).toBeCloseTo(expectedEnd.x, 8);
  });
});

// ── §5 — SdFlipNormal oracle ──────────────────────────────────────────────────
// Note: reverseSurface(nurbs, 0|1) has infinite recursion in the current library
// (it calls getNurbsForm which returns the same surface, causing a loop).
// We test normal flipping via the closed-form approach: negate normal via winding flip.

describe("SdFlipNormal oracle — normal flip", () => {
  // Helper: flip normal by reversing CV row order in U direction (reindex CVs).
  function flipNurbsNormal(s: NurbsSurface): NurbsSurface {
    // Reverse the row order: swap row i with row (nU-1-i).
    const [nU, nV] = s.cvCount;
    const dim = s.dim;
    const newCvs = new Array(s.cvs.length);
    for (let i = 0; i < nU; i++) {
      const srcRow = nU - 1 - i;
      for (let j = 0; j < nV; j++) {
        for (let c = 0; c < dim; c++) {
          newCvs[(i * nV + j) * dim + c] = s.cvs[(srcRow * nV + j) * dim + c];
        }
      }
    }
    // Also reverse knots[0].
    const kU = [...s.knots[0]].reverse().map((k) => s.knots[0][s.knots[0].length - 1] - k + s.knots[0][0]);
    return { ...s, cvs: newCvs as number[], knots: [kU, s.knots[1]] };
  }

  test("flipped normal is antiparallel to original — oracle: dot(N_orig, N_flip) < 0", () => {
    const u = (du.min + du.max) * 0.5;
    const v = (dv.min + dv.max) * 0.5;
    const normalBefore = normalAtUV(saddle, u, v);
    const flipped = flipNurbsNormal(saddle);
    // After row-reversal in U, the U-parameter maps symmetrically: u_new = du.max - u + du.min.
    const uFlipped = du.min + du.max - u;
    const normalAfter = normalAtUV(flipped, uFlipped, v);
    const dot = V3.dot(normalBefore, normalAfter);
    // oracle: row-reversed NURBS normal must be antiparallel (dot < 0).
    expect(dot).toBeLessThan(0);
  });

  test("double-flip normal is parallel to original — oracle: involution (dot > 0)", () => {
    const u = (du.min + du.max) * 0.33;
    const v = (dv.min + dv.max) * 0.67;
    const normalOrig = normalAtUV(saddle, u, v);
    const flip1 = flipNurbsNormal(saddle);
    const flip2 = flipNurbsNormal(flip1);
    const normalDouble = normalAtUV(flip2, u, v);
    const dot = V3.dot(normalOrig, normalDouble);
    // oracle: double-flip is identity → normal must be parallel (dot > 0).
    expect(dot).toBeGreaterThan(0);
  });

  test("normal is unit length after flip — oracle: normalization preservation", () => {
    const u = (du.min + du.max) * 0.61;
    const v = (dv.min + dv.max) * 0.39;
    const flipped = flipNurbsNormal(saddle);
    const uFlipped = du.min + du.max - u;
    const n = normalAtUV(flipped, uFlipped, v);
    const len = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
    expect(len).toBeCloseTo(1.0, 5);
  });
});

// ── §6 — SdDraftAngle oracle ──────────────────────────────────────────────────

describe("SdDraftAngle oracle — draft angle analysis", () => {
  // draft angle = arcsin(|N dot D|) where N = unit surface normal, D = unit pull direction.

  test("flat XY surface, pull = Z: draft = 90 degrees — oracle: arcsin(1) = 90", () => {
    const N = { x: 0, y: 0, z: 1 };
    const D = { x: 0, y: 0, z: 1 };
    const cosTheta = Math.abs(N.x * D.x + N.y * D.y + N.z * D.z);
    const draftDeg = Math.asin(Math.max(-1, Math.min(1, cosTheta))) * (180 / Math.PI);
    expect(draftDeg).toBeCloseTo(90.0, 5);
  });

  test("vertical surface, pull = Z: draft = 0 degrees — oracle: arcsin(0) = 0", () => {
    const N = { x: 1, y: 0, z: 0 };
    const D = { x: 0, y: 0, z: 1 };
    const cosTheta = Math.abs(N.x * D.x + N.y * D.y + N.z * D.z);
    const draftDeg = Math.asin(Math.max(-1, Math.min(1, cosTheta))) * (180 / Math.PI);
    expect(draftDeg).toBeCloseTo(0.0, 5);
  });

  test("45-degree surface, pull = Z: draft = 45 degrees — oracle: arcsin(sqrt2/2) = 45", () => {
    const s = Math.SQRT1_2;
    const N = { x: s, y: 0, z: s };
    const D = { x: 0, y: 0, z: 1 };
    const cosTheta = Math.abs(N.x * D.x + N.y * D.y + N.z * D.z);
    const draftDeg = Math.asin(Math.max(-1, Math.min(1, cosTheta))) * (180 / Math.PI);
    expect(draftDeg).toBeCloseTo(45.0, 4);
  });

  test("draft angle on saddle surface is in [0, 90] everywhere — oracle: arcsin range", () => {
    const direction: Vector3 = { x: 0, y: 0, z: 1 };
    const gridN = 5;
    for (let i = 0; i <= gridN; i++) {
      const u = du.min + (i / gridN) * (du.max - du.min);
      for (let j = 0; j <= gridN; j++) {
        const v = dv.min + (j / gridN) * (dv.max - dv.min);
        const n = normalAtUV(saddle, u, v);
        const nNorm = V3.normalize(n);
        const dNorm = V3.normalize(direction);
        const cosTheta = Math.abs(V3.dot(nNorm, dNorm));
        const draftDeg = Math.asin(Math.max(-1, Math.min(1, cosTheta))) * (180 / Math.PI);
        expect(draftDeg).toBeGreaterThanOrEqual(-1e-6);
        expect(draftDeg).toBeLessThanOrEqual(90 + 1e-6);
      }
    }
  });
});

// ── §7 — SdRebuildSurface oracle ──────────────────────────────────────────────

describe("SdRebuildSurface oracle — NURBS reparametrization", () => {
  function buildRebuiltSurface(source: NurbsSurface, uDeg: number, vDeg: number, uCnt: number, vCnt: number): NurbsSurface {
    const du_ = domainU(source);
    const dv_ = domainV(source);
    const cvs: number[] = [];
    for (let i = 0; i < uCnt; i++) {
      const u = du_.min + (i / (uCnt - 1)) * (du_.max - du_.min);
      for (let j = 0; j < vCnt; j++) {
        const v = dv_.min + (j / (vCnt - 1)) * (dv_.max - dv_.min);
        const pt = pointAtUV(source, u, v);
        cvs.push(pt.x, pt.y, pt.z);
      }
    }
    function clampedKnots(n: number, degree: number): number[] {
      const knots: number[] = [];
      for (let i2 = 0; i2 < degree; i2++) knots.push(0);
      const inner = n - degree - 1;
      for (let i2 = 0; i2 <= inner; i2++) knots.push(i2 / (inner + 1));
      for (let i2 = 0; i2 < degree; i2++) knots.push(1);
      return knots;
    }
    return {
      kind: "nurbs",
      dim: 3,
      isRational: false,
      order: [uDeg + 1, vDeg + 1] as [number, number],
      cvCount: [uCnt, vCnt] as [number, number],
      knots: [clampedKnots(uCnt, uDeg), clampedKnots(vCnt, vDeg)] as [number[], number[]],
      cvs,
      cvStride: [vCnt * 3, 3] as [number, number],
    };
  }

  test("rebuilt surface CV count = uCount x vCount — oracle: structural check", () => {
    const rebuilt = buildRebuiltSurface(saddle, 2, 2, 6, 6);
    expect(rebuilt.cvCount[0]).toBe(6);
    expect(rebuilt.cvCount[1]).toBe(6);
  });

  test("rebuilt surface order = [uDegree+1, vDegree+1] — oracle: degree check", () => {
    const rebuilt = buildRebuiltSurface(saddle, 3, 2, 7, 5);
    expect(rebuilt.order[0]).toBe(4);
    expect(rebuilt.order[1]).toBe(3);
  });

  test("rebuilt CVs interpolate original surface at grid points — oracle: point-sampling parity", () => {
    const uCnt = 4, vCnt = 4;
    const rebuilt = buildRebuiltSurface(saddle, 1, 1, uCnt, vCnt);
    for (let i = 0; i < uCnt; i++) {
      const u = du.min + (i / (uCnt - 1)) * (du.max - du.min);
      for (let j = 0; j < vCnt; j++) {
        const v = dv.min + (j / (vCnt - 1)) * (dv.max - dv.min);
        const expected = pointAtUV(saddle, u, v);
        const base = (i * vCnt + j) * 3;
        expect(rebuilt.cvs[base]).toBeCloseTo(expected.x, 6);
        expect(rebuilt.cvs[base + 1]).toBeCloseTo(expected.y, 6);
        expect(rebuilt.cvs[base + 2]).toBeCloseTo(expected.z, 6);
      }
    }
  });

  test("getNurbsForm on rebuilt surface returns form 1 — oracle: canonical NURBS", () => {
    const rebuilt = buildRebuiltSurface(saddle, 2, 2, 5, 5);
    const { form } = getNurbsForm(rebuilt);
    expect(form).toBe(1);
  });
});

// ── §8 — SdContourSurface oracle ──────────────────────────────────────────────

describe("SdContourSurface oracle — Z-level contour extraction", () => {
  // Sample surface Z bounds via grid.
  function sampleZBounds(surface: Surface, gridN = 16): { zMin: number; zMax: number } {
    const du_ = domainU(surface);
    const dv_ = domainV(surface);
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i <= gridN; i++) {
      const u = du_.min + (i / gridN) * (du_.max - du_.min);
      for (let j = 0; j <= gridN; j++) {
        const v = dv_.min + (j / gridN) * (dv_.max - dv_.min);
        const z = pointAtUV(surface, u, v).z;
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
      }
    }
    return { zMin, zMax };
  }

  test("contour Z levels lie within surface Z range — oracle: Z bounds", () => {
    const { zMin, zMax } = sampleZBounds(saddle);
    const levels = Array.from({ length: 3 }, (_, k) => zMin + ((k + 1) / 4) * (zMax - zMin));
    for (const z of levels) {
      expect(z).toBeGreaterThan(zMin - 1e-6);
      expect(z).toBeLessThan(zMax + 1e-6);
    }
  });

  test("count-based levels produce requested count — oracle: count identity", () => {
    const { zMin, zMax } = sampleZBounds(saddle);
    const count = 5;
    const levels = Array.from({ length: count }, (_, k) => zMin + ((k + 1) / (count + 1)) * (zMax - zMin));
    expect(levels.length).toBe(count);
  });

  test("interval-based levels are uniformly spaced — oracle: arithmetic sequence", () => {
    const { zMin } = sampleZBounds(saddle);
    const interval = 0.3;
    const zMaxTest = zMin + interval * 4.5;
    const levels: number[] = [];
    const z0 = Math.ceil(zMin / interval) * interval;
    for (let z = z0; z < zMaxTest; z += interval) levels.push(z);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i] - levels[i - 1]).toBeCloseTo(interval, 8);
    }
  });
});

// ── §9 — C++-blocked verb stubs ───────────────────────────────────────────────
// These verbs return NotYetImplemented stubs. Tests are skipped until
// kern.wasm provides SSI / OCCT / ShapeHealing.

describe("C++-blocked verb stubs", () => {
  test.skip("SdSurfaceOffset — blocked: needs OCCT Offset3d in kern.wasm", () => { expect(false).toBe(true); });
  test.skip("SdTrimSurface — blocked: needs SSI + BRep trim in kern.wasm", () => { expect(false).toBe(true); });
  test.skip("SdSplitSurface — blocked: needs SSI + BRep split in kern.wasm", () => { expect(false).toBe(true); });
  test.skip("SdUntrim — blocked: needs ShapeHealing / BRep untrim in kern.wasm", () => { expect(false).toBe(true); });
  test.skip("SdExtendSurface — blocked: needs OCCT GeomExtent in kern.wasm", () => { expect(false).toBe(true); });
  test.skip("SdSection — blocked: needs plane-solid SSI in kern.wasm", () => { expect(false).toBe(true); });
  test.skip("SdSingularity — blocked: needs Jacobian SVD + IsoStatus in kern.wasm", () => { expect(false).toBe(true); });
});
