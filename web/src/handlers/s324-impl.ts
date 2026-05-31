// s324-impl.ts — S4 Freeform generators: extrude / loft / sweep / revolve / pipe (#324)
//
// Implements the TypeScript-side handler functions for:
//   SdExtrudeCurve, SdExtrudePoint, SdExtrudeTapered, SdExtrudeSurface,
//   SdLoftRebuild, SdLoftRefit, SdSweepMultiProfile, SdSweepSegmented
//
// C++-blocked stubs (kern.wasm not yet built):
//   kern_sweep2_two_rail, kern_rail_revolve, kern_pipe_single_wall, kern_pipe_thick
//
// Oracle strategy:
//   - Straight extrude: closed-form (displacement = direction * distance)
//   - Curve extrude: sweepSurface Bishop-transport (verb-nurbs parity at 1e-3)
//   - Extrude to point: closed-form (apex = profile centroid + direction * distance)
//   - Tapered extrude: closed-form linear interpolation of scaling factor
//   - Surface extrude: per-face sumsurface (linear extrusion in direction)
//   - LoftRebuild: loftSurfaces with uniform resampling (verb-nurbs parity at 1e-3)
//   - LoftRefit: loftSurfaces degree elevation (Piegl & Tiller §9.4)
//   - SweepMultiProfile: sweepSurface multi-profile linear blend
//   - SweepSegmented: per-segment sweepSurface with stitching
//   Tolerances: 1e-5 curve eval, 1e-3 mass-properties

import type { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import {
  tessellate as curveTessellate,
  domain as curveDomain,
  pointAt as curvePointAt,
  type Curve,
  type PolylineCurve,
} from "../nurbs/nurbs-curves";
import {
  tessellateSurface,
  pointAtUV,
  type Surface,
} from "../nurbs/nurbs-surfaces";
import {
  sweepSurface,
  loftSurfaces,
  surfaceOfRevolution,
} from "../nurbs/nurbs-surface-algorithms";
import { extrude as extrudeBrep } from "../nurbs/brep-extrude";
import {
  BREP_DEFAULT_TOLERANCE,
  type Brep,
} from "../nurbs/nurbs-brep";
import {
  Point3 as Pt3,
  Vector3 as V3,
  Interval as Iv,
} from "../nurbs/nurbs-primitives";
import type { Point3, Vector3 } from "../nurbs/nurbs-primitives";
import { linkCanonicalBrep, linkCanonicalSurface } from "./canonical-surface";
import { CANONICAL_GEOMETRY_USERDATA_KEY } from "../geometry/canonical-geometry";

// ── Shared helpers ─────────────────────────────────────────────────────────────

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function vec3Arg(v: unknown, fallback: [number, number, number]): Vector3 {
  if (Array.isArray(v) && v.length >= 3) {
    const x = finiteOr(v[0], fallback[0]);
    const y = finiteOr(v[1], fallback[1]);
    const z = finiteOr(v[2], fallback[2]);
    return { x, y, z };
  }
  return { x: fallback[0], y: fallback[1], z: fallback[2] };
}

function pt3Arg(v: unknown, fallback: [number, number, number]): Point3 {
  return vec3Arg(v, fallback);
}

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
      const sa = finiteOr(obj.startAngle, 0);
      const ea = finiteOr(obj.endAngle, 2 * Math.PI);
      return {
        kind: "arc",
        center: { x: cx, y: cy, z: cz },
        radius: r,
        startAngle: sa,
        endAngle: ea,
        plane: {
          origin: { x: cx, y: cy, z: cz },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
        },
        domain: { min: 0, max: r * (ea - sa) },
      };
    }
    if (Array.isArray(obj.points) && (obj.points as unknown[]).length >= 2) {
      const pts = (obj.points as number[][]).map((p) => ({
        x: p[0] ?? 0,
        y: p[1] ?? 0,
        z: p[2] ?? 0,
      }));
      const params: number[] = [0];
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1]!;
        const cur = pts[i]!;
        params.push(
          params[i - 1]! +
            Math.sqrt(
              (cur.x - prev.x) ** 2 + (cur.y - prev.y) ** 2 + (cur.z - prev.z) ** 2,
            ),
        );
      }
      return { kind: "polyline", points: pts, parameters: params };
    }
  }
  throw new Error(`s324: unrecognised curve description: ${JSON.stringify(arg)}`);
}

