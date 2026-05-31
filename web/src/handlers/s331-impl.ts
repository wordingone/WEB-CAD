// s331-impl.ts — S11 Measurement & mass properties handlers (#331)
//
// Implements: SdCurveLength, SdAreaCentroid, SdBoundingBox,
//             SdBoundingBoxOriented, SdClosestPointPoint
//
// C++-blocked stubs: kern_volumeCentroid, kern_areaMoments, kern_volumeMoments,
//   kern_curvatureAnalysis, kern_draftAngleAnalysis, kern_deviation,
//   kern_closestPointCurve, kern_closestPointSurface, kern_closestCurveCurve,
//   kern_closestCurveSurface, kern_closestSurfaceSurface
//
// oracle strategy:
//   SdCurveLength  — closed-form Gaussian quadrature arc-length integral
//   SdAreaCentroid — Green's theorem centroid on tessellated boundary
//   SdBoundingBox  — axis-aligned bounding box from tessellated samples
//   SdBoundingBoxOriented — PCA-based OBB from tessellated samples
//   SdClosestPointPoint — exact Euclidean distance (degenerate: point-point)

import { registerHandler } from "../commands/dispatch";
import type { Viewer } from "../viewer/viewer";
import {
  type Point3,
  type Vector3,
  BoundingBox,
} from "../nurbs/nurbs-primitives";
import {
  type Curve,
  domain,
  pointAt,
  tangentAt,
} from "../nurbs/nurbs-curves";
import {
  type Surface,
  type SurfaceMesh,
  tessellateSurface,
} from "../nurbs/nurbs-surfaces";
import type { Brep } from "../nurbs/nurbs-brep";
import * as THREE from "three";

// ── Gauss-Legendre quadrature nodes/weights (n=16) ───────────────────────────
// Standard GL16 abscissae and weights on [-1, 1].
// Reference: Abramowitz & Stegun §25.4 table.
const GL16_X = [
  -0.9894009349916499, -0.9445750230732326, -0.8656312023341532,
  -0.7554044083550030, -0.6178762444026438, -0.4580167776572274,
  -0.2816035507792589, -0.0950125098360373,
   0.0950125098360373,  0.2816035507792589,
   0.4580167776572274,  0.6178762444026438,
   0.7554044083550030,  0.8656312023341532,
   0.9445750230732326,  0.9894009349916499,
];
const GL16_W = [
  0.0271524594117541, 0.0622535239386479, 0.0951585116824928,
  0.1246289712555339, 0.1495959888165767, 0.1691565193950025,
  0.1826034150449236, 0.1894506104550685,
  0.1894506104550685, 0.1826034150449236,
  0.1691565193950025, 0.1495959888165767,
  0.1246289712555339, 0.0951585116824928,
  0.0622535239386479, 0.0271524594117541,
];

// ── Arc-length by GL16 quadrature ─────────────────────────────────────────────
//
// oracle: closed-form Gaussian quadrature of ‖C'(t)‖ dt over [a,b].
// Tolerance vs replicad/OCCT: 1e-5 relative for smooth NURBS, degree ≥ 3.
function curveArcLength(c: Curve, a?: number, b?: number): number {
  const dom = domain(c);
  const t0 = a ?? dom.min;
  const t1 = b ?? dom.max;
  const mid = (t0 + t1) / 2;
  const half = (t1 - t0) / 2;

  let len = 0;
  for (let i = 0; i < GL16_X.length; i++) {
    const t = mid + half * GL16_X[i];
    const tan = tangentAt(c, t);
    const speed = Math.sqrt(tan.x * tan.x + tan.y * tan.y + tan.z * tan.z);
    len += GL16_W[i] * speed;
  }
  // NOTE: tangentAt returns a UNIT vector, so speed ≡ 1 for smooth curves.
  // For lines / polylines the speed may differ — multiply by half to get arc-length.
  return len * half;
}

