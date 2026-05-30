import * as THREE from "three";
import {
  BREP_DEFAULT_TOLERANCE,
  type Brep,
  type BrepEdge,
  type BrepFace,
  type BrepVertex,
} from "../nurbs/nurbs-brep";
import type { Curve } from "../nurbs/nurbs-curves";
import { Interval, Plane, type Point3 } from "../nurbs/nurbs-primitives";
import type { NurbsSurface, Surface } from "../nurbs/nurbs-surfaces";
import type { Viewer } from "../viewer/viewer";
import type { CanonicalGeometryStore } from "../geometry/canonical-geometry";

function point(v: THREE.Vector3): Point3 {
  return { x: v.x, y: v.y, z: v.z };
}

function lineCurve(a: THREE.Vector3, b: THREE.Vector3): Curve {
  return {
    kind: "line",
    from: point(a),
    to: point(b),
    domain: Interval.create(0, a.distanceTo(b)),
  };
}

function vertexKey(v: THREE.Vector3): string {
  const q = (n: number) => Math.round(n * 1e6);
  return `${q(v.x)},${q(v.y)},${q(v.z)}`;
}

function planarNurbsSurface(
  plane: Plane,
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
): NurbsSurface {
  const corner = (u: number, v: number): number[] => {
    const x = plane.origin.x + plane.xAxis.x * u + plane.yAxis.x * v;
    const y = plane.origin.y + plane.xAxis.y * u + plane.yAxis.y * v;
    const z = plane.origin.z + plane.xAxis.z * u + plane.yAxis.z * v;
    return [x, y, z];
  };
  return {
    kind: "nurbs",
    dim: 3,
    isRational: false,
    order: [2, 2],
    cvCount: [2, 2],
    knots: [[uMin, uMax], [vMin, vMax]],
    cvs: [
      ...corner(uMin, vMin),
      ...corner(uMin, vMax),
      ...corner(uMax, vMin),
      ...corner(uMax, vMax),
    ],
    cvStride: [6, 3],
  };
}

function curveFromUvLoop(uv: Array<{ u: number; v: number }>): Curve {
  const trimPoints = uv.map((p) => ({ x: p.u, y: p.v, z: 0 }));
  trimPoints.push({ ...trimPoints[0] });
  const parameters = [0];
  for (let i = 1; i < trimPoints.length; i++) {
    const p = trimPoints[i - 1];
    const q = trimPoints[i];
    parameters.push(parameters[i - 1] + Math.hypot(q.x - p.x, q.y - p.y));
  }
  return {
    kind: "polyline",
    points: trimPoints,
    parameters,
  };
}

function signedAreaUv(uv: Array<{ u: number; v: number }>): number {
  let area = 0;
  for (let i = 0; i < uv.length; i++) {
    const j = (i + 1) % uv.length;
    area += uv[i].u * uv[j].v - uv[j].u * uv[i].v;
  }
  return area / 2;
}

function avoidTriangularLoop(points: THREE.Vector3[]): THREE.Vector3[] {
  if (points.length !== 3) return points;
  const edges = [
    { index: 0, lengthSq: points[0].distanceToSquared(points[1]) },
    { index: 1, lengthSq: points[1].distanceToSquared(points[2]) },
    { index: 2, lengthSq: points[2].distanceToSquared(points[0]) },
  ].sort((aEdge, bEdge) => bEdge.lengthSq - aEdge.lengthSq);
  const splitIndex = edges[0].index;
  const a = points[splitIndex];
  const b = points[(splitIndex + 1) % points.length];
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return [
    ...points.slice(0, splitIndex + 1),
    mid,
    ...points.slice(splitIndex + 1),
  ];
}

