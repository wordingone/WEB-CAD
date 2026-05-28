import * as THREE from "three";
import type { CanonicalGeometryStore } from "../geometry/canonical-geometry";
import type { Brep } from "../nurbs/nurbs-brep";
import type { Surface } from "../nurbs/nurbs-surfaces";
import type { Viewer } from "../viewer/viewer";

type CanonicalGeometryViewer = Viewer & {
  getCanonicalGeometryStore?: () => CanonicalGeometryStore;
};

function meshTriangleCount(mesh: THREE.Mesh): number | undefined {
  const geom = mesh.geometry as THREE.BufferGeometry | undefined;
  if (!geom) return undefined;
  if (geom.index) return Math.floor(geom.index.count / 3);
  const pos = geom.getAttribute("position");
  return pos ? Math.floor(pos.count / 3) : undefined;
}

export function linkCanonicalSurface(viewer: Viewer, obj: THREE.Object3D, createdBy: string, surface: Surface): void {
  const store = (viewer as CanonicalGeometryViewer).getCanonicalGeometryStore?.();
  if (!store) return;
  const mesh = obj as THREE.Mesh;
  const position = mesh.geometry?.getAttribute("position");
  const record = store.create({
    kind: "surface",
    surface,
    source: "command",
    createdBy,
    displayMesh: {
      revision: 1,
      generatedAt: Date.now(),
      vertexCount: position?.count,
      triangleCount: mesh.isMesh ? meshTriangleCount(mesh) : undefined,
      derivation: "tessellated-surface",
    },
    metadata: {
      creator: obj.userData.creator,
      cplaneKind: obj.userData.cplaneKind,
      levelId: obj.userData.levelId,
      layerId: obj.userData.layerId,
    },
  });
  store.linkObject(obj, record.id);
}

export function linkCanonicalBrep(viewer: Viewer, obj: THREE.Object3D, brep: Brep, createdBy: string): void {
  const store = (viewer as CanonicalGeometryViewer).getCanonicalGeometryStore?.();
  if (!store) return;
  const mesh = obj as THREE.Mesh;
  const position = mesh.geometry?.getAttribute("position");
  const record = store.create({
    kind: "brep",
    brep,
    source: "command",
    createdBy,
    displayMesh: {
      revision: 1,
      generatedAt: Date.now(),
      vertexCount: position?.count,
      triangleCount: mesh.isMesh ? meshTriangleCount(mesh) : undefined,
      derivation: "tessellated-brep",
    },
    metadata: {
      creator: obj.userData.creator,
      cplaneKind: obj.userData.cplaneKind,
      levelId: obj.userData.levelId,
      layerId: obj.userData.layerId,
    },
  });
  store.linkObject(obj, record.id);
}