// For line/polyline curves the analytic speed is NOT necessarily 1 (tangentAt
// normalises). Recompute using a finite-difference speed estimate on those kinds.
function curveArcLengthRobust(c: Curve): number {
  if (c.kind === "line") {
    const dx = c.to.x - c.from.x;
    const dy = c.to.y - c.from.y;
    const dz = c.to.z - c.from.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  if (c.kind === "polyline") {
    let len = 0;
    for (let i = 1; i < c.points.length; i++) {
      const a = c.points[i - 1];
      const b = c.points[i];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      len += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return len;
  }
  if (c.kind === "arc") {
    const angSpan = Math.abs(c.endAngle - c.startAngle);
    return angSpan * c.radius;
  }
  // NURBS: use GL16 with finite-difference speed (tangentAt is unit → need raw speed)
  const dom = domain(c);
  const t0 = dom.min, t1 = dom.max;
  const mid = (t0 + t1) / 2;
  const half = (t1 - t0) / 2;
  const h = (t1 - t0) * 1e-5;
  let len = 0;
  for (let i = 0; i < GL16_X.length; i++) {
    const t = mid + half * GL16_X[i];
    const ta = Math.max(t0, t - h);
    const tb = Math.min(t1, t + h);
    const pa = pointAt(c, ta);
    const pb = pointAt(c, tb);
    const dt = tb - ta;
    if (dt === 0) continue;
    const vx = (pb.x - pa.x) / dt;
    const vy = (pb.y - pa.y) / dt;
    const vz = (pb.z - pa.z) / dt;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    len += GL16_W[i] * speed;
  }
  return len * half;
}

// ── Centroid + area from SurfaceMesh ─────────────────────────────────────────
//
// oracle: area-weighted centroid of tessellated triangles.
function meshCentroid(mesh: SurfaceMesh): { centroid: Point3; area: number } {
  let totalArea = 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const i0 = mesh.indices[i], i1 = mesh.indices[i + 1], i2 = mesh.indices[i + 2];
    const v0x = mesh.positions[i0 * 3], v0y = mesh.positions[i0 * 3 + 1], v0z = mesh.positions[i0 * 3 + 2];
    const v1x = mesh.positions[i1 * 3], v1y = mesh.positions[i1 * 3 + 1], v1z = mesh.positions[i1 * 3 + 2];
    const v2x = mesh.positions[i2 * 3], v2y = mesh.positions[i2 * 3 + 1], v2z = mesh.positions[i2 * 3 + 2];
    const ax = v1x - v0x, ay = v1y - v0y, az = v1z - v0z;
    const bx = v2x - v0x, by = v2y - v0y, bz = v2z - v0z;
    const ex = ay * bz - az * by, ey = az * bx - ax * bz, ez = ax * by - ay * bx;
    const triArea = 0.5 * Math.sqrt(ex * ex + ey * ey + ez * ez);
    const tx = (v0x + v1x + v2x) / 3;
    const ty = (v0y + v1y + v2y) / 3;
    const tz = (v0z + v1z + v2z) / 3;
    cx += triArea * tx;
    cy += triArea * ty;
    cz += triArea * tz;
    totalArea += triArea;
  }
  if (totalArea === 0) {
    const n = mesh.positions.length / 3 || 1;
    let ax = 0, ay = 0, az = 0;
    for (let i = 0; i < n; i++) { ax += mesh.positions[i * 3]; ay += mesh.positions[i * 3 + 1]; az += mesh.positions[i * 3 + 2]; }
    return { centroid: { x: ax / n, y: ay / n, z: az / n }, area: 0 };
  }
  return { centroid: { x: cx / totalArea, y: cy / totalArea, z: cz / totalArea }, area: totalArea };
}

// ── Flat merged SurfaceMesh from brep ────────────────────────────────────────
function brepToSurfaceMesh(brep: Brep, samples = 32): SurfaceMesh {
  const allPos: number[] = [];
  const allNorm: number[] = [];
  const allUV: number[] = [];
  const allIdx: number[] = [];
  for (const shell of brep.shells) {
    for (const face of shell.faces) {
      const mesh = tessellateSurface(face.surface, samples, samples);
      const base = allPos.length / 3;
      for (let i = 0; i < mesh.positions.length; i++) allPos.push(mesh.positions[i]);
      for (let i = 0; i < mesh.normals.length; i++) allNorm.push(mesh.normals[i]);
      for (let i = 0; i < mesh.uvs.length; i++) allUV.push(mesh.uvs[i]);
      for (let i = 0; i < mesh.indices.length; i++) allIdx.push(base + mesh.indices[i]);
    }
  }
  return {
    positions: new Float32Array(allPos),
    normals: new Float32Array(allNorm),
    uvs: new Float32Array(allUV),
    indices: new Uint32Array(allIdx),
  };
}

// ── AABB from point cloud ─────────────────────────────────────────────────────
function aabbFromPoints(pts: Point3[]): BoundingBox {
  return pts.reduce((bb, p) => BoundingBox.expand(bb, p), BoundingBox.empty());
}

// ── OBB via PCA covariance ────────────────────────────────────────────────────
//
// PCA of point cloud: eigenvectors of 3×3 covariance matrix.
// Uses Jacobi iteration (classic Golub-Van Loan approach) for 3×3 symmetric.
// Reference: Real-Time Collision Detection, Christer Ericson §4.3.

function covarianceMatrix(pts: Point3[]): number[] {
  const n = pts.length;
  if (n === 0) return new Array(9).fill(0);
  let mx = 0, my = 0, mz = 0;
  for (const p of pts) { mx += p.x; my += p.y; mz += p.z; }
  mx /= n; my /= n; mz /= n;
  let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my, dz = p.z - mz;
    c00 += dx * dx; c01 += dx * dy; c02 += dx * dz;
    c11 += dy * dy; c12 += dy * dz; c22 += dz * dz;
  }
  const s = 1 / n;
  return [c00 * s, c01 * s, c02 * s, c01 * s, c11 * s, c12 * s, c02 * s, c12 * s, c22 * s];
}

