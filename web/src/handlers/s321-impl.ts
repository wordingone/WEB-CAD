// s321-impl.ts — Curve creation & primitives (issue #321).
//
// Implements: SdBezier, SdSpiral, SdHelix, SdSubCurve
// Stubs (C++-blocked): kern_interpCurveOnSurface, kern_conicArc, kern_blendCurve
//
// oracle: closed-form math for spiral/helix/subcurve; verb-nurbs for bezier degree check.

import { registerHandler, registerRuntimeAlias } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import {
  Point3 as Prim3,
  Plane as PrimPlane,
  Vector3 as PrimVector3,
} from "../nurbs/nurbs-primitives";
import {
  tessellate,
  createClampedUniformNurbs,
  createInterpolatingCubicBSpline,
  trim as curveTrim,
  domain as curveDomain,
  pointAt,
  tangentAt,
  derivativeAt,
  type Curve,
  type NurbsCurve,
} from "../nurbs/nurbs-curves";
import { linkCanonicalCurve } from "./canonical-surface";

// ── helpers ──────────────────────────────────────────────────────────────────

function polylineGeom(pts: { x: number; y: number; z: number }[]): THREE.BufferGeometry {
  const flat = pts.flatMap((p) => [p.x, p.y, p.z]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  return geom;
}

function curveMat(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: 0x000000 });
}

function curveParameters(points: { x: number; y: number; z: number }[]): number[] {
  const params = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    params.push(
      params[i - 1] + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2),
    );
  }
  return params;
}

// ── SdBezier ─────────────────────────────────────────────────────────────────
//
// Rational/non-rational Bezier curve of any degree via de Casteljau (exact).
// Control points: required. Weights: optional (default all 1 → polynomial).
// Internally stored as a degree-n NurbsCurve with Bernstein knot vector.
//
// oracle: closed-form de Casteljau (degree-3 matches SdCurve catmull-rom at
//         control points when weights=1 and 4 control points, different interior).

export function buildBezierNurbs(
  controlPoints: { x: number; y: number; z: number }[],
  weights?: number[],
): NurbsCurve {
  const n = controlPoints.length;
  if (n < 2) throw new Error("SdBezier requires at least 2 control points");
  const degree = n - 1;
  const order = n;

  const isRational = weights !== undefined && weights.some((w) => Math.abs(w - 1) > 1e-10);
  const cvStride = isRational ? 4 : 3;

  // Bernstein (Bezier) knot vector: [0 repeated order times, 1 repeated order times]
  // OpenNURBS convention: length = order + cvCount - 2 = 2*order - 2
  const knots: number[] = [
    ...Array<number>(order - 1).fill(0),
    ...Array<number>(order - 1).fill(1),
  ];

  const cvs: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = weights?.[i] ?? 1;
    const p = controlPoints[i];
    if (isRational) {
      cvs.push(p.x * w, p.y * w, p.z * w, w);
    } else {
      cvs.push(p.x, p.y, p.z);
    }
  }

  return {
    kind: "nurbs",
    dim: 3,
    isRational,
    order,
    cvCount: n,
    knots,
    cvs,
    cvStride,
  };
}

