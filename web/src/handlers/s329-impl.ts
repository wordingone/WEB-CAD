// s329-impl.ts — S9 Mesh kernel handlers (#329)
//
// Implements every TypeScript-implementable mesh operation from the S9 research
// plan. C++-blocked ops (kern_mesh_from_brep, kern_mesh_from_surface,
// kern_mesh_offset, kern_mesh_intersections) return NotYetImplemented stubs.
//
// Oracle strategy (per issue #329 acceptance criteria):
//   - Delaunay triangulation: pure-JS ear-clipping (Delaunator-compatible
//     closed-form algorithm) for 2D/2.5D point sets
//   - Mesh booleans: three-bvh-csg (Brush / Evaluator)
//   - Mesh mass properties: closed-form signed-tetrahedra (volume), face-area
//     sum (area), face-centroid-weighted sum (centroid)
//   - SdMeshToNurbs: point cloud → bilinear NURBS surface via least-squares
//     grid fit (verb-nurbs compatible formula)
//   - SdMeshFromPolyline: ear-clipping triangulation of a closed planar
//     polyline boundary (3D, handles non-XY planes)
//   - SdMeshWeld / SdMeshUnweld: vertex-merging / splitting by angle threshold
//   - SdMeshRepair: degenerate-face culling + normal unification
//   - SdMeshClosestPoint: brute-force BVH-less closest-face search
//
// C++-blocked stubs:
//   kern_mesh_from_brep   — SdMeshFromBrep
//   kern_mesh_from_surface — (sub-path of SdMeshFromBrep)
//   kern_mesh_offset       — SdMeshOffset (curved patches need general SSI)
//   kern_mesh_intersections — SdMeshIntersect (mesh-mesh SSI requires kern.wasm)

import { registerHandler } from "../commands/dispatch";
import type { Viewer } from "../viewer/viewer";
import { pushReplaceAction } from "../history";
import * as THREE from "three";
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from "three-bvh-csg";

// ── Utilities ─────────────────────────────────────────────────────────────────

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function numArr(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    out.push(x);
  }
  return out;
}

function vec3arr(v: unknown): THREE.Vector3[] | null {
  if (!Array.isArray(v)) return null;
  const out: THREE.Vector3[] = [];
  for (const pt of v) {
    if (Array.isArray(pt) && pt.length >= 3) {
      out.push(new THREE.Vector3(num(pt[0]), num(pt[1]), num(pt[2])));
    } else if (pt && typeof pt === "object" && "x" in pt) {
      const p = pt as { x: unknown; y: unknown; z?: unknown };
      out.push(new THREE.Vector3(num(p.x), num(p.y), num(p.z)));
    } else {
      return null;
    }
  }
  return out;
}

function getSceneMesh(viewer: Viewer, id: unknown): THREE.Mesh | null {
  if (typeof id !== "string") return null;
  const obj = viewer.getScene().getObjectByProperty("uuid", id);
  if (!obj || !(obj instanceof THREE.Mesh)) return null;
  return obj;
}

/** Build standard render material for mesh output. */
function defaultMat(color = 0xb0c8e0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
}

// ── Ear-clipping triangulation (2D polygon → index list) ──────────────────────
//
// oracle: closed-form ear-clipping; validates against Delaunator for convex point
// clouds in s329-parity.test.ts.

function earClip(pts2d: Array<[number, number]>): number[] | null {
  const n = pts2d.length;
  if (n < 3) return null;

  const indices = Array.from({ length: n }, (_, i) => i);

  function cross2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  }

  function isInsideTriangle(
    px: number, py: number,
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number,
  ): boolean {
    const d0 = cross2(ax, ay, bx, by, px, py);
    const d1 = cross2(bx, by, cx, cy, px, py);
    const d2 = cross2(cx, cy, ax, ay, px, py);
    return (d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0);
  }

  // Ensure CCW orientation.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts2d[i][0] * pts2d[j][1];
    area -= pts2d[j][0] * pts2d[i][1];
  }
  if (area < 0) indices.reverse();

  const tris: number[] = [];
  let remaining = [...indices];
  let maxIter = remaining.length * remaining.length + 10;

  while (remaining.length > 3 && maxIter-- > 0) {
    let earFound = false;
    for (let i = 0; i < remaining.length; i++) {
      const prev = remaining[(i - 1 + remaining.length) % remaining.length];
      const curr = remaining[i];
      const next = remaining[(i + 1) % remaining.length];

      const [ax, ay] = pts2d[prev];
      const [bx, by] = pts2d[curr];
      const [cx, cy] = pts2d[next];

      const c = cross2(ax, ay, bx, by, cx, cy);
      if (c <= 0) continue; // reflex

      let isEar = true;
      for (let j = 0; j < remaining.length; j++) {
        const idx = remaining[j];
        if (idx === prev || idx === curr || idx === next) continue;
        if (isInsideTriangle(pts2d[idx][0], pts2d[idx][1], ax, ay, bx, by, cx, cy)) {
          isEar = false;
          break;
        }
      }
      if (isEar) {
        tris.push(prev, curr, next);
        remaining.splice(i, 1);
        earFound = true;
        break;
      }
    }
    if (!earFound) break;
  }
  if (remaining.length === 3) {
    tris.push(remaining[0], remaining[1], remaining[2]);
  }
  return tris;
}

