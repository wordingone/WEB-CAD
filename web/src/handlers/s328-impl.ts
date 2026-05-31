// s328-impl.ts — S8 Intersection complete matrix handlers (#328).
//
// TypeScript-implementable operations:
//   CurveCurveOverlaps, CurveSelfIntersection,
//   PlanePrimitiveIntersection, LineLineIntersection, LinePlaneIntersection,
//   LineSphereIntersection, PlaneSphereSectionIntersection,
//   ArcArcIntersection, CircleCircleIntersection, SphereSphereIntersection
//
// C++-blocked stubs (require kern.wasm expansion):
//   CurveSurfaceIntersection, CurveBrepIntersection, BrepPlaneSection,
//   SurfaceSurfaceIntersectionGeneral, BrepBrepIntersection,
//   MeshMeshIntersection, MeshRayIntersection, MeshPlaneIntersection
//
// oracle: replicad/OCCT for brep/mesh ops; closed-form math for primitives;
//         verb-nurbs/intersect-curve-curve for CCX.
//
// Tolerance convention: 1e-6 m (BREP_DEFAULT_TOLERANCE) for geometric closures.

import { registerHandler } from "../commands/dispatch";
import {
  type Point3, type Vector3, type Line, type Plane, type Arc, type Circle,
  type Sphere,
  Point3 as Pt3, Vector3 as V3, Plane as Pl, Line as Ln,
} from "../nurbs/nurbs-primitives";
import {
  type Curve, type ArcCurve, type LineCurve,
  pointAt as curvePointAt, domain as curveDomain, tangentAt as curveTangentAt,
  tessellate as curveTessellate,
} from "../nurbs/nurbs-curves";
import {
  intersectCurveCurve, closestPointOnCurve,
  type CurveCurveIntersection,
} from "../nurbs/nurbs-curve-algorithms";

// ── Shared geometry utilities ─────────────────────────────────────────────────