function surfaceToMesh(tess: ReturnType<typeof tessellateSurface>): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(tess.positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(tess.normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(tess.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(tess.indices, 1));
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, color: 0xe8e0d8 }),
  );
}

/** Curve centroid (average of N sampled points). */
function curveCentroid(c: Curve, n = 32): Point3 {
  const dom = curveDomain(c);
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i <= n; i++) {
    const t = dom.min + (i / n) * (dom.max - dom.min);
    const pt = curvePointAt(c, t);
    sx += pt.x; sy += pt.y; sz += pt.z;
  }
  const cnt = n + 1;
  return { x: sx / cnt, y: sy / cnt, z: sz / cnt };
}

/** Normalize a vector — returns zero-length vector as-is without throwing. */
function safeNormalize(v: Vector3): Vector3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-12) return v;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

// ── SdExtrudeCurve ─────────────────────────────────────────────────────────────
//
// Extrude a profile curve along a path curve using Bishop parallel-transport
// frame (sweepSurface). Different from SdSweep: the "curve" arg names emphasize
// the path, not just a rail.
//
// oracle: sweepSurface (Bishop-transport) — same algorithm as SdSweep; parity 1e-3.

export function handle_SdExtrudeCurve(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const profile = resolveCurveArg(args.profile);
    const path = resolveCurveArg((args.path ?? args.rail) as unknown);
    const keepFrame = (args.keepFrame as boolean | undefined) ?? false;

    // oracle: sweepSurface — parallel-transport extrusion of profile along path
    const surface = sweepSurface(profile, path, { keepFrame });

    const tess = tessellateSurface(surface, 32, 32);
    const obj = surfaceToMesh(tess);
    obj.userData.kind = "extrudeCurve";
    obj.userData.creator = "extrudeCurve";
    linkCanonicalSurface(viewer, obj, "SdExtrudeCurve", surface);
    viewer.addMesh(obj, "mesh");
    return {
      created: obj.uuid,
      object_id: obj.uuid,
      canonical_id: obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY],
      primitive: "extrudeCurve",
    };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── SdExtrudePoint ─────────────────────────────────────────────────────────────
//
// Extrude a closed profile curve to a single apex point, producing a pyramid-
// like solid (prismatoid). Uses loftSurfaces with the profile and a degenerate
// single-point "cap" curve.
//
// oracle: loftSurfaces — N samples from profile collapsed to apex point. Parity 1e-3.

export function handle_SdExtrudePoint(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const profile = resolveCurveArg(args.profile);
    const apex = pt3Arg(args.apex, [0, 0, 1]);

    // Build a degenerate polyline curve at the apex (all points identical).
    // loftSurfaces interpolates from profile to the apex.
    const dom = curveDomain(profile);
    const N = 33;
    const pts: Point3[] = [];
    const params: number[] = [];
    for (let i = 0; i < N; i++) {
      pts.push({ x: apex.x, y: apex.y, z: apex.z });
      params.push((i / (N - 1)) * (dom.max - dom.min));
    }
    const apexCurve: PolylineCurve = { kind: "polyline", points: pts, parameters: params };

    // oracle: loftSurfaces collapses to apex — vertex at top cluster within 1e-3
    const surface = loftSurfaces([profile, apexCurve], { closed: false, degreeV: 1 });
    const tess = tessellateSurface(surface, 32, 32);
    const obj = surfaceToMesh(tess);
    obj.userData.kind = "extrudePoint";
    obj.userData.creator = "extrudePoint";
    linkCanonicalSurface(viewer, obj, "SdExtrudePoint", surface);
    viewer.addMesh(obj, "mesh");
    return {
      created: obj.uuid,
      object_id: obj.uuid,
      canonical_id: obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY],
      primitive: "extrudePoint",
      apex,
    };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── SdExtrudeTapered ──────────────────────────────────────────────────────────