function planeFaceFromLoops(loops: THREE.Vector3[][], surfaceKind: "plane" | "nurbs" = "plane"): BrepFace | null {
  const validLoops = loops.filter((loop) => loop.length >= 3);
  if (validLoops.length === 0) return null;
  const points = validLoops.flat();
  const a = points[0];
  const b = points.find((candidate, index) => index > 0 && candidate.distanceToSquared(a) > 1e-18);
  if (!b) return null;
  const c = points.find((candidate) => new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(candidate, a)).lengthSq() > 1e-18);
  if (!c) return null;
  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  const n = new THREE.Vector3().crossVectors(ab, ac);
  if (n.lengthSq() < 1e-18) return null;
  n.normalize();

  const centroid = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length);
  const plane = Plane.fromPointNormal(point(centroid), point(n));
  const uvForPoint = (p: THREE.Vector3) => {
    const d = p.clone().sub(centroid);
    return {
      u: d.x * plane.xAxis.x + d.y * plane.xAxis.y + d.z * plane.xAxis.z,
      v: d.x * plane.yAxis.x + d.y * plane.yAxis.y + d.z * plane.yAxis.z,
    };
  };
  const uvLoops = validLoops.map((loop) => loop.map(uvForPoint));
  const uvAll = uvLoops.flat();
  const uMin = Math.min(...uvAll.map((p) => p.u));
  const uMax = Math.max(...uvAll.map((p) => p.u));
  const vMin = Math.min(...uvAll.map((p) => p.v));
  const vMax = Math.max(...uvAll.map((p) => p.v));
  const surface: Surface = surfaceKind === "nurbs" ? planarNurbsSurface(plane, uMin, uMax, vMin, vMax) : {
    kind: "plane",
    plane,
    uDomain: Interval.create(uMin, uMax),
    vDomain: Interval.create(vMin, vMax),
    uExtent: Interval.create(uMin, uMax),
    vExtent: Interval.create(vMin, vMax),
  };
  const orderedLoops = uvLoops
    .map((uv, index) => ({ uv, points: validLoops[index], area: signedAreaUv(uv) }))
    .sort((aLoop, bLoop) => Math.abs(bLoop.area) - Math.abs(aLoop.area));
  const [outer, ...inners] = orderedLoops;
  return {
    surface,
    outerLoop: { curves: [curveFromUvLoop(outer.uv)], orientation: outer.area >= 0 },
    innerLoops: inners.map((loop) => ({ curves: [curveFromUvLoop(loop.uv)], orientation: loop.area < 0 })),
    orientation: true,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

function planeFaceFromLoop(points: THREE.Vector3[], surfaceKind: "plane" | "nurbs" = "plane"): BrepFace | null {
  return planeFaceFromLoops([points], surfaceKind);
}

function planeFaceFromTriangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, surfaceKind: "plane" | "nurbs" = "plane"): BrepFace | null {
  return planeFaceFromLoop([a, b, c], surfaceKind);
}

function facePlane(face: BrepFace): { normal: THREE.Vector3; constant: number } | null {
  if (face.surface.kind === "plane") {
    const normal = new THREE.Vector3(face.surface.plane.normal.x, face.surface.plane.normal.y, face.surface.plane.normal.z).normalize();
    const origin = new THREE.Vector3(face.surface.plane.origin.x, face.surface.plane.origin.y, face.surface.plane.origin.z);
    return { normal, constant: normal.dot(origin) };
  }
  if (face.surface.kind !== "nurbs" || face.surface.cvs.length < 9) return null;
  const cvs = face.surface.cvs;
  const p0 = new THREE.Vector3(cvs[0], cvs[1], cvs[2]);
  const p1 = new THREE.Vector3(cvs[3], cvs[4], cvs[5]);
  const p2 = new THREE.Vector3(cvs[6], cvs[7], cvs[8]);
  const normal = p1.clone().sub(p0).cross(p2.clone().sub(p0)).normalize();
  if (!Number.isFinite(normal.lengthSq()) || normal.lengthSq() < 0.5) return null;
  return { normal, constant: normal.dot(p0) };
}

function sameFacePlane(a: BrepFace, b: BrepFace): boolean {
  const pa = facePlane(a);
  const pb = facePlane(b);
  if (!pa || !pb) return false;
  const alignment = pa.normal.dot(pb.normal);
  if (Math.abs(alignment) <= 1 - 1e-8) return false;
  return (alignment >= 0 ? Math.abs(pa.constant - pb.constant) : Math.abs(pa.constant + pb.constant)) < 1e-5;
}

