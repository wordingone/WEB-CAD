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

function planeFaceFromLoop(points: THREE.Vector3[], surfaceKind: "plane" | "nurbs" = "plane"): BrepFace | null {
  if (points.length < 3) return null;
  const a = points[0];
  const b = points[1];
  const c = points.find((candidate, index) => index > 1 && new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(candidate, a)).lengthSq() > 1e-18);
  if (!c) return null;
  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  const n = new THREE.Vector3().crossVectors(ab, ac);
  if (n.lengthSq() < 1e-18) return null;
  n.normalize();

  const centroid = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length);
  const plane = Plane.fromPointNormal(point(centroid), point(n));
  const uv = points.map((p) => {
    const d = p.clone().sub(centroid);
    return {
      u: d.x * plane.xAxis.x + d.y * plane.xAxis.y + d.z * plane.xAxis.z,
      v: d.x * plane.yAxis.x + d.y * plane.yAxis.y + d.z * plane.yAxis.z,
    };
  });
  const uMin = Math.min(...uv.map((p) => p.u));
  const uMax = Math.max(...uv.map((p) => p.u));
  const vMin = Math.min(...uv.map((p) => p.v));
  const vMax = Math.max(...uv.map((p) => p.v));
  const surface: Surface = surfaceKind === "nurbs" ? planarNurbsSurface(plane, uMin, uMax, vMin, vMax) : {
    kind: "plane",
    plane,
    uDomain: Interval.create(uMin, uMax),
    vDomain: Interval.create(vMin, vMax),
    uExtent: Interval.create(uMin, uMax),
    vExtent: Interval.create(vMin, vMax),
  };
  const trimPoints = uv.map((p) => ({ x: p.u, y: p.v, z: 0 }));
  trimPoints.push({ ...trimPoints[0] });
  const parameters = [0];
  for (let i = 1; i < trimPoints.length; i++) {
    const p = trimPoints[i - 1];
    const q = trimPoints[i];
    parameters.push(parameters[i - 1] + Math.hypot(q.x - p.x, q.y - p.y));
  }
  const outerLoopCurve: Curve = {
    kind: "polyline",
    points: trimPoints,
    parameters,
  };
  return {
    surface,
    outerLoop: { curves: [outerLoopCurve], orientation: true },
    innerLoops: [],
    orientation: true,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

function planeFaceFromTriangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, surfaceKind: "plane" | "nurbs" = "plane"): BrepFace | null {
  return planeFaceFromLoop([a, b, c], surfaceKind);
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

function boundaryLoopForComponent(component: number[], triangles: TriangleDraft[]): number[] | null {
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
  const next = new Map<number, number[]>();
  for (const [key, count] of edgeUse.entries()) {
    if (count !== 1) continue;
    const edge = directed.get(key);
    if (!edge) continue;
    const [from, to] = edge;
    const candidates = next.get(from) ?? [];
    candidates.push(to);
    next.set(from, candidates);
  }
  if (next.size === 0) return null;
  if ([...next.values()].some((candidates) => candidates.length !== 1)) return null;
  const start = [...next.keys()][0];
  const loop = [start];
  const visited = new Set<number>([start]);
  let current = start;
  while (true) {
    const candidates = next.get(current);
    if (!candidates || candidates.length !== 1) return null;
    const candidate = candidates[0];
    if (candidate === start) break;
    if (visited.has(candidate)) return null;
    loop.push(candidate);
    visited.add(candidate);
    current = candidate;
  }
  return visited.size === next.size ? loop : null;
}

function mergedCoplanarFaces(triangles: TriangleDraft[], vertices: THREE.Vector3[], surfaceKind: "plane" | "nurbs"): { faces: BrepFace[]; faceBoundaryVerts: THREE.Vector3[][]; mergedComponents: number; mergedTriangles: number } {
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
  const faceBoundaryVerts: THREE.Vector3[][] = [];
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

    const loop = component.length > 1 ? boundaryLoopForComponent(component, triangles) : null;
    const face = loop ? planeFaceFromLoop(loop.map((id) => vertices[id]), surfaceKind) : null;
    if (face && loop) {
      faces.push(face);
      faceBoundaryVerts.push(loop.map((id) => vertices[id]));
      mergedComponents++;
      mergedTriangles += component.length;
    } else {
      for (const triIndex of component) {
        const tri = triangles[triIndex];
        const triFace = planeFaceFromTriangle(...tri.verts, surfaceKind);
        if (!triFace) continue;
        faces.push(triFace);
        faceBoundaryVerts.push(tri.verts);
      }
    }
  }
  return { faces, faceBoundaryVerts, mergedComponents, mergedTriangles };
}

export type MeshToPlanarBrepOptions = {
  mergeCoplanarFaces?: boolean;
  surfaceKind?: "plane" | "nurbs";
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
      faceBoundaryVerts: triangles.map((triangle) => triangle.verts),
      mergedComponents: 0,
      mergedTriangles: 0,
    };
  const { faces, faceBoundaryVerts } = conversion;
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
  for (let faceIndex = 0; faceIndex < faceBoundaryVerts.length; faceIndex++) {
    const boundary = faceBoundaryVerts[faceIndex];
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
      draft.faceIndices.push(faceIndex);
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
): boolean {
  const brep = meshToPlanarBrep(result);
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
      derivation: "planarized-display-mesh",
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
): boolean {
  const brep = meshToPlanarBrep(mesh);
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
      derivation: "planarized-display-mesh",
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
