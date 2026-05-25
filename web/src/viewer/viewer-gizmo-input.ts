import * as THREE from "three";
import type { Viewer, Pane } from "./viewer.js";
import { syncPivot, updateRelocateBadge } from "./viewer-gizmos.js";
import { getSnap } from "./snap-state.js";

// Register all event listeners that drive relocate + priority logic on perspPane.
export function registerGumballListeners(v: Viewer, perspPane: Pane): void {
  perspPane.body.addEventListener("pointermove", () => {
    for (const g of v.gizmos) {
      const a = (g as unknown as { axis: string | null }).axis;
      if (a) {
        v.lastHover = {
          mode: (g as unknown as { mode: "translate" | "rotate" | "scale" }).mode,
          axis: a,
          ts: performance.now(),
        };
        return;
      }
    }
    v.lastHover = null;
  });
  perspPane.body.addEventListener("pointermove", (e: PointerEvent) => onRelocateMove(v, e, perspPane));
  perspPane.body.addEventListener("pointerdown", (e: PointerEvent) => {
    if (v.relocate.active) {
      onRelocateExit(v, e);
      return;
    }
    if (e.button !== 0) return;
    const now = performance.now();
    const dx = e.clientX - v.lastClickPos.x;
    const dy = e.clientY - v.lastClickPos.y;
    const isDbl = (now - v.lastClickTs) < 500 && Math.hypot(dx, dy) < 10;
    if (isDbl) {
      onDblclickHandle(v, e, perspPane);
      if (v.relocate.active) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
      }
      v.lastClickTs = 0;
      v.lastClickPos = { x: 0, y: 0 };
      return;
    }
    v.lastClickTs = now;
    v.lastClickPos = { x: e.clientX, y: e.clientY };
    if (v.pivotProxy && v.targetObject) {
      v.pivotProxy.updateMatrix();
      v.targetObject.updateMatrix();
      v.dblclickPivotStart.copy(v.pivotProxy.matrix);
      v.dblclickTargetStart.copy(v.targetObject.matrix);
    }
    resolveGumballPriority(v, e, perspPane);
  }, true);
}

function onDblclickHandle(v: Viewer, e: MouseEvent, pane: Pane): void {
  if (v.relocate.active) return;
  if (!v.pivotProxy || !v.targetObject) return;
  let mode: "translate" | "rotate" | "scale";
  let axis: string;
  if (v.lastHover) {
    mode = v.lastHover.mode;
    axis = v.lastHover.axis;
  } else {
    const pr = pane.el.getBoundingClientRect();
    const ndcX = ((e.clientX - pr.left) / pr.width) * 2 - 1;
    const ndcY = -((e.clientY - pr.top) / pr.height) * 2 + 1;
    v.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), pane.camera);
    const HANDLE_NAMES = new Set(["X", "Y", "Z", "XY", "XZ", "YZ", "XYZ", "E", "XYZE"]);
    let best: { mode: "translate" | "rotate" | "scale"; axis: string; distance: number } | null = null;
    for (const g of v.gizmos) {
      const m = (g as unknown as { mode: "translate" | "rotate" | "scale" }).mode;
      const targets: THREE.Object3D[] = [];
      g.traverse((o) => { if (HANDLE_NAMES.has(o.name)) targets.push(o); });
      if (targets.length === 0) continue;
      const hits = v.raycaster.intersectObjects(targets, true);
      if (hits[0] && (best === null || hits[0].distance < best.distance)) {
        let node: THREE.Object3D | null = hits[0].object;
        while (node && !HANDLE_NAMES.has(node.name)) node = node.parent;
        if (node?.name) best = { mode: m, axis: node.name, distance: hits[0].distance };
      }
    }
    if (!best) {
      console.warn("[relocate] dblclick on no handle — raycast missed");
      return;
    }
    mode = best.mode;
    axis = best.axis;
  }
  e.preventDefault();
  e.stopPropagation();
  v.dblclickPivotStart.decompose(
    v.pivotProxy.position,
    v.pivotProxy.quaternion,
    v.pivotProxy.scale,
  );
  v.pivotProxy.updateMatrix();
  v.dblclickTargetStart.decompose(
    v.targetObject.position,
    v.targetObject.quaternion,
    v.targetObject.scale,
  );
  v.targetObject.updateMatrix();
  v.relocate.pivotStart.copy(v.pivotProxy.matrix);
  v.relocate.mode = mode;
  v.relocate.axis = axis;
  v.relocate.pane = pane;
  buildSnapCandidates(v);
  if (mode === "scale" && (axis === "X" || axis === "Y" || axis === "Z")) {
    const cam = pane.camera;
    const camPos = new THREE.Vector3();
    cam.getWorldPosition(camPos);
    const pivotPos = new THREE.Vector3();
    v.pivotProxy.getWorldPosition(pivotPos);
    let camFactor: number;
    if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
      const oc = cam as THREE.OrthographicCamera;
      camFactor = (oc.top - oc.bottom) / oc.zoom;
    } else {
      const pc = cam as THREE.PerspectiveCamera;
      camFactor = pivotPos.distanceTo(camPos) * Math.min(1.9 * Math.tan((Math.PI * pc.fov) / 360) / pc.zoom, 7);
    }
    const scaleSize = 0.55;
    v.scaleArmStartLength = camFactor * scaleSize / 4 * 0.5 * v.scaleArmFactor[axis];
  }
  const proj = projectCursorForHandle(v, e, pane, mode, axis);
  if (!proj) return;
  v.relocate.cursorStart.copy(proj);
  v.relocate.active = true;
  for (const g of v.gizmos) g.enabled = false;
  if (v.controls) v.controls.enabled = false;
  updateRelocateBadge(v);
  console.log("[relocate] entered:", mode, axis);
}