function cleanupLoop(loop: THREE.Vector3[]): THREE.Vector3[] {
  const deduped: THREE.Vector3[] = [];
  for (const p of loop) {
    if (deduped.length === 0 || deduped[deduped.length - 1].distanceToSquared(p) > 1e-18) deduped.push(p);
  }
  if (deduped.length > 1 && deduped[0].distanceToSquared(deduped[deduped.length - 1]) < 1e-18) deduped.pop();
  let changed = true;
  while (changed && deduped.length > 3) {
    changed = false;
    for (let i = 0; i < deduped.length; i++) {
      const prev = deduped[(i - 1 + deduped.length) % deduped.length];
      const cur = deduped[i];
      const next = deduped[(i + 1) % deduped.length];
      const a = cur.clone().sub(prev);
      const b = next.clone().sub(cur);
      if (a.lengthSq() < 1e-18 || b.lengthSq() < 1e-18 || a.cross(b).lengthSq() < 1e-16) {
        deduped.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return deduped;
}

function loopAreaMagnitude(loop: THREE.Vector3[]): number {
  if (loop.length < 3) return 0;
  const origin = loop[0];
  let area = 0;
  for (let i = 1; i + 1 < loop.length; i++) {
    area += new THREE.Vector3().subVectors(loop[i], origin).cross(new THREE.Vector3().subVectors(loop[i + 1], origin)).length() / 2;
  }
  return area;
}

function orderBoundaryLoops(loops: THREE.Vector3[][]): THREE.Vector3[][] {
  return loops
    .map((loop) => cleanupLoop(loop))
    .filter((loop) => loop.length >= 3)
    .sort((a, b) => loopAreaMagnitude(b) - loopAreaMagnitude(a));
}

function pathInclusive(loop: THREE.Vector3[], start: number, end: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  let index = start;
  while (true) {
    out.push(loop[index]);
    if (index === end) break;
    index = (index + 1) % loop.length;
    if (out.length > loop.length + 1) break;
  }
  return out;
}

function stitchLoopsOnSharedEdge(aLoop: THREE.Vector3[], bLoopInput: THREE.Vector3[]): THREE.Vector3[] | null {
  const a = cleanupLoop(aLoop);
  const bCandidates = [cleanupLoop(bLoopInput), cleanupLoop([...bLoopInput].reverse())];
  if (a.length < 3) return null;
  for (const b of bCandidates) {
    if (b.length < 3) continue;
    for (let i = 0; i < a.length; i++) {
      const ap = vertexKey(a[i]);
      const aq = vertexKey(a[(i + 1) % a.length]);
      for (let j = 0; j < b.length; j++) {
        const bp = vertexKey(b[j]);
        const bq = vertexKey(b[(j + 1) % b.length]);
        if (ap !== bq || aq !== bp) continue;
        const aPath = pathInclusive(a, (i + 1) % a.length, i);
        const bPath = pathInclusive(b, (j + 1) % b.length, j);
        const combined = cleanupLoop([...aPath, ...bPath.slice(1)]);
        return combined.length >= 3 ? combined : null;
      }
    }
  }
  return null;
}

function pointOnSegment(pointToTest: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number | null {
  const ab = b.clone().sub(a);
  const lengthSq = ab.lengthSq();
  if (lengthSq < 1e-18) return null;
  const ap = pointToTest.clone().sub(a);
  const t = ap.dot(ab) / lengthSq;
  if (t < -1e-7 || t > 1 + 1e-7) return null;
  const closest = a.clone().add(ab.multiplyScalar(t));
  return closest.distanceToSquared(pointToTest) < 1e-12 ? Math.max(0, Math.min(1, t)) : null;
}

function unionBoundaryLoopsForCoplanarLoops(sourceLoops: THREE.Vector3[][]): THREE.Vector3[][] | null {
  const loops = sourceLoops.map(cleanupLoop).filter((loop) => loop.length >= 3);
  const allPoints = loops.flat();
  const pointsByKey = new Map<string, THREE.Vector3>();
  for (const pointToAdd of allPoints) pointsByKey.set(vertexKey(pointToAdd), pointToAdd);
  const segmentCounts = new Map<string, number>();
  const segmentEndpoints = new Map<string, [string, string]>();

  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const split = allPoints
        .map((candidate) => ({ point: candidate, t: pointOnSegment(candidate, a, b) }))
        .filter((candidate): candidate is { point: THREE.Vector3; t: number } => candidate.t !== null)
        .sort((left, right) => left.t - right.t);
      for (let j = 0; j + 1 < split.length; j++) {
        const from = split[j].point;
        const to = split[j + 1].point;
        if (from.distanceToSquared(to) < 1e-18) continue;
        const ka = vertexKey(from);
        const kb = vertexKey(to);
        const key = ka < kb ? `${ka}:${kb}` : `${kb}:${ka}`;
        segmentCounts.set(key, (segmentCounts.get(key) ?? 0) + 1);
        segmentEndpoints.set(key, ka < kb ? [ka, kb] : [kb, ka]);
      }
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const [key, count] of segmentCounts.entries()) {
    if (count % 2 === 0) continue;
    const endpoints = segmentEndpoints.get(key);
    if (!endpoints) continue;
    const [a, b] = endpoints;
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  if (adjacency.size === 0 || [...adjacency.values()].some((neighbors) => neighbors.length !== 2)) return null;

  const edgeKey = (a: string, b: string) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const visited = new Set<string>();
  const output: THREE.Vector3[][] = [];
  for (const start of adjacency.keys()) {
    const startNeighbors = adjacency.get(start) ?? [];
    if (startNeighbors.every((neighbor) => visited.has(edgeKey(start, neighbor)))) continue;
    const loopKeys = [start];
    let previous: string | null = null;
    let current = start;
    while (true) {
      const neighbors = adjacency.get(current) ?? [];
      const next = neighbors.find((neighbor) => neighbor !== previous && !visited.has(edgeKey(current, neighbor)))
        ?? neighbors.find((neighbor) => !visited.has(edgeKey(current, neighbor)));
      if (!next) return null;
      visited.add(edgeKey(current, next));
      previous = current;
      current = next;
      if (current === start) break;
      if (loopKeys.includes(current)) return null;
      loopKeys.push(current);
    }
    const loop = cleanupLoop(loopKeys.map((key) => pointsByKey.get(key)).filter((point): point is THREE.Vector3 => Boolean(point)));
    if (loop.length < 3) return null;
    output.push(loop);
  }
  return output.length > 0 ? orderBoundaryLoops(output) : null;
}

function stitchAnyFaceLoops(loopsA: THREE.Vector3[][], loopsB: THREE.Vector3[][]): THREE.Vector3[][] | null {
  for (let i = 0; i < loopsA.length; i++) {
    for (let j = 0; j < loopsB.length; j++) {
      const stitched = stitchLoopsOnSharedEdge(loopsA[i], loopsB[j]);
      if (!stitched) continue;
      return orderBoundaryLoops([
        stitched,
        ...loopsA.filter((_, index) => index !== i),
        ...loopsB.filter((_, index) => index !== j),
      ]);
    }
  }
  for (let i = 0; i < loopsA.length; i++) {
    for (let j = 0; j < loopsB.length; j++) {
      const unionLoops = unionBoundaryLoopsForCoplanarLoops([loopsA[i], loopsB[j]]);
      if (!unionLoops) continue;
      return orderBoundaryLoops([
        ...unionLoops,
        ...loopsA.filter((_, index) => index !== i),
        ...loopsB.filter((_, index) => index !== j),
      ]);
    }
  }
  return null;
}

function canonicalLoopsKey(loops: THREE.Vector3[][]): string {
  return orderBoundaryLoops(loops)
    .map((loop) => loop.map(vertexKey).sort().join("|"))
    .sort()
    .join("||");
}

function removeDuplicateCoplanarFaceLoops(faces: BrepFace[], faceBoundaryLoops: THREE.Vector3[][][]): { faces: BrepFace[]; faceBoundaryLoops: THREE.Vector3[][][] } {
  const keptFaces: BrepFace[] = [];
  const keptLoops: THREE.Vector3[][][] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < faces.length; i++) {
    const loopsKey = canonicalLoopsKey(faceBoundaryLoops[i]);
    const plane = facePlane(faces[i]);
    const planeKey = plane
      ? `${Math.round(Math.abs(plane.normal.x) * 1e8)},${Math.round(Math.abs(plane.normal.y) * 1e8)},${Math.round(Math.abs(plane.normal.z) * 1e8)},${Math.round(Math.abs(plane.constant) * 1e6)}`
      : "unknown";
    const key = `${planeKey}:${loopsKey}`;
    const existing = seen.get(key);
    if (existing !== undefined && sameFacePlane(keptFaces[existing], faces[i])) continue;
    seen.set(key, keptFaces.length);
    keptFaces.push(faces[i]);
    keptLoops.push(faceBoundaryLoops[i]);
  }
  return { faces: keptFaces, faceBoundaryLoops: keptLoops };
}

function mergeAdjacentCoplanarFaceLoops(
  faces: BrepFace[],
  faceBoundaryLoops: THREE.Vector3[][][],
  surfaceKind: "plane" | "nurbs",
): { faces: BrepFace[]; faceBoundaryLoops: THREE.Vector3[][][] } {
  let nextLoops = faceBoundaryLoops.map(orderBoundaryLoops);
  let nextFaces = faces;
  let changed = true;
  while (changed) {
    changed = false;
    const outerEdgeToFaces = new Map<string, number[]>();
    for (let faceIndex = 0; faceIndex < nextLoops.length; faceIndex++) {
      for (const loop of nextLoops[faceIndex]) {
        for (let i = 0; i < loop.length; i++) {
          const a = vertexKey(loop[i]);
          const b = vertexKey(loop[(i + 1) % loop.length]);
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          const list = outerEdgeToFaces.get(key) ?? [];
          list.push(faceIndex);
          outerEdgeToFaces.set(key, list);
        }
      }
    }
    mergeSearch:
    for (const faceIndices of outerEdgeToFaces.values()) {
      if (faceIndices.length < 2) continue;
      for (let aIndex = 0; aIndex < faceIndices.length; aIndex++) {
        for (let bIndex = aIndex + 1; bIndex < faceIndices.length; bIndex++) {
          const i = faceIndices[aIndex];
          const j = faceIndices[bIndex];
          if (!sameFacePlane(nextFaces[i], nextFaces[j])) continue;
          const loopsA = nextLoops[i];
          const loopsB = nextLoops[j];
          const mergedLoops = stitchAnyFaceLoops(loopsA, loopsB);
          if (!mergedLoops) continue;
          const mergedFace = planeFaceFromLoops(mergedLoops, surfaceKind);
          if (!mergedFace) continue;
          nextFaces = nextFaces.filter((_, index) => index !== j && index !== i);
          nextLoops = nextLoops.filter((_, index) => index !== j && index !== i);
          nextFaces.push(mergedFace);
          nextLoops.push(mergedLoops);
          changed = true;
          break mergeSearch;
        }
      }
    }
  }
  ({ faces: nextFaces, faceBoundaryLoops: nextLoops } = removeDuplicateCoplanarFaceLoops(nextFaces, nextLoops));
  return { faces: nextFaces, faceBoundaryLoops: nextLoops };
}

type TriangleDraft = {
  verts: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  vertexIds: [number, number, number];
  normal: THREE.Vector3;
  planeOffset: number;
};

function coplanar(a: TriangleDraft, b: TriangleDraft): boolean {
  return a.normal.dot(b.normal) > 1 - 1e-8
    && Math.abs(a.planeOffset - b.planeOffset) < 1e-6;
}

function boundaryLoopsForComponent(component: number[], triangles: TriangleDraft[]): number[][] | null {
  const directed = new Map<string, [number, number]>();
  const edgeUse = new Map<string, number>();
  for (const triIndex of component) {
    const ids = triangles[triIndex].vertexIds;
    for (const [from, to] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]] as const) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
      directed.set(key, [from, to]);
    }
  }
  const adjacency = new Map<number, number[]>();
  for (const [key, count] of edgeUse.entries()) {
    if (count !== 1) continue;
    const edge = directed.get(key);
    if (!edge) continue;
    const [a, b] = edge;
    const aList = adjacency.get(a) ?? [];
    aList.push(b);
    adjacency.set(a, aList);
    const bList = adjacency.get(b) ?? [];
    bList.push(a);
    adjacency.set(b, bList);
  }
  if (adjacency.size === 0) return null;
  if ([...adjacency.values()].some((candidates) => candidates.length !== 2)) return null;

  const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const visitedEdges = new Set<string>();
  const loops: number[][] = [];
  for (const start of adjacency.keys()) {
    const startEdges = adjacency.get(start) ?? [];
    if (startEdges.every((candidate) => visitedEdges.has(edgeKey(start, candidate)))) continue;
    const loop = [start];
    let previous: number | null = null;
    let current = start;
    while (true) {
      const candidates = adjacency.get(current) ?? [];
      const next = candidates.find((candidate) => candidate !== previous && !visitedEdges.has(edgeKey(current, candidate)))
        ?? candidates.find((candidate) => !visitedEdges.has(edgeKey(current, candidate)));
      if (next === undefined) return null;
      visitedEdges.add(edgeKey(current, next));
      previous = current;
      current = next;
      if (current === start) break;
      if (loop.includes(current)) return null;
      loop.push(current);
    }
    if (loop.length < 3) return null;
    loops.push(loop);
  }
  return loops.length > 0 ? loops : null;
}