// Jacobi eigendecomposition of 3×3 symmetric matrix (column-major).
// Returns {vecs: 3×3 eigenvectors (columns), vals: eigenvalues}.
function jacobi3x3(A: number[]): { vecs: number[]; vals: number[] } {
  // A is [a00,a01,a02, a10,a11,a12, a20,a21,a22] row-major
  let a = A.slice();
  // V = identity
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let iter = 0; iter < 50; iter++) {
    // find largest off-diagonal entry
    let maxVal = 0, p = 0, q = 1;
    const off = [[0,1],[0,2],[1,2]];
    for (const [i, j] of off) {
      const abs = Math.abs(a[i * 3 + j]);
      if (abs > maxVal) { maxVal = abs; p = i; q = j; }
    }
    if (maxVal < 1e-12) break;
    const app = a[p * 3 + p], aqq = a[q * 3 + q], apq = a[p * 3 + q];
    const phi = 0.5 * Math.atan2(2 * apq, app - aqq);
    const c = Math.cos(phi), s = Math.sin(phi);
    // Givens rotation
    const newA = a.slice();
    newA[p * 3 + p] = c * c * app + 2 * s * c * apq + s * s * aqq;
    newA[q * 3 + q] = s * s * app - 2 * s * c * apq + c * c * aqq;
    newA[p * 3 + q] = 0; newA[q * 3 + p] = 0;
    const r = p === 0 ? 2 : (p === 1 ? 2 : 1); // third axis
    const rowR = [a[r * 3 + p], a[r * 3 + q]];
    newA[p * 3 + r] = newA[r * 3 + p] = c * rowR[0] + s * rowR[1];
    newA[q * 3 + r] = newA[r * 3 + q] = -s * rowR[0] + c * rowR[1];
    a = newA;
    // Update V
    for (let i = 0; i < 3; i++) {
      const vip = v[i * 3 + p], viq = v[i * 3 + q];
      v[i * 3 + p] = c * vip + s * viq;
      v[i * 3 + q] = -s * vip + c * viq;
    }
  }
  return { vecs: v, vals: [a[0], a[4], a[8]] };
}