function onRelocateMove(v: Viewer, e: PointerEvent, pane: Pane): void {
  if (!v.relocate.active || v.relocate.pane !== pane) return;
  if (!v.pivotProxy) return;
  const cursorAxisProj = projectCursorForHandle(v, e, pane, v.relocate.mode, v.relocate.axis);
  if (!cursorAxisProj) return;
  const snap = applyHostSnap(v, cursorAxisProj, pane);
  const proj = snap.point;
  const startPos = new THREE.Vector3();
  const startQuat = new THREE.Quaternion();
  const startScl = new THREE.Vector3();
  v.relocate.pivotStart.decompose(startPos, startQuat, startScl);
  if (v.relocate.mode === "rotate") {
    const axisLocal = axisVectorLocal(v.relocate.axis);
    const axisWorld = axisLocal.clone().applyQuaternion(startQuat).normalize();
    const v0 = new THREE.Vector3().subVectors(v.relocate.cursorStart, startPos);
    const v1 = new THREE.Vector3().subVectors(proj, startPos);
    v0.sub(axisWorld.clone().multiplyScalar(v0.dot(axisWorld)));
    v1.sub(axisWorld.clone().multiplyScalar(v1.dot(axisWorld)));
    if (v0.lengthSq() < 1e-8 || v1.lengthSq() < 1e-8) return;
    v0.normalize();
    v1.normalize();
    const angle = Math.atan2(v0.clone().cross(v1).dot(axisWorld), v0.dot(v1));
    const dq = new THREE.Quaternion().setFromAxisAngle(axisWorld, angle);
    v.pivotProxy.position.copy(startPos);
    v.pivotProxy.quaternion.copy(startQuat).premultiply(dq);
    v.pivotProxy.scale.copy(startScl);
  } else if (v.relocate.mode === "scale" && (v.relocate.axis === "X" || v.relocate.axis === "Y" || v.relocate.axis === "Z")) {
    const axisLocal = axisVectorLocal(v.relocate.axis);
    const axisWorld = axisLocal.clone().applyQuaternion(startQuat).normalize();
    const cursorOffset = new THREE.Vector3().subVectors(cursorAxisProj, startPos);
    const cursorDist = cursorOffset.dot(axisWorld);
    const factor = Math.max(0.1, Math.min(8, Math.abs(cursorDist) / Math.max(1e-6, v.scaleArmStartLength)));
    setScaleArmFactor(v, v.relocate.axis as "X" | "Y" | "Z", factor);
    v.pivotProxy.position.copy(startPos);
    v.pivotProxy.quaternion.copy(startQuat);
    v.pivotProxy.scale.copy(startScl);
  } else {
    if (snap.snapped) {
      v.pivotProxy.position.copy(proj);
    } else {
      const delta = new THREE.Vector3().subVectors(proj, v.relocate.cursorStart);
      v.pivotProxy.position.copy(startPos).add(delta);
    }
    v.pivotProxy.quaternion.copy(startQuat);
    v.pivotProxy.scale.copy(startScl);
  }
  v.pivotProxy.updateMatrix();
}

