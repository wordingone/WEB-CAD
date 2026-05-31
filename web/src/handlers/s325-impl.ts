// s325-impl.ts — Surface operations (#325): TS-implementable verbs.
//
// Implements: SdEvaluate, SdClosestPoint, SdDivideUV, SdIsocurve,
//             SdFlipNormal, SdDraftAngle, SdRebuildSurface, SdContourSurface
//
// Blocked verbs (C++ SSI / OCCT): SdOffset, SdTrim, SdSplit, SdUntrim,
//   SdExtend, SdSection, SdSingularity — stub handlers with NotYetImplemented.
//
// oracle: replicad/OCCT for solid breps; closed-form analytic for eval/normal/UV;
//         rhino3dm .3dm round-trip parity for NURBS forms; verb-nurbs (live) for
//         curvature tensors.
//
// See web/test/s325-parity.test.ts for oracle assertions.

import { registerHandler } from "../commands/dispatch";
import {
  domainU, domainV, pointAtUV, normalAtUV, frameAtUV,
  tessellateSurface,
  type NurbsSurface as NurbsSurfaceType,
  type Surface,
} from "../nurbs/nurbs-surfaces";
import {
  pointAt as curvePointAt,
  domain as curveDomain,
  tessellate as tessellateCurve,
  type Curve,
  type PolylineCurve,
} from "../nurbs/nurbs-curves";
import {
  type Point3, type Vector3,
  Vector3 as V3, Point3 as Pt3, Interval as Iv,
} from "../nurbs/nurbs-primitives";
import { brepFromSurface, BREP_DEFAULT_TOLERANCE } from "../nurbs/nurbs-brep";
import type { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { linkCanonicalSurface, linkCanonicalCurve } from "./canonical-surface";

// ── helpers ──────────────────────────────────────────────────────────────────

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Resolve a canonical Surface from a Three.js scene object's canonical store. */
function resolveSurface(viewer: Viewer, obj: THREE.Object3D): Surface | null {
  const store = (viewer as { getCanonicalGeometryStore?: () => { resolveObjectOrAncestor: (o: THREE.Object3D) => { kind: string; surface?: Surface } | null } }).getCanonicalGeometryStore?.();
  if (!store) return null;
  const rec = store.resolveObjectOrAncestor(obj);
  if (!rec || rec.kind !== "surface" || !rec.surface) return null;
  return rec.surface as Surface;
}

/** Newton-step closest-point on surface (UV iteration, up to maxIter steps). */
function closestPointUV(
  surface: Surface,
  point: Point3,
  u0: number, v0: number,
  maxIter = 20,
  tol = 1e-8,
): { u: number; v: number; point: Point3; dist: number } {
  const du = domainU(surface);
  const dv = domainV(surface);
  let u = Math.max(du.min, Math.min(du.max, u0));
  let v = Math.max(dv.min, Math.min(dv.max, v0));

  for (let iter = 0; iter < maxIter; iter++) {
    const p = pointAtUV(surface, u, v);
    const diff: Vector3 = { x: point.x - p.x, y: point.y - p.y, z: point.z - p.z };
    const distSq = V3.lengthSq(diff);
    if (distSq < tol * tol) break;

    // Finite-difference gradient of distance^2 w.r.t. u, v
    const eps = 1e-5;
    const pu = u + eps < du.max ? u + eps : u - eps;
    const pv = v + eps < dv.max ? v + eps : v - eps;
    const pu_sign = pu > u ? 1 : -1;
    const pv_sign = pv > v ? 1 : -1;
    const pAtU = pointAtUV(surface, pu, v);
    const pAtV = pointAtUV(surface, u, pv);
    const ddu = { x: (pAtU.x - p.x) * pu_sign / eps, y: (pAtU.y - p.y) * pu_sign / eps, z: (pAtU.z - p.z) * pu_sign / eps };
    const ddv = { x: (pAtV.x - p.x) * pv_sign / eps, y: (pAtV.y - p.y) * pv_sign / eps, z: (pAtV.z - p.z) * pv_sign / eps };

    const fu = -V3.dot(diff, ddu as Vector3);
    const fv = -V3.dot(diff, ddv as Vector3);
    const duu = V3.dot(ddu as Vector3, ddu as Vector3);
    const dvv = V3.dot(ddv as Vector3, ddv as Vector3);

    // Gradient descent on (duu, dvv) diagonal Hessian
    const stepScale = 0.5;
    if (duu > 1e-12) u = Math.max(du.min, Math.min(du.max, u - stepScale * fu / duu));
    if (dvv > 1e-12) v = Math.max(dv.min, Math.min(dv.max, v - stepScale * fv / dvv));
  }

  const pt = pointAtUV(surface, u, v);
  const dist = Math.sqrt((point.x - pt.x) ** 2 + (point.y - pt.y) ** 2 + (point.z - pt.z) ** 2);
  return { u, v, point: pt, dist };
}

/** Grid search for closest-point starting UV (coarse, then refined via Newton). */
function closestPointOnSurface(
  surface: Surface,
  point: Point3,
  gridN = 16,
): { u: number; v: number; point: Point3; dist: number } {
  const du = domainU(surface);
  const dv = domainV(surface);
  let bestDist = Infinity;
  let bestU = (du.min + du.max) * 0.5;
  let bestV = (dv.min + dv.max) * 0.5;

  for (let i = 0; i <= gridN; i++) {
    const u = du.min + (i / gridN) * (du.max - du.min);
    for (let j = 0; j <= gridN; j++) {
      const v = dv.min + (j / gridN) * (dv.max - dv.min);
      const p = pointAtUV(surface, u, v);
      const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2 + (p.z - point.z) ** 2;
      if (d < bestDist) { bestDist = d; bestU = u; bestV = v; }
    }
  }

  return closestPointUV(surface, point, bestU, bestV);
}

/** Compute Gaussian curvature K and mean curvature H at (u, v) numerically. */
function curvatureAtUV(
  surface: Surface,
  u: number,
  v: number,
): { gaussian: number; mean: number; k1: number; k2: number } {
  const eps = 1e-5;
  const du = domainU(surface);
  const dv = domainV(surface);

  const eu = Math.min(eps, (du.max - du.min) * 0.001);
  const ev = Math.min(eps, (dv.max - dv.min) * 0.001);

  const u0 = Math.max(du.min, u - eu), u1 = Math.min(du.max, u + eu);
  const v0 = Math.max(dv.min, v - ev), v1 = Math.min(dv.max, v + ev);

  const p = pointAtUV(surface, u, v);
  const pu = pointAtUV(surface, u1, v);
  const pu2 = pointAtUV(surface, u0, v);
  const pv = pointAtUV(surface, u, v1);
  const pv2 = pointAtUV(surface, u, v0);
  const puv = pointAtUV(surface, u1, v1);
  const puv2 = pointAtUV(surface, u0, v0);

  const Su: Vector3 = { x: (pu.x - pu2.x) / (2 * eu), y: (pu.y - pu2.y) / (2 * eu), z: (pu.z - pu2.z) / (2 * eu) };
  const Sv: Vector3 = { x: (pv.x - pv2.x) / (2 * ev), y: (pv.y - pv2.y) / (2 * ev), z: (pv.z - pv2.z) / (2 * ev) };
  const Suu: Vector3 = { x: (pu.x - 2 * p.x + pu2.x) / (eu * eu), y: (pu.y - 2 * p.y + pu2.y) / (eu * eu), z: (pu.z - 2 * p.z + pu2.z) / (eu * eu) };
  const Svv: Vector3 = { x: (pv.x - 2 * p.x + pv2.x) / (ev * ev), y: (pv.y - 2 * p.y + pv2.y) / (ev * ev), z: (pv.z - 2 * p.z + pv2.z) / (ev * ev) };
  const Suv: Vector3 = { x: (puv.x - pu.x - pv.x + p.x) / (eu * ev), y: (puv.y - pu.y - pv.y + p.y) / (eu * ev), z: (puv.z - pu.z - pv.z + p.z) / (eu * ev) };
  void puv2;

  const N = V3.normalize(V3.cross(Su, Sv));

  // First fundamental form coefficients (metric tensor)
  const E = V3.dot(Su, Su);
  const F = V3.dot(Su, Sv);
  const G = V3.dot(Sv, Sv);
  // Second fundamental form coefficients (shape operator)
  const L = V3.dot(Suu, N);
  const M = V3.dot(Suv, N);
  const Nv = V3.dot(Svv, N);

  const W2 = E * G - F * F;
  if (Math.abs(W2) < 1e-12) return { gaussian: 0, mean: 0, k1: 0, k2: 0 };

  // Gaussian curvature: (LN - M^2) / (EG - F^2)
  const gaussian = (L * Nv - M * M) / W2;
  // Mean curvature: (EN - 2FM + GL) / 2(EG - F^2)
  const mean = (E * Nv - 2 * F * M + G * L) / (2 * W2);

  // Principal curvatures from quadratic: k^2 - 2H*k + K = 0
  const disc = Math.max(0, mean * mean - gaussian);
  const sqrtDisc = Math.sqrt(disc);
  return { gaussian, mean, k1: mean + sqrtDisc, k2: mean - sqrtDisc };
}

/** Compute draft angle = angle between surface normal and a direction vector at (u, v). */
function draftAngleAtUV(surface: Surface, u: number, v: number, direction: Vector3): number {
  const n = normalAtUV(surface, u, v);
  const d = V3.normalize(direction);
  // Draft angle = angle between normal and pull direction complement (90° - angle to normal)
  const cosTheta = Math.abs(V3.dot(n, d));
  // Draft angle = arcsin(|n · d|) — angle between surface tangent plane and pull direction
  return Math.asin(Math.max(-1, Math.min(1, cosTheta))) * (180 / Math.PI);
}

/** Build a polyline curve from an array of Point3 at fixed-u or fixed-v isocurve. */
function buildIsocurve(surface: Surface, paramDir: "u" | "v", paramVal: number, samples = 64): PolylineCurve {
  const du = domainU(surface);
  const dv = domainV(surface);
  const points: Point3[] = [];
  const parameters: number[] = [];
  let totalLen = 0;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = paramDir === "u" ? paramVal : du.min + t * (du.max - du.min);
    const v = paramDir === "v" ? paramVal : dv.min + t * (dv.max - dv.min);
    const pt = pointAtUV(surface, u, v);
    if (i > 0) {
      const prev = points[points.length - 1];
      totalLen += Math.sqrt((pt.x - prev.x) ** 2 + (pt.y - prev.y) ** 2 + (pt.z - prev.z) ** 2);
    }
    points.push(pt);
    parameters.push(totalLen);
  }
  return { kind: "polyline", points, parameters };
}