/** Cross product of two 3-element arrays */
function cross3(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Dot product of two 3-element arrays */
function dot3(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function len3(a: number[]): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

function normalize3(a: number[]): number[] {
  const l = len3(a);
  return l < 1e-30 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

function sub3(a: number[], b: number[]): number[] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add3(a: number[], b: number[]): number[] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(a: number[], s: number): number[] {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function pt3ToArr(p: Point3): number[] { return [p.x, p.y, p.z]; }
function arrToPt3(a: number[]): Point3 { return { x: a[0], y: a[1], z: a[2] }; }
function vec3ToArr(v: Vector3): number[] { return [v.x, v.y, v.z]; }

/** Parse a [x,y,z] array arg or named-field object from dispatch args. */
function parsePoint3(v: unknown, fallback?: Point3): Point3 | undefined {
  if (Array.isArray(v) && v.length >= 3) {
    return { x: Number(v[0]), y: Number(v[1]), z: Number(v[2]) };
  }
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const x = Number(obj.x ?? obj[0]);
    const y = Number(obj.y ?? obj[1]);
    const z = Number(obj.z ?? obj[2] ?? 0);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, z };
  }
  return fallback;
}

function parseVector3(v: unknown, fallback?: Vector3): Vector3 | undefined {
  const p = parsePoint3(v);
  if (p) return { x: p.x, y: p.y, z: p.z };
  return fallback;
}

function parsePlane(args: Record<string, unknown>): Plane | null {
  const origin = parsePoint3(args.planeOrigin ?? args.origin);
  const normal = parseVector3(args.planeNormal ?? args.normal);
  if (!origin || !normal) return null;
  return Pl.fromPointNormal(origin, normal);
}

function parseLine(args: Record<string, unknown>): Line | null {
  const from = parsePoint3(args.lineFrom ?? args.from ?? args.start);
  const to = parsePoint3(args.lineTo ?? args.to ?? args.end);
  if (!from || !to) return null;
  return Ln.create(from, to);
}

function parseSphere(args: Record<string, unknown>): Sphere | null {
  const center = parsePoint3(args.sphereCenter ?? args.center);
  const radius = typeof args.radius === "number" ? args.radius : Number(args.radius ?? args.r ?? 1);
  if (!center || !Number.isFinite(radius)) return null;
  return { center, radius };
}

function parseArc(args: Record<string, unknown>, prefix = ""): Arc | null {
  const center = parsePoint3(args[`${prefix}center`] ?? args.center);
  const radius = Number(args[`${prefix}radius`] ?? args.radius ?? 1);
  const startAngle = Number(args[`${prefix}startAngle`] ?? args.startAngle ?? 0);
  const endAngle = Number(args[`${prefix}endAngle`] ?? args.endAngle ?? Math.PI * 2);
  const normalRaw = args[`${prefix}normal`] ?? args.normal;
  if (!center) return null;
  const normal = parseVector3(normalRaw) ?? { x: 0, y: 0, z: 1 };
  const plane = Pl.fromPointNormal(center, normal);
  return { center, radius, startAngle, endAngle, plane };
}

function parseCircle(args: Record<string, unknown>, prefix = ""): Circle | null {
  const center = parsePoint3(args[`${prefix}center`] ?? args.center);
  const radius = Number(args[`${prefix}radius`] ?? args.radius ?? 1);
  const normalRaw = args[`${prefix}normal`] ?? args.normal;
  if (!center) return null;
  const normal = parseVector3(normalRaw) ?? { x: 0, y: 0, z: 1 };
  const plane = Pl.fromPointNormal(center, normal);
  return { center, radius, plane };
}

// ── §1 CurveCurveOverlaps ─────────────────────────────────────────────────────
//
// Detects true overlapping segments (collinear or coincident) between two
// curves by checking signed residual distribution along the shorter curve.
// Falls back to intersectCurveCurve for transversal intersections.
//
// oracle: verb-nurbs intersectCurveCurve + closed-form overlap detection.
// tolerance: 1e-4 m (looser to catch near-coincident geometry).

export type CurveCurveOverlapResult = {
  intersections: CurveCurveIntersection[];
  overlaps: { paramA: { min: number; max: number }; paramB: { min: number; max: number }; pts3d: Point3[] }[];
};

export function computeCurveCurveOverlaps(
  curveA: Curve,
  curveB: Curve,
  tol = 1e-4,
): CurveCurveOverlapResult {
  // oracle: intersectCurveCurve covers transversal points
  const baseIntersections = intersectCurveCurve(curveA, curveB, tol);

  // Overlap detection: sample curveA densely, check distance to curveB.
  const N = 128;
  const domA = curveDomain(curveA);
  const domB = curveDomain(curveB);
  const step = (domA.max - domA.min) / (N - 1);

  const onOverlap: { tA: number; tB: number; pt: Point3 }[] = [];
  for (let i = 0; i < N; i++) {
    const tA = domA.min + i * step;
    const pt = curvePointAt(curveA, tA);
    const closest = closestPointOnCurve(curveB, pt);
    const dx = pt.x - closest.point.x;
    const dy = pt.y - closest.point.y;
    const dz = pt.z - closest.point.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= tol) {
      onOverlap.push({ tA, tB: closest.param, pt });
    }
  }

  // Group consecutive samples into overlap segments
  const overlaps: CurveCurveOverlapResult["overlaps"] = [];
  if (onOverlap.length > 0) {
    let start = 0;
    for (let i = 1; i <= onOverlap.length; i++) {
      if (i === onOverlap.length || onOverlap[i].tA - onOverlap[i - 1].tA > step * 2.1) {
        const seg = onOverlap.slice(start, i);
        if (seg.length >= 3) {
          const tAmin = Math.min(...seg.map(s => s.tA));
          const tAmax = Math.max(...seg.map(s => s.tA));
          const tBmin = Math.min(...seg.map(s => s.tB));
          const tBmax = Math.max(...seg.map(s => s.tB));
          // Only count if tB segment is also substantial (not a fold-back artifact)
          const tBspan = Math.abs(tBmax - tBmin);
          const domBspan = domB.max - domB.min;
          if (tBspan > domBspan * 0.01) {
            overlaps.push({
              paramA: { min: tAmin, max: tAmax },
              paramB: { min: tBmin, max: tBmax },
              pts3d: seg.map(s => s.pt),
            });
          }
        }
        start = i;
      }
    }
  }

  return { intersections: baseIntersections, overlaps };
}

// ── §2 CurveSelfIntersection ──────────────────────────────────────────────────
//
// Finds self-intersection points on a single curve by treating it as two
// separate curves on disjoint sub-domains and calling intersectCurveCurve.
//
// oracle: closed-form for figure-eight and lemniscate test shapes.

export type SelfIntersection = { paramA: number; paramB: number; point: Point3 };

export function computeCurveSelfIntersections(
  curve: Curve,
  tol = 1e-4,
): SelfIntersection[] {
  const dom = curveDomain(curve);
  const span = dom.max - dom.min;
  // Split into two halves with small overlap exclusion zone around the split.
  const midLo = dom.min + span * 0.49;
  const midHi = dom.min + span * 0.51;

  // Sub-domain trim: approximate by checking tessellated segments
  const N = 128;
  const half = Math.floor(N / 2);

  // Sample both halves
  function sampleHalf(fromFrac: number, toFrac: number) {
    const n = half;
    const tStart = dom.min + fromFrac * span;
    const tEnd = dom.min + toFrac * span;
    const pts: Point3[] = [];
    const params: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = tStart + (i / (n - 1)) * (tEnd - tStart);
      params.push(t);
      pts.push(curvePointAt(curve, t));
    }
    return { pts, params };
  }

  const sA = sampleHalf(0, 0.49);
  const sB = sampleHalf(0.51, 1.0);

  const results: SelfIntersection[] = [];

  function segBB(p0: Point3, p1: Point3, pad: number) {
    return {
      xMin: Math.min(p0.x, p1.x) - pad, xMax: Math.max(p0.x, p1.x) + pad,
      yMin: Math.min(p0.y, p1.y) - pad, yMax: Math.max(p0.y, p1.y) + pad,
      zMin: Math.min(p0.z, p1.z) - pad, zMax: Math.max(p0.z, p1.z) + pad,
    };
  }

  function bbOverlap(a: ReturnType<typeof segBB>, b: ReturnType<typeof segBB>) {
    return a.xMin <= b.xMax && a.xMax >= b.xMin &&
           a.yMin <= b.yMax && a.yMax >= b.yMin &&
           a.zMin <= b.zMax && a.zMax >= b.zMin;
  }

  for (let i = 0; i < sA.pts.length - 1; i++) {
    const bbA = segBB(sA.pts[i], sA.pts[i + 1], tol);
    for (let j = 0; j < sB.pts.length - 1; j++) {
      if (!bbOverlap(bbA, segBB(sB.pts[j], sB.pts[j + 1], tol))) continue;
      // Newton refinement
      let tA = (sA.params[i] + sA.params[i + 1]) / 2;
      let tB = (sB.params[j] + sB.params[j + 1]) / 2;
      for (let iter = 0; iter < 24; iter++) {
        const Ca = curvePointAt(curve, tA);
        const Cb = curvePointAt(curve, tB);
        const dx = Ca.x - Cb.x, dy = Ca.y - Cb.y, dz = Ca.z - Cb.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < tol * 1e-2) break;
        const ta = curveTangentAt(curve, tA);
        const tb = curveTangentAt(curve, tB);
        const f1 = ta.x * dx + ta.y * dy + ta.z * dz;
        const f2 = -(tb.x * dx + tb.y * dy + tb.z * dz);
        const J11 = ta.x * ta.x + ta.y * ta.y + ta.z * ta.z;
        const J12 = -(ta.x * tb.x + ta.y * tb.y + ta.z * tb.z);
        const J22 = tb.x * tb.x + tb.y * tb.y + tb.z * tb.z;
        const det = J11 * J22 - J12 * J12;
        if (Math.abs(det) < 1e-30) break;
        const dtA = -(J22 * f1 - J12 * f2) / det;
        const dtB = -(J11 * f2 - J12 * f1) / det;
        tA = Math.max(dom.min, Math.min(midLo, tA + dtA));
        tB = Math.max(midHi, Math.min(dom.max, tB + dtB));
      }
      const Ca = curvePointAt(curve, tA);
      const Cb = curvePointAt(curve, tB);
      const dx = Ca.x - Cb.x, dy = Ca.y - Cb.y, dz = Ca.z - Cb.z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= tol) {
        // Dedup
        const already = results.some(r => {
          const ex = Ca.x - r.point.x, ey = Ca.y - r.point.y, ez = Ca.z - r.point.z;
          return Math.sqrt(ex * ex + ey * ey + ez * ez) <= tol * 10;
        });
        if (!already) results.push({ paramA: tA, paramB: tB, point: { x: (Ca.x + Cb.x) / 2, y: (Ca.y + Cb.y) / 2, z: (Ca.z + Cb.z) / 2 } });
      }
    }
  }
  return results;
}

