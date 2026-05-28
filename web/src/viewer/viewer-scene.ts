import * as THREE from "three";
import type { Viewer, MeshIn, Bounds } from "./viewer.js";
import { fitCamera } from "./viewer-camera.js";
import { clearSelected } from "./selection-state.js";
import { drawingLayerStore } from "../geometry/drawing-layers.js";
import { linkPlanarizedMeshImportBrep } from "../handlers/mesh-planar-brep.js";

export function clearScene(v: Viewer): void {
  v.getCanonicalGeometryStore().clear();
  if (v.currentMesh) {
    v.scene.remove(v.currentMesh); // audit-undo-ok: currentMesh is the IFC model view object set by file-load; clearScene is the file-load/reset path, not a user spatial action
    v.currentMesh.geometry.dispose();
    (v.currentMesh.material as THREE.Material).dispose();
    v.currentMesh = null;
  }
  if (v.currentEdges) {
    v.scene.remove(v.currentEdges); // audit-undo-ok: currentEdges is the IFC edge overlay; same file-load/reset context as currentMesh
    v.currentEdges.geometry.dispose();
    (v.currentEdges.material as THREE.Material).dispose();
    v.currentEdges = null;
  }
  if (v.currentObject) {
    v.scene.remove(v.currentObject); // audit-undo-ok: currentObject is the IFC scene graph root; same file-load/reset context
    v.currentObject.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) (mat as THREE.Material).dispose();
      }
    });
    v.currentObject = null;
  }
  const infraSet = new Set<THREE.Object3D>([
    v.grid, v.axes, ...v.axisLabels,
    ...(v.pivotProxy ? [v.pivotProxy] : []),
    ...(v.snapMarker ? [v.snapMarker] : []),
    ...v.gizmos,
    v._cplaneGizmo.group,
  ]);
  const toRemove = v.scene.children.filter(
    (c) => !infraSet.has(c) && !(c instanceof THREE.Light),
  );
  for (const obj of toRemove) {
    v.scene.remove(obj); // audit-undo-ok: bulk dispose of all non-infra scene objects during clearScene reset; not a user action, undo history is wiped on file load
    obj.traverse((child) => {
      const m = child as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material;
      if (mat) {
        if (Array.isArray(mat)) (mat as THREE.Material[]).forEach((mm) => mm.dispose());
        else (mat as THREE.Material).dispose();
      }
    });
  }
  v.targetObject = null;
  v.pivotOffset.identity();
  v.relocate.active = false;
  for (const g of v.gizmos) g.detach();
  v.updateRelocateBadge();
  clearSelected();
}

export function setMesh(v: Viewer, mesh: MeshIn, bounds: Bounds): void {
  clearScene(v);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  geometry.translate(-cx, -cy, -cz);
  const material = new THREE.MeshStandardMaterial({
    color: 0x7ad3a3,
    roughness: 0.55,
    metalness: 0.05,
    flatShading: false,
  });
  const m = new THREE.Mesh(geometry, material);
  m.position.set(cx, cy, cz);
  m.userData.kind = "brep";
  m.userData.creator = "mesh-import";
  linkPlanarizedMeshImportBrep(v.getCanonicalGeometryStore(), m, "mesh-import", {
    source: "setMesh",
  });
  v.scene.add(m); // audit-undo-ok: setMesh is the file-load path (IFC/mesh import); currentMesh is the model view object, not a user spatial action
  v.currentMesh = m;
  const edges = new THREE.EdgesGeometry(geometry, 25);
  const edgeMat = new THREE.LineBasicMaterial({
    color: 0x0e0e10,
    linewidth: 1,
    opacity: 0.6,
    transparent: true,
  });
  const edgeLines = new THREE.LineSegments(edges, edgeMat);
  m.add(edgeLines);
  v.currentEdges = edgeLines;
  fitCamera(v, bounds);
}

export function setObject(v: Viewer, object: THREE.Object3D, bounds: Bounds): void {
  clearScene(v);
  const importFormat = typeof object.userData.importFormat === "string" ? object.userData.importFormat : undefined;
  const importFilename = typeof object.userData.importFilename === "string" ? object.userData.importFilename : undefined;
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const cz = bounds.min[2];
  const wrapper = new THREE.Group();
  wrapper.position.set(0, 0, 0);
  object.position.sub(new THREE.Vector3(cx, cy, cz));
  wrapper.add(object);
  object.updateMatrixWorld(true);
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.userData.kind ??= "brep";
    mesh.userData.creator ??= "mesh-import";
    linkPlanarizedMeshImportBrep(v.getCanonicalGeometryStore(), mesh, String(mesh.userData.creator), {
      source: "setObject",
      objectName: mesh.name || undefined,
      format: importFormat ?? (mesh.userData.ifcClass ? "ifc" : undefined),
      filename: importFilename,
      expressID: mesh.userData.expressID,
      ifcClass: mesh.userData.ifcClass,
      guid: mesh.userData.guid,
    });
  });
  v.scene.add(wrapper); // audit-undo-ok: setObject is the IFC file-load path; wrapper is the IFC scene graph root, not a user spatial action
  v.currentObject = wrapper;
  const hw = (bounds.max[0] - bounds.min[0]) / 2;
  const hh = (bounds.max[1] - bounds.min[1]) / 2;
  const hd = bounds.max[2] - bounds.min[2];
  fitCamera(v, { min: [-hw, -hh, 0], max: [hw, hh, hd] });
}