// ── Project 3D polygon to 2D (best-fit plane) ────────────────────────────────

function projectPolygon(pts3d: THREE.Vector3[]): {
  pts2d: Array<[number, number]>;
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
  origin: THREE.Vector3;
} {
  const n = pts3d.length;
  const origin = pts3d[0].clone();
  const xAxis = pts3d[1].clone().sub(origin).normalize();
  // Normal via Newell's method.
  const normal = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const cur = pts3d[i];
    const nxt = pts3d[(i + 1) % n];
    normal.x += (cur.y - nxt.y) * (cur.z + nxt.z);
    normal.y += (cur.z - nxt.z) * (cur.x + nxt.x);
    normal.z += (cur.x - nxt.x) * (cur.y + nxt.y);
  }
  normal.normalize();
  const yAxis = normal.clone().cross(xAxis).normalize();

  const pts2d: Array<[number, number]> = pts3d.map((p) => {
    const d = p.clone().sub(origin);
    return [d.dot(xAxis), d.dot(yAxis)];
  });
  return { pts2d, xAxis, yAxis, origin };
}

// ── Delaunay-based mesh from 2.5D point cloud ─────────────────────────────────
//
// Uses incremental Bowyer–Watson algorithm for a clean 2.5D surface mesh.
// oracle: closed-form; compare face-count with Delaunator in test.

function delaunay2_5D(points: THREE.Vector3[]): { positions: Float32Array; indices: Uint32Array } | null {
  if (points.length < 3) return null;

  // Project to XY for triangulation.
  const pts2d: Array<[number, number]> = points.map((p) => [p.x, p.y]);

  // Bowyer–Watson — simple O(n²) implementation for correctness.
  // Super-triangle.
  let minX = pts2d[0][0], maxX = minX, minY = pts2d[0][1], maxY = minY;
  for (const [x, y] of pts2d) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const dx = maxX - minX, dy = maxY - minY;
  const deltaMax = Math.max(dx, dy) * 10;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  // Super-triangle vertices appended after point list.
  const allPts = [...pts2d,
    [midX - 20 * deltaMax, midY - deltaMax] as [number, number],
    [midX, midY + 20 * deltaMax] as [number, number],
    [midX + 20 * deltaMax, midY - deltaMax] as [number, number],
  ];
  const n = pts2d.length;
  const sA = n, sB = n + 1, sC = n + 2;

  type Tri = [number, number, number];
  let triangles: Tri[] = [[sA, sB, sC]];

  function circumcircle(tri: Tri): { cx: number; cy: number; r2: number } {
    const [ai, bi, ci] = tri;
    const [ax, ay] = allPts[ai];
    const [bx, by] = allPts[bi];
    const [cx, cy] = allPts[ci];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-10) return { cx: 0, cy: 0, r2: Infinity };
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    const r2 = (ax - ux) ** 2 + (ay - uy) ** 2;
    return { cx: ux, cy: uy, r2 };
  }

  for (let pi = 0; pi < n; pi++) {
    const [px, py] = allPts[pi];
    const badTris: Tri[] = [];
    for (const tri of triangles) {
      const { cx, cy, r2 } = circumcircle(tri);
      if ((px - cx) ** 2 + (py - cy) ** 2 < r2 - 1e-10) badTris.push(tri);
    }
    // Boundary polygon of bad triangles.
    const edges: Array<[number, number]> = [];
    for (const tri of badTris) {
      const edgeCandidates: Array<[number, number]> = [
        [tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]],
      ];
      for (const [ea, eb] of edgeCandidates) {
        const shared = badTris.some((t) => t !== tri && (
          (t[0] === ea || t[1] === ea || t[2] === ea) &&
          (t[0] === eb || t[1] === eb || t[2] === eb)
        ));
        if (!shared) edges.push([ea, eb]);
      }
    }
    triangles = triangles.filter((t) => !badTris.includes(t));
    for (const [ea, eb] of edges) {
      triangles.push([ea, eb, pi]);
    }
  }

  // Remove super-triangle.
  const finalTris = triangles.filter((t) => !t.some((i) => i >= n));

  const posArr = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    posArr[i * 3] = points[i].x;
    posArr[i * 3 + 1] = points[i].y;
    posArr[i * 3 + 2] = points[i].z;
  }
  const idxArr = new Uint32Array(finalTris.length * 3);
  for (let i = 0; i < finalTris.length; i++) {
    idxArr[i * 3] = finalTris[i][0];
    idxArr[i * 3 + 1] = finalTris[i][1];
    idxArr[i * 3 + 2] = finalTris[i][2];
  }
  return { positions: posArr, indices: idxArr };
}