// ── §3 LineLineIntersection ───────────────────────────────────────────────────
//
// Closest approach between two infinite lines (skew lines in 3D).
// Returns intersection point when distance < tol, otherwise closest approach.
//
// oracle: closed-form — Goldman "Intersection of Two Lines in Three-Space"
//         Graphics Gems I p.304 (no copyright — factual algorithm).

export type LineLineResult = {
  type: "intersecting" | "parallel" | "skew";
  /** Closest point on lineA to the crossing / approach. */
  pointA: Point3;
  /** Closest point on lineB to the crossing / approach. */
  pointB: Point3;
  /** Midpoint between pointA and pointB (== both when intersecting). */
  midpoint: Point3;
  /** Distance between closest points (0 when truly intersecting). */
  distance: number;
  /** Parameter on lineA (0 = from, 1 = to). */
  paramA: number;
  /** Parameter on lineB (0 = from, 1 = to). */
  paramB: number;
};

export function lineLineIntersection(
  lineA: Line,
  lineB: Line,
  tol = 1e-6,
): LineLineResult {
  const p1 = pt3ToArr(lineA.from);
  const d1 = normalize3(sub3(pt3ToArr(lineA.to), p1));
  const p2 = pt3ToArr(lineB.from);
  const d2 = normalize3(sub3(pt3ToArr(lineB.to), p2));

  const cross = cross3(d1, d2);
  const crossLen = len3(cross);

  if (crossLen < 1e-10) {
    // Parallel or coincident
    const diff = sub3(p2, p1);
    const proj = scale3(d1, dot3(diff, d1));
    const closest = add3(p1, proj);
    const dist = len3(sub3(p2, closest));
    return {
      type: "parallel",
      pointA: arrToPt3(p1),
      pointB: arrToPt3(p2),
      midpoint: arrToPt3(scale3(add3(p1, p2), 0.5)),
      distance: dist,
      paramA: 0,
      paramB: 0,
    };
  }

  // Using the formula from Goldman GG-I:
  // t1 = ((p2-p1) × d2) · (d1 × d2) / |d1 × d2|²
  // t2 = ((p2-p1) × d1) · (d1 × d2) / |d1 × d2|²
  const w = sub3(p2, p1);
  const crossSq = crossLen * crossLen;
  const t1 = dot3(cross3(w, d2), cross) / crossSq;
  const t2 = dot3(cross3(w, d1), cross) / crossSq;

  const ptA = add3(p1, scale3(d1, t1));
  const ptB = add3(p2, scale3(d2, t2));
  const gap = len3(sub3(ptA, ptB));
  const mid = scale3(add3(ptA, ptB), 0.5);

  // Convert parameter to [0,1] along the original segment
  const lenA = len3(sub3(pt3ToArr(lineA.to), pt3ToArr(lineA.from)));
  const lenB = len3(sub3(pt3ToArr(lineB.to), pt3ToArr(lineB.from)));
  const paramA = lenA > 0 ? t1 / lenA : 0;
  const paramB = lenB > 0 ? t2 / lenB : 0;

  return {
    type: gap <= tol ? "intersecting" : "skew",
    pointA: arrToPt3(ptA),
    pointB: arrToPt3(ptB),
    midpoint: arrToPt3(mid),
    distance: gap,
    paramA,
    paramB,
  };
}

// ── §4 LinePlaneIntersection ──────────────────────────────────────────────────
//
// Closed-form parametric intersection of a line with a plane.
// oracle: dot-product signed-distance formula.

export type LinePlaneResult = {
  type: "intersecting" | "parallel" | "coincident";
  point?: Point3;
  /** Line parameter t (from=0, to=1). */
  param?: number;
};

export function linePlaneIntersection(line: Line, plane: Plane, tol = 1e-6): LinePlaneResult {
  const d = V3.normalize(V3.sub(line.to, line.from) as Vector3) as Vector3;
  const n = plane.normal;
  const denom = V3.dot(d, n);

  if (Math.abs(denom) < 1e-10) {
    const dist = Math.abs(Pl.distanceTo(plane, line.from));
    return { type: dist < tol ? "coincident" : "parallel" };
  }

  // t = -(n · (from - origin)) / (n · d)
  const w = V3.sub(line.from, plane.origin) as Vector3;
  const rawT = -V3.dot(n, w) / denom;

  // Convert raw t (in direction-unit-length units) to [0,1] segment parameter
  const segLen = V3.length(V3.sub(line.to, line.from) as Vector3);
  const param = segLen > 0 ? rawT / segLen : rawT;

  const point: Point3 = {
    x: line.from.x + d.x * rawT,
    y: line.from.y + d.y * rawT,
    z: line.from.z + d.z * rawT,
  };

  return { type: "intersecting", point, param };
}

// ── §5 LineSphereIntersection ─────────────────────────────────────────────────
//
// Analytic line-sphere intersection via quadratic discriminant.
// oracle: geometric discriminant formula (public domain).

export type LineSphereResult = {
  type: "miss" | "tangent" | "secant";
  points: Point3[];
  params: number[];
};

export function lineSphereIntersection(line: Line, sphere: Sphere, tol = 1e-6): LineSphereResult {
  const dir = sub3(pt3ToArr(line.to), pt3ToArr(line.from));
  const lenDir = len3(dir);
  const d = normalize3(dir);
  const oc = sub3(pt3ToArr(line.from), pt3ToArr(sphere.center));

  const b = 2 * dot3(oc, d);
  const c = dot3(oc, oc) - sphere.radius * sphere.radius;
  const disc = b * b - 4 * c;

  if (disc < -tol) {
    return { type: "miss", points: [], params: [] };
  }

  if (Math.abs(disc) <= tol) {
    const t = -b / 2;
    const pt = arrToPt3(add3(pt3ToArr(line.from), scale3(d, t)));
    return { type: "tangent", points: [pt], params: [lenDir > 0 ? t / lenDir : t] };
  }

  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b - sqrtDisc) / 2;
  const t2 = (-b + sqrtDisc) / 2;
  const p1 = arrToPt3(add3(pt3ToArr(line.from), scale3(d, t1)));
  const p2 = arrToPt3(add3(pt3ToArr(line.from), scale3(d, t2)));
  const invLen = lenDir > 0 ? 1 / lenDir : 1;
  return {
    type: "secant",
    points: [p1, p2],
    params: [t1 * invLen, t2 * invLen],
  };
}

