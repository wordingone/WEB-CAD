import * as THREE from "three";
import type { Viewer } from "./viewer.js";

// Plane layout (setSectionBox order):
//   [0] normal(+1,0,0) constant=-min[0]  → -X face
//   [1] normal(-1,0,0) constant=+max[0]  → +X face
//   [2] normal(0,+1,0) constant=-min[1]  → -Y face
//   [3] normal(0,-1,0) constant=+max[1]  → +Y face
//   [4] normal(0,0,+1) constant=-min[2]  → -Z face
//   [5] normal(0,0,-1) constant=+max[2]  → +Z face
// For all faces: plane.constant += delta moves the face outward (positive = expand).
const FACE_IDX: Record<string, number> = {
  '+x': 1, '-x': 0, '+y': 3, '-y': 2, '+z': 5, '-z': 4,
};

export function isolate(v: Viewer, uuid: string): boolean {
  isolateOff(v);
  const target = v.scene.getObjectByProperty("uuid", uuid);
  if (!target) return false;
  const ancestors = new Set<string>();
  let cur: THREE.Object3D | null = target.parent;
  while (cur && cur !== v.scene) { ancestors.add(cur.uuid); cur = cur.parent; }
  const descendants = new Set<string>();
  target.traverse((c) => { descendants.add(c.uuid); });
  v.scene.traverse((obj) => {
    if (obj === v.scene) return;
    const keep = obj.uuid === uuid || ancestors.has(obj.uuid) || descendants.has(obj.uuid);
    v._preIsolationVisible.set(obj.uuid, obj.visible);
    if (!keep) obj.visible = false;
  });
  v._isolatedUuid = uuid;
  return true;
}

export function isolateOff(v: Viewer): void {
  if (v._isolatedUuid === null) return;
  v.scene.traverse((obj) => {
    const prev = v._preIsolationVisible.get(obj.uuid);
    if (prev !== undefined) obj.visible = prev;
  });
  v._preIsolationVisible.clear();
  v._isolatedUuid = null;
}

export function getIsolatedUuid(v: Viewer): string | null {
  return v._isolatedUuid;
}

export function getSceneBounds(v: Viewer): THREE.Box3 | null {
  v.scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  v.scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) && !(obj instanceof THREE.Group)) return;
    const kind = (obj.userData as Record<string, unknown>).kind;
    if (kind !== "brep" && kind !== "compound") return;
    box.expandByObject(obj);
  });
  if (box.isEmpty() && v.currentBounds) {
    box.set(
      new THREE.Vector3(...v.currentBounds.min),
      new THREE.Vector3(...v.currentBounds.max),
    );
  }
  return box.isEmpty() ? null : box;
}

export function setSectionBox(v: Viewer, min: [number, number, number], max: [number, number, number], enabled = true): void {
  v._sectionPlanes = [];
  if (enabled) {
    v._sectionPlanes = [
      new THREE.Plane(new THREE.Vector3( 1,  0,  0), -min[0]),
      new THREE.Plane(new THREE.Vector3(-1,  0,  0),  max[0]),
      new THREE.Plane(new THREE.Vector3( 0,  1,  0), -min[1]),
      new THREE.Plane(new THREE.Vector3( 0, -1,  0),  max[1]),
      new THREE.Plane(new THREE.Vector3( 0,  0,  1), -min[2]),
      new THREE.Plane(new THREE.Vector3( 0,  0, -1),  max[2]),
    ];
  }
  applyClippingPlanes(v);
}

export function clearSectionBox(v: Viewer): void {
  v._sectionPlanes = [];
  applyClippingPlanes(v);
}

export function getSectionBox(v: Viewer): { min: [number, number, number]; max: [number, number, number] } | null {
  if (v._sectionPlanes.length < 6) return null;
  return {
    min: [-v._sectionPlanes[0].constant, -v._sectionPlanes[2].constant, -v._sectionPlanes[4].constant],
    max: [ v._sectionPlanes[1].constant,  v._sectionPlanes[3].constant,  v._sectionPlanes[5].constant],
  };
}

export function pushSectionFace(v: Viewer, face: '+x' | '-x' | '+y' | '-y' | '+z' | '-z', delta: number): void {
  if (v._sectionPlanes.length < 6) return;
  const idx = FACE_IDX[face];
  v._sectionPlanes[idx].constant += delta;
  applyClippingPlanes(v);
  const box = getSectionBox(v);
  if (box) {
    const w = box.max[0] - box.min[0];
    const d = box.max[1] - box.min[1];
    const h = box.max[2] - box.min[2];
    const cx = (box.min[0] + box.max[0]) / 2;
    const cy = (box.min[1] + box.max[1]) / 2;
    const cz = (box.min[2] + box.max[2]) / 2;
    v.scene.traverse((obj) => {
      if (obj.userData.kind !== "section-box") return;
      obj.position.set(cx, cy, cz);
      obj.scale.set(w, d, h);
    });
  }
}

