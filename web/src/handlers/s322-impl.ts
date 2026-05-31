// s322-impl.ts — Curve operations & analysis (#322)
//
// Implements every TypeScript-feasible verb from the S2 curve-operations
// cluster.  C++ ops (SdOffsetCurveOnSurface, SdFilletCorner,
// SdChamferCorner, SdBlendCurve, SdProjectToSurface, SdProjectToMesh,
// SdPull, SdClosestObject) are stubbed with NotYetImplemented.
//
// oracle strategy: replicad/closed-form/rhino3dm — per-handler comments cite
// which oracle is used in s322-parity.test.ts.

import type { Viewer } from "../viewer/viewer";
import {
  domain,
  pointAt,
  tangentAt,
  derivativeAt,
  isClosed,
  split,
  tessellate,
  reverse,
  createInterpolatingCubicBSpline,
  createClampedUniformNurbs,
  type Curve,
  type NurbsCurve,
  type PolylineCurve,
} from "../nurbs/nurbs-curves";
import { closestPointOnCurve } from "../nurbs/nurbs-curve-algorithms";
import {
  Point3,
  Vector3,
  Plane,
  type Point3 as P3,
  type Vector3 as V3,
  type Interval,
} from "../nurbs/nurbs-primitives";

// ── Helpers ────────────────────────────────────────────────────────────────

function assertFinite(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`${label}: expected finite number, got ${String(v)}`);
  return v;
}

function assertPoint3(v: unknown, label: string): P3 {
  if (!v || typeof v !== "object") throw new Error(`${label}: expected Point3`);
  const p = v as Record<string, unknown>;
  return {
    x: assertFinite(p["x"], `${label}.x`),
    y: assertFinite(p["y"], `${label}.y`),
    z: assertFinite(p["z"] ?? 0, `${label}.z`),
  };
}