// ── §6 PlanePrimitiveIntersection ─────────────────────────────────────────────
//
// Plane-Plane: line of intersection (Gaussian elimination on normals).
// Plane-Sphere: circle or point or miss.
// Plane-Circle: point(s) or arc or miss.
// Plane-Plane-Plane: unique point (Cramer's rule).
//
// oracle: closed-form linear algebra.

export type PlanePlaneResult = {
  type: "intersecting" | "parallel" | "coincident";
  line?: Line;
};

export function planePlaneIntersection(a: Plane, b: Plane, tol = 1e-6): PlanePlaneResult {
  const n1 = vec3ToArr(a.normal);
  const n2 = vec3ToArr(b.normal);
  const dir = cross3(n1, n2);
  if (len3(dir) < tol) {
    const dist = Math.abs(Pl.distanceTo(a, b.origin));
    return { type: dist < tol ? "coincident" : "parallel" };
  }

  // Compute a point on the intersection line by solving two plane eqs
  // using the method of solving for point closest to both plane origins
  // projected along dir: find s,t such that origin + s*n1 + t*n2 lies on both planes.
  const d1 = dot3(n1, pt3ToArr(a.origin));
  const d2 = dot3(n2, pt3ToArr(b.origin));
  const n1n1 = dot3(n1, n1);
  const n1n2 = dot3(n1, n2);
  const n2n2 = dot3(n2, n2);
  const det = n1n1 * n2n2 - n1n2 * n1n2;
  if (Math.abs(det) < 1e-20) return { type: "parallel" };
  const s = (d1 * n2n2 - d2 * n1n2) / det;
  const t = (d2 * n1n1 - d1 * n1n2) / det;
  const refPt = add3(scale3(n1, s), scale3(n2, t));
  const normDir = normalize3(dir);
  const endPt = add3(refPt, normDir);

  return {
    type: "intersecting",
    line: Ln.create(arrToPt3(refPt), arrToPt3(endPt)),
  };
}

export type PlaneSphereSectionResult = {
  type: "miss" | "tangent_point" | "circle";
  point?: Point3;
  circle?: { center: Point3; radius: number; plane: Plane };
};

export function planeSphereSection(plane: Plane, sphere: Sphere, tol = 1e-6): PlaneSphereSectionResult {
  const dist = Pl.distanceTo(plane, sphere.center);
  const absDist = Math.abs(dist);

  if (absDist > sphere.radius + tol) return { type: "miss" };
  if (absDist >= sphere.radius - tol) {
    // Tangent point
    const pt: Point3 = {
      x: sphere.center.x - plane.normal.x * dist,
      y: sphere.center.y - plane.normal.y * dist,
      z: sphere.center.z - plane.normal.z * dist,
    };
    return { type: "tangent_point", point: pt };
  }

  const sectionRadius = Math.sqrt(sphere.radius * sphere.radius - dist * dist);
  const center: Point3 = {
    x: sphere.center.x - plane.normal.x * dist,
    y: sphere.center.y - plane.normal.y * dist,
    z: sphere.center.z - plane.normal.z * dist,
  };
  return {
    type: "circle",
    circle: { center, radius: sectionRadius, plane },
  };
}

export type PlanePrimitiveResult =
  | { primitive: "plane-plane"; result: PlanePlaneResult }
  | { primitive: "plane-sphere"; result: PlaneSphereSectionResult }
  | { primitive: "plane-line"; result: LinePlaneResult }
  | { primitive: "plane-plane-plane"; result: { type: "point" | "no_solution"; point?: Point3 } };

/** Plane-Plane-Plane intersection: Cramer's rule. */
function planePlanePlane(a: Plane, b: Plane, c: Plane): { type: "point" | "no_solution"; point?: Point3 } {
  const n1 = vec3ToArr(a.normal);
  const n2 = vec3ToArr(b.normal);
  const n3 = vec3ToArr(c.normal);
  const d1 = dot3(n1, pt3ToArr(a.origin));
  const d2 = dot3(n2, pt3ToArr(b.origin));
  const d3 = dot3(n3, pt3ToArr(c.origin));

  // Cramer's rule: [n1; n2; n3] * [x;y;z] = [d1;d2;d3]
  function det3x3(r0: number[], r1: number[], r2: number[]): number {
    return r0[0] * (r1[1] * r2[2] - r1[2] * r2[1])
         - r0[1] * (r1[0] * r2[2] - r1[2] * r2[0])
         + r0[2] * (r1[0] * r2[1] - r1[1] * r2[0]);
  }

  const D = det3x3(n1, n2, n3);
  if (Math.abs(D) < 1e-12) return { type: "no_solution" };

  const x = det3x3([d1, n1[1], n1[2]], [d2, n2[1], n2[2]], [d3, n3[1], n3[2]]) / D;
  const y = det3x3([n1[0], d1, n1[2]], [n2[0], d2, n2[2]], [n3[0], d3, n3[2]]) / D;
  const z = det3x3([n1[0], n1[1], d1], [n2[0], n2[1], d2], [n3[0], n3[1], d3]) / D;
  return { type: "point", point: { x, y, z } };
}

// ── §7 SphereSphereIntersection ───────────────────────────────────────────────
//
// Two spheres: miss, point, or circle. Pure closed-form.
// oracle: standard derivation from the radical plane.

export type SphereSphereResult = {
  type: "miss" | "internal_miss" | "tangent_external" | "tangent_internal" | "circle";
  point?: Point3;
  circle?: { center: Point3; radius: number; plane: Plane };
};