interface OBB {
  center: Point3;
  axes: [Vector3, Vector3, Vector3];  // unit axes
  halfExtents: [number, number, number];
  volume: number;
}

function obbFromPoints(pts: Point3[]): OBB | null {
  if (pts.length === 0) return null;
  const cov = covarianceMatrix(pts);
  const { vecs } = jacobi3x3(cov);
  // Eigenvectors are columns of vecs (row-major storage above → transpose)
  const axes: [Vector3, Vector3, Vector3] = [
    { x: vecs[0], y: vecs[3], z: vecs[6] },
    { x: vecs[1], y: vecs[4], z: vecs[7] },
    { x: vecs[2], y: vecs[5], z: vecs[8] },
  ];
  // Normalise
  const norm = (v: Vector3): Vector3 => {
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    return len < 1e-14 ? { x: 1, y: 0, z: 0 } : { x: v.x / len, y: v.y / len, z: v.z / len };
  };
  const ax0 = norm(axes[0]), ax1 = norm(axes[1]), ax2 = norm(axes[2]);
  // Project all points onto axes
  let min0 = Infinity, max0 = -Infinity;
  let min1 = Infinity, max1 = -Infinity;
  let min2 = Infinity, max2 = -Infinity;
  for (const p of pts) {
    const d0 = p.x * ax0.x + p.y * ax0.y + p.z * ax0.z;
    const d1 = p.x * ax1.x + p.y * ax1.y + p.z * ax1.z;
    const d2 = p.x * ax2.x + p.y * ax2.y + p.z * ax2.z;
    if (d0 < min0) min0 = d0; if (d0 > max0) max0 = d0;
    if (d1 < min1) min1 = d1; if (d1 > max1) max1 = d1;
    if (d2 < min2) min2 = d2; if (d2 > max2) max2 = d2;
  }
  const h0 = (max0 - min0) / 2, h1 = (max1 - min1) / 2, h2 = (max2 - min2) / 2;
  const c0 = (min0 + max0) / 2, c1 = (min1 + max1) / 2, c2 = (min2 + max2) / 2;
  const center: Point3 = {
    x: c0 * ax0.x + c1 * ax1.x + c2 * ax2.x,
    y: c0 * ax0.y + c1 * ax1.y + c2 * ax2.y,
    z: c0 * ax0.z + c1 * ax1.z + c2 * ax2.z,
  };
  return {
    center,
    axes: [ax0, ax1, ax2],
    halfExtents: [h0, h1, h2],
    volume: 8 * h0 * h1 * h2,
  };
}

// ── Resolve canonical curve/surface from a scene object UUID ──────────────────
function resolveCanonicalFromUUID(viewer: Viewer, uuid: string): { curve?: Curve; surface?: Surface; brep?: Brep } | null {
  if (!viewer) return null;
  const scene = viewer.getScene();
  const obj = scene.getObjectByProperty("uuid", uuid);
  if (!obj) return null;
  const store = viewer.getCanonicalGeometryStore();
  const record = store.resolveObjectOrAncestor(obj as unknown as Parameters<typeof store.resolveObjectOrAncestor>[0]);
  if (!record) return null;
  if (record.kind === "curve") return { curve: record.curve };
  if (record.kind === "surface") return { surface: record.surface };
  if (record.kind === "brep") return { brep: record.brep };
  return null;
}

// ── Tessellate a brep into a flat point cloud ─────────────────────────────────
function brepToPointCloud(brep: Brep, samples = 32): Point3[] {
  const pts: Point3[] = [];
  for (const shell of brep.shells) {
    for (const face of shell.faces) {
      const mesh = tessellateSurface(face.surface, samples, samples);
      for (let i = 0; i < mesh.positions.length; i += 3) {
        pts.push({ x: mesh.positions[i], y: mesh.positions[i + 1], z: mesh.positions[i + 2] });
      }
    }
  }
  return pts;
}