function mergedCoplanarFaces(triangles: TriangleDraft[], vertices: THREE.Vector3[], surfaceKind: "plane" | "nurbs"): { faces: BrepFace[]; faceBoundaryLoops: THREE.Vector3[][][]; mergedComponents: number; mergedTriangles: number } {
  const edgeToTriangles = new Map<string, number[]>();
  for (let i = 0; i < triangles.length; i++) {
    const ids = triangles[i].vertexIds;
    for (const [a, b] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]] as const) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const list = edgeToTriangles.get(key) ?? [];
      list.push(i);
      edgeToTriangles.set(key, list);
    }
  }

  const visited = new Set<number>();
  const faces: BrepFace[] = [];
  const faceBoundaryLoops: THREE.Vector3[][][] = [];
  let mergedComponents = 0;
  let mergedTriangles = 0;
  for (let seed = 0; seed < triangles.length; seed++) {
    if (visited.has(seed)) continue;
    const queue = [seed];
    const component: number[] = [];
    visited.add(seed);
    while (queue.length) {
      const triIndex = queue.pop()!;
      component.push(triIndex);
      const ids = triangles[triIndex].vertexIds;
      for (const [a, b] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]] as const) {
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        for (const neighbor of edgeToTriangles.get(key) ?? []) {
          if (visited.has(neighbor) || !coplanar(triangles[triIndex], triangles[neighbor])) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    const loops = component.length > 1 ? boundaryLoopsForComponent(component, triangles) : null;
    const boundaryLoops = loops?.map((loop) => loop.map((id) => vertices[id])) ?? null;
    const face = boundaryLoops ? planeFaceFromLoops(boundaryLoops, surfaceKind) : null;
    if (face && boundaryLoops) {
      faces.push(face);
      faceBoundaryLoops.push(boundaryLoops);
      mergedComponents++;
      mergedTriangles += component.length;
    } else {
      for (const triIndex of component) {
        const tri = triangles[triIndex];
        const triFace = planeFaceFromTriangle(...tri.verts, surfaceKind);
        if (!triFace) continue;
        faces.push(triFace);
        faceBoundaryLoops.push([tri.verts]);
      }
    }
  }
  return { faces, faceBoundaryLoops, mergedComponents, mergedTriangles };
}