function onRelocateExit(v: Viewer, e: PointerEvent): void {
  if (!v.relocate.active) return;
  e.preventDefault();
  e.stopPropagation();
  if (typeof (e as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation === "function") {
    (e as Event & { stopImmediatePropagation: () => void }).stopImmediatePropagation();
  }
  if (v.pivotProxy && v.targetObject) {
    v.pivotProxy.updateMatrix();
    v.targetObject.updateMatrix();
    v.pivotOffset.copy(v.targetObject.matrix).invert().multiply(v.pivotProxy.matrix);
  }
  v.relocate.active = false;
  v.relocate.pane = null;
  v.relocate.axis = "";
  v.snapCandidates = [];
  v.snapEdges = [];
  v.snapHysteresis = false;
  hideSnapMarker(v);
  if (v.pivotProxy) {
    for (const g of v.gizmos) {
      g.detach();
      g.attach(v.pivotProxy);
      g.enabled = true;
      const tc = g as unknown as { dragging: boolean; axis: string | null };
      tc.dragging = false;
      tc.axis = null;
      g.updateMatrixWorld(true);
    }
  } else {
    for (const g of v.gizmos) g.enabled = true;
  }
  if (v.controls) v.controls.enabled = true;
  updateRelocateBadge(v);
}

function projectCursorForHandle(
  v: Viewer,
  e: MouseEvent,
  pane: Pane,
  mode: "translate" | "rotate" | "scale",
  axis: string,
): THREE.Vector3 | null {
  if (!v.pivotProxy) return null;
  const pr = pane.el.getBoundingClientRect();
  const ndcX = ((e.clientX - pr.left) / pr.width) * 2 - 1;
  const ndcY = -((e.clientY - pr.top) / pr.height) * 2 + 1;
  v.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), pane.camera);
  const center = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const src = v.relocate.active ? v.relocate.pivotStart.clone() : v.pivotProxy.matrix.clone();
  src.decompose(center, rot, scl);
  if (mode === "rotate") {
    const axisLocal = axisVectorLocal(axis);
    const axisWorld = axisLocal.clone().applyQuaternion(rot).normalize();
    return intersectRayPlane(v, center, axisWorld);
  }
  if (axis.length === 1) {
    const axisLocal = axisVectorLocal(axis);
    const axisWorld = axisLocal.clone().applyQuaternion(rot).normalize();
    return closestPointOnLineToRay(v, center, axisWorld);
  }
  if (axis.length === 2) {
    const normalLocal = planeNormalLocal(axis);
    const normalWorld = normalLocal.clone().applyQuaternion(rot).normalize();
    return intersectRayPlane(v, center, normalWorld);
  }
  if (axis === "XYZ") {
    const normal = new THREE.Vector3();
    pane.camera.getWorldDirection(normal).negate();
    return intersectRayPlane(v, center, normal.normalize());
  }
  return null;
}

function axisVectorLocal(axis: string): THREE.Vector3 {
  if (axis === "X") return new THREE.Vector3(1, 0, 0);
  if (axis === "Y") return new THREE.Vector3(0, 1, 0);
  if (axis === "Z") return new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3(1, 0, 0);
}

