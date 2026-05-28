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
import type { PlaneSurface } from "../nurbs/nurbs-surfaces";
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

function planeFaceFromTriangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): BrepFace | null {
  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  const n = new THREE.Vector3().crossVectors(ab, ac);
  if (n.lengthSq() < 1e-18) return null;
  n.normalize();

  const centroid = new THREE.Vector3().addVectors(a, b).add(c).multiplyScalar(1 / 3);
  const plane = Plane.fromPointNormal(point(centroid), point(n));
  const uv = [a, b, c].map((p) => {
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
  const surface: PlaneSurface = {
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

export function meshToPlanarBrep(mesh: THREE.Mesh): Brep | null {
  const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
  const position = geometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!position || position.count < 3) return null;

  const faces: BrepFace[] = [];
  const triangleVerts: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [];
  const tri = (ia: number, ib: number, ic: number) => {
    const a = new THREE.Vector3().fromBufferAttribute(position, ia);
    const b = new THREE.Vector3().fromBufferAttribute(position, ib);
    const c = new THREE.Vector3().fromBufferAttribute(position, ic);
    const face = planeFaceFromTriangle(
      a,
      b,
      c,
    );
    if (face) {
      triangleVerts.push([a, b, c]);
      faces.push(face);
    }
  };

  const index = geometry?.getIndex();
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) tri(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  } else {
    for (let i = 0; i + 2 < position.count; i += 3) tri(i, i + 1, i + 2);
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
  for (let faceIndex = 0; faceIndex < triangleVerts.length; faceIndex++) {
    const triVerts = triangleVerts[faceIndex];
    for (const [from, to] of [[triVerts[0], triVerts[1]], [triVerts[1], triVerts[2]], [triVerts[2], triVerts[0]]] as const) {
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
  return { shells: [{ faces, edges, vertices, isClosed }] };
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