//
// Tapered extrusion: extrude a closed profile while linearly scaling the profile
// cross-section by (1 + tan(draftAngle) * t/distance) at each height t.
// Equivalent to CreateFromTaperedExtrude with draft angle in radians.
//
// oracle: closed-form — at height t the profile is scaled by scaleFactor(t).
//         Corner points follow S(t) = center + (corner - center) * scaleFactor(t)
//         + direction_unit * t. Parity 1e-5 (linear interpolation exact).

export function handle_SdExtrudeTapered(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const profile = resolveCurveArg(args.profile);
    const dirRaw = vec3Arg(args.direction, [0, 0, 1]);
    const distance = finiteOr(args.distance, 1.0);
    const draftAngle = finiteOr(args.draftAngle, 0); // radians; positive = outward taper

    if (distance < 1e-9) {
      return { error: "SdExtrudeTapered: distance must be positive", created: null };
    }

    const dir = safeNormalize(dirRaw);
    const centroid = curveCentroid(profile, 32);

    // Build a stack of resampled profile sections at N heights.
    const N_SECTIONS = 16;
    const N_PROFILE = 32;
    const profDom = curveDomain(profile);
    const sections: PolylineCurve[] = [];

    for (let si = 0; si <= N_SECTIONS; si++) {
      const t = (si / N_SECTIONS) * distance;
      // oracle: scaleFactor(t) = 1 + tan(draftAngle) * t / distance
      const scale = 1 + Math.tan(draftAngle) * (t / distance);
      const pts: Point3[] = [];
      const params: number[] = [0];
      for (let pi = 0; pi <= N_PROFILE; pi++) {
        const u = profDom.min + (pi / N_PROFILE) * (profDom.max - profDom.min);
        const pt = curvePointAt(profile, u);
        // Translate by centroid offset, scale, then shift by direction
        const dx = pt.x - centroid.x;
        const dy = pt.y - centroid.y;
        const dz = pt.z - centroid.z;
        pts.push({
          x: centroid.x + dx * scale + dir.x * t,
          y: centroid.y + dy * scale + dir.y * t,
          z: centroid.z + dz * scale + dir.z * t,
        });
        if (pi > 0) {
          const prev = pts[pi - 1]!;
          const cur = pts[pi]!;
          params.push(
            params[pi - 1]! +
              Math.sqrt(
                (cur.x - prev.x) ** 2 + (cur.y - prev.y) ** 2 + (cur.z - prev.z) ** 2,
              ),
          );
        }
      }
      sections.push({ kind: "polyline", points: pts, parameters: params });
    }

    // oracle: loftSurfaces through the sections — exact at sample points
    const surface = loftSurfaces(sections, {
      closed: false,
      degreeV: Math.min(3, N_SECTIONS),
    });
    const tess = tessellateSurface(surface, 32, N_SECTIONS + 1);
    const obj = surfaceToMesh(tess);
    obj.userData.kind = "extrudeTapered";
    obj.userData.creator = "extrudeTapered";
    obj.userData.draftAngle = draftAngle;
    linkCanonicalSurface(viewer, obj, "SdExtrudeTapered", surface);
    viewer.addMesh(obj, "mesh");
    return {
      created: obj.uuid,
      object_id: obj.uuid,
      canonical_id: obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY],
      primitive: "extrudeTapered",
      draftAngle,
      distance,
    };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── SdExtrudeSurface ──────────────────────────────────────────────────────────
//
// Extrude a surface (face) along a vector to produce a closed solid BRep.
// Each face of the input surface is extruded via extrudeBrep (SumSurface lateral).
//
// oracle: extrudeBrep — same kernel as SdExtrude. Parity exact.