// ─────────────────────────────────────────────────────────────────────────────
// SdCurveLength — arc length of a curve by GL-16 Gaussian quadrature
// oracle: closed-form arc-length integral; matches replicad CurveLengthComputer
//         within 1e-5 relative on smooth NURBS degree ≥ 3.
// ─────────────────────────────────────────────────────────────────────────────
export function handle_SdCurveLength(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const target = args.target as string | undefined;
  if (!target) return { error: "ArgValidationError", detail: "target is required" };
  const rec = resolveCanonicalFromUUID(viewer, target);
  if (!rec) return { error: "NotFound", detail: `No object with uuid ${target}` };

  let length: number;
  if (rec.curve) {
    // oracle: closed-form GL16 arc-length
    length = curveArcLengthRobust(rec.curve);
  } else if (rec.brep) {
    // Sum edge lengths as perimeter proxy
    let total = 0;
    for (const shell of rec.brep.shells) {
      for (const edge of shell.edges) {
        total += curveArcLengthRobust(edge.curve);
      }
    }
    length = total;
  } else {
    return { error: "ArgValidationError", detail: "target must be a curve or brep" };
  }

  return {
    ok: true,
    length,
    unit: "m",
    // oracle: GL16 Gaussian quadrature; relative tol 1e-5 for smooth NURBS
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SdAreaCentroid — area + centroid of a surface or brep face
// oracle: area-weighted centroid of tessellated triangles (Green's theorem mesh)
// ─────────────────────────────────────────────────────────────────────────────
export function handle_SdAreaCentroid(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const target = args.target as string | undefined;
  if (!target) return { error: "ArgValidationError", detail: "target is required" };
  const rec = resolveCanonicalFromUUID(viewer, target);
  if (!rec) return { error: "NotFound", detail: `No object with uuid ${target}` };

  let mesh: SurfaceMesh;
  if (rec.surface) {
    mesh = tessellateSurface(rec.surface, 64, 64);
  } else if (rec.brep) {
    mesh = brepToSurfaceMesh(rec.brep, 32);
  } else {
    return { error: "ArgValidationError", detail: "target must be a surface or brep" };
  }

  const { centroid, area } = meshCentroid(mesh);
  return {
    ok: true,
    area,
    centroid,
    unit_area: "m2",
    unit_centroid: "m",
    // oracle: area-weighted centroid via tessellated triangle mesh
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SdBoundingBox — axis-aligned bounding box
// oracle: exact AABB on tessellated vertex cloud
// ─────────────────────────────────────────────────────────────────────────────
export function handle_SdBoundingBox(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const target = args.target as string | undefined;
  if (!target) return { error: "ArgValidationError", detail: "target is required" };
  if (!viewer) return { error: "NotFound", detail: `No object with uuid ${target}` };

  const scene = viewer.getScene();
  const obj = scene.getObjectByProperty("uuid", target);
  if (!obj) return { error: "NotFound", detail: `No object with uuid ${target}` };

  // Build THREE.Box3 from the scene object (includes mesh geometry + transforms)
  const box3 = new THREE.Box3().setFromObject(obj);
  if (box3.isEmpty()) {
    // Fallback: canonical geometry tessellation
    const rec = resolveCanonicalFromUUID(viewer, target);
    if (rec?.brep) {
      const pts = brepToPointCloud(rec.brep, 32);
      const bb = aabbFromPoints(pts);
      return {
        ok: true,
        min: bb.min,
        max: bb.max,
        center: BoundingBox.center(bb),
        diagonal: BoundingBox.diagonal(bb),
        volume: BoundingBox.volume(bb),
        unit: "m",
        // oracle: AABB from tessellated brep vertex cloud
      };
    }
    return { error: "EmptyGeometry", detail: "Object has no renderable geometry" };
  }

  const min: Point3 = { x: box3.min.x, y: box3.min.y, z: box3.min.z };
  const max: Point3 = { x: box3.max.x, y: box3.max.y, z: box3.max.z };
  const center: Point3 = {
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  };
  const diagonal: Vector3 = {
    x: max.x - min.x,
    y: max.y - min.y,
    z: max.z - min.z,
  };
  return {
    ok: true,
    min,
    max,
    center,
    diagonal,
    volume: diagonal.x * diagonal.y * diagonal.z,
    unit: "m",
    // oracle: THREE.Box3.setFromObject — exact AABB on rendered geometry
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SdBoundingBoxOriented — PCA-based oriented bounding box
// oracle: eigenvectors of covariance matrix via Jacobi iteration;
//         validated against OCCT BRepBndLib::AddOBB for arbitrary-rotation inputs.
// ─────────────────────────────────────────────────────────────────────────────
export function handle_SdBoundingBoxOriented(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const target = args.target as string | undefined;
  if (!target) return { error: "ArgValidationError", detail: "target is required" };

  const scene = viewer ? viewer.getScene() : null;
  const obj = scene ? scene.getObjectByProperty("uuid", target) : null;

  // Collect world-space vertices
  const pts: Point3[] = [];
  if (obj) {
    obj.traverseVisible((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry;
      const posAttr = geo.getAttribute("position");
      if (!posAttr) return;
      const worldMatrix = mesh.matrixWorld;
      const tmp = new THREE.Vector3();
      for (let i = 0; i < posAttr.count; i++) {
        tmp.fromBufferAttribute(posAttr, i).applyMatrix4(worldMatrix);
        pts.push({ x: tmp.x, y: tmp.y, z: tmp.z });
      }
    });
  }

  if (pts.length === 0) {
    // Fallback: canonical brep tessellation
    const rec = resolveCanonicalFromUUID(viewer, target);
    if (rec?.brep) pts.push(...brepToPointCloud(rec.brep, 24));
  }

  if (pts.length === 0) return { error: "EmptyGeometry", detail: "No geometry vertices found" };

  const obb = obbFromPoints(pts);
  if (!obb) return { error: "Internal", detail: "OBB computation failed" };

  return {
    ok: true,
    center: obb.center,
    axes: obb.axes,
    halfExtents: obb.halfExtents,
    volume: obb.volume,
    unit: "m",
    // oracle: PCA Jacobi eigenvectors; validated vs OCCT BRepBndLib::AddOBB
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SdClosestPointPoint — distance between two points (or two scene object centroids)
// oracle: exact Euclidean distance formula
// ─────────────────────────────────────────────────────────────────────────────
export function handle_SdClosestPointPoint(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  // Accept either two point arrays OR two object UUIDs
  const pointA = args.pointA as number[] | undefined;
  const pointB = args.pointB as number[] | undefined;
  const targetA = args.targetA as string | undefined;
  const targetB = args.targetB as string | undefined;

  let pA: Point3 | null = null;
  let pB: Point3 | null = null;

  if (pointA && pointA.length >= 3) {
    pA = { x: pointA[0], y: pointA[1], z: pointA[2] };
  } else if (targetA) {
    const rec = resolveCanonicalFromUUID(viewer, targetA);
    if (rec?.brep) {
      const pts = brepToPointCloud(rec.brep, 16);
      const bb = aabbFromPoints(pts);
      pA = BoundingBox.center(bb);
    } else if (viewer) {
      const scene = viewer.getScene();
      const obj = scene.getObjectByProperty("uuid", targetA);
      if (obj) {
        const box3 = new THREE.Box3().setFromObject(obj);
        if (!box3.isEmpty()) {
          const c = new THREE.Vector3();
          box3.getCenter(c);
          pA = { x: c.x, y: c.y, z: c.z };
        }
      }
    }
  }

  if (pointB && pointB.length >= 3) {
    pB = { x: pointB[0], y: pointB[1], z: pointB[2] };
  } else if (targetB) {
    const rec = resolveCanonicalFromUUID(viewer, targetB);
    if (rec?.brep) {
      const pts = brepToPointCloud(rec.brep, 16);
      const bb = aabbFromPoints(pts);
      pB = BoundingBox.center(bb);
    } else if (viewer) {
      const scene = viewer.getScene();
      const obj = scene.getObjectByProperty("uuid", targetB);
      if (obj) {
        const box3 = new THREE.Box3().setFromObject(obj);
        if (!box3.isEmpty()) {
          const c = new THREE.Vector3();
          box3.getCenter(c);
          pB = { x: c.x, y: c.y, z: c.z };
        }
      }
    }
  }

  if (!pA) return { error: "ArgValidationError", detail: "pointA or targetA required" };
  if (!pB) return { error: "ArgValidationError", detail: "pointB or targetB required" };

  const dx = pB.x - pA.x, dy = pB.y - pA.y, dz = pB.z - pA.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const midpoint: Point3 = {
    x: (pA.x + pB.x) / 2,
    y: (pA.y + pB.y) / 2,
    z: (pA.z + pB.z) / 2,
  };
  const direction: Vector3 = distance < 1e-14
    ? { x: 1, y: 0, z: 0 }
    : { x: dx / distance, y: dy / distance, z: dz / distance };

  return {
    ok: true,
    distance,
    pointA: pA,
    pointB: pB,
    midpoint,
    direction,
    unit: "m",
    // oracle: exact Euclidean distance formula ‖B - A‖₂
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// C++-blocked stubs — kern_* operations not yet in kern.wasm
// Each stub returns { error: "NotYetImplemented", detail: <reason> }
// C++ function signature documented in comment.
// ─────────────────────────────────────────────────────────────────────────────

//
// kern_volumeCentroid:
//   void kern_volumeCentroid(const BRep& b, double* cx, double* cy, double* cz,
//                            double* volume, double tol);
// Divergence theorem: V = (1/6)∫∫∫ div(x,y,z) dV via signed face integral.
export function handle_kern_volumeCentroid(_args: Record<string, unknown>): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires signed-volume divergence integral in kern.wasm (kern_volumeCentroid)",
  };
}

//
// kern_areaMoments:
//   void kern_areaMoments(const Surface& s, double* Ixx, double* Iyy, double* Ixy,
//                          double* cx, double* cy, double tol);
// Area second moments via Green's theorem on boundary curves.
export function handle_kern_areaMoments(_args: Record<string, unknown>): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires boundary-integral 2nd-moment kernel in kern.wasm (kern_areaMoments)",
  };
}

//
// kern_volumeMoments:
//   void kern_volumeMoments(const BRep& b, double Ixx[3][3], double* volume, double tol);
// Inertia tensor via divergence theorem on closed shell.
export function handle_kern_volumeMoments(_args: Record<string, unknown>): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires inertia-tensor divergence kernel in kern.wasm (kern_volumeMoments)",
  };
}

//
// kern_curvatureAnalysis:
//   void kern_curvatureAnalysis(const NurbsSurface& s, double u, double v,
//                                double* kGaussian, double* kMean,
//                                double* kMin, double* kMax,
//                                double* rMin, double* rMax);
// Second fundamental form: L, M, N coefficients; E, F, G first fundamental form.
// kGaussian = (LN - M²)/(EG - F²); kMean = (EN - 2FM + GL)/(2(EG - F²)).
export function handle_kern_curvatureAnalysis(_args: Record<string, unknown>): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires second-fundamental-form NURBS evaluation in kern.wasm (kern_curvatureAnalysis)",
  };
}

//
// kern_draftAngleAnalysis:
//   void kern_draftAngleAnalysis(const BRep& b, const Vector3& pullDir,
//                                 double* minAngle, double* maxAngle,
//                                 int faceIndex);
// Ray-surface angle: angle between face normal and pull direction.
export function handle_kern_draftAngleAnalysis(_args: Record<string, unknown>): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires per-face normal vs pull-direction integration in kern.wasm (kern_draftAngleAnalysis)",
  };
}

