// ssi.ts — Surface-Surface Intersection (SSI) kernel.
//
// Algorithm: Patrikalakis & Maekawa, "Shape Interrogation for Computer Aided
// Design and Manufacturing" §7 (SSI). Clean-room paraphrase — no copyrightable
// source reproduced.
//
// Three stages:
//   1. Seed finding: recursive bounding-box subdivision of both surfaces until
//      the sub-patch bounding boxes are smaller than the subdivision tolerance.
//      Overlapping leaf pairs yield seed candidates refined by Newton-Raphson.
//   2. Marching: from each seed, march along the intersection curve using the
//      cross-product of surface normals as the curve tangent. Closed curve
//      detection via start-point proximity test.
//   3. Output: IntersectionCurve[] — 3D polyline samples + paired parameter
//      coordinates on each surface.
//
// Refs:
//   - Patrikalakis & Maekawa §7.2 (subdivision), §7.3 (marching)
//   - openNURBS ON_RayShootBVH (subdivision tree shape)
//   - OCCT IntTools_FaceFace.hxx:48-53 (Newton refinement tolerance model)

import {
  type Point3, type Vector3,
  Point3 as Pt3, Vector3 as V3,
} from "./nurbs-primitives";
import {
  type Surface,
  pointAtUV, normalAtUV, domainU, domainV,
} from "./nurbs-surfaces";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * One connected intersection curve between two surfaces.
 * `pts3d` is a 3D polyline; `params` gives the paired (u,v) coordinates on
 * each surface at each sample. Both arrays have the same length.
 */
export type IntersectionCurve = {
  /** 3D samples along the intersection curve, in march order. */
  pts3d: Point3[];
  /** Paired parameter coords: params[i].s0 = {u,v} on surface A at pts3d[i]. */
  params: { s0: { u: number; v: number }; s1: { u: number; v: number } }[];
  /** True if the curve is closed (last point ≈ first point). */
  closed: boolean;
};

export type SsiOptions = {
  /**
   * Geometric tolerance for seed finding and marching convergence (metres).
   * Default: 1e-4 — looser than BREP_DEFAULT_TOLERANCE for practical SSI
   * performance. Tighten to 1e-6 for export-grade precision.
   */
  tolerance?: number;
  /**
   * Marching step size in model units. Default: 0.05.
   * Smaller = more accurate curve, more samples. Larger = faster, coarser.
   */
  marchStep?: number;
  /**
   * Maximum number of marching steps per curve (safety cap). Default: 5000.
   */
  maxMarchSteps?: number;
  /**
   * Subdivision depth cap for seed finding. Default: 6 (2^6 = 64 sub-patches
   * per surface axis).
   */
  maxSubdivDepth?: number;
};

/**
 * Compute all intersection curves between surfaces `a` and `b`.
 * Returns an empty array when the surfaces are disjoint or only tangent.
 */
export function ssi(
  a: Surface,
  b: Surface,
  options: SsiOptions = {},
): IntersectionCurve[] {
  const tol        = options.tolerance      ?? 1e-4;
  const marchStep  = options.marchStep      ?? 0.05;
  const maxSteps   = options.maxMarchSteps  ?? 5000;
  const maxDepth   = options.maxSubdivDepth ?? 6;

  // Stage 1 — collect seeds
  const seeds = _findSeeds(a, b, tol, maxDepth);
  if (seeds.length === 0) return [];

  // Stage 2 — march from each seed; de-duplicate
  const curves: IntersectionCurve[] = [];
  const visited = new Set<string>();

  for (const seed of seeds) {
    const key = _paramKey(seed.u0, seed.v0, seed.u1, seed.v1, tol);
    if (visited.has(key)) continue;

    const curve = _marchCurve(a, b, seed, tol, marchStep, maxSteps);
    if (curve.pts3d.length < 2) continue;

    // Mark all samples as visited
    for (const p of curve.params) {
      visited.add(_paramKey(p.s0.u, p.s0.v, p.s1.u, p.s1.v, tol));
    }
    curves.push(curve);
  }

  return curves;
}

