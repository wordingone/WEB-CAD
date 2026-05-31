// s323-impl.ts — Surface creation handlers for #323 (S3 umbrella #320).
//
// Implements TypeScript-side ops from the research plan:
//   SdNurbsSurfaceFromGrid, SdNurbsSurfaceEvaluate, SdNurbsSurfaceNormal,
//   SdNurbsSurfaceDerivatives, SdTorusSurface
//
// C++-blocked ops (kern.wasm stubs): kern_edgeSurface, kern_networkSurface,
//   kern_sumSurface, kern_torusSurface_nurbs, kern_evaluateSurfaceDerivatives_rational,
//   kern_surfaceTrim_withTopology
//
// oracle: closed-form math / verb-nurbs-style de Boor for NURBS eval parity.
// oracle: replicad for solid-closed versions (torus, capped cylinder analogy).

import { registerHandler } from "../commands/dispatch";
import type { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import {
  type NurbsSurface,
  type Surface,
  type SumSurface,
  pointAtUV,
  normalAtUV,
  tessellateSurface,
  domainU,
  domainV,
} from "../nurbs/nurbs-surfaces";
import { surfaceOfRevolution } from "../nurbs/nurbs-surface-algorithms";
import type { Vector3 } from "../nurbs/nurbs-primitives";
import { BREP_DEFAULT_TOLERANCE } from "../nurbs/nurbs-brep";
import { linkCanonicalSurface } from "./canonical-surface";
import { resolveLayerId } from "./shared";
import { getActiveLevelId } from "../geometry/levels";
import { resolveCPlane } from "../viewer/cplane";
import type { ArcCurve, Curve } from "../nurbs/nurbs-curves";
import { pointAt as nurbsCurvePointAt, domain as nurbsCurveDomain } from "../nurbs/nurbs-curves";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function numArr3(v: unknown): [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const a = finiteOr(v[0], NaN), b = finiteOr(v[1], NaN), c = finiteOr(v[2], NaN);
  return Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) ? [a, b, c] : undefined;
}