export function setScaleArmFactor(v: Viewer, axis: "X" | "Y" | "Z", factor: number): void {
  const refs = v.scaleArmRefs.get(axis);
  if (!refs) return;
  v.scaleArmFactor[axis] = factor;
  for (const { mesh, sign } of refs.cubes) {
    mesh.geometry.dispose();
    const g = new THREE.BoxGeometry(0.08, 0.08, 0.08);
    if (axis === "X") g.translate(sign * 0.5 * factor, 0.04, 0);
    if (axis === "Y") g.translate(0, sign * 0.5 * factor + 0.04, 0);
    if (axis === "Z") g.translate(0, 0.04, sign * 0.5 * factor);
    mesh.geometry = g;
  }
  for (const { mesh, sign } of refs.pickers) {
    mesh.geometry.dispose();
    const g = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    if (axis === "X") g.translate(sign * 0.5 * factor, 0, 0);
    if (axis === "Y") g.translate(0, sign * 0.5 * factor, 0);
    if (axis === "Z") g.translate(0, 0, sign * 0.5 * factor);
    mesh.geometry = g;
  }
}

function planeNormalLocal(axis: string): THREE.Vector3 {
  if (axis === "XY") return new THREE.Vector3(0, 0, 1);
  if (axis === "XZ") return new THREE.Vector3(0, 1, 0);
  if (axis === "YZ") return new THREE.Vector3(1, 0, 0);
  return new THREE.Vector3(0, 0, 1);
}