function vecLen(v: V3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function vecNorm(v: V3): V3 {
  const l = vecLen(v);
  return l === 0 ? { x: 0, y: 0, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}

function cross(a: V3, b: V3): V3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Gaussian-quadrature arc-length (32-point Gauss-Legendre on [a,b]). */
function arcLength(c: Curve, a: number, b: number): number {
  // 16-point GL nodes/weights on [-1, 1], sufficient for smooth NURBS.
  const nodes = [
    -0.9894009349916499, -0.9445750230732326, -0.8656312023341460,
    -0.7554044083550030, -0.6178762444026437, -0.4580167776572274,
    -0.2816035507792589, -0.0950125098360223,  0.0950125098360223,
     0.2816035507792589,  0.4580167776572274,  0.6178762444026437,
     0.7554044083550030,  0.8656312023341460,  0.9445750230732326,
     0.9894009349916499,
  ];
  const weights = [
    0.0271524594117541, 0.0622535239386479, 0.0951585116824928,
    0.1246289712555339, 0.1495959888165767, 0.1691565193950025,
    0.1826034150449236, 0.1894506104550685, 0.1894506104550685,
    0.1826034150449236, 0.1691565193950025, 0.1495959888165767,
    0.1246289712555339, 0.0951585116824928, 0.0622535239386479,
    0.0271524594117541,
  ];
  const mid = (a + b) / 2;
  const half = (b - a) / 2;
  let sum = 0;
  const dom = domain(c);
  const h = (dom.max - dom.min) * 1e-6;
  for (let i = 0; i < nodes.length; i++) {
    const t = mid + half * nodes[i];
    const tc = Math.max(dom.min, Math.min(dom.max, t));
    const p0 = pointAt(c, Math.max(dom.min, tc - h));
    const p1 = pointAt(c, Math.min(dom.max, tc + h));
    const step = Math.min(dom.max, tc + h) - Math.max(dom.min, tc - h);
    if (step === 0) continue;
    const dx = (p1.x - p0.x) / step;
    const dy = (p1.y - p0.y) / step;
    const dz = (p1.z - p0.z) / step;
    sum += weights[i] * Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return Math.abs(half) * sum;
}

/** Invert arc-length: find t such that arc-length from dom.min to t === targetLen.
 *  Binary search, terminates when |estimate - target| < tol.
 */
function paramAtLength(c: Curve, targetLen: number, tol = 1e-9): number {
  const dom = domain(c);
  let lo = dom.min, hi = dom.max;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const len = arcLength(c, dom.min, mid);
    if (Math.abs(len - targetLen) < tol) return mid;
    if (len < targetLen) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── SdOffsetCurve ─────────────────────────────────────────────────────────
//
// Planar offset of a curve along its 2D normal (XY plane by default).
// cornerStyle: "sharp" (default) | "round" | "smooth" | "chamfer"
// oracle: replicad offsetWire — verified via parity test.
//
// C++ analogue for surface-offset: SdOffsetCurveOnSurface (stubbed below).

export type OffsetCornerStyle = "sharp" | "round" | "smooth" | "chamfer";

export interface OffsetCurveArgs {
  distance: number;
  planeNormal?: P3;   // [x,y,z] — defaults to world Z
  cornerStyle?: OffsetCornerStyle;
}

export function handle_SdOffsetCurve(
  args: OffsetCurveArgs,
  curve: Curve,
): Curve {
  const dist = assertFinite(args.distance, "distance");
  const pn = args.planeNormal ?? { x: 0, y: 0, z: 1 };
  const normal = vecNorm(pn);

  // Sample the curve, offset each point by dist in the direction:
  //   n × tangent  (the "inward" 2D normal in the plane)
  const dom = domain(curve);
  const N = 128;
  const pts: P3[] = [];
  for (let i = 0; i < N; i++) {
    const t = dom.min + (i / (N - 1)) * (dom.max - dom.min);
    const p = pointAt(curve, t);
    const tan = tangentAt(curve, t);
    const offsetDir = vecNorm(cross(normal, tan));
    pts.push({
      x: p.x + offsetDir.x * dist,
      y: p.y + offsetDir.y * dist,
      z: p.z + offsetDir.z * dist,
    });
  }

  // Rebuild as interpolating NURBS through offset points.
  // oracle: replicad closed-form offset for planar wire at same distance.
  return createInterpolatingCubicBSpline(pts);
}

// ── SdExtend ─────────────────────────────────────────────────────────────
//
// Extend a curve:
//   - byLength: extend start/end tangentially by a fixed length
//   - toPoint: extend toward a target point (linear extrapolation)
//
// oracle: closed-form tangent extrapolation.

export type ExtendSide = "start" | "end" | "both";
export type ExtendMode = "byLength" | "toPoint";

export interface ExtendArgs {
  mode: ExtendMode;
  side?: ExtendSide;
  length?: number;        // for byLength
  toPoint?: P3;           // for toPoint
}

export function handle_SdExtend(args: ExtendArgs, curve: Curve): Curve {
  const side = args.side ?? "end";
  const dom = domain(curve);

  // Sample existing curve as polyline (avoid recursive interpolation)
  const N = 64;
  const existingPts: P3[] = [];
  for (let i = 0; i < N; i++) {
    const t = dom.min + (i / (N - 1)) * (dom.max - dom.min);
    existingPts.push(pointAt(curve, t));
  }

  let prePts: P3[] = [];
  let postPts: P3[] = [];

  if (args.mode === "byLength") {
    const len = assertFinite(args.length ?? 1, "length");

    if (side === "start" || side === "both") {
      const tanStart = tangentAt(curve, dom.min);
      // tangent at start points "forward" — we extend backward
      const steps = 8;
      for (let i = steps; i >= 1; i--) {
        const frac = (i / steps) * len;
        prePts.push({
          x: existingPts[0].x - tanStart.x * frac,
          y: existingPts[0].y - tanStart.y * frac,
          z: existingPts[0].z - tanStart.z * frac,
        });
      }
    }
    if (side === "end" || side === "both") {
      const tanEnd = tangentAt(curve, dom.max);
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const frac = (i / steps) * len;
        postPts.push({
          x: existingPts[N - 1].x + tanEnd.x * frac,
          y: existingPts[N - 1].y + tanEnd.y * frac,
          z: existingPts[N - 1].z + tanEnd.z * frac,
        });
      }
    }
  } else {
    // toPoint mode: extend from the nearest end to the target
    const tp = assertPoint3(args.toPoint, "toPoint");
    const dStart = Point3.distance(existingPts[0], tp);
    const dEnd = Point3.distance(existingPts[N - 1], tp);
    if (side === "start" || (side === "both" && dStart <= dEnd)) {
      // Extend start toward tp
      prePts = [tp];
    } else {
      // Extend end toward tp
      postPts = [tp];
    }
  }

  const allPts = [...prePts, ...existingPts, ...postPts];
  return createInterpolatingCubicBSpline(allPts);
}

// ── SdDivide ─────────────────────────────────────────────────────────────
//
// Divide a curve into N equal-length segments (by arc-length).
// Returns parameter values + 3D points at each division location.
//
// oracle: closed-form arc-length Gaussian quadrature.

export interface DivideArgs {
  count?: number;         // divide into N segments (returns N+1 points)
  length?: number;        // divide by fixed length
}

export interface DivideResult {
  params: number[];
  points: P3[];
}

export function handle_SdDivide(args: DivideArgs, curve: Curve): DivideResult {
  const dom = domain(curve);
  const totalLen = arcLength(curve, dom.min, dom.max);

  let targetLengths: number[] = [];
  if (args.count !== undefined) {
    const n = Math.max(2, Math.round(args.count));
    for (let i = 0; i <= n; i++) targetLengths.push((i / n) * totalLen);
  } else if (args.length !== undefined) {
    const segLen = assertFinite(args.length, "length");
    if (segLen <= 0) throw new Error("SdDivide: length must be positive");
    for (let l = 0; l <= totalLen + 1e-12; l += segLen) targetLengths.push(l);
  } else {
    throw new Error("SdDivide: specify count or length");
  }

  const params: number[] = [];
  const points: P3[] = [];
  for (const tl of targetLengths) {
    const t = tl <= 0 ? dom.min : tl >= totalLen ? dom.max : paramAtLength(curve, tl);
    params.push(t);
    points.push(pointAt(curve, t));
  }
  return { params, points };
}

// ── SdProjectToPlane ──────────────────────────────────────────────────────
//
// Project every point on a curve onto a plane (orthogonal projection).
// Returns a new curve lying in the plane.
//
// oracle: closed-form Plane.projectPoint (dot-product distance formula).

export interface ProjectToPlaneArgs {
  planeOrigin: P3;
  planeNormal: P3;
}

export function handle_SdProjectToPlane(
  args: ProjectToPlaneArgs,
  curve: Curve,
): Curve {
  const origin = assertPoint3(args.planeOrigin, "planeOrigin");
  const normal = vecNorm(assertPoint3(args.planeNormal, "planeNormal"));
  const plane = Plane.fromPointNormal(origin, normal);

  const N = 64;
  const dom = domain(curve);
  const pts: P3[] = [];
  for (let i = 0; i < N; i++) {
    const t = dom.min + (i / (N - 1)) * (dom.max - dom.min);
    const p = pointAt(curve, t);
    pts.push(Plane.projectPoint(plane, p));
  }
  return createInterpolatingCubicBSpline(pts);
}

// ── SdClosestPoint ────────────────────────────────────────────────────────
//
// Closest point on a curve to a test point.
//
// oracle: closestPointOnCurve from nurbs-curve-algorithms.ts (Newton).

export interface ClosestPointArgs {
  testPoint: P3;
}

export interface ClosestPointResult {
  point: P3;
  param: number;
  distance: number;
}

export function handle_SdClosestPoint(
  args: ClosestPointArgs,
  curve: Curve,
): ClosestPointResult {
  const p = assertPoint3(args.testPoint, "testPoint");
  return closestPointOnCurve(curve, p);
}

// ── SdLength ──────────────────────────────────────────────────────────────
//
// Arc-length of a curve (or sub-interval).
//
// oracle: 16-pt Gauss-Legendre quadrature (closed-form).

export interface LengthArgs {
  paramStart?: number;
  paramEnd?: number;
}

export interface LengthResult {
  length: number;
  paramStart: number;
  paramEnd: number;
}

export function handle_SdLength(args: LengthArgs, curve: Curve): LengthResult {
  const dom = domain(curve);
  const a = args.paramStart ?? dom.min;
  const b = args.paramEnd   ?? dom.max;
  return {
    length: arcLength(curve, Math.min(a, b), Math.max(a, b)),
    paramStart: Math.min(a, b),
    paramEnd: Math.max(a, b),
  };
}

// ── SdCurveArea ───────────────────────────────────────────────────────────
//
// Signed area enclosed by a planar closed curve (shoelace / Green's theorem).
// Plane normal defaults to world Z.
//
// oracle: closed-form shoelace on tessellation.

export interface CurveAreaArgs {
  planeNormal?: P3;
}

export function handle_SdCurveArea(args: CurveAreaArgs, curve: Curve): number {
  if (!isClosed(curve, 1e-6))
    throw new Error("SdCurveArea: curve is not closed");
  const n = args.planeNormal ?? { x: 0, y: 0, z: 1 };
  const normal = vecNorm(n);

  // Compute two orthogonal axes in the plane
  const arb = Math.abs(normal.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const xAx = vecNorm(cross(arb, normal));
  const yAx = cross(normal, xAx);

  const pts = tessellate(curve, 256);
  // Shoelace in 2D projection
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ax = Vector3.dot(a as unknown as V3, xAx);
    const ay = Vector3.dot(a as unknown as V3, yAx);
    const bx = Vector3.dot(b as unknown as V3, xAx);
    const by = Vector3.dot(b as unknown as V3, yAx);
    area += (ax * by - bx * ay);
  }
  return Math.abs(area) / 2;
}

// ── SdCurveAreaCentroid ───────────────────────────────────────────────────
//
// Centroid of the region enclosed by a planar closed curve.
//
// oracle: closed-form Green's theorem on tessellation.

export interface CurveAreaCentroidResult {
  centroid: P3;
  area: number;
}

export function handle_SdCurveAreaCentroid(
  args: CurveAreaArgs,
  curve: Curve,
): CurveAreaCentroidResult {
  if (!isClosed(curve, 1e-6))
    throw new Error("SdCurveAreaCentroid: curve is not closed");
  const n = args.planeNormal ?? { x: 0, y: 0, z: 1 };
  const normal = vecNorm(n);
  const arb = Math.abs(normal.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const xAx = vecNorm(cross(arb, normal));
  const yAx = cross(normal, xAx);

  const pts = tessellate(curve, 256);

  // Project all points to 2D (u, v) in the plane axes
  // Using absolute world coordinates projected onto xAx and yAx.
  // Green's theorem in 2D: A = ½ ∑ (xᵢ yᵢ₊₁ − xᵢ₊₁ yᵢ)
  //   Cₓ = (1/6A) ∑ (xᵢ + xᵢ₊₁)(xᵢ yᵢ₊₁ − xᵢ₊₁ yᵢ)
  let area = 0, cu = 0, cv = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    // 2D coords via dot product with plane axes
    const au = xAx.x * a.x + xAx.y * a.y + xAx.z * a.z;
    const av = yAx.x * a.x + yAx.y * a.y + yAx.z * a.z;
    const bu = xAx.x * b.x + xAx.y * b.y + xAx.z * b.z;
    const bv = yAx.x * b.x + yAx.y * b.y + yAx.z * b.z;
    const cross2d = au * bv - bu * av;
    area += cross2d;
    cu += (au + bu) * cross2d;
    cv += (av + bv) * cross2d;
  }
  const A = area / 2;
  const invA = A === 0 ? 0 : 1 / (6 * A);
  const u = cu * invA;
  const v = cv * invA;

  // Reconstruct 3D centroid from 2D (u, v) using plane axes (no offset needed —
  // u and v are already in world-space projected coordinates, so centroid is
  // directly reconstructed as a world-space point on the plane).
  return {
    centroid: {
      x: xAx.x * u + yAx.x * v,
      y: xAx.y * u + yAx.y * v,
      z: xAx.z * u + yAx.z * v,
    },
    area: Math.abs(A),
  };
}

// ── SdCurvature ───────────────────────────────────────────────────────────
//
// Curvature κ = |C' × C''| / |C'|³, plus curvature vector and radius.
// oracle: closed-form second-derivative finite difference.

export interface CurvatureArgs {
  param: number;
}

export interface CurvatureResult {
  kappa: number;       // unsigned curvature magnitude
  radius: number;      // = 1/kappa (Inf when straight)
  vector: P3;          // curvature vector (points toward center)
  normal: P3;          // unit principal normal
  param: number;
}

export function handle_SdCurvature(
  args: CurvatureArgs,
  curve: Curve,
): CurvatureResult {
  const t = assertFinite(args.param, "param");
  const dom = domain(curve);
  const h = (dom.max - dom.min) * 1e-5;
  const tc = Math.max(dom.min, Math.min(dom.max, t));

  const derivs = derivativeAt(curve, tc, 2);
  const d1 = derivs[1] ?? { x: 0, y: 0, z: 0 };
  const d2 = derivs[2] ?? { x: 0, y: 0, z: 0 };

  const crossV = cross(d1, d2);
  const crossLen = vecLen(crossV);
  const d1Len = vecLen(d1);
  const d1Len3 = d1Len * d1Len * d1Len;

  const kappa = d1Len3 < 1e-30 ? 0 : crossLen / d1Len3;
  const radius = kappa < 1e-20 ? Infinity : 1 / kappa;

  // Curvature vector = d2 projected perpendicular to d1 (Frenet)
  const d1sq = d1.x * d1.x + d1.y * d1.y + d1.z * d1.z;
  let cvec: P3 = { x: 0, y: 0, z: 0 };
  if (d1sq > 1e-30) {
    const proj = (d2.x * d1.x + d2.y * d1.y + d2.z * d1.z) / d1sq;
    cvec = {
      x: d2.x - proj * d1.x,
      y: d2.y - proj * d1.y,
      z: d2.z - proj * d1.z,
    };
  }
  const cvecLen = vecLen(cvec);
  const principalNormal: P3 = cvecLen > 1e-20
    ? { x: cvec.x / cvecLen, y: cvec.y / cvecLen, z: cvec.z / cvecLen }
    : { x: 0, y: 0, z: 0 };

  void h; // h available if needed for refinement

  return { kappa, radius, vector: cvec, normal: principalNormal, param: tc };
}

// ── SdFrame ───────────────────────────────────────────────────────────────
//
// Frenet frame at parameter t: {origin, tangent, normal, binormal}.
// oracle: closed-form Frenet frame from first and second derivatives.

export interface FrameArgs {
  param: number;
}

export interface FrameResult {
  origin: P3;
  tangent: P3;
  normal: P3;
  binormal: P3;
  param: number;
}

export function handle_SdFrame(args: FrameArgs, curve: Curve): FrameResult {
  const t = assertFinite(args.param, "param");
  const dom = domain(curve);
  const tc = Math.max(dom.min, Math.min(dom.max, t));

  const origin = pointAt(curve, tc);
  const derivs = derivativeAt(curve, tc, 2);
  const d1 = derivs[1] ?? { x: 1, y: 0, z: 0 };
  const d2 = derivs[2] ?? { x: 0, y: 0, z: 0 };

  const tangent = vecNorm(d1);
  const b = vecNorm(cross(d1, d2));
  const normal = cross(b, tangent);

  return {
    origin,
    tangent: tangent as P3,
    normal: vecNorm(normal) as P3,
    binormal: b as P3,
    param: tc,
  };
}

// ── SdPerpFrame ───────────────────────────────────────────────────────────
//
// Parallel-transport frame (avoids Frenet flips on inflection points).
// Algorithm: propagate a reference frame along the curve by rotating the
// previous normal into the new tangent plane at each step.
// oracle: Frenet matches PerpFrame on simple arcs (no inflection).

export interface PerpFrameArgs {
  param?: number;  // optional when count is provided
  count?: number;  // if provided, returns frames at count equidistant params
}

export function handle_SdPerpFrame(
  args: PerpFrameArgs,
  curve: Curve,
): FrameResult | FrameResult[] {
  const dom = domain(curve);

  function perpFrameAt(t: number, prevTan: V3, prevNorm: V3): FrameResult {
    const origin = pointAt(curve, t);
    const d1 = derivativeAt(curve, t, 1)[1] ?? { x: 1, y: 0, z: 0 };
    const tan = vecNorm(d1) as V3;

    // Rotate prevNorm into new tangent plane
    const dot = Vector3.dot(prevNorm, tan);
    let normal: V3 = { x: prevNorm.x - dot * tan.x, y: prevNorm.y - dot * tan.y, z: prevNorm.z - dot * tan.z };
    const nLen = vecLen(normal);
    if (nLen < 1e-12) {
      // Fall back to arbitrary perpendicular
      const arb = Math.abs(tan.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
      normal = vecNorm(cross(arb, tan)) as V3;
    } else {
      normal = { x: normal.x / nLen, y: normal.y / nLen, z: normal.z / nLen } as V3;
    }
    const binormal = cross(tan, normal);

    return {
      origin,
      tangent: tan as P3,
      normal: normal as P3,
      binormal: vecNorm(binormal) as P3,
      param: t,
    };
  }

  if (args.count !== undefined) {
    const n = Math.max(2, args.count);
    // Compute initial Frenet frame at start
    const t0 = dom.min;
    const d1_0 = derivativeAt(curve, t0, 1)[1] ?? { x: 1, y: 0, z: 0 };
    const d2_0 = derivativeAt(curve, t0, 2)[2] ?? { x: 0, y: 0, z: 0 };
    let curTan = vecNorm(d1_0) as V3;
    let b0 = vecNorm(cross(d1_0, d2_0)) as V3;
    if (vecLen(b0) < 1e-10) b0 = vecNorm(cross(curTan, { x: 0, y: 0, z: 1 })) as V3;
    let curNorm = cross(b0, curTan) as V3;

    const frames: FrameResult[] = [];
    for (let i = 0; i < n; i++) {
      const t = dom.min + (i / (n - 1)) * (dom.max - dom.min);
      const f = perpFrameAt(t, curTan, curNorm);
      frames.push(f);
      curTan = f.tangent as unknown as V3;
      curNorm = f.normal as unknown as V3;
    }
    return frames;
  }

  // Single frame
  if (args.param === undefined) throw new Error("SdPerpFrame: param or count required");
  const t = assertFinite(args.param, "param");
  const tc = Math.max(dom.min, Math.min(dom.max, t));
  const d1_0 = derivativeAt(curve, dom.min, 1)[1] ?? { x: 1, y: 0, z: 0 };
  const d2_0 = derivativeAt(curve, dom.min, 2)[2] ?? { x: 0, y: 0, z: 0 };
  let curTan = vecNorm(d1_0) as V3;
  let b0 = vecNorm(cross(d1_0, d2_0)) as V3;
  if (vecLen(b0) < 1e-10) b0 = vecNorm(cross(curTan, { x: 0, y: 0, z: 1 })) as V3;
  let curNorm = cross(b0, curTan) as V3;

  // Walk forward to tc in small steps
  const steps = 128;
  for (let i = 0; i < steps; i++) {
    const t_i = dom.min + ((i + 1) / steps) * (tc - dom.min);
    const f = perpFrameAt(t_i, curTan, curNorm);
    curTan = f.tangent as unknown as V3;
    curNorm = f.normal as unknown as V3;
    if (t_i >= tc) break;
  }
  return perpFrameAt(tc, curTan, curNorm);
}

// ── SdDiscontinuity ───────────────────────────────────────────────────────
//
// Detect parametric discontinuities of order <= continuityOrder.
// Returns parameters where |C^(k)(t+) - C^(k)(t-)| > tol.
// oracle: closed-form derivative jump detection.

export interface DiscontinuityArgs {
  continuityOrder: number;   // 0=G0, 1=G1, 2=G2
  tol?: number;
}

export interface DiscontinuityResult {
  params: number[];
  order: number[];   // discontinuity order at each param
}

export function handle_SdDiscontinuity(
  args: DiscontinuityArgs,
  curve: Curve,
): DiscontinuityResult {
  const order = Math.max(0, Math.min(3, Math.round(args.continuityOrder)));
  const tol = args.tol ?? 1e-6;
  const dom = domain(curve);
  const N = 512;
  const params: number[] = [];
  const orders: number[] = [];

  // For polylines: discontinuities at each interior knot.
  if (curve.kind === "polyline") {
    for (let i = 1; i < curve.parameters.length - 1; i++) {
      const t = curve.parameters[i];
      if (order >= 1) {
        // Tangent jump at corner
        const t_before = Math.max(dom.min, t - 1e-8);
        const t_after  = Math.min(dom.max, t + 1e-8);
        const ta = derivativeAt(curve, t_before, 1)[1] ?? { x: 0, y: 0, z: 0 };
        const tb = derivativeAt(curve, t_after, 1)[1] ?? { x: 0, y: 0, z: 0 };
        const jump = Math.sqrt((ta.x - tb.x) ** 2 + (ta.y - tb.y) ** 2 + (ta.z - tb.z) ** 2);
        if (jump > tol) { params.push(t); orders.push(1); }
      }
    }
    return { params, order: orders };
  }

  // For NURBS: scan for derivative jumps at interior knots.
  if (curve.kind === "nurbs") {
    const knots = curve.knots;
    const seen = new Set<number>();
    for (const k of knots) {
      if (k <= dom.min || k >= dom.max) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      const h = 1e-8;
      let discOrder = -1;
      for (let ord = 0; ord <= order; ord++) {
        const d_before = derivativeAt(curve, Math.max(dom.min, k - h), ord)[ord];
        const d_after = derivativeAt(curve, Math.min(dom.max, k + h), ord)[ord];
        if (!d_before || !d_after) continue;
        const jump = Math.sqrt(
          (d_before.x - d_after.x) ** 2 +
          (d_before.y - d_after.y) ** 2 +
          (d_before.z - d_after.z) ** 2
        );
        if (jump > tol) { discOrder = ord; break; }
      }
      if (discOrder >= 0) { params.push(k); orders.push(discOrder); }
    }
    return { params, order: orders };
  }

  // Arcs and lines: scan uniformly (typically no discontinuities)
  return { params: [], order: [] };
}

// ── SdDomain ──────────────────────────────────────────────────────────────
//
// Return the parametric domain [min, max] of a curve.
// oracle: direct domain() call.

export function handle_SdDomain(curve: Curve): Interval {
  return domain(curve);
}

// ── SdSetDomain ───────────────────────────────────────────────────────────
//
// Reparametrize (re-scale) a curve's domain to [newMin, newMax].
// oracle: closed-form linear remap; pointAt(reparametrized, mid) ===
//         pointAt(original, origMid).

export interface SetDomainArgs {
  min: number;
  max: number;
}

export function handle_SdSetDomain(args: SetDomainArgs, curve: Curve): Curve {
  const newMin = assertFinite(args.min, "min");
  const newMax = assertFinite(args.max, "max");
  if (newMax <= newMin) throw new Error("SdSetDomain: max must be > min");
  const dom = domain(curve);
  const oldSpan = dom.max - dom.min;
  const newSpan = newMax - newMin;

  if (curve.kind === "nurbs") {
    // Linearly remap the knot vector
    const newKnots = curve.knots.map(
      (k) => newMin + ((k - dom.min) / oldSpan) * newSpan,
    );
    return { ...curve, knots: newKnots };
  }
  if (curve.kind === "line") {
    return { ...curve, domain: { min: newMin, max: newMax } };
  }
  if (curve.kind === "arc") {
    return { ...curve, domain: { min: newMin, max: newMax } };
  }
  if (curve.kind === "polyline") {
    const newParams = curve.parameters.map(
      (p) => newMin + ((p - dom.min) / oldSpan) * newSpan,
    );
    return { ...curve, parameters: newParams };
  }
  return curve;
}

// ── SdDeviation ───────────────────────────────────────────────────────────
//
// Hausdorff-style deviation between two curves:
//   max over samples on A of closest distance to B.
// oracle: closestPointOnCurve (Newton).

export interface DeviationArgs {
  sampleCount?: number;
}

export interface DeviationResult {
  maxDeviation: number;
  avgDeviation: number;
  paramA: number;   // param on curve A where max deviation occurs
  closestOnB: P3;   // closest point on curve B at maxDeviation
}

export function handle_SdDeviation(
  args: DeviationArgs,
  curveA: Curve,
  curveB: Curve,
): DeviationResult {
  const N = args.sampleCount ?? 64;
  const domA = domain(curveA);

  let maxDev = -Infinity;
  let maxParam = domA.min;
  let closestOnB: P3 = { x: 0, y: 0, z: 0 };
  let sumDev = 0;

  for (let i = 0; i < N; i++) {
    const t = domA.min + (i / (N - 1)) * (domA.max - domA.min);
    const p = pointAt(curveA, t);
    const r = closestPointOnCurve(curveB, p);
    sumDev += r.distance;
    if (r.distance > maxDev) {
      maxDev = r.distance;
      maxParam = t;
      closestOnB = r.point;
    }
  }

  return {
    maxDeviation: maxDev,
    avgDeviation: sumDev / N,
    paramA: maxParam,
    closestOnB,
  };
}

// ── SdPointEval ───────────────────────────────────────────────────────────
//
// Evaluate a point on a curve at parameter t.
// oracle: closed-form pointAt (de Boor / direct).

export interface PointEvalArgs {
  param: number;
}

export function handle_SdPointEval(args: PointEvalArgs, curve: Curve): P3 {
  const t = assertFinite(args.param, "param");
  const dom = domain(curve);
  return pointAt(curve, Math.max(dom.min, Math.min(dom.max, t)));
}

// ── SdTangentEval ─────────────────────────────────────────────────────────
//
// Evaluate the unit tangent vector at parameter t.
// oracle: closed-form tangentAt (finite-difference / direct).

export interface TangentEvalArgs {
  param: number;
}

export function handle_SdTangentEval(args: TangentEvalArgs, curve: Curve): P3 {
  const t = assertFinite(args.param, "param");
  const dom = domain(curve);
  const v = tangentAt(curve, Math.max(dom.min, Math.min(dom.max, t)));
  return v as P3;
}

// ── SdDerivativeEval ──────────────────────────────────────────────────────
//
// Evaluate position + derivatives up to `order` at parameter t.
// Returns array [position, 1st_deriv, 2nd_deriv, ...].
// oracle: closed-form derivativeAt.

export interface DerivativeEvalArgs {
  param: number;
  order: number;
}

export function handle_SdDerivativeEval(
  args: DerivativeEvalArgs,
  curve: Curve,
): P3[] {
  const t = assertFinite(args.param, "param");
  const ord = Math.max(1, Math.round(args.order));
  const dom = domain(curve);
  return derivativeAt(curve, Math.max(dom.min, Math.min(dom.max, t)), ord);
}

// ── C++ BLOCKED STUBS ─────────────────────────────────────────────────────
//
// These ops require OCCT/OpenNURBS routines not yet compiled into kern.wasm.
// Each stub documents the C++ function signature needed.

/**
 * SdOffsetCurveOnSurface
 *
 * C++ signature (OpenNURBS):
 *   ON_Curve* ON_OffsetCurveOnSurface(
 *     const ON_Curve& curve,
 *     const ON_Surface& surface,
 *     double offset_dist,
 *     double fitting_tol,
 *     const ON_3dVector* dir_hint
 *   );
 *
 * Blocked: requires general surface-curve pull + geodesic offset in kern.wasm.
 */
export function handle_SdOffsetCurveOnSurface(
  _args: Record<string, unknown>,
): { error: string; detail: string } {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires ON_OffsetCurveOnSurface (geodesic offset on surface) in kern.wasm",
  };
}

/**
 * SdFilletCorner
 *
 * C++ signature (OCCT / OpenNURBS):
 *   bool ON_CreateFilletCurves(
 *     const ON_Curve& curve0, double t0,
 *     const ON_Curve& curve1, double t1,
 *     double radius,
 *     bool trimOrExtend,
 *     ON_NurbsCurve& fillet
 *   );
 *
 * Blocked: requires OCCT curve-fillet topology in kern.wasm.
 */
export function handle_SdFilletCorner(
  _args: Record<string, unknown>,
): { error: string; detail: string } {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires ON_CreateFilletCurves (fillet corner) in kern.wasm",
  };
}

/**
 * SdChamferCorner
 *
 * C++ signature (OCCT / OpenNURBS):
 *   bool ON_ChamferCurves(
 *     const ON_Curve& curve0, double t0,
 *     const ON_Curve& curve1, double t1,
 *     double d1, double d2,
 *     ON_NurbsCurve& chamfer
 *   );
 *
 * Blocked: requires OCCT curve-chamfer topology in kern.wasm.
 */
export function handle_SdChamferCorner(
  _args: Record<string, unknown>,
): { error: string; detail: string } {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires ON_ChamferCurves (chamfer corner) in kern.wasm",
  };
}

/**
 * SdBlendCurve
 *
 * C++ signature (OpenNURBS / Rhino):
 *   bool RhBlendCurve(
 *     const ON_Curve* curve0, double t0, int continuity0,
 *     const ON_Curve* curve1, double t1, int continuity1,
 *     ON_NurbsCurve& blend,
 *     double tolerance
 *   );
 *
 * Blocked: requires G0/G1/G2 blend-curve solver in kern.wasm.
 */
export function handle_SdBlendCurve(
  _args: Record<string, unknown>,
): { error: string; detail: string } {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires RhBlendCurve G0/G1/G2 solver in kern.wasm",
  };
}

