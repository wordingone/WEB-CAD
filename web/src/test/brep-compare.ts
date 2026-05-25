// brep-compare.ts — §WEB-CAD#62
// Per-vertex and per-face-normal comparison between two BrepSnapshots.
//
// Comparison strategy:
//   Vertices:     Hausdorff-style — for each vertex in `reference`, find the
//                 nearest vertex in `actual` (KD-linear scan, O(n·m)).
//                 Report max nearest-distance as max_vertex_delta_m.
//
//   Face normals: Sort both normal lists by (nx,ny,nz) lexicographic order,
//                 then compare element-by-element. Reports max angular deviation
//                 (1 - dot(a,b)) ≈ deviation²/2 for small angles.
//
// Both comparisons are additive: every deviation is recorded, not just the first.
// Tolerance: 1e-3 m (1 mm) for vertices; 1e-3 rad (≈0.057°) for normals.

import type { BrepSnapshot } from "./mesh-to-brep-snapshot";

export interface BrepVertexFailure {
  ref_index: number;
  ref_vertex: [number, number, number];
  nearest_actual: [number, number, number];
  delta_m: number;
}

export interface BrepNormalFailure {
  index: number;
  ref_normal: [number, number, number];
  actual_normal: [number, number, number];
  angular_dev: number;
}

export interface BrepCompareResult {
  pass: boolean;
  max_vertex_delta_m: number;
  max_normal_angular_dev: number;
  vertex_failures: BrepVertexFailure[];
  normal_failures: BrepNormalFailure[];
  ref_vert_count: number;
  actual_vert_count: number;
  ref_face_count: number;
  actual_face_count: number;
  count_mismatch: boolean;
}

function dist3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Compare actual BrepSnapshot against reference within tolerances.
 * @param toleranceM   vertex tolerance in metres (default 1e-3 = 1mm)
 * @param normalTol    normal angular deviation tolerance (default 1e-3 rad)
 */
export function compareBrepSnapshot(
  actual: BrepSnapshot,
  reference: BrepSnapshot,
  toleranceM = 1e-3,
  normalTol  = 1e-3,
): BrepCompareResult {
  const vertFailures: BrepVertexFailure[] = [];
  const normFailures: BrepNormalFailure[] = [];

  const aV = actual.vertices;
  const rV = reference.vertices;

  const countMismatch = actual.vertCount !== reference.vertCount
    || actual.faceCount !== reference.faceCount;

  let maxVertDelta = 0;

  // Vertex Hausdorff: for each reference vertex, find nearest in actual
  const aLen = aV.length / 3;
  for (let ri = 0; ri < rV.length; ri += 3) {
    const rx = rV[ri], ry = rV[ri + 1], rz = rV[ri + 2];
    let nearest = Infinity;
    let nbx = 0, nby = 0, nbz = 0;
    for (let ai = 0; ai < aLen; ai++) {
      const d = dist3(rx, ry, rz, aV[ai * 3], aV[ai * 3 + 1], aV[ai * 3 + 2]);
      if (d < nearest) {
        nearest = d;
        nbx = aV[ai * 3]; nby = aV[ai * 3 + 1]; nbz = aV[ai * 3 + 2];
      }
    }
    if (nearest > maxVertDelta) maxVertDelta = nearest;
    if (nearest > toleranceM) {
      vertFailures.push({
        ref_index: ri / 3,
        ref_vertex: [rx, ry, rz],
        nearest_actual: [nbx, nby, nbz],
        delta_m: nearest,
      });
    }
  }

  // Normal comparison: sort both by lex order, compare pairwise
  const aN = actual.faceNormals;
  const rN = reference.faceNormals;

  function lexNormals(flat: number[]): [number, number, number][] {
    const arr: [number, number, number][] = [];
    for (let i = 0; i < flat.length; i += 3) arr.push([flat[i], flat[i + 1], flat[i + 2]]);
    return arr.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  }

  const sortedA = lexNormals(aN);
  const sortedR = lexNormals(rN);
  const nPairs = Math.min(sortedA.length, sortedR.length);

  let maxNormDev = 0;
  for (let i = 0; i < nPairs; i++) {
    const [ax, ay, az] = sortedA[i];
    const [rx, ry, rz] = sortedR[i];
    const dot = Math.max(-1, Math.min(1, ax * rx + ay * ry + az * rz));
    const dev = 1 - dot;
    if (dev > maxNormDev) maxNormDev = dev;
    if (dev > normalTol) {
      normFailures.push({
        index: i,
        ref_normal: [rx, ry, rz],
        actual_normal: [ax, ay, az],
        angular_dev: dev,
      });
    }
  }

  const pass = !countMismatch
    && maxVertDelta <= toleranceM
    && maxNormDev <= normalTol
    && vertFailures.length === 0
    && normFailures.length === 0;

  return {
    pass,
    max_vertex_delta_m: parseFloat(maxVertDelta.toFixed(6)),
    max_normal_angular_dev: parseFloat(maxNormDev.toFixed(6)),
    vertex_failures: vertFailures,
    normal_failures: normFailures,
    ref_vert_count: reference.vertCount,
    actual_vert_count: actual.vertCount,
    ref_face_count: reference.faceCount,
    actual_face_count: actual.faceCount,
    count_mismatch: countMismatch,
  };
}