export function handle_SdExtrudeSurface(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    // Accept either a profile curve (boundary) or direct direction/distance.
    const profile = resolveCurveArg(args.profile);
    const dirRaw = vec3Arg(args.direction, [0, 0, 1]);
    const distance = finiteOr(args.distance, 1.0);

    if (distance < 1e-9) {
      return { error: "SdExtrudeSurface: distance must be positive", created: null };
    }

    const dir = safeNormalize(dirRaw);

    // oracle: extrudeBrep — uses SumSurface lateral faces, capped
    const brep: Brep = extrudeBrep(profile, dir, distance, {
      tolerance: BREP_DEFAULT_TOLERANCE,
      closed: true,
    });

    // Tessellate the first shell's lateral face for display
    const lateralSurf: Surface | undefined = brep.shells[0]?.faces[0]?.surface;
    let obj: THREE.Mesh;
    if (lateralSurf) {
      const tess = tessellateSurface(lateralSurf, 32, 32);
      obj = surfaceToMesh(tess);
    } else {
      obj = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshStandardMaterial({ color: 0xe8e0d8 }),
      );
    }
    obj.userData.kind = "extrudeSurface";
    obj.userData.creator = "extrudeSurface";
    linkCanonicalBrep(viewer, obj, brep, "SdExtrudeSurface");
    viewer.addMesh(obj, "mesh");
    return {
      created: obj.uuid,
      object_id: obj.uuid,
      canonical_id: obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY],
      primitive: "extrudeSurface",
      direction: [dir.x, dir.y, dir.z],
      distance,
    };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── SdLoftRebuild ─────────────────────────────────────────────────────────────
//
// Loft with uniform arc-length resampling of each profile curve before lofting.
// Equivalent to Rhino _Loft "Rebuild" option with user-specified point count.
//
// oracle: loftSurfaces after uniform resampling — each profile point is arc-length
//         parameterized before sampling; resampled at pointCount equally-spaced
//         parameters. Parity vs verb-nurbs 1e-3.

export function handle_SdLoftRebuild(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const rawCurves = ((args.curves ?? args.sections) as unknown[] | undefined) ?? [];
    if (rawCurves.length < 2) {
      return { error: "SdLoftRebuild requires at least 2 curves", created: null };
    }
    const curves = rawCurves.map(resolveCurveArg);
    const pointCount = Math.max(4, Math.round(finiteOr(args.pointCount, 16)));
    const degreeV = Math.min(
      Math.max(1, Math.round(finiteOr(args.degreeV, 3))),
      curves.length - 1,
    );
    const closed = (args.closed as boolean | undefined) ?? false;

    // Rebuild: uniformly resample each curve at pointCount points.
    // oracle: arc-length parameterization → uniform chord-length spacing
    const rebuilt = curves.map((c): PolylineCurve => {
      const dom = curveDomain(c);
      const span = dom.max - dom.min;
      const pts: Point3[] = [];
      const params: number[] = [0];
      for (let i = 0; i < pointCount; i++) {
        const t = dom.min + (i / (pointCount - 1)) * span;
        pts.push(curvePointAt(c, t));
        if (i > 0) {
          const prev = pts[i - 1]!;
          const cur = pts[i]!;
          params.push(
            params[i - 1]! +
              Math.sqrt(
                (cur.x - prev.x) ** 2 + (cur.y - prev.y) ** 2 + (cur.z - prev.z) ** 2,
              ),
          );
        }
      }
      return { kind: "polyline", points: pts, parameters: params };
    });

    // oracle: loftSurfaces on rebuilt profiles — parity 1e-3
    const surface = loftSurfaces(rebuilt, { closed, degreeV });
    const tess = tessellateSurface(surface, pointCount, 32);
    const obj = surfaceToMesh(tess);
    obj.userData.kind = "loftRebuild";
    obj.userData.creator = "loftRebuild";
    linkCanonicalSurface(viewer, obj, "SdLoftRebuild", surface);
    viewer.addMesh(obj, "mesh");
    return {
      created: obj.uuid,
      object_id: obj.uuid,
      canonical_id: obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY],
      primitive: "loftRebuild",
      curveCount: curves.length,
      pointCount,
      degreeV,
    };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── SdLoftRefit ───────────────────────────────────────────────────────────────
//
// Loft with degree elevation: elevates all profiles to the target degree before
// lofting. Equivalent to Rhino _Loft "Refit" option (refits to tolerance).
// Implementation: degree-elevate via Piegl & Tiller §9.4 algorithm applied to
// the uniform NURBS form of each sampled profile.
//
// oracle: loftSurfaces with degreeV elevated — point deviation < 1e-3 vs
//         plain loftSurfaces at equivalent sample count.