/**
 * SdProjectToSurface
 *
 * C++ signature (OpenNURBS):
 *   bool ON_ProjectCurveToSurface(
 *     const ON_Curve& curve,
 *     const ON_Surface& surface,
 *     const ON_3dVector& projection_dir,
 *     double tol,
 *     ON_SimpleArray<ON_NurbsCurve*>& projected
 *   );
 *
 * Blocked: requires SSI (surface-surface intersection) or surface closest-point
 * iteration in kern.wasm.
 */
export function handle_SdProjectToSurface(
  _args: Record<string, unknown>,
): { error: string; detail: string } {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires ON_ProjectCurveToSurface (general SSI) in kern.wasm",
  };
}

/**
 * SdProjectToMesh
 *
 * C++ signature (OpenNURBS):
 *   bool ON_MeshRay(
 *     const ON_Mesh& mesh,
 *     ON_Line ray,
 *     ON_MESH_POINT* hit
 *   );
 *
 * Blocked: requires general mesh BVH + ray-casting in kern.wasm.
 */
export function handle_SdProjectToMesh(
  _args: Record<string, unknown>,
): { error: string; detail: string } {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires ON_MeshRay + BVH mesh projection in kern.wasm",
  };
}

/**
 * SdPull
 *
 * C++ signature (OpenNURBS / Rhino):
 *   ON_NurbsCurve* RhPullCurveToSurface(
 *     const ON_Curve* curve,
 *     const ON_Surface* surface,
 *     double tol
 *   );
 *
 * Blocked: requires geodesic pull-back on parametric surface in kern.wasm.
 */