export function getActiveMeshData(v: Viewer): { vertices: Float32Array; indices: Uint32Array } | null {
  if (v.currentMesh) {
    const g = v.currentMesh.geometry;
    const pos = g.attributes.position?.array as Float32Array | undefined;
    const idx = g.index?.array;
    if (!pos || !idx) return null;
    return { vertices: new Float32Array(pos), indices: new Uint32Array(idx) };
  }
  if (v.currentObject) {
    const verts: number[] = [];
    const idx: number[] = [];
    const tmp = new THREE.Vector3();
    const matWorld = new THREE.Matrix4();
    v.currentObject.updateMatrixWorld(true);
    v.currentObject.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry as THREE.BufferGeometry;
      const pos = g.attributes.position?.array as Float32Array | undefined;
      if (!pos) return;
      matWorld.copy(mesh.matrixWorld);
      const baseIndex = verts.length / 3;
      for (let i = 0; i < pos.length; i += 3) {
        tmp.set(pos[i], pos[i + 1], pos[i + 2]);
        tmp.applyMatrix4(matWorld);
        verts.push(tmp.x, tmp.y, tmp.z);
      }
      const indexAttr = g.index;
      if (indexAttr) {
        const a = indexAttr.array;
        for (let i = 0; i < a.length; i++) idx.push(a[i] + baseIndex);
      } else {
        const triCount = (pos.length / 3) | 0;
        for (let i = 0; i < triCount; i++) idx.push(baseIndex + i);
      }
    });
    if (verts.length === 0) return null;
    return {
      vertices: new Float32Array(verts),
      indices: new Uint32Array(idx),
    };
  }
  return null;
}

export function raycastForHover(v: Viewer, clientX: number, clientY: number): THREE.Object3D | null {
  const hitPane = v.panes.find(p => {
    const r = p.el.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  });
  if (!hitPane) return null;
  const pr = hitPane.el.getBoundingClientRect();
  const ndcX = ((clientX - pr.left) / pr.width) * 2 - 1;
  const ndcY = -((clientY - pr.top) / pr.height) * 2 + 1;
  v.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), hitPane.camera);
  const gizmoSet = new Set<THREE.Object3D>(v.gizmos);
  const pickables = v.scene.children.filter(
    c => c !== v.grid && c !== v.axes && !(c instanceof THREE.Sprite) &&
         !(c instanceof THREE.DirectionalLight) && !(c instanceof THREE.AmbientLight) &&
         !gizmoSet.has(c) && c !== v.pivotProxy && c !== v._cplaneGizmo.group,
  );
  const hits = v.raycaster.intersectObjects(pickables, true);
  for (const h of hits) {
    const o = h.object;
    const isDisplay = !!o.userData.isJoinDisplay;
    if (o.userData.noSnap && !isDisplay) continue;
    if (!isDisplay) {
      let anc: THREE.Object3D | null = o;
      let effVisible = true;
      while (anc) { if (!anc.visible) { effVisible = false; break; } anc = anc.parent; }
      if (!effVisible) continue;
      const dlId = o.userData.drawingLayerId as string | undefined;
      if (dlId) {
        const dl = drawingLayerStore.get(dlId);
        if (dl && (!dl.visible || dl.locked)) continue;
      }
    }
    if (o.parent instanceof THREE.Group && o.parent.userData.creator === "roof") return o.parent;
    return o;
  }
  return null;
}

export function raycastForCreator(v: Viewer, clientX: number, clientY: number, validCreators: string[]): THREE.Object3D | null {
  const hitPane = v.panes.find(p => {
    const r = p.el.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  });
  if (!hitPane) return null;
  const pr = hitPane.el.getBoundingClientRect();
  const ndcX = ((clientX - pr.left) / pr.width) * 2 - 1;
  const ndcY = -((clientY - pr.top) / pr.height) * 2 + 1;
  v.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), hitPane.camera);
  const gizmoSet = new Set<THREE.Object3D>(v.gizmos);
  const pickables = v.scene.children.filter(
    c => c !== v.grid && c !== v.axes && !(c instanceof THREE.Sprite) &&
         !(c instanceof THREE.DirectionalLight) && !(c instanceof THREE.AmbientLight) &&
         !gizmoSet.has(c) && c !== v.pivotProxy && c !== v._cplaneGizmo.group,
  );
  const hits = v.raycaster.intersectObjects(pickables, true);
  for (const h of hits) {
    const o = h.object;
    if (o.userData.noSnap) continue;
    const creator = (o.userData as { creator?: string }).creator ?? "";
    if (validCreators.includes(creator)) return o;
    const parent = o.parent;
    if (parent && parent !== v.scene) {
      const parentCreator = (parent.userData as { creator?: string }).creator ?? "";
      if (validCreators.includes(parentCreator)) return parent;
    }
  }
  return null;
}