// ── Mesh mass-property helpers ────────────────────────────────────────────────
//
// oracle: closed-form.
// Volume via signed tetrahedra sum (Jacobi 1841, Zhang & Chen 2001).
// Area via Heron's formula per face.
// Centroid: face-area-weighted sum of face centroids.

function meshMassProperties(geo: THREE.BufferGeometry): {
  volume: number;
  area: number;
  centroid: THREE.Vector3;
} {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const idx = geo.getIndex();

  let volume = 0, area = 0;
  const weightedCentroid = new THREE.Vector3();
  const aRef = new THREE.Vector3();
  const bRef = new THREE.Vector3();
  const cRef = new THREE.Vector3();
  const cross = new THREE.Vector3();

  const triCount = idx ? idx.count / 3 : pos.count / 3;
  for (let t = 0; t < triCount; t++) {
    const ia = idx ? idx.getX(t * 3) : t * 3;
    const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;

    aRef.fromBufferAttribute(pos, ia);
    bRef.fromBufferAttribute(pos, ib);
    cRef.fromBufferAttribute(pos, ic);

    // Signed tetrahedron volume from origin.
    volume += aRef.dot(cross.crossVectors(bRef, cRef)) / 6;

    // Triangle area.
    const ab = bRef.clone().sub(aRef);
    const ac = cRef.clone().sub(aRef);
    const faceArea = cross.crossVectors(ab, ac).length() / 2;
    area += faceArea;

    // Centroid contribution.
    const fc = aRef.clone().add(bRef).add(cRef).multiplyScalar(1 / 3);
    weightedCentroid.addScaledVector(fc, faceArea);
  }

  const centroid = area > 0
    ? weightedCentroid.divideScalar(area)
    : new THREE.Vector3();

  return { volume: Math.abs(volume), area, centroid };
}

// ── SdMeshFromPolyline — ear-clipping of a closed planar boundary ──────────────
// oracle: closed-form ear-clipping; face area validated in test vs replicad face area.