// ── Stage 1: Seed finding via bounding-box subdivision ───────────────────────

type Seed = { u0: number; v0: number; u1: number; v1: number; pt: Point3 };

/**
 * Recursively subdivide the parameter domains of both surfaces. When the
 * bounding boxes of two sub-patches overlap within `tol`, try Newton-Raphson
 * to find the exact intersection point.
 */
function _findSeeds(
  a: Surface,
  b: Surface,
  tol: number,
  maxDepth: number,
): Seed[] {
  const domA0 = domainU(a), domA1 = domainV(a);
  const domB0 = domainU(b), domB1 = domainV(b);

  const seeds: Seed[] = [];

  function subdivide(
    ua0: number, ua1: number, va0: number, va1: number,
    ub0: number, ub1: number, vb0: number, vb1: number,
    depth: number,
  ): void {
    // Sample bounding boxes of each sub-patch
    const bbA = _patchBBox(a, ua0, ua1, va0, va1);
    const bbB = _patchBBox(b, ub0, ub1, vb0, vb1);
    if (!_bboxOverlap(bbA, bbB, tol)) return;

    if (depth >= maxDepth) {
      // Leaf: attempt Newton refinement from centres
      const umA = (ua0 + ua1) / 2, vmA = (va0 + va1) / 2;
      const umB = (ub0 + ub1) / 2, vmB = (vb0 + vb1) / 2;
      const refined = _newtonRefine(a, b, umA, vmA, umB, vmB, tol);
      if (refined) seeds.push(refined);
      return;
    }

    // Subdivide the larger patch first (balanced strategy)
    const areaA = (ua1 - ua0) * (va1 - va0);
    const areaB = (ub1 - ub0) * (vb1 - vb0);
    const umA = (ua0 + ua1) / 2, vmA = (va0 + va1) / 2;
    const umB = (ub0 + ub1) / 2, vmB = (vb0 + vb1) / 2;

    if (areaA >= areaB) {
      // Subdivide A into 4 quadrants
      for (const [ua, ub] of [[ua0, umA], [umA, ua1]] as [number,number][]) {
        for (const [va, vb] of [[va0, vmA], [vmA, va1]] as [number,number][]) {
          subdivide(ua, ub, va, vb, ub0, ub1, vb0, vb1, depth + 1);
        }
      }
    } else {
      // Subdivide B into 4 quadrants
      for (const [ua, ub] of [[ub0, umB], [umB, ub1]] as [number,number][]) {
        for (const [va, vb] of [[vb0, vmB], [vmB, vb1]] as [number,number][]) {
          subdivide(ua0, ua1, va0, va1, ua, ub, va, vb, depth + 1);
        }
      }
    }
  }

  subdivide(
    domA0.min, domA0.max, domA1.min, domA1.max,
    domB0.min, domB0.max, domB1.min, domB1.max,
    0,
  );

  // Deduplicate seeds by distance
  return _deduplicateSeeds(seeds, tol);
}