export type MeshToPlanarBrepOptions = {
  mergeCoplanarFaces?: boolean;
  surfaceKind?: "plane" | "nurbs";
  avoidTriangularFaces?: boolean;
};

export function meshToPlanarBrep(mesh: THREE.Mesh, options: MeshToPlanarBrepOptions = {}): Brep | null {
  const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
  const position = geometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!position || position.count < 3) return null;

  const sourceVertices: THREE.Vector3[] = [];
  const sourceVertexByKey = new Map<string, number>();
  const sourceVertex = (v: THREE.Vector3): number => {
    const key = vertexKey(v);
    const existing = sourceVertexByKey.get(key);
    if (existing !== undefined) return existing;
    const id = sourceVertices.length;
    sourceVertexByKey.set(key, id);
    sourceVertices.push(v);
    return id;
  };
  const triangles: TriangleDraft[] = [];
  const tri = (ia: number, ib: number, ic: number) => {
    const a = new THREE.Vector3().fromBufferAttribute(position, ia);
    const b = new THREE.Vector3().fromBufferAttribute(position, ib);
    const c = new THREE.Vector3().fromBufferAttribute(position, ic);
    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (normal.lengthSq() < 1e-18) return;
    normal.normalize();
    const vertexIds = [sourceVertex(a), sourceVertex(b), sourceVertex(c)] as [number, number, number];
    triangles.push({ verts: [a, b, c], vertexIds, normal, planeOffset: normal.dot(a) });
  };

  const index = geometry?.getIndex();
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) tri(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  } else {
    for (let i = 0; i + 2 < position.count; i += 3) tri(i, i + 1, i + 2);
  }
  if (triangles.length === 0) return null;

  const surfaceKind = options.surfaceKind ?? "plane";
  const conversion = options.mergeCoplanarFaces
    ? mergedCoplanarFaces(triangles, sourceVertices, surfaceKind)
    : {
      faces: triangles.map((triangle) => planeFaceFromTriangle(...triangle.verts, surfaceKind)).filter((face): face is BrepFace => Boolean(face)),
      faceBoundaryLoops: triangles.map((triangle) => [triangle.verts]),
      mergedComponents: 0,
      mergedTriangles: 0,
    };
  let { faces, faceBoundaryLoops } = conversion;
  if (options.mergeCoplanarFaces) {
    ({ faces, faceBoundaryLoops } = mergeAdjacentCoplanarFaceLoops(faces, faceBoundaryLoops, surfaceKind));
  }
  if (options.avoidTriangularFaces) {
    faceBoundaryLoops = faceBoundaryLoops.map((loops) => loops.map(avoidTriangularLoop));
    faces = faceBoundaryLoops
      .map((loops) => planeFaceFromLoops(loops, surfaceKind))
      .filter((face): face is BrepFace => Boolean(face));
    if (options.mergeCoplanarFaces) {
      ({ faces, faceBoundaryLoops } = mergeAdjacentCoplanarFaceLoops(faces, faceBoundaryLoops, surfaceKind));
      faceBoundaryLoops = faceBoundaryLoops.map((loops) => loops.map(avoidTriangularLoop));
      faces = faceBoundaryLoops
        .map((loops) => planeFaceFromLoops(loops, surfaceKind))
        .filter((face): face is BrepFace => Boolean(face));
    }
  }
  if (faces.length === 0) return null;

  const vertices: BrepVertex[] = [];
  const vertexByKey = new Map<string, number>();
  const getVertex = (v: THREE.Vector3): number => {
    const key = vertexKey(v);
    const existing = vertexByKey.get(key);
    if (existing !== undefined) return existing;
    const idx = vertices.length;
    vertexByKey.set(key, idx);
    vertices.push({ point: point(v), edgeIndices: [], tolerance: BREP_DEFAULT_TOLERANCE });
    return idx;
  };

  type EdgeDraft = {
    a: number;
    b: number;
    curve: Curve;
    faceIndices: number[];
  };
  const edgesByKey = new Map<string, EdgeDraft>();
  for (let faceIndex = 0; faceIndex < faceBoundaryLoops.length; faceIndex++) {
    for (const boundary of faceBoundaryLoops[faceIndex]) {
      for (let i = 0; i < boundary.length; i++) {
        const from = boundary[i];
        const to = boundary[(i + 1) % boundary.length];
        const va = getVertex(from);
        const vb = getVertex(to);
        const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
        let draft = edgesByKey.get(key);
        if (!draft) {
          draft = { a: va, b: vb, curve: lineCurve(from, to), faceIndices: [] };
          edgesByKey.set(key, draft);
        }
        if (!draft.faceIndices.includes(faceIndex)) draft.faceIndices.push(faceIndex);
      }
    }
  }

  const edges: BrepEdge[] = [];
  for (const draft of edgesByKey.values()) {
    const edgeIndex = edges.length;
    vertices[draft.a].edgeIndices.push(edgeIndex);
    vertices[draft.b].edgeIndices.push(edgeIndex);
    edges.push({
      curve: draft.curve,
      faceIndex1: draft.faceIndices[0],
      faceIndex2: draft.faceIndices[1] ?? null,
      tolerance: BREP_DEFAULT_TOLERANCE,
    });
  }
  const isClosed = edges.length > 0 && edges.every((edge) => edge.faceIndex2 !== null);
  return {
    shells: [{
      faces,
      edges,
      vertices,
      isClosed,
    }],
  };
}