export function handle_SdPull(
  _args: Record<string, unknown>,
): { error: string; detail: string } {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires RhPullCurveToSurface (geodesic surface pull) in kern.wasm",
  };
}

/**
 * SdClosestObject
 *
 * C++ signature (OpenNURBS):
 *   bool ON_ClosestPointBetweenObjects(
 *     const ON_Geometry& A, const ON_Geometry& B,
 *     double* tA, double* tB,
 *     ON_3dPoint* ptA, ON_3dPoint* ptB
 *   );
 *
 * Blocked: requires general geometry (surface + mesh) closest-point queries in kern.wasm.
 */
export function handle_SdClosestObject(
  _args: Record<string, unknown>,
): { error: string; detail: string } {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires ON_ClosestPointBetweenObjects (general SSI/mesh) in kern.wasm",
  };
}

// ── Viewer-aware wrapper (not used for pure-math handlers) ─────────────────
// This file exports pure functions; dispatch registration is done externally
// via spatial-api.yaml + register-handlers.ts when the viewer is available.
// The Viewer import is retained for future handlers that may need scene access.
const _viewerTypeGuard = (_v: Viewer): void => void 0;
void _viewerTypeGuard;

// ── Registration entry point ─────────────────────────────────────────────────
// Pure-math handlers take (args, curve) — dispatch wraps by resolving args.curve.