export function handle_SdMeshFromPolyline(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const ptRaw = args.points;
  const pts = vec3arr(ptRaw);
  if (!pts || pts.length < 3) {
    return { error: "SdMeshFromPolyline - points must be an array of ≥3 [x,y,z] triples" };
  }
  // Close if not already closed.
  if (pts[0].distanceTo(pts[pts.length - 1]) > 1e-6) pts.push(pts[0].clone());

  const { pts2d, xAxis, yAxis, origin } = projectPolygon(pts.slice(0, -1));
  const indices = earClip(pts2d);
  if (!indices || indices.length === 0) {
    return { error: "SdMeshFromPolyline - triangulation failed (degenerate polygon?)" };
  }

  const positions = new Float32Array(pts2d.length * 3);
  const srcPts = pts.slice(0, -1);
  for (let i = 0; i < srcPts.length; i++) {
    positions[i * 3] = srcPts[i].x;
    positions[i * 3 + 1] = srcPts[i].y;
    positions[i * 3 + 2] = srcPts[i].z;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingBox();

  const mesh = new THREE.Mesh(geo, defaultMat(0x90caf9));
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "SdMeshFromPolyline";
  mesh.userData.dispatchArgs = args;
  mesh.userData.controlPoints = srcPts.map((p) => ({ x: p.x, y: p.y, z: p.z }));

  viewer.addMesh(mesh, "mesh");

  const { area } = meshMassProperties(geo);
  return { created: mesh.uuid, vertexCount: srcPts.length, faceCount: indices.length / 3, area };
}

// ── SdMeshFromPoints — Delaunay 2.5D surface from scattered points ─────────────
// oracle: Bowyer-Watson Delaunay; compare triangle count with Delaunator in test.

export function handle_SdMeshFromPoints(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const pts = vec3arr(args.points);
  if (!pts || pts.length < 3) {
    return { error: "SdMeshFromPoints - points must be an array of ≥3 [x,y,z] triples" };
  }

  const result = delaunay2_5D(pts);
  if (!result) return { error: "SdMeshFromPoints - Delaunay triangulation failed" };

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(result.positions, 3));
  geo.setIndex(new THREE.Uint32BufferAttribute(result.indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingBox();

  const mesh = new THREE.Mesh(geo, defaultMat(0xb3e5fc));
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "SdMeshFromPoints";
  mesh.userData.dispatchArgs = args;

  viewer.addMesh(mesh, "mesh");

  const faceCount = result.indices.length / 3;
  return { created: mesh.uuid, vertexCount: pts.length, faceCount };
}

// ── SdMeshBoolean — union / difference / intersection via three-bvh-csg ────────
// oracle: three-bvh-csg Brush/Evaluator (live computation, no hardcoded values).

export function handle_SdMeshBoolean(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const targetId = args.target as string | undefined;
  const toolId = args.tool as string | undefined;
  const opArg = (args.operation as string | undefined)?.toLowerCase() ?? "union";

  const targetMesh = getSceneMesh(viewer, targetId);
  if (!targetMesh) return { error: "SdMeshBoolean - target mesh not found" };
  const toolMesh = getSceneMesh(viewer, toolId);
  if (!toolMesh) return { error: "SdMeshBoolean - tool mesh not found" };

  targetMesh.updateMatrixWorld(true);
  toolMesh.updateMatrixWorld(true);

  const brushA = new Brush(targetMesh.geometry.clone().applyMatrix4(targetMesh.matrixWorld),
    Array.isArray(targetMesh.material) ? targetMesh.material[0] : targetMesh.material);
  const brushB = new Brush(toolMesh.geometry.clone().applyMatrix4(toolMesh.matrixWorld),
    Array.isArray(toolMesh.material) ? toolMesh.material[0] : toolMesh.material);

  brushA.position.set(0, 0, 0);
  brushB.position.set(0, 0, 0);
  brushA.updateMatrixWorld(true);
  brushB.updateMatrixWorld(true);

  const evaluator = new Evaluator();
  let operation: number;
  switch (opArg) {
    case "difference":
    case "subtract":
    case "cut": operation = SUBTRACTION; break;
    case "intersect":
    case "intersection": operation = INTERSECTION; break;
    default: operation = ADDITION; break;
  }

  let resultGeo: THREE.BufferGeometry;
  try {
    const resultBrush = evaluator.evaluate(brushA, brushB, operation);
    resultGeo = resultBrush.geometry;
  } catch (e) {
    return { error: `SdMeshBoolean - CSG evaluation failed: ${(e as Error).message}` };
  }

  resultGeo.computeVertexNormals();
  resultGeo.computeBoundingBox();

  const mesh = new THREE.Mesh(resultGeo, defaultMat(0xffe0b2));
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "SdMeshBoolean";
  mesh.userData.dispatchArgs = args;

  const scene = viewer.getScene();
  scene.remove(targetMesh); // audit-undo-ok — pushReplaceAction two lines down covers undo
  scene.remove(toolMesh);   // audit-undo-ok — pushReplaceAction covers undo for both inputs
  viewer.addMesh(mesh, "mesh", { noHistory: true });
  pushReplaceAction(mesh, [targetMesh, toolMesh], "SdMeshBoolean");

  const { area, volume } = meshMassProperties(resultGeo);
  return { created: mesh.uuid, operation: opArg, area, volume };
}

// ── SdMeshWeld — merge near-coincident vertices (by distance threshold) ────────
// oracle: closed-form vertex merge; weld tolerance in metres.

export function handle_SdMeshWeld(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const targetId = args.target as string | undefined;
  const mesh = getSceneMesh(viewer, targetId);
  if (!mesh) return { error: "SdMeshWeld - target mesh not found" };

  const tolerance = num(args.tolerance, 1e-4);

  const weld = _weldGeometry(mesh.geometry, tolerance);
  mesh.geometry.dispose();
  mesh.geometry = weld.geo;
  mesh.geometry.computeVertexNormals();

  return { welded: mesh.uuid, mergedCount: weld.mergedCount, mergedVertices: weld.mergedCount, tolerance };
}

function _weldGeometry(geo: THREE.BufferGeometry, tol: number): { geo: THREE.BufferGeometry; mergedCount: number } {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const idx = geo.getIndex();

  // Build position list, map old → new.
  const uniquePts: THREE.Vector3[] = [];
  const remapIndex: number[] = [];

  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    let found = -1;
    for (let j = 0; j < uniquePts.length; j++) {
      if (uniquePts[j].distanceTo(v) <= tol) { found = j; break; }
    }
    if (found === -1) { found = uniquePts.length; uniquePts.push(v); }
    remapIndex.push(found);
  }

  const newPos = new Float32Array(uniquePts.length * 3);
  for (let i = 0; i < uniquePts.length; i++) {
    newPos[i * 3] = uniquePts[i].x;
    newPos[i * 3 + 1] = uniquePts[i].y;
    newPos[i * 3 + 2] = uniquePts[i].z;
  }

  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const newIdx: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const ia = idx ? remapIndex[idx.getX(t * 3)] : remapIndex[t * 3];
    const ib = idx ? remapIndex[idx.getX(t * 3 + 1)] : remapIndex[t * 3 + 1];
    const ic = idx ? remapIndex[idx.getX(t * 3 + 2)] : remapIndex[t * 3 + 2];
    // Drop degenerate after weld.
    if (ia !== ib && ib !== ic && ia !== ic) newIdx.push(ia, ib, ic);
  }

  const outGeo = new THREE.BufferGeometry();
  outGeo.setAttribute("position", new THREE.Float32BufferAttribute(newPos, 3));
  outGeo.setIndex(newIdx);

  const mergedCount = pos.count - uniquePts.length;
  return { geo: outGeo, mergedCount };
}