export function getSectionFacePosition(v: Viewer, face: '+x' | '-x' | '+y' | '-y' | '+z' | '-z'): number | null {
  if (v._sectionPlanes.length < 6) return null;
  const idx = FACE_IDX[face];
  const plane = v._sectionPlanes[idx];
  return face.startsWith('+') ? plane.constant : -plane.constant;
}

export function addClippingPlane(v: Viewer, origin: [number, number, number], normal: [number, number, number], label?: string): void {
  const n = new THREE.Vector3(...normal).normalize();
  const plane = new THREE.Plane(n, -n.dot(new THREE.Vector3(...origin)));
  v._clipPlanes.push(plane);
  if (label) v._clipLabels.set(label, plane);
  applyClippingPlanes(v);
}

export function clearClippingPlanes(v: Viewer): void {
  v._clipPlanes = [];
  v._clipLabels.clear();
  applyClippingPlanes(v);
}

export function removeClippingPlane(v: Viewer, label: string): boolean {
  const plane = v._clipLabels.get(label);
  if (!plane) return false;
  v._clipPlanes = v._clipPlanes.filter((p) => p !== plane);
  v._clipLabels.delete(label);
  applyClippingPlanes(v);
  return true;
}

export function getClippingPlaneCount(v: Viewer): number {
  return v._clipPlanes.length;
}

export function getClippingPlanes(v: Viewer): Array<{ label: string; origin: [number, number, number]; normal: [number, number, number] }> {
  const labelByPlane = new Map<THREE.Plane, string>();
  v._clipLabels.forEach((plane, label) => labelByPlane.set(plane, label));
  return v._clipPlanes.map((plane, idx) => {
    const n = plane.normal;
    const o = n.clone().multiplyScalar(-plane.constant);
    return {
      label: labelByPlane.get(plane) ?? `plane-${idx}`,
      origin: [o.x, o.y, o.z] as [number, number, number],
      normal: [n.x, n.y, n.z] as [number, number, number],
    };
  });
}

export function updateClippingPlane(v: Viewer, label: string, mesh: THREE.Mesh): void {
  const plane = v._clipLabels.get(label);
  if (!plane) return;
  mesh.updateMatrixWorld(true);
  const m3 = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const localN = (mesh.userData.clipLocalNormal instanceof THREE.Vector3)
    ? mesh.userData.clipLocalNormal.clone()
    : new THREE.Vector3(0, 0, 1);
  const normal = localN.applyMatrix3(m3).normalize();
  const origin = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
  plane.normal.copy(normal);
  plane.constant = -normal.dot(origin);
}

export function rebuildFill(v: Viewer): void {
  const all = [...v._sectionPlanes, ...v._clipPlanes];
  if (all.length === 0) { v._clipFill.dispose(v.scene); return; }
  v._clipFill.update(all, v.scene, v._fillMode);
}

export function applyClippingPlanes(v: Viewer): void {
  const all = [...v._sectionPlanes, ...v._clipPlanes];
  v.renderer.clippingPlanes = [];
  v.renderer.localClippingEnabled = all.length > 0;

  const gizmoObjs = new Set<THREE.Object3D>();
  for (const g of v.gizmos) g.traverse((o) => gizmoObjs.add(o));
  if (v.pivotProxy) gizmoObjs.add(v.pivotProxy);

  v.scene.traverse((obj) => {
    const isM = obj instanceof THREE.Mesh;
    const isL = obj instanceof THREE.LineSegments;
    if (!isM && !isL) return;
    if (obj.userData.noRenderMode) return;
    const exclude = obj.userData.excludeFromClip === true || gizmoObjs.has(obj);
    const planes = exclude ? [] : all;
    const mat = (obj as THREE.Mesh).material;
    const mats: THREE.Material[] = Array.isArray(mat) ? mat : [mat];
    for (const m of mats) {
      if (m.clippingPlanes !== planes) {
        m.clippingPlanes = planes;
        m.needsUpdate = true;
      }
    }
  });
  rebuildFill(v);
}

export function applyActiveClipPlanesToSubtree(v: Viewer, root: THREE.Object3D): void {
  const all = [...v._sectionPlanes, ...v._clipPlanes];
  if (all.length === 0) return;
  root.traverse((obj) => {
    const isM = obj instanceof THREE.Mesh;
    const isL = obj instanceof THREE.LineSegments;
    if (!isM && !isL) return;
    if (obj.userData.noRenderMode) return;
    if (obj.userData.excludeFromClip) return;
    const mat2 = (obj as THREE.Mesh).material;
    const mats: THREE.Material[] = Array.isArray(mat2) ? mat2 : [mat2];
    for (const m of mats) {
      m.clippingPlanes = all;
      m.needsUpdate = true;
    }
  });
}