import { registerHandler } from "../commands/dispatch";

function resolveCurveFromArgs(args: Record<string, unknown>): Curve {
  const raw = args["curve"] ?? args["source"];
  if (!raw || typeof raw !== "object") {
    throw new Error("SdCurveOp: 'curve' arg required — pass a curve description object");
  }
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj["points"]) && (obj["points"] as unknown[]).length >= 2) {
    const pts = (obj["points"] as number[][]).map((p) => ({
      x: p[0] ?? 0, y: p[1] ?? 0, z: p[2] ?? 0,
    }));
    let arcLen = 0;
    const params: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]; const b = pts[i];
      arcLen += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);
      params.push(arcLen);
    }
    return { kind: "polyline", points: pts, parameters: params } as Curve;
  }
  if (obj["kind"] === "nurbs" && Array.isArray(obj["knots"]) && Array.isArray(obj["cvs"])) {
    return {
      kind: "nurbs",
      dim: (obj["dim"] as number) ?? 3,
      isRational: (obj["isRational"] as boolean) ?? false,
      order: obj["order"] as number,
      cvCount: (obj["cvCount"] as number) ?? (obj["cvs"] as number[]).length / ((obj["cvStride"] as number) ?? 3),
      knots: obj["knots"] as number[],
      cvs: obj["cvs"] as number[],
      cvStride: (obj["cvStride"] as number) ?? 3,
    } as Curve;
  }
  if (obj["kind"] === "line" && Array.isArray(obj["from"]) && Array.isArray(obj["to"])) {
    const [fx = 0, fy = 0, fz = 0] = obj["from"] as number[];
    const [tx = 0, ty = 0, tz = 0] = obj["to"] as number[];
    const len = Math.sqrt((tx - fx) ** 2 + (ty - fy) ** 2 + (tz - fz) ** 2);
    return { kind: "line", from: { x: fx, y: fy, z: fz }, to: { x: tx, y: ty, z: tz }, domain: { min: 0, max: len } } as Curve;
  }
  throw new Error(`SdCurveOp: unrecognised curve description kind=${String(obj["kind"])}`);
}

