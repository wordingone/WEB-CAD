// mesh-to-brep-snapshot.ts — §WEB-CAD#62
// Convert a THREE.BufferGeometry to a BrepSnapshot:
// a compact, serialisable record of vertex positions + per-face normals.
//
// BrepSnapshot is the comparison currency for parametric builder gates:
// given the same footprint, two builders should produce identical snapshots
// within epsilon. It is NOT a full Brep topology — edges and trim loops are
// omitted because tessellated mesh data doesn't carry them without expensive
// reconstruction. Vertex cloud + face normals are sufficient for the 1mm
// correctness gate.

import * as THREE from "three";

export interface BrepSnapshot {
  /** Flat vertex array: [x0,y0,z0, x1,y1,z1, ...] rounded to 6dp. */
  vertices: number[];
  /** Per-face normals: [nx0,ny0,nz0, nx1,ny1,nz1, ...] rounded to 6dp. */
  faceNormals: number[];
  vertCount: number;
  faceCount: number;
  /** Axis-aligned bounding box of the vertex cloud. */
  bbox: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
}

const R6 = (n: number) => parseFloat(n.toFixed(6));

function snapVec3(x: number, y: number, z: number): [number, number, number] {
  return [R6(x), R6(y), R6(z)];
}

/**
 * Extract BrepSnapshot from a single BufferGeometry (must be indexed or non-indexed).
 * Applies `object.matrixWorld` if supplied — allows extracting from placed scene objects.
 */
export function geometryToBrepSnapshot(
  geometry: THREE.BufferGeometry,
  matrixWorld?: THREE.Matrix4,
): BrepSnapshot {
  const geom = geometry.clone();
  if (!geom.index) {
    geom.computeVertexNormals();
  }

  const pos = geom.getAttribute("position") as THREE.BufferAttribute;
  const idx = geom.index;

  const mat = matrixWorld ?? new THREE.Matrix4();
  const verts: number[] = [];
  const normals: number[] = [];

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  const tmp = new THREE.Vector3();

  // Collect all unique vertex positions (in world space)
  const vertCount = pos.count;
  for (let i = 0; i < vertCount; i++) {
    tmp.fromBufferAttribute(pos, i).applyMatrix4(mat);
    const [x, y, z] = snapVec3(tmp.x, tmp.y, tmp.z);
    verts.push(x, y, z);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // Per-face normals (cross product of triangle edges)
  const faceCount = idx ? idx.count / 3 : vertCount / 3;
  for (let f = 0; f < faceCount; f++) {
    const i0 = idx ? idx.getX(f * 3)     : f * 3;
    const i1 = idx ? idx.getX(f * 3 + 1) : f * 3 + 1;
    const i2 = idx ? idx.getX(f * 3 + 2) : f * 3 + 2;

    const ax = verts[i0 * 3], ay = verts[i0 * 3 + 1], az = verts[i0 * 3 + 2];
    const bx = verts[i1 * 3], by = verts[i1 * 3 + 1], bz = verts[i1 * 3 + 2];
    const cx = verts[i2 * 3], cy = verts[i2 * 3 + 1], cz = verts[i2 * 3 + 2];

    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const fx = cx - ax, fy = cy - ay, fz = cz - az;

    const nx = ey * fz - ez * fy;
    const ny = ez * fx - ex * fz;
    const nz = ex * fy - ey * fx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const [nnx, nny, nnz] = len > 1e-12
      ? snapVec3(nx / len, ny / len, nz / len)
      : [0, 0, 1] as [number, number, number];
    normals.push(nnx, nny, nnz);
  }

  geom.dispose();

  return {
    vertices: verts,
    faceNormals: normals,
    vertCount: verts.length / 3,
    faceCount,
    bbox: {
      minX: R6(minX), maxX: R6(maxX),
      minY: R6(minY), maxY: R6(maxY),
      minZ: R6(minZ), maxZ: R6(maxZ),
    },
  };
}

/**
 * Extract BrepSnapshot from a THREE.Object3D (Group or Mesh).
 * Traverses all descendant Mesh objects, accumulates into one snapshot.
 */
export function objectToBrepSnapshot(obj: THREE.Object3D): BrepSnapshot {
  obj.updateMatrixWorld(true);

  const allVerts: number[] = [];
  const allNormals: number[] = [];

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  obj.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const snap = geometryToBrepSnapshot(child.geometry, child.matrixWorld);
    allVerts.push(...snap.vertices);
    allNormals.push(...snap.faceNormals);
    if (snap.bbox.minX < minX) minX = snap.bbox.minX;
    if (snap.bbox.maxX > maxX) maxX = snap.bbox.maxX;
    if (snap.bbox.minY < minY) minY = snap.bbox.minY;
    if (snap.bbox.maxY > maxY) maxY = snap.bbox.maxY;
    if (snap.bbox.minZ < minZ) minZ = snap.bbox.minZ;
    if (snap.bbox.maxZ > maxZ) maxZ = snap.bbox.maxZ;
  });

  return {
    vertices: allVerts,
    faceNormals: allNormals,
    vertCount: allVerts.length / 3,
    faceCount: allNormals.length / 3,
    bbox: {
      minX: R6(minX), maxX: R6(maxX),
      minY: R6(minY), maxY: R6(maxY),
      minZ: R6(minZ), maxZ: R6(maxZ),
    },
  };
}