export function linkPlanarizedMeshEditBrep(
  viewer: Viewer,
  source: THREE.Object3D,
  result: THREE.Mesh,
  createdBy: string,
  metadata: Record<string, unknown>,
  options: MeshToPlanarBrepOptions = {},
): boolean {
  const brep = meshToPlanarBrep(result, {
    mergeCoplanarFaces: true,
    surfaceKind: "nurbs",
    avoidTriangularFaces: true,
    ...options,
  });
  if (!brep) return false;
  const store = viewer.getCanonicalGeometryStore();
  const sourceRecord = store.resolveObjectOrAncestor(source);
  const position = result.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  const record = store.create({
    kind: "brep",
    brep,
    source: "edit",
    createdBy,
    displayMesh: {
      revision: 1,
      generatedAt: Date.now(),
      vertexCount: position?.count,
      triangleCount: position ? Math.floor((result.geometry.index?.count ?? position.count) / 3) : undefined,
      derivation: "tessellated-brep",
    },
    metadata: {
      ...metadata,
      source: sourceRecord?.id,
      derivation: "planarized-edit-mesh",
      conversion: "merged-coplanar-planar-nurbs-brep",
      facePolicy: "merge adjacent coplanar edit triangles and split residual triangular loops so canonical BRep faces are not triangular",
    },
  });
  store.linkObject(result, record.id);
  return true;
}