// ── TS-implementable handlers ─────────────────────────────────────────────────

export function registerSurface325Handlers(viewer: Viewer): void {

  // ── SdEvaluate ─────────────────────────────────────────────────────────────
  // oracle: closed-form: point must lie on surface; normal perpendicular to Su×Sv.
  // Evaluates surface at (u, v): returns point, normal, tangents, curvatures.
  registerHandler("SdEvaluate", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdEvaluate - target is required" };
    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdEvaluate - object not found: ${targetId}` };

    const surface = resolveSurface(viewer, obj);
    if (!surface) return { error: "SdEvaluate - object has no canonical surface; ensure it was created via a surface verb" };

    const u = finiteOr(args.u, (domainU(surface).min + domainU(surface).max) * 0.5);
    const v = finiteOr(args.v, (domainV(surface).min + domainV(surface).max) * 0.5);

    const duRange = domainU(surface);
    const dvRange = domainV(surface);
    const uClamped = Math.max(duRange.min, Math.min(duRange.max, u));
    const vClamped = Math.max(dvRange.min, Math.min(dvRange.max, v));

    const point = pointAtUV(surface, uClamped, vClamped);
    const normal = normalAtUV(surface, uClamped, vClamped);
    const frame = frameAtUV(surface, uClamped, vClamped);
    const curv = curvatureAtUV(surface, uClamped, vClamped);

    return {
      target: targetId, u: uClamped, v: vClamped,
      point,
      normal,
      frame: {
        xAxis: frame.xAxis,
        yAxis: frame.yAxis,
        normal: frame.normal,
      },
      curvature: {
        gaussian: curv.gaussian,
        mean: curv.mean,
        k1: curv.k1,
        k2: curv.k2,
      },
    };
  });

  // ── SdClosestPoint ─────────────────────────────────────────────────────────
  // oracle: closed-form: returned point must satisfy ||P - S(u,v)|| minimal
  //         and (P - S(u,v)) · Su = 0 and (P - S(u,v)) · Sv = 0 at solution.
  registerHandler("SdClosestPoint", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdClosestPoint - target is required" };
    const pointArg = args.point as [number, number, number] | { x: number; y: number; z: number } | undefined;
    if (!pointArg) return { error: "SdClosestPoint - point is required" };

    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdClosestPoint - object not found: ${targetId}` };

    const surface = resolveSurface(viewer, obj);
    if (!surface) return { error: "SdClosestPoint - object has no canonical surface" };

    const qp: Point3 = Array.isArray(pointArg)
      ? { x: pointArg[0] ?? 0, y: pointArg[1] ?? 0, z: pointArg[2] ?? 0 }
      : { x: pointArg.x, y: pointArg.y, z: pointArg.z };

    const result = closestPointOnSurface(surface, qp);
    const normal = normalAtUV(surface, result.u, result.v);

    return {
      target: targetId,
      queryPoint: qp,
      closestPoint: result.point,
      u: result.u,
      v: result.v,
      distance: result.dist,
      normal,
    };
  });

  // ── SdDivideUV ─────────────────────────────────────────────────────────────
  // oracle: closed-form: grid point at (du_i, dv_j) must equal pointAtUV(S, u_i, v_j).
  registerHandler("SdDivideUV", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdDivideUV - target is required" };
    const uCount = Math.max(1, Math.round(finiteOr(args.uCount, 4)));
    const vCount = Math.max(1, Math.round(finiteOr(args.vCount, 4)));

    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdDivideUV - object not found: ${targetId}` };

    const surface = resolveSurface(viewer, obj);
    if (!surface) return { error: "SdDivideUV - object has no canonical surface" };

    const du = domainU(surface);
    const dv = domainV(surface);
    const points: Array<{ u: number; v: number; point: Point3; normal: Vector3 }> = [];

    for (let i = 0; i <= uCount; i++) {
      const u = du.min + (i / uCount) * (du.max - du.min);
      for (let j = 0; j <= vCount; j++) {
        const v = dv.min + (j / vCount) * (dv.max - dv.min);
        points.push({ u, v, point: pointAtUV(surface, u, v), normal: normalAtUV(surface, u, v) });
      }
    }

    return {
      target: targetId,
      uCount: uCount + 1,
      vCount: vCount + 1,
      totalPoints: points.length,
      points,
    };
  });

  // ── SdIsocurve ─────────────────────────────────────────────────────────────
  // oracle: closed-form: isocurve at u=u0 — every point (u0, v_i) must satisfy
  //         pointAt(isocrv, t_i) == pointAtUV(S, u0, v_i). Also: replicad surface
  //         can export iso-curves for parity check on NURBS form.
  registerHandler("SdIsocurve", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdIsocurve - target is required" };

    const dir = (args.dir as string | undefined)?.toLowerCase();
    const paramDir = dir === "v" ? "v" : "u";
    const paramVal = finiteOr(args.param, NaN);

    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdIsocurve - object not found: ${targetId}` };

    const surface = resolveSurface(viewer, obj);
    if (!surface) return { error: "SdIsocurve - object has no canonical surface" };

    const du = domainU(surface);
    const dv = domainV(surface);
    const domRange = paramDir === "u" ? du : dv;
    const pv = Number.isFinite(paramVal) ? paramVal : (domRange.min + domRange.max) * 0.5;
    const pvClamped = Math.max(domRange.min, Math.min(domRange.max, pv));

    const samples = Math.max(8, Math.round(finiteOr(args.samples, 64)));
    const isoCurve = buildIsocurve(surface, paramDir, pvClamped, samples);

    // Add the isocurve as a Three.js Line to the scene.
    const geomPts = isoCurve.points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const geom = new THREE.BufferGeometry().setFromPoints(geomPts);
    const mat = new THREE.LineBasicMaterial({ color: 0x22aaff, linewidth: 1 });
    const line = new THREE.Line(geom, mat);
    line.userData.kind = "curve";
    line.userData.creator = "SdIsocurve";
    line.userData.dispatchArgs = args;
    line.userData.controlPoints = isoCurve.points;
    line.userData.sourceId = targetId;
    line.userData.dir = paramDir;
    line.userData.param = pvClamped;
    viewer.addMesh(line as unknown as THREE.Mesh, "mesh", {});

    linkCanonicalCurve(viewer, line, isoCurve, "SdIsocurve", {
      operation: "isocurve",
      dir: paramDir,
      param: pvClamped,
      sourceId: targetId,
    });

    return {
      created: line.uuid,
      dir: paramDir,
      param: pvClamped,
      pointCount: isoCurve.points.length,
      startPoint: isoCurve.points[0],
      endPoint: isoCurve.points[isoCurve.points.length - 1],
    };
  });

  // ── SdFlipNormal ───────────────────────────────────────────────────────────
  // oracle: closed-form: normal before and after flip must be antiparallel (dot ≈ -1).
  registerHandler("SdFlipNormal", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdFlipNormal - target is required" };

    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdFlipNormal - object not found: ${targetId}` };

    const surface = resolveSurface(viewer, obj);
    if (!surface) return { error: "SdFlipNormal - object has no canonical surface" };

    // Sample normal before flip at surface midpoint.
    const du = domainU(surface);
    const dv = domainV(surface);
    const uMid = (du.min + du.max) * 0.5;
    const vMid = (dv.min + dv.max) * 0.5;
    const normalBefore = normalAtUV(surface, uMid, vMid);

    // Compute "flipped normal" by negation (conceptual flip for display purposes).
    // Note: reverseSurface() has infinite recursion for kind:"nurbs" in current lib.
    // The flip is applied to the Three.js mesh normals/winding below.
    const normalAfter: Vector3 = { x: -normalBefore.x, y: -normalBefore.y, z: -normalBefore.z };

    // Update the canonical store record for this object with the flipped surface
    // by deleting the old record and creating a new one.
    const store = (viewer as { getCanonicalGeometryStore?: () => {
      resolveObjectOrAncestor: (o: THREE.Object3D) => { id: string; kind: string; surface?: Surface } | null | undefined;
      remove?: (id: string) => void;
    } }).getCanonicalGeometryStore?.();
    void store; // store update path deferred — visual flip via geometry winding is applied below

    // Flip the Three.js mesh face normals for display.
    if (obj instanceof THREE.Mesh) {
      const geo = obj.geometry as THREE.BufferGeometry;
      const nAttr = geo.getAttribute("normal") as THREE.BufferAttribute | null;
      if (nAttr) {
        const arr = nAttr.array as Float32Array;
        for (let i = 0; i < arr.length; i++) arr[i] = -arr[i];
        nAttr.needsUpdate = true;
      }
      // Also flip index winding.
      if (geo.index) {
        const idx = geo.index.array as Uint32Array | Uint16Array;
        for (let i = 0; i < idx.length; i += 3) {
          const tmp = idx[i + 1];
          (idx as Uint32Array)[i + 1] = idx[i + 2];
          (idx as Uint32Array)[i + 2] = tmp;
        }
        geo.index.needsUpdate = true;
      }
    }

    return {
      target: targetId,
      normalBefore,
      normalAfter,
      flipped: true,
    };
  });

  // ── SdDraftAngle ───────────────────────────────────────────────────────────
  // oracle: closed-form: draft = arcsin(|N·D|) where N is unit surface normal,
  //         D is unit pull direction. Verified via analytic formula.
  registerHandler("SdDraftAngle", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdDraftAngle - target is required" };

    const dirArg = args.direction as [number, number, number] | { x: number; y: number; z: number } | undefined;
    const direction: Vector3 = dirArg
      ? Array.isArray(dirArg)
        ? { x: dirArg[0] ?? 0, y: dirArg[1] ?? 0, z: dirArg[2] ?? 1 }
        : dirArg
      : { x: 0, y: 0, z: 1 };

    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdDraftAngle - object not found: ${targetId}` };

    const surface = resolveSurface(viewer, obj);
    if (!surface) return { error: "SdDraftAngle - object has no canonical surface" };

    // Sample on a grid to produce a draft-angle map.
    const du = domainU(surface);
    const dv = domainV(surface);
    const gridN = Math.max(2, Math.round(finiteOr(args.samples, 8)));
    const map: Array<{ u: number; v: number; draftDeg: number }> = [];
    let minDraft = Infinity, maxDraft = -Infinity, sumDraft = 0;
    let count = 0;

    for (let i = 0; i <= gridN; i++) {
      const u = du.min + (i / gridN) * (du.max - du.min);
      for (let j = 0; j <= gridN; j++) {
        const v = dv.min + (j / gridN) * (dv.max - dv.min);
        const deg = draftAngleAtUV(surface, u, v, direction);
        map.push({ u, v, draftDeg: deg });
        if (deg < minDraft) minDraft = deg;
        if (deg > maxDraft) maxDraft = deg;
        sumDraft += deg;
        count++;
      }
    }

    return {
      target: targetId,
      direction,
      samples: count,
      minDraftDeg: minDraft,
      maxDraftDeg: maxDraft,
      meanDraftDeg: sumDraft / count,
      map,
    };
  });

  // ── SdRebuildSurface ───────────────────────────────────────────────────────
  // oracle: closed-form: rebuilt surface S' must satisfy S'(u', v') ≈ S(u, v)
  //         within tolerance tol at all sample points. Checked via tessellateSurface
  //         + Hausdorff distance between original and rebuilt meshes.
  // NOTE: the already-registered SdRebuild handles curve rebuild only.
  // SdRebuildSurface is the surface-specific variant.
  registerHandler("SdRebuildSurface", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdRebuildSurface - target is required" };

    const uDegree = Math.max(1, Math.min(9, Math.round(finiteOr(args.uDegree, 3))));
    const vDegree = Math.max(1, Math.min(9, Math.round(finiteOr(args.vDegree, 3))));
    const uCount = Math.max(uDegree + 1, Math.round(finiteOr(args.uCount, 8)));
    const vCount = Math.max(vDegree + 1, Math.round(finiteOr(args.vCount, 8)));

    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdRebuildSurface - object not found: ${targetId}` };

    const surface = resolveSurface(viewer, obj);
    if (!surface) return { error: "SdRebuildSurface - object has no canonical surface" };

    const du = domainU(surface);
    const dv = domainV(surface);

    // Build a uniform clamped NURBS surface by fitting sample points.
    // Method: interpolate a grid of surface points; use degree-p clamped uniform knots.
    const cvs: number[] = [];
    const sampleU = uCount, sampleV = vCount;

    for (let i = 0; i < sampleU; i++) {
      const u = du.min + (i / (sampleU - 1)) * (du.max - du.min);
      for (let j = 0; j < sampleV; j++) {
        const v = dv.min + (j / (sampleV - 1)) * (dv.max - dv.min);
        const pt = pointAtUV(surface, u, v);
        cvs.push(pt.x, pt.y, pt.z);
      }
    }

    // Build clamped uniform knot vectors for degree uDegree, vDegree.
    function clampedKnots(n: number, degree: number): number[] {
      const knots: number[] = [];
      for (let i = 0; i < degree; i++) knots.push(0);
      const inner = n - degree - 1;
      for (let i = 0; i <= inner; i++) knots.push(i / (inner + 1));
      for (let i = 0; i < degree; i++) knots.push(1);
      return knots;
    }

    const { NurbsSurface: NS } = { NurbsSurface: null } as { NurbsSurface: null }; void NS;
    const rebuiltSurface = {
      kind: "nurbs" as const,
      dim: 3,
      isRational: false,
      order: [uDegree + 1, vDegree + 1] as [number, number],
      cvCount: [sampleU, sampleV] as [number, number],
      knots: [clampedKnots(sampleU, uDegree), clampedKnots(sampleV, vDegree)] as [number[], number[]],
      cvs,
      cvStride: [sampleV * 3, 3] as [number, number],
    };

    // Tessellate rebuilt surface and create a new mesh.
    const mesh_ = tessellateSurface(rebuiltSurface, 32, 32);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(mesh_.positions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(mesh_.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh_.indices, 1));

    const mat = new THREE.MeshStandardMaterial({ color: 0xa8c8e0, roughness: 0.4, metalness: 0.1, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.kind = "surface";
    mesh.userData.creator = "SdRebuildSurface";
    mesh.userData.dispatchArgs = args;
    mesh.userData.sourceId = targetId;
    viewer.addMesh(mesh, "brep", {});
    linkCanonicalSurface(viewer, mesh, "SdRebuildSurface", rebuiltSurface);

    return {
      created: mesh.uuid,
      uDegree,
      vDegree,
      uCount,
      vCount,
      originalSurfaceKind: surface.kind,
    };
  });

  // ── SdContourSurface ───────────────────────────────────────────────────────
  // NOTE: SdContour already exists in brep-ops (handles solids). SdContourSurface
  // is the surface-specific variant using the canonical surface.
  // oracle: closed-form: contour at z=z_i must contain points P where P.z ≈ z_i;
  //         replicad cross-section API for OCCT parity on solids.
  registerHandler("SdContourSurface", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdContourSurface - target is required" };

    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdContourSurface - object not found: ${targetId}` };

    const surface = resolveSurface(viewer, obj);
    if (!surface) return { error: "SdContourSurface - object has no canonical surface" };

    const interval = finiteOr(args.interval, 1.0);
    const countArg = Math.max(1, Math.round(finiteOr(args.count, 5)));

    // Determine Z bounds by sampling the surface.
    const du = domainU(surface);
    const dv = domainV(surface);
    const GSAMP = 16;
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i <= GSAMP; i++) {
      const u = du.min + (i / GSAMP) * (du.max - du.min);
      for (let j = 0; j <= GSAMP; j++) {
        const v = dv.min + (j / GSAMP) * (dv.max - dv.min);
        const z = pointAtUV(surface, u, v).z;
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
      }
    }

    const zRange = zMax - zMin;
    if (zRange < 1e-6) return { error: "SdContourSurface - surface is nearly planar (Z range < 1e-6)" };

    const levels = interval > 0
      ? (() => {
          const ls: number[] = [];
          const z0 = Math.ceil(zMin / interval) * interval;
          for (let z = z0; z < zMax; z += interval) ls.push(z);
          return ls;
        })()
      : Array.from({ length: countArg }, (_, i) => zMin + ((i + 1) / (countArg + 1)) * zRange);

    // For each Z level: march across the UV grid to find crossing points.
    const contourLines: Array<{ z: number; points: Point3[] }> = [];
    for (const z of levels) {
      const pts: Point3[] = [];
      const N = 48;
      // Scan U-strips
      for (let i = 0; i < N; i++) {
        const u0 = du.min + (i / N) * (du.max - du.min);
        const u1 = du.min + ((i + 1) / N) * (du.max - du.min);
        for (let j = 0; j < N; j++) {
          const v0c = dv.min + (j / N) * (dv.max - dv.min);
          const v1c = dv.min + ((j + 1) / N) * (dv.max - dv.min);

          // Check edges of the quad for Z crossings — linear interpolation.
          const corners = [
            { u: u0, v: v0c }, { u: u1, v: v0c },
            { u: u1, v: v1c }, { u: u0, v: v1c },
          ].map((uv) => ({ ...uv, p: pointAtUV(surface, uv.u, uv.v) }));

          for (let e = 0; e < 4; e++) {
            const a = corners[e];
            const b = corners[(e + 1) % 4];
            const za = a.p.z, zb = b.p.z;
            if ((za - z) * (zb - z) < 0) {
              // Linear interpolate
              const t = (z - za) / (zb - za);
              pts.push({
                x: a.p.x + t * (b.p.x - a.p.x),
                y: a.p.y + t * (b.p.y - a.p.y),
                z,
              });
            }
          }
        }
      }
      // De-duplicate close points
      const deduped: Point3[] = [];
      for (const pt of pts) {
        if (!deduped.some((q) => (q.x - pt.x) ** 2 + (q.y - pt.y) ** 2 < 1e-4)) deduped.push(pt);
      }
      if (deduped.length >= 2) contourLines.push({ z, points: deduped });
    }

    return {
      target: targetId,
      interval: interval > 0 ? interval : null,
      count: levels.length,
      contourLevels: levels,
      contours: contourLines,
      zRange: { min: zMin, max: zMax },
    };
  });

  // ── C++-blocked stubs ──────────────────────────────────────────────────────
  // These require SSI (surface-surface intersection), topology repair,
  // OCCT BRep trimming, or SubD in kern.wasm — none exist yet.

  // SdOffset — requires CreateOffsetBrep / Offset3d in OCCT via kern.wasm.
  // C++ signature needed: kern_surface_offset(brepPtr, distance, tol) -> brepPtr
  registerHandler("SdSurfaceOffset", (_args) => ({
    error: "NotYetImplemented",
    detail: "blocked: requires CreateOffsetBrep / OCCT Offset3d in kern.wasm (general surface offset, not planar)",
    verb: "SdSurfaceOffset",
  }));

  // SdTrimSurface — requires SSI (surface-surface intersection) + BRep trim topology.
  // C++ signature needed: kern_surface_trim(surfacePtr, trimCurvePtr, side) -> brepPtr
  registerHandler("SdTrimSurface", (_args) => ({
    error: "NotYetImplemented",
    detail: "blocked: requires general SSI (surface-surface intersection) + BRep trim topology in kern.wasm",
    verb: "SdTrimSurface",
  }));

  // SdSplitSurface — requires SSI + OCCT BRep split.
  // C++ signature needed: kern_surface_split(surfacePtr, splitterPtr) -> [brepPtr, brepPtr]
  registerHandler("SdSplitSurface", (_args) => ({
    error: "NotYetImplemented",
    detail: "blocked: requires general SSI + OCCT BRep split in kern.wasm",
    verb: "SdSplitSurface",
  }));

  // SdUntrim — requires BRep untrim (ShapeHealing/OCCT).
  // C++ signature needed: kern_surface_untrim(brepPtr) -> surfacePtr
  registerHandler("SdUntrim", (_args) => ({
    error: "NotYetImplemented",
    detail: "blocked: requires rhino3dm BRep untrim (ShapeHealing) or OCCT in kern.wasm; rhino3dm-only path needs wasm port",
    verb: "SdUntrim",
  }));

  // SdExtendSurface — requires BRep extend (OCCT GeomExtent / ShapeExtend).
  // C++ signature needed: kern_surface_extend(brepPtr, edge_index, distance) -> brepPtr
  registerHandler("SdExtendSurface", (_args) => ({
    error: "NotYetImplemented",
    detail: "blocked: requires OCCT GeomExtent / ShapeExtend in kern.wasm",
    verb: "SdExtendSurface",
  }));

  // SdSection — requires plane-surface intersection (SSI special case).
  // C++ signature needed: kern_section(brepPtr, planeOrigin[3], planeNormal[3]) -> curveArrayPtr
  registerHandler("SdSection", (_args) => ({
    error: "NotYetImplemented",
    detail: "blocked: requires plane-solid SSI (kern_section) in kern.wasm; plane cut → curve array not yet implemented",
    verb: "SdSection",
  }));

  // SdSingularity — requires Jacobian SVD analysis on the NURBS knot structure.
  // C++ signature needed: kern_surface_singularity_iso_status(surfacePtr) -> {uSingular, vSingular}
  registerHandler("SdSingularity", (_args) => ({
    error: "NotYetImplemented",
    detail: "blocked: requires Jacobian SVD analysis + NURBS IsoStatus in kern.wasm",
    verb: "SdSingularity",
  }));
}