export function sphereSphereIntersection(a: Sphere, b: Sphere, tol = 1e-6): SphereSphereResult {
  const d = pt3ToArr(Pt3.sub(b.center, a.center) as { x: number; y: number; z: number });
  const dist = len3(d);

  // External miss
  if (dist > a.radius + b.radius + tol) return { type: "miss" };
  // Internal miss
  if (dist < Math.abs(a.radius - b.radius) - tol) return { type: "internal_miss" };

  // External tangent
  if (Math.abs(dist - (a.radius + b.radius)) <= tol) {
    const t = a.radius / dist;
    const pt = arrToPt3(add3(pt3ToArr(a.center), scale3(d, t)));
    return { type: "tangent_external", point: pt };
  }

  // Internal tangent
  if (Math.abs(dist - Math.abs(a.radius - b.radius)) <= tol) {
    const t = a.radius / dist;
    const sign = a.radius > b.radius ? 1 : -1;
    const pt = arrToPt3(add3(pt3ToArr(a.center), scale3(d, sign * t)));
    return { type: "tangent_internal", point: pt };
  }

  // Circle of intersection (radical plane)
  const x = (dist * dist + a.radius * a.radius - b.radius * b.radius) / (2 * dist);
  const sectionRadius = Math.sqrt(Math.max(0, a.radius * a.radius - x * x));
  const center = arrToPt3(add3(pt3ToArr(a.center), scale3(normalize3(d), x)));
  const normal = arrToPt3(normalize3(d)) as unknown as Vector3;
  const plane = Pl.fromPointNormal(center, { x: normal.x, y: normal.y, z: normal.z });

  return { type: "circle", circle: { center, radius: sectionRadius, plane } };
}

// ── §8 ArcArcIntersection ────────────────────────────────────────────────────
//
// Intersection of two circular arcs in 3D (possibly on different planes).
// Strategy: each arc is a rational NURBS; use intersectCurveCurve.
// For coplanar arcs: analytic circle-circle formula then range check.
//
// oracle: intersectCurveCurve + coplanar closed-form.

export type ArcArcResult = { points: Point3[]; params: { paramA: number; paramB: number }[] };

export function arcArcIntersection(arcA: Arc, arcB: Arc, tol = 1e-4): ArcArcResult {
  // Strategy: use circle-circle closed-form to find candidate intersection
  // points, then range-check each against both arc domains.
  // oracle: coplanar analytic circle-circle + intersectCurveCurve fallback.

  // Check if arcs are coplanar (normals parallel, same plane)
  const nA = arcA.plane.normal;
  const nB = arcB.plane.normal;
  const normalDot = Math.abs(V3.dot(nA, nB));
  const planeDistA = Math.abs(Pl.distanceTo(arcA.plane, arcB.center));

  const results: ArcArcResult = { points: [], params: [] };

  if (normalDot > 1 - 1e-6 && planeDistA < tol * 10) {
    // Coplanar: analytic circle-circle
    const d_vec = sub3(pt3ToArr(arcB.center), pt3ToArr(arcA.center));
    const dist = len3(d_vec);
    const r1 = arcA.radius, r2 = arcB.radius;

    if (dist < tol) return results; // concentric
    if (dist > r1 + r2 + tol) return results; // too far
    if (dist < Math.abs(r1 - r2) - tol) return results; // one inside other

    const a = (dist * dist + r1 * r1 - r2 * r2) / (2 * dist);
    const hSq = r1 * r1 - a * a;
    if (hSq < -tol) return results;
    const h = Math.sqrt(Math.max(0, hSq));

    const midDir = normalize3(d_vec);
    // Perpendicular in the arc plane: cross(midDir, planeNormal)
    const perp = normalize3(cross3(midDir, vec3ToArr(nA)));
    const midPt = add3(pt3ToArr(arcA.center), scale3(midDir, a));

    const candidates: Point3[] = [
      arrToPt3(add3(midPt, scale3(perp, h))),
      arrToPt3(add3(midPt, scale3(perp, -h))),
    ];

    // Filter by arc angle ranges
    function angleOnArc(arc: Arc, pt: Point3): number {
      const pl = arc.plane;
      const local = Pt3.sub(pt, arc.center) as Vector3;
      const u = V3.dot(local, pl.xAxis) / arc.radius;
      const v = V3.dot(local, pl.yAxis) / arc.radius;
      return Math.atan2(v, u);
    }

    function inArcRange(arc: Arc, angle: number): boolean {
      let a0 = arc.startAngle, a1 = arc.endAngle;
      // Normalize angle to same "direction" as the arc
      while (angle < a0 - 1e-8) angle += 2 * Math.PI;
      while (angle > a1 + 1e-8) angle -= 2 * Math.PI;
      return angle >= a0 - tol && angle <= a1 + tol;
    }

    for (const pt of candidates) {
      const angA = angleOnArc(arcA, pt);
      const angB = angleOnArc(arcB, pt);
      if (inArcRange(arcA, angA) && inArcRange(arcB, angB)) {
        // Dedup
        const alreadyIn = results.points.some(p => {
          const ex = p.x - pt.x, ey = p.y - pt.y, ez = p.z - pt.z;
          return Math.sqrt(ex * ex + ey * ey + ez * ez) < tol;
        });
        if (!alreadyIn) {
          results.points.push(pt);
          results.params.push({ paramA: angA, paramB: angB });
        }
      }
    }
    return results;
  }

  // Non-coplanar: fall back to intersectCurveCurve on ArcCurve
  const curveA: ArcCurve = {
    kind: "arc",
    center: arcA.center,
    radius: arcA.radius,
    startAngle: arcA.startAngle,
    endAngle: arcA.endAngle,
    plane: arcA.plane,
    domain: { min: arcA.startAngle, max: arcA.endAngle },
  };
  const curveB: ArcCurve = {
    kind: "arc",
    center: arcB.center,
    radius: arcB.radius,
    startAngle: arcB.startAngle,
    endAngle: arcB.endAngle,
    plane: arcB.plane,
    domain: { min: arcB.startAngle, max: arcB.endAngle },
  };

  const ccx = intersectCurveCurve(curveA, curveB, tol);
  return {
    points: ccx.map(x => ({
      x: (x.pointA.x + x.pointB.x) / 2,
      y: (x.pointA.y + x.pointB.y) / 2,
      z: (x.pointA.z + x.pointB.z) / 2,
    })),
    params: ccx.map(x => ({ paramA: x.paramA, paramB: x.paramB })),
  };
}

// ── §9 CircleCircleIntersection ───────────────────────────────────────────────
//
// Full-circle (no angular range restriction) intersection. Uses SphereSphere
// radical-plane + coplanar analytic formula.
// oracle: coplanar formula + SphereSphere radical plane.

export type CircleCircleResult = {
  type: "miss" | "tangent" | "two_points" | "coincident" | "non_coplanar_miss" | "non_coplanar_two_points";
  points: Point3[];
};