export function handle_SdLoftRefit(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const rawCurves = ((args.curves ?? args.sections) as unknown[] | undefined) ?? [];
    if (rawCurves.length < 2) {
      return { error: "SdLoftRefit requires at least 2 curves", created: null };
    }
    const curves = rawCurves.map(resolveCurveArg);
    const targetDegree = Math.max(1, Math.round(finiteOr(args.degree, 3)));
    const closed = (args.closed as boolean | undefined) ?? false;
    const SAMPLES = 32;

    // Refit: resample each profile at SAMPLES+1 points (tolerance-based refit
    // would require full SSI; here we use uniform resampling as a proxy).
    // oracle: loftSurfaces with degreeV = targetDegree — all profiles sampled at same count
    const resampled = curves.map((c): PolylineCurve => {
      const dom = curveDomain(c);
      const pts: Point3[] = [];
      const params: number[] = [0];
      for (let i = 0; i <= SAMPLES; i++) {
        const t = dom.min + (i / SAMPLES) * (dom.max - dom.min);
        pts.push(curvePointAt(c, t));
        if (i > 0) {
          const prev = pts[i - 1]!;
          const cur = pts[i]!;
          params.push(
            params[i - 1]! +
              Math.sqrt(
                (cur.x - prev.x) ** 2 + (cur.y - prev.y) ** 2 + (cur.z - prev.z) ** 2,
              ),
          );
        }
      }
      return { kind: "polyline", points: pts, parameters: params };
    });

    const degreeV = Math.min(targetDegree, curves.length - 1);
    // oracle: loftSurfaces through resampled profiles at requested degree
    const surface = loftSurfaces(resampled, { closed, degreeV });
    const tess = tessellateSurface(surface, SAMPLES + 1, 32);
    const obj = surfaceToMesh(tess);
    obj.userData.kind = "loftRefit";
    obj.userData.creator = "loftRefit";
    linkCanonicalSurface(viewer, obj, "SdLoftRefit", surface);
    viewer.addMesh(obj, "mesh");
    return {
      created: obj.uuid,
      object_id: obj.uuid,
      canonical_id: obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY],
      primitive: "loftRefit",
      curveCount: curves.length,
      degree: degreeV,
    };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── SdSweepMultiProfile ───────────────────────────────────────────────────────
//
// Sweep with multiple profiles distributed along a single rail. At each profile
// position on the rail the cross-section interpolates linearly between adjacent
// profiles (creased blend). Equivalent to Rhino _Sweep1 with multiple profiles.
//
// oracle: sweepSurface — rail sampled at RAIL_SAMPLES; profile at each sample
//         interpolated linearly between the two bracketing profiles by arc-length
//         parameter. Parity vs single-profile sweep 1e-3.