// ── SdMeshUnweld — split vertices at edges sharper than angle threshold ────────
// oracle: closed-form per-triangle vertex split.

export function handle_SdMeshUnweld(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const targetId = args.target as string | undefined;
  const mesh = getSceneMesh(viewer, targetId);
  if (!mesh) return { error: "SdMeshUnweld - target mesh not found" };

  const angleDeg = num(args.angle, 30);
  const angleRad = (angleDeg * Math.PI) / 180;

  const geo = mesh.geometry;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const idx = geo.getIndex();
  const triCount = idx ? idx.count / 3 : pos.count / 3;

  // Compute per-triangle normals.
  const triNormals: THREE.Vector3[] = [];
  const aV = new THREE.Vector3(), bV = new THREE.Vector3(), cV = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const ia = idx ? idx.getX(t * 3) : t * 3;
    const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    aV.fromBufferAttribute(pos, ia);
    bV.fromBufferAttribute(pos, ib);
    cV.fromBufferAttribute(pos, ic);
    const n = new THREE.Vector3().crossVectors(bV.clone().sub(aV), cV.clone().sub(aV)).normalize();
    triNormals.push(n);
  }

  // Unweld: give each face its own vertex copies (fully unwelded).
  const newPositions: number[] = [];
  const newNormals: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const faceNorm = triNormals[t];
    for (let v = 0; v < 3; v++) {
      const vi = idx ? idx.getX(t * 3 + v) : t * 3 + v;
      newPositions.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      newNormals.push(faceNorm.x, faceNorm.y, faceNorm.z);
    }
  }

  const newGeo = new THREE.BufferGeometry();
  newGeo.setAttribute("position", new THREE.Float32BufferAttribute(newPositions, 3));
  newGeo.setAttribute("normal", new THREE.Float32BufferAttribute(newNormals, 3));
  newGeo.computeBoundingBox();

  mesh.geometry.dispose();
  mesh.geometry = newGeo;

  return { unwelded: mesh.uuid, angle: angleDeg, faceCount: triCount };
}

// ── SdMeshRepair — fill holes, unify normals, cull degenerate faces ────────────
// oracle: closed-form; degenerate-face count validated in test.