/** Sample a regular grid over a sub-patch and return its axis-aligned bbox. */
function _patchBBox(
  s: Surface,
  u0: number, u1: number, v0: number, v1: number,
  N = 3,
): { min: Point3; max: Point3 } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < N; i++) {
    const u = u0 + (i / (N - 1)) * (u1 - u0);
    for (let j = 0; j < N; j++) {
      const v = v0 + (j / (N - 1)) * (v1 - v0);
      const p = pointAtUV(s, u, v);
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
  }
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

function _bboxOverlap(
  a: { min: Point3; max: Point3 },
  b: { min: Point3; max: Point3 },
  tol: number,
): boolean {
  return (
    a.min.x - tol <= b.max.x && a.max.x + tol >= b.min.x &&
    a.min.y - tol <= b.max.y && a.max.y + tol >= b.min.y &&
    a.min.z - tol <= b.max.z && a.max.z + tol >= b.min.z
  );
}

/**
 * Newton-Raphson refinement of a seed point.
 * Solves the 3-equation system: S0(u0,v0) - S1(u1,v1) = 0 for (u0,v0,u1,v1).
 * (Under-determined in 4 unknowns — we fix a local frame and solve the 3D residual.)
 *
 * Simplified approach: find (u0,v0) on S0 closest to S1(u1,v1) and vice versa,
 * alternating until convergence. This is the alternating projection method
 * (Piegl & Tiller §11.2 "closest point on surface").
 */
function _newtonRefine(
  a: Surface,
  b: Surface,
  u0: number, v0: number,
  u1: number, v1: number,
  tol: number,
): Seed | null {
  const domA0 = domainU(a), domA1 = domainV(a);
  const domB0 = domainU(b), domB1 = domainV(b);
  const MAX_ITER = 20;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const pA = pointAtUV(a, u0, v0);
    const pB = pointAtUV(b, u1, v1);
    const dist = Pt3.distance(pA, pB);
    if (dist <= tol) {
      const pt = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2, z: (pA.z + pB.z) / 2 };
      return { u0, v0, u1, v1, pt };
    }

    // Move (u1,v1) toward pA: project pA onto surface B in parameter space
    const [nu1, nv1] = _projectPointOnSurface(b, pA, u1, v1, domB0, domB1, tol);
    // Move (u0,v0) toward new B point: project onto surface A
    const pB2 = pointAtUV(b, nu1, nv1);
    const [nu0, nv0] = _projectPointOnSurface(a, pB2, u0, v0, domA0, domA1, tol);

    u0 = nu0; v0 = nv0; u1 = nu1; v1 = nv1;
  }

  // Check convergence after MAX_ITER
  const pA = pointAtUV(a, u0, v0);
  const pB = pointAtUV(b, u1, v1);
  if (Pt3.distance(pA, pB) <= tol * 10) {
    const pt = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2, z: (pA.z + pB.z) / 2 };
    return { u0, v0, u1, v1, pt };
  }
  return null;
}

/**
 * Project `target` onto surface `s` starting from (u, v).
 * Uses finite-difference gradient descent in parameter space.
 */
function _projectPointOnSurface(
  s: Surface,
  target: Point3,
  u: number, v: number,
  domU: { min: number; max: number },
  domV: { min: number; max: number },
  tol: number,
): [number, number] {
  // Gauss-Newton step: Δu = dot(err, ∂S/∂u) / |∂S/∂u|²
  // where ∂S/∂u ≈ (S(u+eps,v) - S(u,v)) / eps → eps cancels: Δu = dot(err, du) * eps / duu
  const eps = Math.min(domU.max - domU.min, domV.max - domV.min) * 1e-4;
  const MAX_ITER = 20;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const p  = pointAtUV(s, u, v);
    const pu = pointAtUV(s, Math.min(domU.max, u + eps), v);
    const pv = pointAtUV(s, u, Math.min(domV.max, v + eps));

    const du = V3.sub(pu as Vector3, p as Vector3);
    const dv = V3.sub(pv as Vector3, p as Vector3);
    const err = V3.sub(target as Vector3, p as Vector3);

    const errLen = V3.length(err as Vector3);
    if (errLen < tol * 0.1) break;

    const duu = V3.dot(du, du), dvv = V3.dot(dv, dv);
    if (duu < 1e-30 && dvv < 1e-30) break;

    // Gauss-Newton: Δu = dot(err, du/eps) / |du/eps|² = dot(err, du) * eps / duu
    const dtu = duu > 1e-30 ? V3.dot(err, du) * eps / duu : 0;
    const dtv = dvv > 1e-30 ? V3.dot(err, dv) * eps / dvv : 0;

    u = Math.max(domU.min, Math.min(domU.max, u + dtu));
    v = Math.max(domV.min, Math.min(domV.max, v + dtv));
  }

  return [u, v];
}

function _deduplicateSeeds(seeds: Seed[], tol: number): Seed[] {
  const out: Seed[] = [];
  for (const s of seeds) {
    if (!out.some(o => Pt3.distance(o.pt, s.pt) < tol * 5)) out.push(s);
  }
  return out;
}