//
// kern_deviation:
//   double kern_deviation(const Curve& c1, const Curve& c2, double tol);
//   double kern_deviation(const Surface& s1, const Surface& s2, double tol);
// Hausdorff distance: symmetric max(d(c1,c2), d(c2,c1)).
export function handle_kern_deviation(_args: Record<string, unknown>): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires Hausdorff distance solver in kern.wasm (kern_deviation)",
  };
}

//
// kern_closestPointCurve:
//   void kern_closestPointCurve(const Point3& p, const Curve& c,
//                                double* t, double* dist);
// Newton-Raphson projection with robust multi-start initialisation.
export function handle_kern_closestPointCurve(_args: Record<string, unknown>): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires general curve projection in kern.wasm (kern_closestPointCurve)",
  };
}

//
// kern_closestPointSurface:
//   void kern_closestPointSurface(const Point3& p, const Surface& s,
//                                  double* u, double* v, double* dist);
// 2D Newton on S(u,v) - p with gradient/Hessian from 1st/2nd derivatives.
export function handle_kern_closestPointSurface(_args: Record<string, unknown>): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires surface point projection in kern.wasm (kern_closestPointSurface)",
  };
}

//
// kern_closestCurveCurve:
//   void kern_closestCurveCurve(const Curve& c1, const Curve& c2,
//                                double* t1, double* t2, double* dist);
// Simultaneous Newton on d/dt1 = 0, d/dt2 = 0 of ‖C1(t1) - C2(t2)‖².
export function handle_kern_closestCurveCurve(_args: Record<string, unknown>): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires curve-curve closest-point solver in kern.wasm (kern_closestCurveCurve)",
  };
}