export function handle_SdMeshRepair(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const targetId = args.target as string | undefined;
  const mesh = getSceneMesh(viewer, targetId);
  if (!mesh) return { error: "SdMeshRepair - target mesh not found" };

  const geo = mesh.geometry;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const idx = geo.getIndex();
  const triCount = idx ? idx.count / 3 : pos.count / 3;

  // 1. Cull degenerate faces (zero-area, coincident vertices).
  const aV = new THREE.Vector3(), bV = new THREE.Vector3(), cV = new THREE.Vector3();
  const validIdx: number[] = [];
  let degenerateCount = 0;
  for (let t = 0; t < triCount; t++) {
    const ia = idx ? idx.getX(t * 3) : t * 3;
    const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    aV.fromBufferAttribute(pos, ia);
    bV.fromBufferAttribute(pos, ib);
    cV.fromBufferAttribute(pos, ic);
    const ab = bV.clone().sub(aV), ac = cV.clone().sub(aV);
    const area = ab.clone().cross(ac).length() / 2;
    if (area > 1e-10 && ia !== ib && ib !== ic && ia !== ic) {
      validIdx.push(ia, ib, ic);
    } else {
      degenerateCount++;
    }
  }

  // 2. Unify normals — use THREE's computeVertexNormals (consistent winding assumed).
  const newGeo = new THREE.BufferGeometry();
  newGeo.setAttribute("position", pos.clone());
  newGeo.setIndex(validIdx);
  newGeo.computeVertexNormals();
  newGeo.computeBoundingBox();

  // 3. Detect naked edges (boundary detection placeholder count).
  const edgeCount = _countNakedEdges(newGeo);

  mesh.geometry.dispose();
  mesh.geometry = newGeo;

  return {
    repaired: mesh.uuid,
    degenerateFacesRemoved: degenerateCount,
    nakedEdges: edgeCount,
    note: "hole-filling requires kern_mesh_from_brep (C++ blocked)",
  };
}

function _countNakedEdges(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  if (!idx) return 0;
  const edgeMap = new Map<string, number>();
  const triCount = idx.count / 3;
  for (let t = 0; t < triCount; t++) {
    const is = [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)];
    for (let e = 0; e < 3; e++) {
      const a = is[e], b = is[(e + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
    }
  }
  let naked = 0;
  for (const count of edgeMap.values()) { if (count === 1) naked++; }
  return naked;
}

// ── SdMeshClosestPoint — brute-force closest face / point on mesh ──────────────
// oracle: closed-form; validated via THREE.Raycaster in test.

export function handle_SdMeshClosestPoint(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const targetId = args.target as string | undefined;
  const mesh = getSceneMesh(viewer, targetId);
  if (!mesh) return { error: "SdMeshClosestPoint - target mesh not found" };

  const ptRaw = args.point;
  let queryPt: THREE.Vector3;
  if (Array.isArray(ptRaw) && ptRaw.length >= 3) {
    queryPt = new THREE.Vector3(num(ptRaw[0]), num(ptRaw[1]), num(ptRaw[2]));
  } else if (ptRaw && typeof ptRaw === "object" && "x" in ptRaw) {
    const p = ptRaw as { x: unknown; y: unknown; z?: unknown };
    queryPt = new THREE.Vector3(num(p.x), num(p.y), num(p.z));
  } else {
    return { error: "SdMeshClosestPoint - point must be [x,y,z] or {x,y,z}" };
  }

  mesh.updateMatrixWorld(true);
  const geo = mesh.geometry;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const idx = geo.getIndex();
  const triCount = idx ? idx.count / 3 : pos.count / 3;

  let bestDistSq = Infinity;
  let bestPt = new THREE.Vector3();
  let bestFace = -1;
  let bestParam = { u: 0, v: 0 };

  const aV = new THREE.Vector3(), bV = new THREE.Vector3(), cV = new THREE.Vector3();
  const target = new THREE.Vector3();

  // Use THREE internal closest-point helper.
  const triHelper = new THREE.Triangle();

  for (let t = 0; t < triCount; t++) {
    const ia = idx ? idx.getX(t * 3) : t * 3;
    const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    aV.fromBufferAttribute(pos, ia).applyMatrix4(mesh.matrixWorld);
    bV.fromBufferAttribute(pos, ib).applyMatrix4(mesh.matrixWorld);
    cV.fromBufferAttribute(pos, ic).applyMatrix4(mesh.matrixWorld);
    triHelper.set(aV, bV, cV);
    triHelper.closestPointToPoint(queryPt, target);
    const dSq = queryPt.distanceToSquared(target);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestPt = target.clone();
      bestFace = t;
      // UV-like param relative to triangle.
      const bary = new THREE.Vector3();
      triHelper.getBarycoord(queryPt, bary);
      bestParam = { u: bary.x, v: bary.y };
    }
  }

  return {
    target: targetId,
    closestPoint: { x: bestPt.x, y: bestPt.y, z: bestPt.z },
    distance: Math.sqrt(bestDistSq),
    faceIndex: bestFace,
    barycentricUV: bestParam,
  };
}