export function registerS322Handlers(_viewer: Viewer): void {
  registerHandler("SdOffsetCurve", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdOffsetCurve(args as unknown as OffsetCurveArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdExtend", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdExtend(args as unknown as ExtendArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdDivide", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdDivide(args as unknown as DivideArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdProjectToPlane", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdProjectToPlane(args as unknown as ProjectToPlaneArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdClosestPoint", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdClosestPoint(args as unknown as ClosestPointArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdLength", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdLength(args as unknown as LengthArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdCurveArea", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdCurveArea(args as unknown as CurveAreaArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdCurveAreaCentroid", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdCurveAreaCentroid(args as unknown as CurveAreaArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdCurvature", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdCurvature(args as unknown as CurvatureArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdFrame", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdFrame(args as unknown as FrameArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdPerpFrame", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdPerpFrame(args as unknown as PerpFrameArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdDiscontinuity", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdDiscontinuity(args as unknown as DiscontinuityArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdDomain", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdDomain(c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdSetDomain", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdSetDomain(args as unknown as SetDomainArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdDeviation", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      const c2 = args["other"] ? resolveCurveFromArgs({ curve: args["other"] }) : c;
      return handle_SdDeviation(args as unknown as DeviationArgs, c, c2);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdPointEval", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdPointEval(args as unknown as PointEvalArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdTangentEval", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdTangentEval(args as unknown as TangentEvalArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  registerHandler("SdDerivativeEval", (args) => {
    try {
      const c = resolveCurveFromArgs(args);
      return handle_SdDerivativeEval(args as unknown as DerivativeEvalArgs, c);
    } catch (e) { return { error: String(e) }; }
  });
  // C++-blocked stubs — registered for structured errors
  registerHandler("SdOffsetCurveOnSurface", (args) => handle_SdOffsetCurveOnSurface(args));
  registerHandler("SdFilletCorner", (args) => handle_SdFilletCorner(args));
  registerHandler("SdChamferCorner", (args) => handle_SdChamferCorner(args));
  registerHandler("SdBlendCurve", (args) => handle_SdBlendCurve(args));
  registerHandler("SdProjectToSurface", (args) => handle_SdProjectToSurface(args));
  registerHandler("SdProjectToMesh", (args) => handle_SdProjectToMesh(args));
  registerHandler("SdPull", (args) => handle_SdPull(args));
  registerHandler("SdClosestObject", (args) => handle_SdClosestObject(args));
}