// ── Stage 2: Marching ─────────────────────────────────────────────────────────

/**
 * March along the intersection curve starting from `seed`.
 * The march direction is the cross-product of the surface normals at the
 * current point (= tangent to the intersection curve, Patrikalakis §7.3).
 * We march in both directions (±tangent) to capture the full curve.
 */
function _marchCurve(
  a: Surface,
  b: Surface,
  seed: Seed,
  tol: number,
  step: number,
  maxSteps: number,
): IntersectionCurve {
  const fwd  = _marchHalf(a, b, seed, tol, step, maxSteps,  1);
  const bwd  = _marchHalf(a, b, seed, tol, step, maxSteps, -1);

  // Combine: reverse backward, drop duplicate seed
  const pts3d = [...bwd.pts3d.slice().reverse(), ...fwd.pts3d.slice(1)];
  const params = [...bwd.params.slice().reverse(), ...fwd.params.slice(1)];

  // Closed detection: start and end 3D points within 2× step
  const closed = pts3d.length >= 3 &&
    Pt3.distance(pts3d[0], pts3d[pts3d.length - 1]) < step * 2;

  return { pts3d, params, closed };
}

function _marchHalf(
  a: Surface,
  b: Surface,
  seed: Seed,
  tol: number,
  step: number,
  maxSteps: number,
  dir: 1 | -1,
): { pts3d: Point3[]; params: { s0: { u: number; v: number }; s1: { u: number; v: number } }[] } {
  const pts3d: Point3[] = [];
  const params: { s0: { u: number; v: number }; s1: { u: number; v: number } }[] = [];

  let u0 = seed.u0, v0 = seed.v0, u1 = seed.u1, v1 = seed.v1;
  let pt = seed.pt;

  const domA0 = domainU(a), domA1 = domainV(a);
  const domB0 = domainU(b), domB1 = domainV(b);

  pts3d.push(pt);
  params.push({ s0: { u: u0, v: v0 }, s1: { u: u1, v: v1 } });

  for (let i = 0; i < maxSteps; i++) {
    const nA = normalAtUV(a, u0, v0);
    const nB = normalAtUV(b, u1, v1);
    let tangent = V3.cross(nA, nB);
    const tlen = V3.length(tangent);
    if (tlen < 1e-12) break; // surfaces nearly tangent — stop marching
    tangent = V3.scale(tangent, (dir * step) / tlen);

    // Candidate next point
    const nextPt: Point3 = {
      x: pt.x + tangent.x,
      y: pt.y + tangent.y,
      z: pt.z + tangent.z,
    };

    // Project onto surface A, then refine with surface B
    const [nu0, nv0] = _projectPointOnSurface(a, nextPt, u0, v0, domA0, domA1, tol);
    const pA = pointAtUV(a, nu0, nv0);
    const [nu1, nv1] = _projectPointOnSurface(b, pA, u1, v1, domB0, domB1, tol);

    // Check convergence of the projected pair
    const pB = pointAtUV(b, nu1, nv1);
    if (Pt3.distance(pA, pB) > tol * 100) break; // lost track of intersection

    const newPt: Point3 = {
      x: (pA.x + pB.x) / 2,
      y: (pA.y + pB.y) / 2,
      z: (pA.z + pB.z) / 2,
    };

    // Closed-curve detection: new point loops back to start
    if (pts3d.length >= 3 && Pt3.distance(newPt, pts3d[0]) < step * 1.5) break;

    u0 = nu0; v0 = nv0; u1 = nu1; v1 = nv1;
    pt = newPt;
    pts3d.push(pt);
    params.push({ s0: { u: u0, v: v0 }, s1: { u: u1, v: v1 } });
  }

  return { pts3d, params };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _paramKey(u0: number, v0: number, u1: number, v1: number, tol: number): string {
  const q = (x: number) => Math.round(x / (tol * 5));
  return `${q(u0)},${q(v0)},${q(u1)},${q(v1)}`;
}