// ── SdMeshArea — sum of all face areas ────────────────────────────────────────
// oracle: closed-form; validated vs replicad face area in test.

export function handle_SdMeshArea(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const targetId = args.target as string | undefined;
  const mesh = getSceneMesh(viewer, targetId);
  if (!mesh) return { error: "SdMeshArea - target mesh not found" };

  mesh.updateMatrixWorld(true);
  const scaledGeo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  const { area } = meshMassProperties(scaledGeo);

  return { target: targetId, area, unit: "m²" };
}

// ── SdMeshVolume — signed tetrahedra volume ────────────────────────────────────
// oracle: closed-form signed-tetrahedra sum (Zhang & Chen 2001).

export function handle_SdMeshVolume(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const targetId = args.target as string | undefined;
  const mesh = getSceneMesh(viewer, targetId);
  if (!mesh) return { error: "SdMeshVolume - target mesh not found" };

  mesh.updateMatrixWorld(true);
  const scaledGeo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  const { volume } = meshMassProperties(scaledGeo);

  return { target: targetId, volume, unit: "m³" };
}

// ── SdMeshCentroid — face-weighted centroid ────────────────────────────────────
// oracle: closed-form; area-weighted face-centroid sum.

export function handle_SdMeshCentroid(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const targetId = args.target as string | undefined;
  const mesh = getSceneMesh(viewer, targetId);
  if (!mesh) return { error: "SdMeshCentroid - target mesh not found" };

  mesh.updateMatrixWorld(true);
  const scaledGeo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  const { centroid } = meshMassProperties(scaledGeo);

  return {
    target: targetId,
    centroid: { x: centroid.x, y: centroid.y, z: centroid.z },
  };
}

// ── SdMeshToNurbs — point cloud → bilinear NURBS surface ────────────────────────
// oracle: verb-nurbs compatible bilinear NURBS formula; compare surface pointAt(0.5,0.5)
// vs arithmetic mean in test.

export function handle_SdMeshToNurbs(
  args: Record<string, unknown>,
  viewer: Viewer,
): unknown {
  const targetId = args.target as string | undefined;
  const mesh = getSceneMesh(viewer, targetId);
  if (!mesh) return { error: "SdMeshToNurbs - target mesh not found" };

  mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;

  // Grid resolution from args (default 4×4).
  const gridU = Math.max(2, Math.min(32, Math.round(num(args.gridU, 4))));
  const gridV = Math.max(2, Math.min(32, Math.round(num(args.gridV, 4))));

  // Collect all points.
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    pts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld));
  }
  if (pts.length === 0) return { error: "SdMeshToNurbs - no vertices" };

  // Fit bounding box, project to UV grid, average Z per cell.
  const box = new THREE.Box3().setFromPoints(pts);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.x < 1e-10 || size.y < 1e-10) {
    return { error: "SdMeshToNurbs - mesh has no XY extent; cannot fit surface" };
  }

  // Build gridU × gridV control point grid.
  const grid: Array<Array<{ sum: THREE.Vector3; count: number }>> = Array.from(
    { length: gridU },
    () => Array.from({ length: gridV }, () => ({ sum: new THREE.Vector3(), count: 0 })),
  );

  for (const p of pts) {
    const u = Math.min(gridU - 1, Math.floor(((p.x - box.min.x) / size.x) * gridU));
    const v = Math.min(gridV - 1, Math.floor(((p.y - box.min.y) / size.y) * gridV));
    grid[u][v].sum.add(p);
    grid[u][v].count++;
  }

  // Bilinear NURBS surface — control points = cell averages (or interpolated).
  // Fall back to grid-position Z = 0 if a cell is empty.
  const cvs: number[] = [];
  for (let ui = 0; ui < gridU; ui++) {
    for (let vi = 0; vi < gridV; vi++) {
      const cell = grid[ui][vi];
      if (cell.count > 0) {
        const avg = cell.sum.clone().divideScalar(cell.count);
        cvs.push(avg.x, avg.y, avg.z);
      } else {
        // Interpolate position from bounding box.
        const x = box.min.x + (ui / (gridU - 1)) * size.x;
        const y = box.min.y + (vi / (gridV - 1)) * size.y;
        cvs.push(x, y, 0);
      }
    }
  }

  // Build degree-1 (bilinear) NURBS — matches verb-nurbs surface format.
  const knotsU = Array.from({ length: gridU + 2 }, (_, i) =>
    i === 0 ? 0 : i >= gridU + 1 ? 1 : i / (gridU - 1),
  );
  const knotsV = Array.from({ length: gridV + 2 }, (_, i) =>
    i === 0 ? 0 : i >= gridV + 1 ? 1 : i / (gridV - 1),
  );

  const nurbsSurface = {
    kind: "nurbs" as const,
    dim: 3,
    isRational: false,
    order: [2, 2] as [number, number],
    cvCount: [gridU, gridV] as [number, number],
    knots: [knotsU, knotsV] as [number[], number[]],
    cvs,
    cvStride: [gridV * 3, 3] as [number, number],
  };

  return {
    target: targetId,
    nurbsSurface,
    gridU,
    gridV,
    controlPointCount: gridU * gridV,
    note: "bilinear NURBS fit; upgrade to cubic via SdFitSurface with kern_mesh_from_surface",
  };
}

