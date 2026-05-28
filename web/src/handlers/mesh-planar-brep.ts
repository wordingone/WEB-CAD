import * as THREE from "three";
import {
  BREP_DEFAULT_TOLERANCE,
  type Brep,
  type BrepFace,
} from "../nurbs/nurbs-brep";
import { Interval, Plane, type Point3 } from "../nurbs/nurbs-primitives";
import type { PlaneSurface } from "../nurbs/nurbs-surfaces";
import type { Viewer } from "../viewer/viewer";
import type { CanonicalGeometryStore } from "../geometry/canonical-geometry";

function point(v: THREE.Vector3): Point3 {
  return { x: v.x, y: v.y, z: v.z };
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
  return {
    surface,
    outerLoop: { curves: [], orientation: true },
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
  const tri = (ia: number, ib: number, ic: number) => {
    const face = planeFaceFromTriangle(
      new THREE.Vector3().fromBufferAttribute(position, ia),
      new THREE.Vector3().fromBufferAttribute(position, ib),
      new THREE.Vector3().fromBufferAttribute(position, ic),
    );
    if (face) faces.push(face);
  };

  const index = geometry?.getIndex();
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) tri(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  } else {
    for (let i = 0; i + 2 < position.count; i += 3) tri(i, i + 1, i + 2);
  }
  if (faces.length === 0) return null;
  return { shells: [{ faces, edges: [], vertices: [], isClosed: true }] };
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
  const sourceRecord = store.resolveObject(source);
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
  if (store.resolveObject(mesh)) return false;
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