export function linkPlanarizedMeshCommandBrep(
  viewer: Viewer,
  mesh: THREE.Mesh,
  createdBy: string,
  metadata: Record<string, unknown>,
  options: MeshToPlanarBrepOptions = {},
): boolean {
  const brep = meshToPlanarBrep(mesh, {
    mergeCoplanarFaces: true,
    surfaceKind: "nurbs",
    avoidTriangularFaces: true,
    ...options,
  });
  if (!brep) return false;
  const store = viewer.getCanonicalGeometryStore();
  const position = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  const record = store.create({
    kind: "brep",
    brep,
    source: "command",
    createdBy,
    displayMesh: {
      revision: 1,
      generatedAt: Date.now(),
      vertexCount: position?.count,
      triangleCount: position ? Math.floor((mesh.geometry.index?.count ?? position.count) / 3) : undefined,
      derivation: "tessellated-brep",
    },
    metadata: {
      ...metadata,
      derivation: "planarized-command-mesh",
      conversion: "merged-coplanar-planar-nurbs-brep",
      facePolicy: "merge adjacent coplanar generated command triangles and split residual triangular loops so canonical BRep faces are not triangular",
    },
  });
  store.linkObject(mesh, record.id);
  return true;
}

export function linkPlanarizedMeshImportBrep(
  store: CanonicalGeometryStore,
  mesh: THREE.Mesh,
  createdBy: string,
  metadata: Record<string, unknown>,
): boolean {
  if (store.resolveObjectOrAncestor(mesh)) return false;
  const brep = meshToPlanarBrep(mesh);
  if (!brep) return false;
  const position = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  const record = store.create({
    kind: "brep",
    brep,
    source: "import",
    createdBy,
    displayMesh: {
      revision: 1,
      generatedAt: Date.now(),
      vertexCount: position?.count,
      triangleCount: position ? Math.floor((mesh.geometry.index?.count ?? position.count) / 3) : undefined,
      derivation: "tessellated-brep",
    },
    metadata: {
      ...metadata,
      derivation: "planarized-import-mesh",
    },
  });
  store.linkObject(mesh, record.id);
  return true;
}