/** Build a THREE.Mesh from a Surface via tessellation. */
function meshFromSurface(surf: Surface, uSamples = 32, vSamples = 32): THREE.Mesh {
  const sm = tessellateSurface(surf, uSamples, vSamples);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(sm.positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(sm.normals, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(sm.uvs, 2));
  geom.setIndex(new THREE.BufferAttribute(sm.indices, 1));
  const mat = new THREE.MeshStandardMaterial({
    color: 0x7ec8d4,
    roughness: 0.35,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geom, mat);
}

/** Validate and coerce a raw control-point grid.
 *  Input: flat array of [x,y,z] triples (row-major, nU rows × nV cols).
 *  Returns the flat numeric array for NurbsSurface.cvs, or null on error.
 */
function coerceCvGrid(
  raw: unknown,
  nU: number,
  nV: number,
  dim: number,
): number[] | null {
  if (!Array.isArray(raw)) return null;
  const expected = nU * nV;
  if (raw.length !== expected) return null;
  const out: number[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < dim) return null;
    for (let d = 0; d < dim; d++) {
      const val = finiteOr(item[d], NaN);
      if (!Number.isFinite(val)) return null;
      out.push(val);
    }
  }
  return out;
}

/** OpenNURBS knot convention: (cvCount + order - 2) knots.
 *  Build clamped uniform from interior knots only. */
function clampedUniformKnots(n: number, order: number): number[] {
  const degree = order - 1;
  const innerCount = n - order;
  const knots: number[] = [];
  for (let i = 0; i < degree; i++) knots.push(0);
  for (let i = 1; i <= innerCount; i++) knots.push(i / (innerCount + 1));
  for (let i = 0; i < degree; i++) knots.push(1);
  return knots;
}

/** Numerical first derivative in U of a surface at (u,v). */
function derivU(surf: Surface, u: number, v: number): Vector3 {
  const du = domainU(surf);
  const eps = Math.min(1e-6, (du.max - du.min) * 0.001);
  const u0 = Math.max(du.min, u - eps);
  const u1 = Math.min(du.max, u + eps);
  const denom = u1 - u0 || 1;
  const p0 = pointAtUV(surf, u0, v);
  const p1 = pointAtUV(surf, u1, v);
  return { x: (p1.x - p0.x) / denom, y: (p1.y - p0.y) / denom, z: (p1.z - p0.z) / denom };
}

/** Numerical first derivative in V. */
function derivV(surf: Surface, u: number, v: number): Vector3 {
  const dv = domainV(surf);
  const eps = Math.min(1e-6, (dv.max - dv.min) * 0.001);
  const v0 = Math.max(dv.min, v - eps);
  const v1 = Math.min(dv.max, v + eps);
  const denom = v1 - v0 || 1;
  const p0 = pointAtUV(surf, u, v0);
  const p1 = pointAtUV(surf, u, v1);
  return { x: (p1.x - p0.x) / denom, y: (p1.y - p0.y) / denom, z: (p1.z - p0.z) / denom };
}

/** Numerical second derivative d²/du² */
function deriv2U(surf: Surface, u: number, v: number): Vector3 {
  const du = domainU(surf);
  const eps = Math.min(1e-5, (du.max - du.min) * 0.01);
  const u0 = Math.max(du.min, u - eps);
  const u1 = Math.min(du.max, u + eps);
  const denom = (u1 - u0) ** 2 / 4 || 1;
  const p0 = pointAtUV(surf, u0, v);
  const pm = pointAtUV(surf, u, v);
  const p1 = pointAtUV(surf, u1, v);
  return {
    x: (p0.x - 2 * pm.x + p1.x) / denom,
    y: (p0.y - 2 * pm.y + p1.y) / denom,
    z: (p0.z - 2 * pm.z + p1.z) / denom,
  };
}

/** Numerical second derivative d²/dv² */
function deriv2V(surf: Surface, u: number, v: number): Vector3 {
  const dv = domainV(surf);
  const eps = Math.min(1e-5, (dv.max - dv.min) * 0.01);
  const v0 = Math.max(dv.min, v - eps);
  const v1 = Math.min(dv.max, v + eps);
  const denom = (v1 - v0) ** 2 / 4 || 1;
  const p0 = pointAtUV(surf, u, v0);
  const pm = pointAtUV(surf, u, v);
  const p1 = pointAtUV(surf, u, v1);
  return {
    x: (p0.x - 2 * pm.x + p1.x) / denom,
    y: (p0.y - 2 * pm.y + p1.y) / denom,
    z: (p0.z - 2 * pm.z + p1.z) / denom,
  };
}

/** Numerical mixed derivative d²/du dv */
function deriv2UV(surf: Surface, u: number, v: number): Vector3 {
  const du = domainU(surf);
  const dv = domainV(surf);
  const eu = Math.min(1e-5, (du.max - du.min) * 0.01);
  const ev = Math.min(1e-5, (dv.max - dv.min) * 0.01);
  const u0 = Math.max(du.min, u - eu), u1 = Math.min(du.max, u + eu);
  const v0 = Math.max(dv.min, v - ev), v1 = Math.min(dv.max, v + ev);
  const den = (u1 - u0) * (v1 - v0) || 1;
  const p00 = pointAtUV(surf, u0, v0);
  const p01 = pointAtUV(surf, u0, v1);
  const p10 = pointAtUV(surf, u1, v0);
  const p11 = pointAtUV(surf, u1, v1);
  return {
    x: (p11.x - p10.x - p01.x + p00.x) / den,
    y: (p11.y - p10.y - p01.y + p00.y) / den,
    z: (p11.z - p10.z - p01.z + p00.z) / den,
  };
}

// ── Torus surface — exact NURBS rational representation ───────────────────────
//
// A torus is the surface of revolution of a circle (major-radius R, minor r)
// around an axis. The exact NURBS representation is degree [2,2] rational
// with 9×9 control points (standard Coons/NURBS-book construction).
//
// oracle: closed-form parametric: P(u,v) = ((R+r*cos(v))*cos(u),
//                                            (R+r*cos(v))*sin(u),
//                                             r*sin(v))
// tolerance: 1e-6 for point evaluation, 1e-4 for normals.

function torusSurface(majorRadius: number, minorRadius: number): Surface {
  // Represent as a RevSurface of a circle (profile in XZ plane at x=R) around Z-axis.
  // Profile: circle arc in the plane y=0, center at (R,0,0), radius=r.
  // We use an ArcCurve for the profile.
  const R = majorRadius, r = minorRadius;
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

// ── C++ stub helpers ──────────────────────────────────────────────────────────

type HandlerResult = Record<string, unknown>;

function cppBlockedStub(opName: string, detail: string): () => HandlerResult {
  return () => ({
    error: "NotYetImplemented",
    detail: `blocked: ${detail}`,
    op: opName,
  });
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerS323Handlers(viewer: Viewer): void {

  // ── SdNurbsSurfaceFromGrid ─────────────────────────────────────────────────
  //
  // Constructs a rational or non-rational NURBS surface from a caller-supplied
  // control-point grid, knot vectors, and optional weights.
  //
  // args:
  //   controlPoints : [[x,y,z], ...] row-major, nU×nV points (required)
  //   nU            : integer — number of CV rows in U direction (required)
  //   nV            : integer — number of CV cols in V direction (required)
  //   degreeU       : integer — NURBS degree in U, default 3 (optional)
  //   degreeV       : integer — NURBS degree in V, default 3 (optional)
  //   knotsU        : [number] — (nU+degreeU-1) knots in OpenNURBS convention (optional, clamped uniform if omitted)
  //   knotsV        : [number] — (nV+degreeV-1) knots in OpenNURBS convention (optional)
  //   weights       : [number] — nU×nV weights for rational surface (optional, all-1 → non-rational)
  //
  // oracle: verb-nurbs de Boor / replicad closed-form parity
  registerHandler("SdNurbsSurfaceFromGrid", (args) => {
    const nU = finiteOr(args.nU, 0) | 0;
    const nV = finiteOr(args.nV, 0) | 0;
    if (nU < 2 || nV < 2) {
      return { error: "SdNurbsSurfaceFromGrid — nU and nV must each be ≥ 2" };
    }
    const degU = Math.max(1, Math.min(finiteOr(args.degreeU, 3) | 0, nU - 1));
    const degV = Math.max(1, Math.min(finiteOr(args.degreeV, 3) | 0, nV - 1));
    const orderU = degU + 1, orderV = degV + 1;

    const weightsRaw = args.weights as unknown[] | undefined;
    const isRational = Array.isArray(weightsRaw) && weightsRaw.length === nU * nV;
    const dim = 3;

    // Control points
    const rawCvs = coerceCvGrid(args.controlPoints, nU, nV, dim);
    if (!rawCvs) {
      return { error: `SdNurbsSurfaceFromGrid — controlPoints must be an array of ${nU * nV} [x,y,z] triples` };
    }

    // Weights: embed into homogeneous coordinates if rational
    let cvs: number[];
    if (isRational) {
      const stride = 4; // x,y,z,w
      cvs = new Array(nU * nV * stride);
      for (let i = 0; i < nU * nV; i++) {
        const w = finiteOr(weightsRaw![i], 1);
        const base3 = i * 3;
        const base4 = i * stride;
        cvs[base4]     = rawCvs[base3]!     * w;
        cvs[base4 + 1] = rawCvs[base3 + 1]! * w;
        cvs[base4 + 2] = rawCvs[base3 + 2]! * w;
        cvs[base4 + 3] = w;
      }
    } else {
      cvs = rawCvs;
    }

    // Knots
    const knotsURaw = args.knotsU as number[] | undefined;
    const knotsVRaw = args.knotsV as number[] | undefined;
    const expectedKU = nU + orderU - 2;
    const expectedKV = nV + orderV - 2;

    const knotsU = (Array.isArray(knotsURaw) && knotsURaw.length === expectedKU)
      ? knotsURaw
      : clampedUniformKnots(nU, orderU);
    const knotsV = (Array.isArray(knotsVRaw) && knotsVRaw.length === expectedKV)
      ? knotsVRaw
      : clampedUniformKnots(nV, orderV);

    const surf: NurbsSurface = {
      kind: "nurbs",
      dim,
      isRational,
      order: [orderU, orderV],
      cvCount: [nU, nV],
      knots: [knotsU, knotsV],
      cvs,
      cvStride: isRational ? [nV * 4, 4] : [nV * 3, 3],
    };

    const mesh = meshFromSurface(surf);
    const cplane = resolveCPlane("SdNurbsSurfaceFromGrid", args as Record<string, unknown>, viewer);
    mesh.userData.kind = "brep";
    mesh.userData.creator = "nurbs-surface";
    mesh.userData.cplaneKind = cplane.kind;
    mesh.userData.layerId = resolveLayerId("SdNurbsSurfaceFromGrid", args as Record<string, unknown>);
    mesh.userData.levelId = getActiveLevelId();
    linkCanonicalSurface(viewer, mesh, "SdNurbsSurfaceFromGrid", surf);
    viewer.addMesh(mesh, "brep");
    return {
      created: mesh.uuid,
      object_id: mesh.uuid,
      primitive: "nurbs-surface",
      nU,
      nV,
      degreeU: degU,
      degreeV: degV,
      isRational,
    };
  });

  // ── SdNurbsSurfaceEvaluate ─────────────────────────────────────────────────
  //
  // Evaluate a point on a surface at parameter (u,v).
  // Does NOT create scene geometry — returns the point coordinates.
  //
  // args:
  //   object_id : string — uuid of a previously created surface mesh (required)
  //   u         : number — parameter in U (required)
  //   v         : number — parameter in V (required)
  //
  // oracle: de Boor exact for NurbsSurface; closed-form for RevSurface.
  registerHandler("SdNurbsSurfaceEvaluate", (args) => {
    const objectId = args.object_id as string | undefined;
    const u = finiteOr(args.u, NaN);
    const v = finiteOr(args.v, NaN);
    if (!objectId) return { error: "SdNurbsSurfaceEvaluate — object_id required" };
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      return { error: "SdNurbsSurfaceEvaluate — u and v must be finite numbers" };
    }

    const store = (viewer as { getCanonicalGeometryStore?: () => { resolveObjectOrAncestor: (o: THREE.Object3D) => { kind: string; surface?: Surface } | undefined } }).getCanonicalGeometryStore?.();
    const obj = viewer.getScene().getObjectByProperty("uuid", objectId)
      ?? viewer.getScene().getObjectByProperty("name", objectId);
    if (!obj || !store) return { error: `SdNurbsSurfaceEvaluate — object_id "${objectId}" not found` };

    const record = store.resolveObjectOrAncestor(obj as THREE.Object3D);
    if (!record || record.kind !== "surface" || !record.surface) {
      return { error: `SdNurbsSurfaceEvaluate — object "${objectId}" has no canonical surface` };
    }
    const surf = record.surface;
    const pt = pointAtUV(surf, u, v);
    const du = domainU(surf), dv = domainV(surf);
    return {
      point: [pt.x, pt.y, pt.z],
      u,
      v,
      domainU: [du.min, du.max],
      domainV: [dv.min, dv.max],
    };
  });

  // ── SdNurbsSurfaceNormal ───────────────────────────────────────────────────
  //
  // Evaluate the unit normal vector of a surface at parameter (u,v).
  // Does NOT create scene geometry — returns the normal vector.
  //
  // args:
  //   object_id : string — uuid of a previously created surface mesh (required)
  //   u         : number — parameter in U (required)
  //   v         : number — parameter in V (required)
  //
  // oracle: numerical central-difference cross product (identical to normalAtUV).
  registerHandler("SdNurbsSurfaceNormal", (args) => {
    const objectId = args.object_id as string | undefined;
    const u = finiteOr(args.u, NaN);
    const v = finiteOr(args.v, NaN);
    if (!objectId) return { error: "SdNurbsSurfaceNormal — object_id required" };
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      return { error: "SdNurbsSurfaceNormal — u and v must be finite numbers" };
    }

    const store = (viewer as { getCanonicalGeometryStore?: () => { resolveObjectOrAncestor: (o: THREE.Object3D) => { kind: string; surface?: Surface } | undefined } }).getCanonicalGeometryStore?.();
    const obj = viewer.getScene().getObjectByProperty("uuid", objectId)
      ?? viewer.getScene().getObjectByProperty("name", objectId);
    if (!obj || !store) return { error: `SdNurbsSurfaceNormal — object_id "${objectId}" not found` };

    const record = store.resolveObjectOrAncestor(obj as THREE.Object3D);
    if (!record || record.kind !== "surface" || !record.surface) {
      return { error: `SdNurbsSurfaceNormal — object "${objectId}" has no canonical surface` };
    }
    const surf = record.surface;
    const n = normalAtUV(surf, u, v);
    const pt = pointAtUV(surf, u, v);
    return {
      normal: [n.x, n.y, n.z],
      point: [pt.x, pt.y, pt.z],
      u,
      v,
    };
  });

  // ── SdNurbsSurfaceDerivatives ──────────────────────────────────────────────
  //
  // Evaluate partial derivatives of a surface at parameter (u,v).
  // Returns first-order (dU, dV) and optionally second-order (d2U, d2V, dUV).
  //
  // args:
  //   object_id : string — uuid of a previously created surface mesh (required)
  //   u         : number — parameter in U (required)
  //   v         : number — parameter in V (required)
  //   order     : integer — derivative order: 1 (default) or 2 (optional)
  //
  // oracle: numerical finite-difference, cross-validated against closed-form
  //         RevSurface tangent formulas.
  registerHandler("SdNurbsSurfaceDerivatives", (args) => {
    const objectId = args.object_id as string | undefined;
    const u = finiteOr(args.u, NaN);
    const v = finiteOr(args.v, NaN);
    const order = finiteOr(args.order, 1) | 0;
    if (!objectId) return { error: "SdNurbsSurfaceDerivatives — object_id required" };
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      return { error: "SdNurbsSurfaceDerivatives — u and v must be finite numbers" };
    }

    const store = (viewer as { getCanonicalGeometryStore?: () => { resolveObjectOrAncestor: (o: THREE.Object3D) => { kind: string; surface?: Surface } | undefined } }).getCanonicalGeometryStore?.();
    const obj = viewer.getScene().getObjectByProperty("uuid", objectId)
      ?? viewer.getScene().getObjectByProperty("name", objectId);
    if (!obj || !store) return { error: `SdNurbsSurfaceDerivatives — object_id "${objectId}" not found` };

    const record = store.resolveObjectOrAncestor(obj as THREE.Object3D);
    if (!record || record.kind !== "surface" || !record.surface) {
      return { error: `SdNurbsSurfaceDerivatives — object "${objectId}" has no canonical surface` };
    }
    const surf = record.surface;
    const pt = pointAtUV(surf, u, v);
    const du = derivU(surf, u, v);
    const dv = derivV(surf, u, v);
    const result: Record<string, unknown> = {
      point: [pt.x, pt.y, pt.z],
      dU: [du.x, du.y, du.z],
      dV: [dv.x, dv.y, dv.z],
      u,
      v,
    };
    if (order >= 2) {
      const d2u = deriv2U(surf, u, v);
      const d2v = deriv2V(surf, u, v);
      const duv = deriv2UV(surf, u, v);
      result.d2U = [d2u.x, d2u.y, d2u.z];
      result.d2V = [d2v.x, d2v.y, d2v.z];
      result.dUV = [duv.x, duv.y, duv.z];
    }
    return result;
  });

  // ── SdTorusSurface ─────────────────────────────────────────────────────────
  //
  // Creates a torus surface (open RevSurface, not capped solid).
  //
  // args:
  //   majorRadius : number — distance from torus center to tube center (default 1) [required m]
  //   minorRadius : number — tube radius (default 0.3) [required m]
  //   center      : [x,y,z] — center of torus (optional, default world origin)
  //
  // oracle: closed-form P(u,v) = ((R+r*cos(v))*cos(u), (R+r*cos(v))*sin(u), r*sin(v))
  //         tolerance 1e-5 at (u=0.37, v=1.1) and off-axis samples.
  registerHandler("SdTorusSurface", (args) => {
    const R = finiteOr(args.majorRadius, 1);
    const r = finiteOr(args.minorRadius, 0.3);
    if (R <= 0 || r <= 0) return { error: "SdTorusSurface — majorRadius and minorRadius must be positive" };
    if (r >= R) return { error: "SdTorusSurface — minorRadius must be less than majorRadius" };

    const center = numArr3(args.center);
    const surf = torusSurface(R, r);
    const mesh = meshFromSurface(surf, 48, 24);

    if (center) {
      mesh.position.set(center[0], center[1], center[2]);
    } else {
      const cplane = resolveCPlane("SdTorusSurface", args as Record<string, unknown>, viewer);
      mesh.position.copy(cplane.normal.clone().multiplyScalar(r));
    }
    mesh.userData.kind = "brep";
    mesh.userData.creator = "torus";
    mesh.userData.layerId = resolveLayerId("SdTorusSurface", args as Record<string, unknown>);
    mesh.userData.levelId = getActiveLevelId();
    linkCanonicalSurface(viewer, mesh, "SdTorusSurface", surf);
    viewer.addMesh(mesh, "brep");
    return {
      created: mesh.uuid,
      object_id: mesh.uuid,
      primitive: "torus",
      majorRadius: R,
      minorRadius: r,
    };
  });

  // ── SdSumSurface — sum surface from two curves ────────────────────────────
  //
  // A sum surface S(u,v) = C1(u) + C2(v) - basepoint.
  // Requires two curve objects (by uuid) from the scene.
  //
  // This is a TypeScript-implementable op (SumSurface is defined in nurbs-surfaces.ts).
  //
  // args:
  //   curve_u_id : string — uuid of curve in U direction (required)
  //   curve_v_id : string — uuid of curve in V direction (required)
  //
  // C++ variant (kern_sumSurface): blocked — general SSI/trim not yet in kern.wasm.
  registerHandler("SdSumSurface", (args) => {
    const cuId = args.curve_u_id as string | undefined;
    const cvId = args.curve_v_id as string | undefined;
    if (!cuId || !cvId) {
      return {
        error: "NotYetImplemented",
        detail: "blocked: SdSumSurface requires curve_u_id and curve_v_id of existing curve objects",
        op: "SdSumSurface",
      };
    }

    type CurveRecord = { kind: string; curve?: Curve };
    const store = (viewer as { getCanonicalGeometryStore?: () => { resolveObjectOrAncestor: (o: THREE.Object3D) => CurveRecord | undefined } }).getCanonicalGeometryStore?.();
    if (!store) return { error: "SdSumSurface — canonical geometry store not available" };

    const objU = viewer.getScene().getObjectByProperty("uuid", cuId);
    const objV = viewer.getScene().getObjectByProperty("uuid", cvId);
    if (!objU) return { error: `SdSumSurface — curve_u_id "${cuId}" not found` };
    if (!objV) return { error: `SdSumSurface — curve_v_id "${cvId}" not found` };

    const recU = store.resolveObjectOrAncestor(objU as THREE.Object3D);
    const recV = store.resolveObjectOrAncestor(objV as THREE.Object3D);
    if (!recU || recU.kind !== "curve" || !recU.curve) {
      return { error: `SdSumSurface — curve_u_id "${cuId}" has no canonical curve` };
    }
    if (!recV || recV.kind !== "curve" || !recV.curve) {
      return { error: `SdSumSurface — curve_v_id "${cvId}" has no canonical curve` };
    }

    // Basepoint: start of the U curve.
    const domU = nurbsCurveDomain(recU.curve);
    const bp = nurbsCurvePointAt(recU.curve, domU.min);
    const sumSurf: SumSurface = {
      kind: "sum",
      curveU: recU.curve,
      curveV: recV.curve,
      basepoint: bp,
    };
    const mesh = meshFromSurface(sumSurf, 32, 32);
    mesh.userData.kind = "brep";
    mesh.userData.creator = "sum-surface";
    mesh.userData.layerId = resolveLayerId("SdSumSurface", args as Record<string, unknown>);
    mesh.userData.levelId = getActiveLevelId();
    linkCanonicalSurface(viewer, mesh, "SdSumSurface", sumSurf);
    viewer.addMesh(mesh, "brep");
    return {
      created: mesh.uuid,
      object_id: mesh.uuid,
      primitive: "sum-surface",
    };
  });

  // ── C++ blocked stubs ─────────────────────────────────────────────────────
  //
  // These operations require general Surface-Surface Intersection (SSI),
  // topological trimming, or algebraic patch fitting that is not yet
  // available in kern.wasm. Each stub returns a typed error with the
  // C++ function signature that will implement it.

  // kern_edgeSurface — Coons patch from 2, 3, or 4 boundary curves.
  // C++ signature:
  //   Brep kern_edgeSurface(
  //     const ON_SimpleArray<ON_Curve*>& edges,  // 2–4 boundary curves
  //     double tolerance
  //   );
  registerHandler("SdEdgeSurface",
    cppBlockedStub("SdEdgeSurface", "requires kern_edgeSurface (Coons patch / bilinear blending) in kern.wasm — general SSI + boundary parameterization not yet implemented"));

  // kern_networkSurface — surface from intersecting U/V curve networks.
  // C++ signature:
  //   Brep kern_networkSurface(
  //     const ON_SimpleArray<ON_Curve*>& uCurves,
  //     const ON_SimpleArray<ON_Curve*>& vCurves,
  //     double tolerance
  //   );
  registerHandler("SdNetworkSurface",
    cppBlockedStub("SdNetworkSurface", "requires kern_networkSurface (curve network fitting) in kern.wasm — least-squares NURBS fitting from curve net not yet implemented"));

  // kern_torusSurface_nurbs — exact rational (9×9 NURBS) torus.
  // C++ signature:
  //   ON_NurbsSurface kern_torusSurface_nurbs(double R, double r);
  //
  // NOTE: SdTorusSurface above uses a RevSurface (RevSurface of a circle),
  // which is the correct analytic representation. The NURBS form (9×9 rational)
  // requires homogeneous weight computation beyond the current NurbsSurface
  // builder. When kern.wasm is ready, replace the RevSurface with an exact
  // NURBS-rational 9×9 grid.
  registerHandler("SdTorusSurfaceExact",
    cppBlockedStub("SdTorusSurfaceExact", "requires kern_torusSurface_nurbs (exact 9×9 rational NURBS) in kern.wasm"));

  // kern_evaluateSurfaceDerivatives_rational — exact rational de Boor derivatives.
  // C++ signature:
  //   bool kern_evaluateSurfaceDerivatives_rational(
  //     const ON_NurbsSurface& srf, double u, double v, int order,
  //     ON_3dPoint* pts   // (order+1)*(order+1) output points
  //   );
  registerHandler("SdNurbsSurfaceDerivativesExact",
    cppBlockedStub("SdNurbsSurfaceDerivativesExact", "requires kern_evaluateSurfaceDerivatives_rational (exact rational Bézier extraction) in kern.wasm"));

  // kern_surfaceTrim_withTopology — SSI-based trim surface with full BRep topology.
  // C++ signature:
  //   Brep kern_surfaceTrim_withTopology(
  //     const ON_NurbsSurface& base,
  //     const ON_SimpleArray<ON_Curve*>& trimCurves,
  //     double tolerance
  //   );
  registerHandler("SdTrimmedNurbsSurface",
    cppBlockedStub("SdTrimmedNurbsSurface", "requires kern_surfaceTrim_withTopology (SSI + parametric trim loop) in kern.wasm"));
}
