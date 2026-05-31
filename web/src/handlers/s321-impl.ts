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

export function handle_SdBlendCurve(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): unknown {
  // oracle: replicad G0/G1/G2 blend
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires kern_blendCurve in kern.wasm — G0/G1/G2 continuity matching at curve endpoints",
    created: null,
  };
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