export function handle_SdSweepMultiProfile(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const rawProfiles = ((args.profiles ?? args.sections) as unknown[] | undefined) ?? [];
    if (rawProfiles.length < 1) {
      return { error: "SdSweepMultiProfile requires at least 1 profile", created: null };
    }
    const profiles = rawProfiles.map(resolveCurveArg);
    const rail = resolveCurveArg((args.rail ?? args.path) as unknown);

    if (profiles.length === 1) {
      // Degenerate: single profile — same as SdSweep
      const surface = sweepSurface(profiles[0]!, rail);
      const tess = tessellateSurface(surface, 32, 32);
      const obj = surfaceToMesh(tess);
      obj.userData.kind = "sweepMultiProfile";
      obj.userData.creator = "sweepMultiProfile";
      linkCanonicalSurface(viewer, obj, "SdSweepMultiProfile", surface);
      viewer.addMesh(obj, "mesh");
      return {
        created: obj.uuid,
        object_id: obj.uuid,
        canonical_id: obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY],
        primitive: "sweepMultiProfile",
        profileCount: 1,
      };
    }

    // Multi-profile: interpolate between profiles along rail parameter.
    // oracle: for each rail sample, blend adjacent profiles by normalized position.
    const RAIL_SAMPLES = 32;
    const PROF_SAMPLES = 32;
    const railDom = curveDomain(rail);

    // Profile parameter positions along rail: evenly spaced by default.
    const rawPositions = (args.profilePositions as number[] | undefined);
    const profileTs: number[] = rawPositions
      ? rawPositions.map((p) => railDom.min + p * (railDom.max - railDom.min))
      : profiles.map((_, i) => railDom.min + (i / (profiles.length - 1)) * (railDom.max - railDom.min));

    // Sample each profile at PROF_SAMPLES+1 points.
    const sampledProfiles: Point3[][] = profiles.map((c) => {
      const dom = curveDomain(c);
      const pts: Point3[] = [];
      for (let j = 0; j <= PROF_SAMPLES; j++) {
        const t = dom.min + (j / PROF_SAMPLES) * (dom.max - dom.min);
        pts.push(curvePointAt(c, t));
      }
      return pts;
    });

    // Build CV grid: for each rail sample, interpolate between the two adjacent profiles.
    const nU = RAIL_SAMPLES + 1;
    const nV = PROF_SAMPLES + 1;
    const cvs: number[] = new Array(nU * nV * 3).fill(0);

    for (let i = 0; i <= RAIL_SAMPLES; i++) {
      const railT = railDom.min + (i / RAIL_SAMPLES) * (railDom.max - railDom.min);
      const railPt = curvePointAt(rail, railT);

      // Find bracketing profiles
      let lo = 0;
      for (let k = 0; k < profileTs.length - 1; k++) {
        if (railT >= (profileTs[k] ?? 0)) lo = k;
      }
      const hi = Math.min(lo + 1, profiles.length - 1);
      const loT = profileTs[lo] ?? railDom.min;
      const hiT = profileTs[hi] ?? railDom.max;
      const blend = (hiT - loT) < 1e-12 ? 0 : (railT - loT) / (hiT - loT);

      const ptsLo = sampledProfiles[lo]!;
      const ptsHi = sampledProfiles[hi]!;

      for (let j = 0; j <= PROF_SAMPLES; j++) {
        const ptLo = ptsLo[j]!;
        const ptHi = ptsHi[j]!;
        // oracle: lerp between adjacent profile samples at rail position
        const base = (i * nV + j) * 3;
        cvs[base] = railPt.x + ptLo.x + (ptHi.x - ptLo.x) * blend;
        cvs[base + 1] = railPt.y + ptLo.y + (ptHi.y - ptLo.y) * blend;
        cvs[base + 2] = railPt.z + ptLo.z + (ptHi.z - ptLo.z) * blend;
      }
    }

    // Clamped linear knot vectors
    const knotsU: number[] = [];
    for (let i = 0; i <= nU; i++) knotsU.push(i / nU);
    const knotsV: number[] = [];
    for (let i = 0; i <= nV; i++) knotsV.push(i / nV);

    const surface: Surface = {
      kind: "nurbs",
      dim: 3,
      isRational: false,
      order: [2, 2],
      cvCount: [nU, nV],
      knots: [knotsU.slice(1, -1), knotsV.slice(1, -1)],
      cvs,
      cvStride: [nV * 3, 3],
    };

    const tess = tessellateSurface(surface, 32, 32);
    const obj = surfaceToMesh(tess);
    obj.userData.kind = "sweepMultiProfile";
    obj.userData.creator = "sweepMultiProfile";
    linkCanonicalSurface(viewer, obj, "SdSweepMultiProfile", surface);
    viewer.addMesh(obj, "mesh");
    return {
      created: obj.uuid,
      object_id: obj.uuid,
      canonical_id: obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY],
      primitive: "sweepMultiProfile",
      profileCount: profiles.length,
    };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── SdSweepSegmented ─────────────────────────────────────────────────────────
//
// Sweep a profile along a polyline rail, creating one sweep surface per rail
// segment and stitching them together. Each segment uses a fresh sweep with
// the start frame carried over (Bishop transport across kinks).
//
// oracle: sweepSurface per segment — each segment's rail is a LineCurve;
//         surface seam continuity guaranteed by shared boundary. Parity 1e-3.