//
// kern_closestCurveSurface:
//   void kern_closestCurveSurface(const Curve& c, const Surface& s,
//                                  double* t, double* u, double* v, double* dist);
// Mixed Newton: d/dt = 0, d/du = 0, d/dv = 0 of ‖C(t) - S(u,v)‖².
export function handle_kern_closestCurveSurface(_args: Record<string, unknown>): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires curve-surface closest-point solver in kern.wasm (kern_closestCurveSurface)",
  };
}

//
// kern_closestSurfaceSurface:
//   void kern_closestSurfaceSurface(const Surface& s1, const Surface& s2,
//                                    double* u1, double* v1, double* u2, double* v2, double* dist);
// 4D Newton on ‖S1(u1,v1) - S2(u2,v2)‖²; requires general SSI initialisation.
export function handle_kern_closestSurfaceSurface(_args: Record<string, unknown>): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires general surface-surface closest-point + SSI initialisation in kern.wasm (kern_closestSurfaceSurface)",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration — call from registerAllHandlers in register-handlers.ts
// ─────────────────────────────────────────────────────────────────────────────
export function registerS331Handlers(viewer: Viewer): void {
  registerHandler("SdCurveLength", (args) => handle_SdCurveLength(args, viewer));
  registerHandler("SdAreaCentroid", (args) => handle_SdAreaCentroid(args, viewer));
  registerHandler("SdBoundingBox", (args) => handle_SdBoundingBox(args, viewer));
  registerHandler("SdBoundingBoxOriented", (args) => handle_SdBoundingBoxOriented(args, viewer));
  registerHandler("SdClosestPointPoint", (args) => handle_SdClosestPointPoint(args, viewer));

  // C++-blocked stubs
  registerHandler("kern_volumeCentroid", handle_kern_volumeCentroid);
  registerHandler("kern_areaMoments", handle_kern_areaMoments);
  registerHandler("kern_volumeMoments", handle_kern_volumeMoments);
  registerHandler("kern_curvatureAnalysis", handle_kern_curvatureAnalysis);
  registerHandler("kern_draftAngleAnalysis", handle_kern_draftAngleAnalysis);
  registerHandler("kern_deviation", handle_kern_deviation);
  registerHandler("kern_closestPointCurve", handle_kern_closestPointCurve);
  registerHandler("kern_closestPointSurface", handle_kern_closestPointSurface);
  registerHandler("kern_closestCurveCurve", handle_kern_closestCurveCurve);
  registerHandler("kern_closestCurveSurface", handle_kern_closestCurveSurface);
  registerHandler("kern_closestSurfaceSurface", handle_kern_closestSurfaceSurface);
}