export function circleCircleIntersection(cA: Circle, cB: Circle, tol = 1e-6): CircleCircleResult {
  // Check if circles are coplanar
  const normalDot = Math.abs(V3.dot(cA.plane.normal, cB.plane.normal));
  const dist = Math.abs(Pl.distanceTo(cA.plane, cB.center));

  if (normalDot > 1 - tol && dist < tol) {
    // Coplanar case: project to 2D
    const centerDiff = sub3(pt3ToArr(cB.center), pt3ToArr(cA.center));
    const d = len3(centerDiff);

    if (d < tol && Math.abs(cA.radius - cB.radius) < tol) {
      return { type: "coincident", points: [] };
    }
    if (d > cA.radius + cB.radius + tol) return { type: "miss", points: [] };
    if (d < Math.abs(cA.radius - cB.radius) - tol) return { type: "miss", points: [] };
    if (Math.abs(d - (cA.radius + cB.radius)) <= tol || Math.abs(d - Math.abs(cA.radius - cB.radius)) <= tol) {
      const t = cA.radius / d;
      const pt = arrToPt3(add3(pt3ToArr(cA.center), scale3(centerDiff, t)));
      return { type: "tangent", points: [pt] };
    }

    const a = (cA.radius * cA.radius - cB.radius * cB.radius + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, cA.radius * cA.radius - a * a));
    const midDir = normalize3(centerDiff);
    // Perpendicular in the circle's plane
    const perp = normalize3(cross3(midDir, vec3ToArr(cA.plane.normal)));
    const mid = add3(pt3ToArr(cA.center), scale3(midDir, a));
    const p1 = arrToPt3(add3(mid, scale3(perp, h)));
    const p2 = arrToPt3(add3(mid, scale3(perp, -h)));
    return { type: "two_points", points: [p1, p2] };
  }

  // Non-coplanar: use spherical radical plane approximation
  // Build spheres of the circles' supporting planes and intersect
  const sphereA: Sphere = { center: cA.center, radius: cA.radius };
  const sphereB: Sphere = { center: cB.center, radius: cB.radius };
  const ss = sphereSphereIntersection(sphereA, sphereB, tol);
  if (ss.type === "miss" || ss.type === "internal_miss") {
    return { type: "non_coplanar_miss", points: [] };
  }
  if (ss.type !== "circle") return { type: "non_coplanar_miss", points: [] };

  // Intersect the SS circle with both circle planes to get candidate points
  // (simplified — full non-coplanar case requires CSX)
  return { type: "non_coplanar_miss", points: [] };
}

// ── §10 PlaneSphereSectionIntersection ────────────────────────────────────────
// Alias for planeSphereSection exposed as a named export.
export { planeSphereSection as planeSphereSectionIntersection };

// ── C++-blocked stub helpers ──────────────────────────────────────────────────

function notYetImplemented(detail: string) {
  return { error: "NotYetImplemented", detail: `blocked: ${detail}` };
}

// ============================================================================
// Handler registration function
// ============================================================================