export function handle_SdBezier(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const rawPts = (args.points as number[][] | undefined) ?? [];
    if (rawPts.length < 2) {
      return { error: "SdBezier requires at least 2 control points", created: null };
    }
    const controlPoints = rawPts.map((p) => Prim3.create(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0));
    const rawWeights = args.weights as number[] | undefined;
    const weights =
      rawWeights && rawWeights.length === controlPoints.length ? rawWeights : undefined;

    const nurbs = buildBezierNurbs(controlPoints, weights);
    // oracle: buildBezierNurbs is closed-form Bernstein; tessellate via de Boor
    const sampleCount = Math.max(64, controlPoints.length * 16);
    const pts = tessellate(nurbs, sampleCount);

    const obj = new THREE.Line(polylineGeom(pts), curveMat());
    obj.userData.kind = "bezier";
    obj.userData.creator = "bezier";
    obj.userData.controlPoints = controlPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    obj.userData.degree = nurbs.order - 1;

    linkCanonicalCurve(viewer, obj, nurbs, "SdBezier", {
      controlPoints: controlPoints.map((p) => [p.x, p.y, p.z]),
      weights: weights ?? null,
      degree: nurbs.order - 1,
      rational: nurbs.isRational,
    });
    viewer.addMesh(obj, "mesh");
    return {
      created: "bezier",
      degree: nurbs.order - 1,
      cvCount: controlPoints.length,
      rational: nurbs.isRational,
    };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── SdSpiral ─────────────────────────────────────────────────────────────────
//
// Archimedean spiral on a plane:
//   r(θ) = radiusStart + (radiusEnd - radiusStart) * (θ / totalAngle)
//   x(θ) = cx + r(θ) * cos(θ), y(θ) = cy + r(θ) * sin(θ)
//
// Parametric — no NURBS approximation needed for display; stored as polyline curve.
// oracle: closed-form r(θ); parity verified against Grasshopper Spiral component.

export function buildSpiralPolyline(
  center: { x: number; y: number; z: number },
  radiusStart: number,
  radiusEnd: number,
  turns: number,
  samples: number,
): { points: { x: number; y: number; z: number }[]; parameters: number[] } {
  const totalAngle = turns * 2 * Math.PI;
  const pts: { x: number; y: number; z: number }[] = [];
  const params: number[] = [];
  let arcLen = 0;
  let prev: { x: number; y: number; z: number } | null = null;

  for (let i = 0; i <= samples; i++) {
    const frac = i / samples;
    const theta = frac * totalAngle;
    const r = radiusStart + (radiusEnd - radiusStart) * frac;
    const x = center.x + r * Math.cos(theta);
    const y = center.y + r * Math.sin(theta);
    const z = center.z;
    const pt = { x, y, z };
    if (prev) arcLen += Math.sqrt((x - prev.x) ** 2 + (y - prev.y) ** 2);
    params.push(arcLen);
    pts.push(pt);
    prev = pt;
  }
  return { points: pts, parameters: params };
}

export function handle_SdSpiral(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const c = (args.center as number[] | undefined) ?? [0, 0, 0];
    const center = { x: c[0] ?? 0, y: c[1] ?? 0, z: c[2] ?? 0 };
    const radiusStart = (args.radiusStart as number | undefined) ?? (args.innerRadius as number | undefined) ?? 0;
    const radiusEnd = (args.radiusEnd as number | undefined) ?? (args.outerRadius as number | undefined) ?? 1;
    const turns = Math.max(0.01, (args.turns as number | undefined) ?? 3);
    const samples = Math.max(16, Math.floor(turns * 64));

    const { points, parameters } = buildSpiralPolyline(center, radiusStart, radiusEnd, turns, samples);

    const curve: Curve = { kind: "polyline", points, parameters };
    const obj = new THREE.Line(polylineGeom(points), curveMat());
    obj.userData.kind = "spiral";
    obj.userData.creator = "spiral";

    linkCanonicalCurve(viewer, obj, curve, "SdSpiral", {
      center: [center.x, center.y, center.z],
      radiusStart,
      radiusEnd,
      turns,
    });
    viewer.addMesh(obj, "mesh");
    return { created: "spiral", center: [center.x, center.y, center.z], radiusStart, radiusEnd, turns };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── SdHelix ──────────────────────────────────────────────────────────────────
//
// 3D helix along an axis:
//   x(θ) = cx + radius * cos(θ)
//   y(θ) = cy + radius * sin(θ)
//   z(θ) = zStart + pitch * θ / (2π)
//
// Parametric polyline. oracle: closed-form helix; parity vs Rhino Helix command.

export function buildHelixPolyline(
  center: { x: number; y: number; z: number },
  radius: number,
  pitch: number,
  turns: number,
  samples: number,
): { points: { x: number; y: number; z: number }[]; parameters: number[] } {
  const totalAngle = turns * 2 * Math.PI;
  const pts: { x: number; y: number; z: number }[] = [];
  const params: number[] = [];
  let arcLen = 0;
  let prev: { x: number; y: number; z: number } | null = null;

  for (let i = 0; i <= samples; i++) {
    const theta = (i / samples) * totalAngle;
    const x = center.x + radius * Math.cos(theta);
    const y = center.y + radius * Math.sin(theta);
    const z = center.z + (pitch * theta) / (2 * Math.PI);
    const pt = { x, y, z };
    if (prev) arcLen += Math.sqrt((x - prev.x) ** 2 + (y - prev.y) ** 2 + (z - prev.z) ** 2);
    params.push(arcLen);
    pts.push(pt);
    prev = pt;
  }
  return { points: pts, parameters: params };
}

export function handle_SdHelix(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const c = (args.center as number[] | undefined) ?? [0, 0, 0];
    const center = { x: c[0] ?? 0, y: c[1] ?? 0, z: c[2] ?? 0 };
    const radius = Math.max(1e-6, (args.radius as number | undefined) ?? 1);
    const pitch = (args.pitch as number | undefined) ?? 1;
    const turns = Math.max(0.01, (args.turns as number | undefined) ?? 3);
    const samples = Math.max(16, Math.floor(turns * 64));

    const { points, parameters } = buildHelixPolyline(center, radius, pitch, turns, samples);
    const curve: Curve = { kind: "polyline", points, parameters };
    const obj = new THREE.Line(polylineGeom(points), curveMat());
    obj.userData.kind = "helix";
    obj.userData.creator = "helix";

    linkCanonicalCurve(viewer, obj, curve, "SdHelix", {
      center: [center.x, center.y, center.z],
      radius,
      pitch,
      turns,
    });
    viewer.addMesh(obj, "mesh");
    return { created: "helix", center: [center.x, center.y, center.z], radius, pitch, turns };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── SdSubCurve ────────────────────────────────────────────────────────────────
//
// Extract a sub-domain of a curve by parameter interval [t0, t1].
// Supports inline curve descriptions (line/arc/polyline/nurbs kinds).
// oracle: closed-form trim; pointAt(subcurve, t) == pointAt(original, remap(t)).

function resolveCurveArg(arg: unknown): Curve {
  if (arg && typeof arg === "object" && !Array.isArray(arg)) {
    const obj = arg as Record<string, unknown>;
    if (obj.kind === "line" && Array.isArray(obj.from) && Array.isArray(obj.to)) {
      const [fx = 0, fy = 0, fz = 0] = obj.from as number[];
      const [tx = 0, ty = 0, tz = 0] = obj.to as number[];
      const len = Math.sqrt((tx - fx) ** 2 + (ty - fy) ** 2 + (tz - fz) ** 2);
      return {
        kind: "line",
        from: { x: fx, y: fy, z: fz },
        to: { x: tx, y: ty, z: tz },
        domain: { min: 0, max: len },
      };
    }
    if (obj.kind === "arc" && typeof obj.radius === "number") {
      const [cx = 0, cy = 0, cz = 0] = (obj.center as number[] | undefined) ?? [0, 0, 0];
      const r = obj.radius as number;
      const sa = (obj.startAngle as number) ?? 0;
      const ea = (obj.endAngle as number) ?? 2 * Math.PI;
      return {
        kind: "arc",
        center: { x: cx, y: cy, z: cz },
        radius: r,
        startAngle: sa,
        endAngle: ea,
        plane: PrimPlane.worldXY(),
        domain: { min: 0, max: r * Math.abs(ea - sa) },
      };
    }
    if (Array.isArray(obj.points) && (obj.points as unknown[]).length >= 2) {
      const pts = (obj.points as number[][]).map((p) => ({
        x: p[0] ?? 0,
        y: p[1] ?? 0,
        z: p[2] ?? 0,
      }));
      return { kind: "polyline", points: pts, parameters: curveParameters(pts) };
    }
    // NURBS kind
    if (
      obj.kind === "nurbs" &&
      typeof obj.order === "number" &&
      Array.isArray(obj.knots) &&
      Array.isArray(obj.cvs)
    ) {
      return {
        kind: "nurbs",
        dim: (obj.dim as number) ?? 3,
        isRational: (obj.isRational as boolean) ?? false,
        order: obj.order as number,
        cvCount: (obj.cvCount as number) ?? (obj.cvs as number[]).length / ((obj.cvStride as number) ?? 3),
        knots: obj.knots as number[],
        cvs: obj.cvs as number[],
        cvStride: (obj.cvStride as number) ?? 3,
      };
    }
  }
  throw new Error(`SdSubCurve: unrecognised curve description: ${JSON.stringify(arg)}`);
}

export function handle_SdSubCurve(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const baseCurve = resolveCurveArg(args.curve ?? args.source);
    const dom = curveDomain(baseCurve);
    const t0Raw = (args.t0 as number | undefined) ?? (args.start as number | undefined) ?? dom.min;
    const t1Raw = (args.t1 as number | undefined) ?? (args.end as number | undefined) ?? dom.max;
    const t0 = Math.max(dom.min, Math.min(dom.max, t0Raw));
    const t1 = Math.max(dom.min, Math.min(dom.max, t1Raw));
    if (Math.abs(t1 - t0) < 1e-12) {
      return { error: "SdSubCurve: t0 and t1 must be distinct", created: null };
    }
    const tMin = Math.min(t0, t1);
    const tMax = Math.max(t0, t1);
    const sub = curveTrim(baseCurve, { min: tMin, max: tMax });
    const sampleCount = Math.max(16, 64);
    const pts = tessellate(sub, sampleCount);
    const obj = new THREE.Line(polylineGeom(pts), curveMat());
    obj.userData.kind = "subcurve";
    obj.userData.creator = "subcurve";

    linkCanonicalCurve(viewer, obj, sub, "SdSubCurve", {
      domainStart: tMin,
      domainEnd: tMax,
    });
    viewer.addMesh(obj, "mesh");
    return { created: "subcurve", domainStart: tMin, domainEnd: tMax };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── SdNurbsCurve ─────────────────────────────────────────────────────────────
//
// Rational/non-rational NURBS from explicit control points + knots + weights.
// Exposes the full NURBS spec to the agent; no approximation.

export function handle_SdNurbsCurve(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const rawPts = (args.points as number[][] | undefined) ?? [];
    if (rawPts.length < 2) {
      return { error: "SdNurbsCurve requires at least 2 control points", created: null };
    }
    const controlPoints = rawPts.map((p) => Prim3.create(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0));
    const degree = Math.max(1, Math.min((args.degree as number | undefined) ?? 3, controlPoints.length - 1));
    const order = degree + 1;
    const weights = (args.weights as number[] | undefined);
    const isRational = weights !== undefined && weights.length === controlPoints.length
      && weights.some((w) => Math.abs(w - 1) > 1e-10);
    const cvStride = isRational ? 4 : 3;

    let knots = (args.knots as number[] | undefined);
    if (!knots) {
      // Auto-generate uniform clamped knot vector
      const n = controlPoints.length;
      const kLen = order + n - 2;
      const p = degree;
      knots = new Array(kLen).fill(0);
      const interior = n - order;
      for (let i = 0; i <= interior; i++) knots[p - 1 + i] = i / (interior + 1);
      for (let i = n - 1; i < kLen; i++) knots[i] = 1;
    }

    const cvs: number[] = [];
    for (let i = 0; i < controlPoints.length; i++) {
      const w = weights?.[i] ?? 1;
      const p = controlPoints[i];
      if (isRational) {
        cvs.push(p.x * w, p.y * w, p.z * w, w);
      } else {
        cvs.push(p.x, p.y, p.z);
      }
    }

    const nurbs: NurbsCurve = {
      kind: "nurbs",
      dim: 3,
      isRational,
      order,
      cvCount: controlPoints.length,
      knots,
      cvs,
      cvStride,
    };

    const pts = tessellate(nurbs, controlPoints.length * 16);
    const obj = new THREE.Line(polylineGeom(pts), curveMat());
    obj.userData.kind = "nurbs";
    obj.userData.creator = "nurbs-curve";
    obj.userData.controlPoints = controlPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    obj.userData.degree = degree;

    linkCanonicalCurve(viewer, obj, nurbs, "SdNurbsCurve", {
      controlPoints: controlPoints.map((p) => [p.x, p.y, p.z]),
      degree,
      rational: isRational,
    });
    viewer.addMesh(obj, "mesh");
    return { created: "nurbs-curve", degree, cvCount: controlPoints.length, rational: isRational };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── SdInterpCurve ─────────────────────────────────────────────────────────────
//
// Interpolating cubic B-spline through data points.
// Uses createInterpolatingCubicBSpline (Piegl & Tiller §9.1 chord-length).
// oracle: createInterpolatingCubicBSpline is the live oracle (P&T §9.1).

export function handle_SdInterpCurve(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const rawPts = (args.points as number[][] | undefined) ?? [];
    if (rawPts.length < 2) {
      return { error: "SdInterpCurve requires at least 2 points", created: null };
    }
    const pts = rawPts.map((p) => Prim3.create(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0));
    const closed = (args.closed as boolean | undefined) ?? false;
    const nurbs = createInterpolatingCubicBSpline(pts, { closed });
    const sampleCount = Math.max(64, pts.length * 16);
    const tess = tessellate(nurbs, sampleCount);
    const obj = new THREE.Line(polylineGeom(tess), curveMat());
    obj.userData.kind = "interp-curve";
    obj.userData.creator = "interp-curve";
    obj.userData.controlPoints = pts.map((p) => new THREE.Vector3(p.x, p.y, p.z));

    linkCanonicalCurve(viewer, obj, nurbs, "SdInterpCurve", {
      through: rawPts,
      closed,
    });
    viewer.addMesh(obj, "mesh");
    return { created: "interp-curve", pointCount: pts.length, closed };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── C++-blocked stubs ─────────────────────────────────────────────────────────
//
// kern_interpCurveOnSurface — requires surface-parameter geodesic walking:
//   C++ signature: kern_interpCurveOnSurface(surface: KernSurface, uvPoints: Float64Array, tangent_mode: u8) -> KernCurve
//   Requires: NURBS surface evaluation + UV geodesic integration in kern.wasm.
//
// kern_conicArc — rational quadratic for conic sections (ellipse/parabola/hyperbola):
//   C++ signature: kern_conicArc(p0: Point3, p1: Point3, p2: Point3, weight: f64) -> KernCurve
//   Requires: rational quadratic NURBS construction in kern.wasm.
//
// kern_blendCurve — G0/G1/G2 blend between two curves:
//   C++ signature: kern_blendCurve(cA: KernCurve, tA: f64, cB: KernCurve, tB: f64, continuity: u8) -> KernCurve
//   Requires: curve derivative evaluation + G1/G2 endpoint matching in kern.wasm.

export function handle_SdInterpCurveOnSurface(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): unknown {
  // oracle: replicad geodesic projection (InterpCurveOnSurface)
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires general SSI (surface-parameter geodesic walking) in kern.wasm — kern_interpCurveOnSurface",
    created: null,
  };
}

export function handle_SdConicArc(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): unknown {
  // oracle: closed-form rational quadratic per conic type
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires kern_conicArc in kern.wasm — rational quadratic construction for ellipse/parabola/hyperbola conic sections",
    created: null,
  };
}

// ── SdBlendCurve ─────────────────────────────────────────────────────────────
// G0/G1/G2 Hermite blend between two curve endpoints — pure TS, no C++ needed.
// G0: degree-1 line segment. G1: cubic Bezier (tangent match). G2: quintic Bezier (curvature match).

function parseCurveArg(raw: unknown, label: string): Curve {
  if (!raw || typeof raw !== "object") throw new Error(`${label}: expected curve object`);
  const obj = raw as Record<string, unknown>;
  if (obj["kind"] === "nurbs" && Array.isArray(obj["knots"]) && Array.isArray(obj["cvs"])) {
    return {
      kind: "nurbs",
      dim: (obj["dim"] as number) ?? 3,
      isRational: (obj["isRational"] as boolean) ?? false,
      order: obj["order"] as number,
      cvCount: typeof obj["cvCount"] === "number" ? (obj["cvCount"] as number)
        : (obj["cvs"] as number[]).length / ((obj["cvStride"] as number) ?? 3),
      knots: obj["knots"] as number[],
      cvs: obj["cvs"] as number[],
      cvStride: (obj["cvStride"] as number) ?? 3,
    } as Curve;
  }
  if (obj["kind"] === "line") {
    const f = obj["from"] as number[], t = obj["to"] as number[];
    const dx = t[0]-f[0], dy = t[1]-f[1], dz = (t[2]??0)-(f[2]??0);
    return { kind: "line",
      from: { x: f[0], y: f[1], z: f[2]??0 },
      to:   { x: t[0], y: t[1], z: t[2]??0 },
      domain: { min: 0, max: Math.sqrt(dx*dx + dy*dy + dz*dz) } };
  }
  if (Array.isArray(obj["points"])) {
    const pts = (obj["points"] as number[][]).map((p) => ({ x: p[0]??0, y: p[1]??0, z: p[2]??0 }));
    let len = 0;
    const params = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i-1], b = pts[i];
      len += Math.sqrt((b.x-a.x)**2 + (b.y-a.y)**2 + (b.z-a.z)**2);
      params.push(len);
    }
    return { kind: "polyline", points: pts, parameters: params };
  }
  throw new Error(`${label}: unrecognised curve format (kind=${String(obj["kind"])})`);
}

/** G0/G1/G2 Hermite blend NURBS — exported for unit tests. */
export function blendCurveNurbs(
  cA: Curve, tA: number,
  cB: Curve, tB: number,
  continuity: "G0" | "G1" | "G2",
): NurbsCurve {
  const P0 = pointAt(cA, tA);
  const P1 = pointAt(cB, tB);
  const dx = P1.x-P0.x, dy = P1.y-P0.y, dz = P1.z-P0.z;
  const chord = Math.sqrt(dx*dx + dy*dy + dz*dz);

  if (continuity === "G0") {
    return createClampedUniformNurbs(3, 2, [P0, P1]);
  }

  const T0 = tangentAt(cA, tA);
  const T1 = tangentAt(cB, tB);
  const s = chord > 1e-12 ? chord : 1;

  if (continuity === "G1") {
    return createClampedUniformNurbs(3, 4, [
      P0,
      { x: P0.x + T0.x*s/3, y: P0.y + T0.y*s/3, z: P0.z + T0.z*s/3 },
      { x: P1.x - T1.x*s/3, y: P1.y - T1.y*s/3, z: P1.z - T1.z*s/3 },
      P1,
    ]);
  }

  // G2: quintic Bezier — match curvature vectors κ*N = (a - (a·T̂)*T̂) / |v|²
  const dA = derivativeAt(cA, tA, 2);
  const dB = derivativeAt(cB, tB, 2);
  const v0 = dA[1], a0 = dA[2];
  const v1 = dB[1], a1 = dB[2];
  const l0sq = v0.x*v0.x + v0.y*v0.y + v0.z*v0.z;
  const l1sq = v1.x*v1.x + v1.y*v1.y + v1.z*v1.z;
  const d0 = a0.x*T0.x + a0.y*T0.y + a0.z*T0.z;
  const d1 = a1.x*T1.x + a1.y*T1.y + a1.z*T1.z;
  const k0 = l0sq > 1e-20
    ? { x:(a0.x-d0*T0.x)/l0sq, y:(a0.y-d0*T0.y)/l0sq, z:(a0.z-d0*T0.z)/l0sq }
    : { x:0, y:0, z:0 };
  const k1 = l1sq > 1e-20
    ? { x:(a1.x-d1*T1.x)/l1sq, y:(a1.y-d1*T1.y)/l1sq, z:(a1.z-d1*T1.z)/l1sq }
    : { x:0, y:0, z:0 };
  const s2_20 = s*s/20;
  return createClampedUniformNurbs(3, 6, [
    P0,
    { x: P0.x + T0.x*s/5,       y: P0.y + T0.y*s/5,       z: P0.z + T0.z*s/5 },
    { x: P0.x + 2*T0.x*s/5 + k0.x*s2_20, y: P0.y + 2*T0.y*s/5 + k0.y*s2_20, z: P0.z + 2*T0.z*s/5 + k0.z*s2_20 },
    { x: P1.x - 2*T1.x*s/5 + k1.x*s2_20, y: P1.y - 2*T1.y*s/5 + k1.y*s2_20, z: P1.z - 2*T1.z*s/5 + k1.z*s2_20 },
    { x: P1.x - T1.x*s/5,       y: P1.y - T1.y*s/5,       z: P1.z - T1.z*s/5 },
    P1,
  ]);
}

export function handle_SdBlendCurve(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const rawA = args["curveA"];
    const rawB = args["curveB"];
    if (!rawA || !rawB) {
      return { error: "SdBlendCurve: curveA and curveB are required", created: null };
    }
    const cA = parseCurveArg(rawA, "curveA");
    const cB = parseCurveArg(rawB, "curveB");
    const domA = curveDomain(cA);
    const domB = curveDomain(cB);
    const tA = typeof args["tA"] === "number" ? (args["tA"] as number) : domA.max;
    const tB = typeof args["tB"] === "number" ? (args["tB"] as number) : domB.min;
    const contRaw = String(args["continuity"] ?? "G1").toUpperCase();
    const continuity = (contRaw === "G0" || contRaw === "G2" ? contRaw : "G1") as "G0" | "G1" | "G2";

    const nurbs = blendCurveNurbs(cA, tA, cB, tB, continuity);
    const pts = tessellate(nurbs, Math.max(64, nurbs.cvCount * 16));
    const obj = new THREE.Line(polylineGeom(pts), curveMat());
    obj.userData.kind = "blend-curve";
    obj.userData.creator = "blend-curve";
    linkCanonicalCurve(viewer, obj, nurbs, "SdBlendCurve", { curveA: rawA, tA, curveB: rawB, tB, continuity });
    viewer.addMesh(obj, "mesh");
    return { created: "blend-curve", continuity };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── Registration entry point ─────────────────────────────────────────────────

export function registerS321Handlers(viewer: Viewer): void {
  registerHandler("SdBezier", (args) => handle_SdBezier(args, viewer));

  registerHandler("SdSpiral", (args) => handle_SdSpiral(args, viewer));

  registerRuntimeAlias("SdHelixCurve", "SdHelix");
  registerHandler("SdHelix", (args) => handle_SdHelix(args, viewer));

  registerRuntimeAlias("SdExtractDomain", "SdSubCurve");
  registerHandler("SdSubCurve", (args) => handle_SdSubCurve(args, viewer));

  registerRuntimeAlias("SdNurbs", "SdNurbsCurve");
  registerHandler("SdNurbsCurve", (args) => handle_SdNurbsCurve(args, viewer));

  registerRuntimeAlias("SdInterpolate", "SdInterpCurve");
  registerHandler("SdInterpCurve", (args) => handle_SdInterpCurve(args, viewer));

  // C++-blocked stubs — registered so dispatch returns structured errors
  registerHandler("SdInterpCurveOnSurface", (args) => handle_SdInterpCurveOnSurface(args, viewer));
  registerHandler("SdConicArc", (args) => handle_SdConicArc(args, viewer));
  registerHandler("SdBlendCurve", (args) => handle_SdBlendCurve(args, viewer));
}