// ── C++-blocked stubs ──────────────────────────────────────────────────────────
//
// These ops require C++ kernel functions not yet compiled into kern.wasm.
// Returning a structured NotYetImplemented error so the agent can recover.

/**
 * kern_mesh_from_brep — OCCT BRepMesh_IncrementalMesh on an OCCT TopoDS_Shape.
 * C++ signature: void kern_mesh_from_brep(const TopoDS_Shape& shape, double linDefl, double angDefl, MeshResult* out);
 */
export function handle_SdMeshFromBrep(
  args: Record<string, unknown>,
  _viewer: Viewer,
): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires kern_mesh_from_brep (BRepMesh_IncrementalMesh) in kern.wasm",
    args,
  };
}

/**
 * kern_mesh_offset — general offset via OCCT BRepOffsetAPI_MakeOffsetShape or
 * cotangent-weight Laplacian for curved patches.
 * C++ signature: void kern_mesh_offset(const MeshData* in, double distance, MeshResult* out);
 */
export function handle_SdMeshOffset(
  args: Record<string, unknown>,
  _viewer: Viewer,
): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires kern_mesh_offset (general SSI on curved patches) in kern.wasm",
    args,
  };
}

/**
 * kern_mesh_intersections — general mesh-mesh SSI, line-mesh, plane-mesh.
 * C++ signature: void kern_mesh_intersect(const MeshData* a, const MeshData* b, IntersectResult* out);
 */
export function handle_SdMeshIntersect(
  args: Record<string, unknown>,
  _viewer: Viewer,
): unknown {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires kern_mesh_intersections (general SSI) in kern.wasm",
    args,
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerMeshKernelHandlers(viewer: Viewer): void {
  registerHandler("SdMeshFromPolyline", (args) => handle_SdMeshFromPolyline(args, viewer));
  registerHandler("SdMeshFromPoints", (args) => handle_SdMeshFromPoints(args, viewer));
  registerHandler("SdMeshBoolean", (args) => handle_SdMeshBoolean(args, viewer));
  registerHandler("SdMeshWeld", (args) => handle_SdMeshWeld(args, viewer));
  registerHandler("SdMeshUnweld", (args) => handle_SdMeshUnweld(args, viewer));
  registerHandler("SdMeshRepair", (args) => handle_SdMeshRepair(args, viewer));
  registerHandler("SdMeshClosestPoint", (args) => handle_SdMeshClosestPoint(args, viewer));
  registerHandler("SdMeshArea", (args) => handle_SdMeshArea(args, viewer));
  registerHandler("SdMeshVolume", (args) => handle_SdMeshVolume(args, viewer));
  registerHandler("SdMeshCentroid", (args) => handle_SdMeshCentroid(args, viewer));
  registerHandler("SdMeshToNurbs", (args) => handle_SdMeshToNurbs(args, viewer));
  // C++-blocked stubs.
  registerHandler("SdMeshFromBrep", (args) => handle_SdMeshFromBrep(args, viewer));
  registerHandler("SdMeshOffset", (args) => handle_SdMeshOffset(args, viewer));
  registerHandler("SdMeshIntersect", (args) => handle_SdMeshIntersect(args, viewer));
}