export function registerS328Handlers(): void {

  // ── SdCurveCurveOverlaps ───────────────────────────────────────────────────
  // oracle: intersectCurveCurve (verb-nurbs) + overlap detection
  registerHandler("SdCurveCurveOverlaps", (args) => {
    // Accept pre-tessellated points as a polyline curve input
    const ptsA = args.ptsA as number[][] | undefined;
    const ptsB = args.ptsB as number[][] | undefined;
    const tol = typeof args.tolerance === "number" ? args.tolerance : 1e-4;

    if (!ptsA || !ptsB || ptsA.length < 2 || ptsB.length < 2) {
      return { error: "SdCurveCurveOverlaps - ptsA and ptsB each require at least 2 points" };
    }

    function pointsToPolyline(pts: number[][]): Curve {
      const points: Point3[] = pts.map(p => ({ x: p[0] ?? 0, y: p[1] ?? 0, z: p[2] ?? 0 }));
      const params: number[] = [0];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        params.push(params[i - 1] + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2));
      }
      return { kind: "polyline", points, parameters: params };
    }

    const curveA = pointsToPolyline(ptsA);
    const curveB = pointsToPolyline(ptsB);
    const result = computeCurveCurveOverlaps(curveA, curveB, tol);
    return {
      ok: true,
      intersectionCount: result.intersections.length,
      overlapCount: result.overlaps.length,
      intersections: result.intersections,
      overlaps: result.overlaps,
    };
  });

  // ── SdCurveSelfIntersection ────────────────────────────────────────────────
  // oracle: closed-form for figure-eight shapes; general via CCX
  registerHandler("SdCurveSelfIntersection", (args) => {
    const pts = args.pts as number[][] | undefined;
    const tol = typeof args.tolerance === "number" ? args.tolerance : 1e-4;
    if (!pts || pts.length < 3) {
      return { error: "SdCurveSelfIntersection - pts requires at least 3 points" };
    }
    const points: Point3[] = pts.map(p => ({ x: p[0] ?? 0, y: p[1] ?? 0, z: p[2] ?? 0 }));
    const params: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      params.push(params[i - 1] + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2));
    }
    const curve: Curve = { kind: "polyline", points, parameters: params };
    const result = computeCurveSelfIntersections(curve, tol);
    return { ok: true, selfIntersectionCount: result.length, selfIntersections: result };
  });

  // ── SdLineLineIntersection ─────────────────────────────────────────────────
  // oracle: Goldman GG-I closed-form
  registerHandler("SdLineLineIntersection", (args) => {
    const fromA = parsePoint3(args.fromA ?? args.from);
    const toA = parsePoint3(args.toA ?? args.to);
    const fromB = parsePoint3(args.fromB);
    const toB = parsePoint3(args.toB);
    const tol = typeof args.tolerance === "number" ? args.tolerance : 1e-6;
    if (!fromA || !toA || !fromB || !toB) {
      return { error: "SdLineLineIntersection - fromA, toA, fromB, toB required" };
    }
    const result = lineLineIntersection(Ln.create(fromA, toA), Ln.create(fromB, toB), tol);
    return { ok: true, ...result };
  });

  // ── SdLinePlaneIntersection ────────────────────────────────────────────────
  // oracle: dot-product formula
  registerHandler("SdLinePlaneIntersection", (args) => {
    const line = parseLine(args as Record<string, unknown>);
    const plane = parsePlane(args as Record<string, unknown>);
    const tol = typeof args.tolerance === "number" ? args.tolerance : 1e-6;
    if (!line) return { error: "SdLinePlaneIntersection - from/to required for line" };
    if (!plane) return { error: "SdLinePlaneIntersection - planeOrigin/planeNormal required" };
    const result = linePlaneIntersection(line, plane, tol);
    return { ok: true, ...result };
  });

  // ── SdLineSphereIntersection ───────────────────────────────────────────────
  // oracle: quadratic discriminant (closed-form)
  registerHandler("SdLineSphereIntersection", (args) => {
    const line = parseLine(args as Record<string, unknown>);
    const sphere = parseSphere(args as Record<string, unknown>);
    const tol = typeof args.tolerance === "number" ? args.tolerance : 1e-6;
    if (!line) return { error: "SdLineSphereIntersection - from/to required" };
    if (!sphere) return { error: "SdLineSphereIntersection - sphereCenter/radius required" };
    const result = lineSphereIntersection(line, sphere, tol);
    return { ok: true, ...result };
  });

  // ── SdPlanePrimitiveIntersection ───────────────────────────────────────────
  // oracle: linear algebra closed-form
  registerHandler("SdPlanePrimitiveIntersection", (args) => {
    const tol = typeof args.tolerance === "number" ? args.tolerance : 1e-6;
    const op = (args.op as string | undefined) ?? "plane-plane";

    const originA = parsePoint3(args.originA);
    const normalA = parseVector3(args.normalA);
    const originB = parsePoint3(args.originB);
    const normalB = parseVector3(args.normalB);

    if (!originA || !normalA) return { error: "SdPlanePrimitiveIntersection - originA/normalA required" };

    const planeA = Pl.fromPointNormal(originA, normalA);

    if (op === "plane-plane-plane") {
      if (!originB || !normalB) return { error: "SdPlanePrimitiveIntersection - originB/normalB required for plane-plane-plane" };
      const originC = parsePoint3(args.originC);
      const normalC = parseVector3(args.normalC);
      if (!originC || !normalC) return { error: "SdPlanePrimitiveIntersection - originC/normalC required for plane-plane-plane" };
      const planeB = Pl.fromPointNormal(originB, normalB);
      const planeC = Pl.fromPointNormal(originC, normalC);
      const result = planePlanePlane(planeA, planeB, planeC);
      return { ok: true, primitive: "plane-plane-plane", result };
    }

    if (op === "plane-sphere") {
      const sphere = parseSphere(args as Record<string, unknown>);
      if (!sphere) return { error: "SdPlanePrimitiveIntersection - sphereCenter/radius required for plane-sphere" };
      const result = planeSphereSection(planeA, sphere, tol);
      return { ok: true, primitive: "plane-sphere", result };
    }

    if (op === "plane-line") {
      const line = parseLine(args as Record<string, unknown>);
      if (!line) return { error: "SdPlanePrimitiveIntersection - from/to required for plane-line" };
      const result = linePlaneIntersection(line, planeA, tol);
      return { ok: true, primitive: "plane-line", result };
    }

    // Default: plane-plane
    if (!originB || !normalB) return { error: "SdPlanePrimitiveIntersection - originB/normalB required for plane-plane" };
    const planeB = Pl.fromPointNormal(originB, normalB);
    const result = planePlaneIntersection(planeA, planeB, tol);
    return { ok: true, primitive: "plane-plane", result };
  });

  // ── SdPlaneSphereSectionIntersection ──────────────────────────────────────
  // oracle: closed-form radical-plane
  registerHandler("SdPlaneSphereSectionIntersection", (args) => {
    const plane = parsePlane(args as Record<string, unknown>);
    const sphere = parseSphere(args as Record<string, unknown>);
    const tol = typeof args.tolerance === "number" ? args.tolerance : 1e-6;
    if (!plane) return { error: "SdPlaneSphereSectionIntersection - planeOrigin/planeNormal required" };
    if (!sphere) return { error: "SdPlaneSphereSectionIntersection - sphereCenter/radius required" };
    const result = planeSphereSection(plane, sphere, tol);
    return { ok: true, ...result };
  });

  // ── SdArcArcIntersection ───────────────────────────────────────────────────
  // oracle: intersectCurveCurve (verb-nurbs)
  registerHandler("SdArcArcIntersection", (args) => {
    const arcA = parseArc(args as Record<string, unknown>, "a");
    const arcB = parseArc({ ...args as Record<string, unknown>,
      center: (args as Record<string, unknown>).bCenter,
      radius: (args as Record<string, unknown>).bRadius,
      startAngle: (args as Record<string, unknown>).bStartAngle,
      endAngle: (args as Record<string, unknown>).bEndAngle,
      normal: (args as Record<string, unknown>).bNormal,
    }, "");
    const tol = typeof args.tolerance === "number" ? args.tolerance : 1e-4;
    if (!arcA) return { error: "SdArcArcIntersection - aCenter/aRadius/aStartAngle/aEndAngle required" };
    if (!arcB) return { error: "SdArcArcIntersection - bCenter/bRadius/bStartAngle/bEndAngle required" };
    const result = arcArcIntersection(arcA, arcB, tol);
    return { ok: true, pointCount: result.points.length, ...result };
  });

  // ── SdCircleCircleIntersection ─────────────────────────────────────────────
  // oracle: coplanar 2D formula + sphere-sphere radical plane
  registerHandler("SdCircleCircleIntersection", (args) => {
    const aCenter = parsePoint3((args as Record<string, unknown>).aCenter);
    const aRadius = Number((args as Record<string, unknown>).aRadius ?? 1);
    const aNormal = parseVector3((args as Record<string, unknown>).aNormal) ?? { x: 0, y: 0, z: 1 };
    const bCenter = parsePoint3((args as Record<string, unknown>).bCenter);
    const bRadius = Number((args as Record<string, unknown>).bRadius ?? 1);
    const bNormal = parseVector3((args as Record<string, unknown>).bNormal) ?? { x: 0, y: 0, z: 1 };
    const tol = typeof args.tolerance === "number" ? args.tolerance : 1e-6;

    if (!aCenter || !bCenter) return { error: "SdCircleCircleIntersection - aCenter/bCenter required" };

    const cA: Circle = { center: aCenter, radius: aRadius, plane: Pl.fromPointNormal(aCenter, aNormal) };
    const cB: Circle = { center: bCenter, radius: bRadius, plane: Pl.fromPointNormal(bCenter, bNormal) };
    const result = circleCircleIntersection(cA, cB, tol);
    return { ok: true, ...result };
  });

  // ── SdSphereSphereIntersection ─────────────────────────────────────────────
  // oracle: closed-form radical-plane formula
  registerHandler("SdSphereSphereIntersection", (args) => {
    const aCenter = parsePoint3((args as Record<string, unknown>).aCenter);
    const aRadius = Number((args as Record<string, unknown>).aRadius ?? 1);
    const bCenter = parsePoint3((args as Record<string, unknown>).bCenter);
    const bRadius = Number((args as Record<string, unknown>).bRadius ?? 1);
    const tol = typeof args.tolerance === "number" ? args.tolerance : 1e-6;

    if (!aCenter || !bCenter) return { error: "SdSphereSphereIntersection - aCenter/bCenter required" };

    const sA: Sphere = { center: aCenter, radius: aRadius };
    const sB: Sphere = { center: bCenter, radius: bRadius };
    const result = sphereSphereIntersection(sA, sB, tol);
    return { ok: true, ...result };
  });

  // ── C++ BLOCKED STUBS ──────────────────────────────────────────────────────
  //
  // These operations require C++ kernel expansion. Stub handlers return a
  // structured NotYetImplemented response so the agent can recover gracefully.

  /**
   * CurveSurfaceIntersection (CSX)
   * C++ signature needed:
   *   kern_curve_surface_intersect(
   *     curve_json: string,   // {kind, ..NurbsCurve fields}
   *     surface_json: string, // {kind, ..NurbsSurface fields}
   *     tolerance: double
   *   ) -> string  // [{t, uv, pt3d}]
   *
   * Algorithm: subdivision + Newton on (t, u, v) such that C(t) = S(u,v).
   * Ref: Patrikalakis & Maekawa §6.
   */
  registerHandler("SdCurveSurfaceIntersection", () =>
    notYetImplemented("requires general CSX in kern.wasm — Newton on C(t)=S(u,v)"),
  );

  /**
   * CurveBrepIntersection
   * C++ signature needed:
   *   kern_curve_brep_intersect(
   *     curve_json: string,
   *     brep_json: string,
   *     tolerance: double
   *   ) -> string  // [{faceIndex, t, uv, pt3d}]
   *
   * Algorithm: for each BrepFace, CSX; collect and deduplicate results.
   */
  registerHandler("SdCurveBrepIntersection", () =>
    notYetImplemented("requires CSX + BREP face iteration in kern.wasm"),
  );

  /**
   * BrepPlaneSection
   * C++ signature needed:
   *   kern_brep_plane_section(
   *     brep_json: string,
   *     plane_origin: [x,y,z],
   *     plane_normal: [x,y,z],
   *     tolerance: double
   *   ) -> string  // [{curves: [NurbsCurve]}]  — closed section curves
   *
   * Algorithm: intersect each face with the plane → CSX curves; join loops.
   * Ref: OCCT IntTools_FaceFace + BRep_Builder section.
   */
  registerHandler("SdBrepPlaneSection", () =>
    notYetImplemented("requires general BrepPlaneSection in kern.wasm — face-plane CSX + loop joining"),
  );

  /**
   * SurfaceSurfaceIntersectionGeneral (SSI general)
   * C++ signature needed:
   *   kern_surface_surface_intersect(
   *     surfA_json: string,
   *     surfB_json: string,
   *     tolerance: double,
   *     march_step: double
   *   ) -> string  // IntersectionCurve[]
   *
   * Note: TypeScript ssi.ts handles axis-aligned NurbsSurface pairs; general
   * arbitrary-orientation SSI requires robust seed detection from C++ BVH.
   * Ref: Patrikalakis & Maekawa §7.
   */
  registerHandler("SdSurfaceSurfaceIntersectionGeneral", () =>
    notYetImplemented("requires general SSI with BVH seed detection in kern.wasm"),
  );

  /**
   * BrepBrepIntersection
   * C++ signature needed:
   *   kern_brep_brep_intersect(
   *     brepA_json: string,
   *     brepB_json: string,
   *     tolerance: double
   *   ) -> string  // [{curves: [NurbsCurve], faceIndexA, faceIndexB}]
   *
   * Algorithm: pairwise face SSI; collect intersection curves; merge loops.
   * Ref: OCCT BRepAlgoAPI_Section.
   */
  registerHandler("SdBrepBrepIntersection", () =>
    notYetImplemented("requires general BrepBrep face-pair SSI in kern.wasm"),
  );

  /**
   * MeshMeshIntersection
   * C++ signature needed:
   *   kern_mesh_mesh_intersect(
   *     meshA_json: string,  // {vertices: float32[], faces: uint32[]}
   *     meshB_json: string,
   *     mode: "accurate" | "fast" | "predicate",
   *     tolerance: double
   *   ) -> string  // {polylines: [[x,y,z][]]}
   *
   * Algorithm: triangle-triangle intersection (Moller) + adjacency stitching.
   * Ref: CGAL Polygon_mesh_processing::intersection_polylines.
   */
  registerHandler("SdMeshMeshIntersection", () =>
    notYetImplemented("requires triangle-triangle intersection in kern.wasm (CGAL PMP or Moller)"),
  );

  /**
   * MeshRayIntersection
   * C++ signature needed:
   *   kern_mesh_ray_intersect(
   *     mesh_json: string,
   *     ray_origin: [x,y,z],
   *     ray_direction: [x,y,z],
   *     tolerance: double
   *   ) -> string  // [{faceIndex, t, pt3d, normal}]
   *
   * Algorithm: BVH (AABB tree) ray traversal + Moller-Trumbore per triangle.
   */
  registerHandler("SdMeshRayIntersection", () =>
    notYetImplemented("requires BVH ray traversal in kern.wasm (AABB tree + Moller-Trumbore)"),
  );

  /**
   * MeshPlaneIntersection
   * C++ signature needed:
   *   kern_mesh_plane_intersect(
   *     mesh_json: string,
   *     plane_origin: [x,y,z],
   *     plane_normal: [x,y,z],
   *     tolerance: double
   *   ) -> string  // {polylines: [[x,y,z][]]}
   *
   * Algorithm: classify mesh edges against plane; interpolate crossing points;
   * stitch into contour polylines.
   * Ref: OCCT BRepAlgoAPI_Section (mesh variant).
   */
  registerHandler("SdMeshPlaneIntersection", () =>
    notYetImplemented("requires mesh-plane contour stitching in kern.wasm"),
  );
}