function intersectRayPlane(v: Viewer, center: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 | null {
  const n = normal.clone().normalize();
  const plane = new THREE.Plane(n, -n.dot(center));
  const out = new THREE.Vector3();
  return v.raycaster.ray.intersectPlane(plane, out) ? out : null;
}

function closestPointOnLineToRay(v: Viewer, center: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 | null {
  const ray = v.raycaster.ray;
  const u = dir.clone().normalize();
  const vDir = ray.direction.clone().normalize();
  const w0 = new THREE.Vector3().subVectors(center, ray.origin);
  const a = u.dot(u);
  const b = u.dot(vDir);
  const c = vDir.dot(vDir);
  const d = u.dot(w0);
  const eDot = vDir.dot(w0);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-8) return null;
  const s = (b * eDot - c * d) / denom;
  return center.clone().add(u.multiplyScalar(s));
}

export function buildSnapCandidates(v: Viewer): void {
  v.snapCandidates = [];
  v.snapEdges = [];
  if (!v.targetObject) return;
  const snap = getSnap();
  const wantVertex = snap.snapOn && snap.vertexSnapOn;
  const wantEdge = snap.snapOn && snap.edgeSnapOn;
  if (!wantVertex && !wantEdge) return;
  v.targetObject.updateMatrixWorld(true);
  const seen = new Set<string>();
  const tol = 1000;
  const key = (pt: THREE.Vector3): string =>
    `${Math.round(pt.x * tol)},${Math.round(pt.y * tol)},${Math.round(pt.z * tol)}`;
  const add = (pt: THREE.Vector3): void => {
    const k = key(pt);
    if (!seen.has(k)) { seen.add(k); v.snapCandidates.push(pt); }
  };
  v.targetObject.traverse((o) => {
    if ((o as THREE.LineSegments).isLineSegments) {
      const geom = (o as THREE.LineSegments).geometry as THREE.BufferGeometry;
      const pos = geom?.attributes?.position;
      if (!pos) return;
      const wm = o.matrixWorld;
      for (let i = 0; i + 1 < pos.count; i += 2) {
        const a = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(wm);
        const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(wm);
        if (wantVertex) { add(a); add(b); }
        if (wantEdge) {
          add(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
          v.snapEdges.push({ a: a.clone(), b: b.clone() });
        }
      }
    } else if ((o as THREE.Mesh).isMesh) {
      if (!wantVertex) return;
      const geom = (o as THREE.Mesh).geometry as THREE.BufferGeometry;
      const pos = geom?.attributes?.position;
      if (!pos) return;
      const wm = o.matrixWorld;
      for (let i = 0; i < pos.count; i++) {
        add(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(wm));
      }
    }
  });
}

function worldToPixel(v: Viewer, p: THREE.Vector3, pane: Pane): { x: number; y: number } {
  const ndc = p.clone().project(pane.camera as THREE.PerspectiveCamera);
  const r = pane.el.getBoundingClientRect();
  return {
    x: r.left + ((ndc.x + 1) / 2) * r.width,
    y: r.top + ((1 - ndc.y) / 2) * r.height,
  };
}

function applyHostSnap(v: Viewer, cursorProj: THREE.Vector3, pane: Pane): { point: THREE.Vector3; snapped: boolean } {
  if (v.relocate.mode === "rotate") { hideSnapMarker(v); v.snapHysteresis = false; return { point: cursorProj, snapped: false }; }
  if (v.snapCandidates.length === 0 && v.snapEdges.length === 0) {
    hideSnapMarker(v);
    v.snapHysteresis = false;
    return { point: cursorProj, snapped: false };
  }
  const SNAP_ENTER_PX = 14;
  const SNAP_EXIT_PX = 32;
  const SNAP_PX = v.snapHysteresis ? SNAP_EXIT_PX : SNAP_ENTER_PX;
  const center = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  v.relocate.pivotStart.decompose(center, rot, scl);
  const projOf = (c: THREE.Vector3): THREE.Vector3 => {
    if (v.relocate.axis.length === 1) {
      const axisLocal = axisVectorLocal(v.relocate.axis);
      const axisWorld = axisLocal.clone().applyQuaternion(rot).normalize();
      const t = c.clone().sub(center).dot(axisWorld);
      return center.clone().add(axisWorld.clone().multiplyScalar(t));
    }
    if (v.relocate.axis.length === 2) {
      const normalLocal = planeNormalLocal(v.relocate.axis);
      const normalWorld = normalLocal.clone().applyQuaternion(rot).normalize();
      const d = c.clone().sub(center).dot(normalWorld);
      return c.clone().sub(normalWorld.clone().multiplyScalar(d));
    }
    return c.clone();
  };
  const cursorPx = worldToPixel(v, cursorProj, pane);
  let best: THREE.Vector3 | null = null;
  let bestPx = SNAP_PX;
  for (const c of v.snapCandidates) {
    const cp = projOf(c);
    const cpPx = worldToPixel(v, cp, pane);
    const d = Math.hypot(cpPx.x - cursorPx.x, cpPx.y - cursorPx.y);
    if (d < bestPx) { bestPx = d; best = cp; }
  }
  for (const seg of v.snapEdges) {
    const ab = new THREE.Vector3().subVectors(seg.b, seg.a);
    const lenSq = ab.lengthSq();
    if (lenSq < 1e-8) continue;
    const t = Math.max(0, Math.min(1, new THREE.Vector3().subVectors(cursorProj, seg.a).dot(ab) / lenSq));
    const onEdge = seg.a.clone().addScaledVector(ab, t);
    const cp = projOf(onEdge);
    const cpPx = worldToPixel(v, cp, pane);
    const d = Math.hypot(cpPx.x - cursorPx.x, cpPx.y - cursorPx.y);
    if (d < bestPx) { bestPx = d; best = cp; }
  }
  if (best) {
    v.snapHysteresis = true;
    showSnapMarker(v, best);
    return { point: best, snapped: true };
  }
  v.snapHysteresis = false;
  hideSnapMarker(v);
  return { point: cursorProj, snapped: false };
}

function showSnapMarker(v: Viewer, p: THREE.Vector3): void {
  if (!v.snapMarker) {
    const geom = new THREE.SphereGeometry(0.06, 12, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ffaa, depthTest: false });
    v.snapMarker = new THREE.Mesh(geom, mat);
    v.snapMarker.renderOrder = 999;
    v.snapMarker.userData.noSnap = true;
    v.snapMarker.userData.noRenderMode = true;
    v.scene.add(v.snapMarker);
  }
  v.snapMarker.position.copy(p);
  v.snapMarker.visible = true;
}

function hideSnapMarker(v: Viewer): void {
  if (v.snapMarker) v.snapMarker.visible = false;
}

function resolveGumballPriority(v: Viewer, e: PointerEvent, pane: Pane): void {
  if (v.relocate.active) return;
  if (e.button !== 0) return;
  const pr = pane.el.getBoundingClientRect();
  const ndcX = ((e.clientX - pr.left) / pr.width) * 2 - 1;
  const ndcY = -((e.clientY - pr.top) / pr.height) * 2 + 1;
  v.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), pane.camera);
  const HANDLE_NAMES = new Set(["X", "Y", "Z", "XY", "XZ", "YZ", "XYZ", "E", "XYZE"]);
  type Hit = { idx: number; mode: "translate" | "rotate" | "scale"; axis: string; dist: number };
  const allHits: Hit[] = [];
  for (let i = 0; i < v.gizmos.length; i++) {
    const g = v.gizmos[i];
    const mode = (g as unknown as { mode: "translate" | "rotate" | "scale" }).mode;
    const targets: THREE.Object3D[] = [];
    g.traverse((o) => {
      if (!HANDLE_NAMES.has(o.name)) return;
      if (!o.parent || !o.parent.visible) return;
      targets.push(o);
    });
    if (targets.length === 0) continue;
    const hits = v.raycaster.intersectObjects(targets, true);
    if (hits[0]) {
      let node: THREE.Object3D | null = hits[0].object;
      while (node && !HANDLE_NAMES.has(node.name)) node = node.parent;
      if (node?.name) allHits.push({ idx: i, mode, axis: node.name, dist: hits[0].distance });
    }
  }
  if (allHits.length === 0) return;
  let winner: Hit;
  if (allHits.length === 1) {
    winner = allHits[0];
  } else {
    const hoveredHits = allHits.filter(h => {
      const gAxis = v.gizmos[h.idx].axis;
      return gAxis !== null && gAxis === h.axis;
    });
    if (hoveredHits.length === 1) {
      winner = hoveredHits[0];
    } else if (hoveredHits.length > 1) {
      const MULTI_HOVER: Record<string, number> = { scale: 0, rotate: 1, translate: 2 };
      hoveredHits.sort((a, b) => MULTI_HOVER[a.mode] - MULTI_HOVER[b.mode]);
      winner = hoveredHits[0];
    } else {
      allHits.sort((a, b) => a.dist - b.dist);
      const closest = allHits[0];
      const tol = closest.dist * 0.01 + 0.01;
      const tied = allHits.filter(h => h.dist - closest.dist <= tol);
      if (tied.length === 1) {
        winner = closest;
      } else {
        const isCenter = (axis: string) => axis === "XYZ" || axis === "E" || axis === "XYZE";
        const allCenter = tied.every(h => isCenter(h.axis));
        const ORDER_CENTER: Record<string, number> = { scale: 0, rotate: 1, translate: 2 };
        const ORDER_AXIS: Record<string, number> = { translate: 0, rotate: 1, scale: 2 };
        const order = allCenter ? ORDER_CENTER : ORDER_AXIS;
        tied.sort((a, b) => order[a.mode] - order[b.mode]);
        winner = tied[0];
      }
    }
  }
  console.log("[gumball] won:", winner.mode, winner.axis, "of", allHits.length, "hits, dist=", winner.dist.toFixed(3));
  if (allHits.length > 1) {
    const wasEnabled: boolean[] = [];
    for (let i = 0; i < v.gizmos.length; i++) {
      wasEnabled[i] = v.gizmos[i].enabled;
      if (i !== winner.idx) v.gizmos[i].enabled = false;
    }
    const restore = (): void => {
      for (let i = 0; i < v.gizmos.length; i++) v.gizmos[i].enabled = wasEnabled[i];
      pane.body.removeEventListener("pointerup", restore);
      pane.body.removeEventListener("pointercancel", restore);
    };
    pane.body.addEventListener("pointerup", restore);
    pane.body.addEventListener("pointercancel", restore);
  }
}