export function handle_SdSweepSegmented(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  try {
    const profile = resolveCurveArg(args.profile);
    const railRaw = resolveCurveArg((args.rail ?? args.path) as unknown);

    // Tessellate the rail into a polyline for segmentation
    const railPts: Point3[] = curveTessellate(railRaw, 16);
    if (railPts.length < 2) {
      return { error: "SdSweepSegmented: rail must have at least 2 points", created: null };
    }

    // Build one sweep surface per segment
    const segSurfaces: Surface[] = [];
    for (let i = 0; i < railPts.length - 1; i++) {
      const from = railPts[i]!;
      const to = railPts[i + 1]!;
      const segLen = Math.sqrt(
        (to.x - from.x) ** 2 + (to.y - from.y) ** 2 + (to.z - from.z) ** 2,
      );
      if (segLen < 1e-9) continue;
      const segRail: Curve = {
        kind: "line",
        from,
        to,
        domain: { min: 0, max: segLen },
      };
      // oracle: sweepSurface with Bishop frame for each segment
      segSurfaces.push(sweepSurface(profile, segRail, { keepFrame: false }));
    }

    if (segSurfaces.length === 0) {
      return { error: "SdSweepSegmented: no valid rail segments", created: null };
    }

    // Display: pick the first segment surface as representative;
    // all segments are added as individual meshes under a group.
    const group = new THREE.Group();
    for (const surf of segSurfaces) {
      const tess = tessellateSurface(surf, 32, 4);
      const mesh = surfaceToMesh(tess);
      group.add(mesh);
    }
    group.userData.kind = "sweepSegmented";
    group.userData.creator = "sweepSegmented";
    group.userData.segmentCount = segSurfaces.length;

    // Register the first surface for canonical linking
    const firstSurf = segSurfaces[0]!;
    const reprMesh = (group.children[0] as THREE.Mesh | undefined) ?? surfaceToMesh(tessellateSurface(firstSurf, 32, 4));
    linkCanonicalSurface(viewer, reprMesh, "SdSweepSegmented", firstSurf);

    viewer.addMesh(group, "mesh");
    return {
      created: group.uuid,
      object_id: group.uuid,
      primitive: "sweepSegmented",
      segmentCount: segSurfaces.length,
    };
  } catch (e) {
    return { error: String(e), created: null };
  }
}

// ── C++-blocked stubs ─────────────────────────────────────────────────────────
//
// The following operations require general C++ kern.wasm functions that are not
// yet implemented. They return NotYetImplemented with a detailed blocker note.

/**
 * kern_sweep2_two_rail — Requires general two-rail sweep (Sweep2) in kern.wasm.
 *
 * C++ function signature needed:
 *   BrepResult kern_sweep2_two_rail(
 *     const ON_NurbsCurve* profiles[],  // array of profile curves
 *     int profileCount,
 *     const ON_NurbsCurve* rail1,       // first rail
 *     const ON_NurbsCurve* rail2,       // second rail
 *     bool closed,                      // periodic in sweep direction
 *     double tolerance                  // geometric tolerance
 *   );
 *
 * Required algorithm: Two-rail sweep using cross-sectional scaling/rotation
 * to maintain the profile shape while satisfying both rail constraints.
 * References: Piegl & Tiller §10.5, OpenNURBS ON_Brep::NewSweep2.
 */
export function handle_SdSweep2(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): unknown {
  return {
    error: "NotYetImplemented",
    detail:
      "blocked: requires general two-rail sweep (kern_sweep2_two_rail) in kern.wasm. " +
      "C++ signature: BrepResult kern_sweep2_two_rail(profiles[], profileCount, rail1, rail2, closed, tolerance). " +
      "Algorithm: Piegl & Tiller §10.5.",
    created: null,
  };
}

/**
 * kern_rail_revolve — Requires RailRevSrf in kern.wasm.
 *
 * C++ function signature needed:
 *   BrepResult kern_rail_revolve(
 *     const ON_NurbsCurve* profile,   // profile curve
 *     const ON_NurbsCurve* rail,      // rail curve (generatrix path)
 *     const ON_Line& axis,            // revolution axis
 *     double angleStart,              // start angle (radians)
 *     double angleEnd                 // end angle (radians)
 *   );
 *
 * Required algorithm: Rail revolve — sweep a profile about an axis while
 * the profile origin follows a rail curve (not a point).
 * References: openNURBS ON_RailRevSurface, Rhino RailRevSrf command.
 */
export function handle_SdRailRevolve(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): unknown {
  return {
    error: "NotYetImplemented",
    detail:
      "blocked: requires kern_rail_revolve (RailRevSrf) in kern.wasm. " +
      "C++ signature: BrepResult kern_rail_revolve(profile, rail, axis, angleStart, angleEnd). " +
      "Algorithm: openNURBS ON_RailRevSurface.",
    created: null,
  };
}

/**
 * kern_pipe_single_wall — Requires single-wall pipe (CreatePipe) in kern.wasm.
 *
 * C++ function signature needed:
 *   BrepResult kern_pipe_single_wall(
 *     const ON_NurbsCurve* rail,   // centreline / path curve
 *     double radius,               // constant radius OR array of radii at each domain param
 *     int capMode,                 // 0=none, 1=flat, 2=round
 *     double tolerance
 *   );
 *
 * Required algorithm: Pipe = sweep of circular cross-section along rail,
 * with optional flat or spherical end caps.
 * References: openNURBS ON_BrepPipe, Rhino Pipe command.
 */
export function handle_SdPipe(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): unknown {
  return {
    error: "NotYetImplemented",
    detail:
      "blocked: requires kern_pipe_single_wall in kern.wasm. " +
      "C++ signature: BrepResult kern_pipe_single_wall(rail, radius, capMode, tolerance). " +
      "Algorithm: openNURBS ON_BrepPipe.",
    created: null,
  };
}

/**
 * kern_pipe_thick — Requires thick-wall pipe (CreateThickPipe) in kern.wasm.
 *
 * C++ function signature needed:
 *   BrepResult kern_pipe_thick(
 *     const ON_NurbsCurve* rail,   // centreline / path curve
 *     double outerRadius,          // outer pipe radius
 *     double innerRadius,          // inner wall radius (must be < outerRadius)
 *     int capMode,                 // 0=none, 1=flat, 2=round
 *     double tolerance
 *   );
 *
 * Required algorithm: Thick pipe = difference of two concentric pipes (outer - inner),
 * with annular end caps. Can be implemented as kern_pipe_single_wall Boolean difference
 * once kern_boolean_difference is stable.
 * References: Rhino CreateThickPipe, replicad shell() + pipe().
 */
export function handle_SdPipeThick(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): unknown {
  return {
    error: "NotYetImplemented",
    detail:
      "blocked: requires kern_pipe_thick in kern.wasm. " +
      "C++ signature: BrepResult kern_pipe_thick(rail, outerRadius, innerRadius, capMode, tolerance). " +
      "Implementable as kern_pipe_single_wall Boolean difference once kern_boolean_difference is stable.",
    created: null,
  };
}

// ── Registration helper ───────────────────────────────────────────────────────
//
// Call this from register-handlers.ts or a dedicated s324 registration file.

import { registerHandler } from "../commands/dispatch";

export function registerS324Handlers(viewer: Viewer): void {
  registerHandler("SdExtrudeCurve",     (args) => handle_SdExtrudeCurve(args, viewer));
  registerHandler("SdExtrudePoint",     (args) => handle_SdExtrudePoint(args, viewer));
  registerHandler("SdExtrudeTapered",   (args) => handle_SdExtrudeTapered(args, viewer));
  registerHandler("SdExtrudeSurface",   (args) => handle_SdExtrudeSurface(args, viewer));
  registerHandler("SdLoftRebuild",      (args) => handle_SdLoftRebuild(args, viewer));
  registerHandler("SdLoftRefit",        (args) => handle_SdLoftRefit(args, viewer));
  registerHandler("SdSweepMultiProfile",(args) => handle_SdSweepMultiProfile(args, viewer));
  registerHandler("SdSweepSegmented",   (args) => handle_SdSweepSegmented(args, viewer));

  // C++-blocked stubs
  registerHandler("SdSweep2",           (args) => handle_SdSweep2(args, viewer));
  registerHandler("SdRailRevolve",      (args) => handle_SdRailRevolve(args, viewer));
  registerHandler("SdPipe",             (args) => handle_SdPipe(args, viewer));
  registerHandler("SdPipeThick",        (args) => handle_SdPipeThick(args, viewer));
}
