import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { Viewer } from "./viewer.js";
import type { Pane } from "./viewer.js";
import { updateClippingPlane, removeClippingPlane, clearSectionBox, rebuildFill } from "./viewer-sections.js";
import { getSnap } from "./snap-state.js";
import { getHandles, getHandleParent, showHandlesFor, clearHandles, isSubObjectHandle, refitParentGeometry } from "./sub-object-handles.js";
import { clearSelected, setSelected } from "./selection-state.js";
import { emitChainFragment } from "./transforms.js";
import {
  pushDeleteAction, pushReplaceAction, pushTransformAction, pushCustomAction,
  captureTransform, beginTransaction, endTransaction, type TransformSnapshot,
} from "../history.js";
import {
  dissolveGroupForMesh, isOpening, nearestGroupMember, onElementCommitted,
  rerecutVoid, rehostVoidCut, restoreVoidCut,
} from "../tools/join-groups.js";
import { resetWallCorners, recomputeWallEndpoints, attemptWallCornerJoins } from "../tools/wall-corners.js";

export interface DragState {
  snapshot: TransformSnapshot | null;
  multiSnapshots: TransformSnapshot[];
  resetNeighborIds: string[];
  wallOpeningEntries: Array<[THREE.Object3D, THREE.Matrix4, TransformSnapshot]>;
  shiftSnapHandler: ((ev: KeyboardEvent) => void) | null;
}

export function makeObjectChangeListener(
  v: Viewer,
  ds: DragState,
  mode: "translate" | "rotate" | "scale",
): () => void {
  return () => {
    if (v.relocate.active) return;
    if (!v.pivotProxy || !v.targetObject) return;
    v.pivotProxy.updateMatrix();
    const dWorld = new THREE.Matrix4().copy(v.pivotProxy.matrix).multiply(v.pivotMatrixBeforeDrag.clone().invert());
    const applyDeltaToLocal = (target: THREE.Object3D, localBefore: THREE.Matrix4): THREE.Matrix4 => {
      if (!target.parent || target.parent === v.scene) {
        return new THREE.Matrix4().copy(dWorld).multiply(localBefore);
      }
      target.parent.updateMatrixWorld();
      const pInv = target.parent.matrixWorld.clone().invert();
      return pInv.clone().multiply(dWorld).multiply(target.parent.matrixWorld).multiply(localBefore);
    };
    const newMatrix = applyDeltaToLocal(v.targetObject, v.targetMatrixBeforeDrag);
    newMatrix.decompose(v.targetObject.position, v.targetObject.quaternion, v.targetObject.scale);
    for (let _mi = 0; _mi < v.multiTargets.length; _mi++) {
      const _mt = v.multiTargets[_mi];
      if (_mt === v.targetObject) continue;
      const _mtBefore = v.multiTargetMatricesBeforeDrag[_mi];
      if (!_mtBefore) continue;
      const _mtNew = applyDeltaToLocal(_mt, _mtBefore);
      _mtNew.decompose(_mt.position, _mt.quaternion, _mt.scale);
    }
    for (const [_op, _opMatBefore] of ds.wallOpeningEntries) {
      const _opNew = applyDeltaToLocal(_op, _opMatBefore);
      _opNew.decompose(_op.position, _op.quaternion, _op.scale);
    }
    if (v.targetObject.userData.creator === "SdClippingPlane") {
      const label = v.targetObject.userData.clipLabel as string | undefined;
      if (label) updateClippingPlane(v, label, v.targetObject as THREE.Mesh);
    }
    if (v.subTargetObject && mode === "translate") {
      const cpIndex = v.subTargetObject.userData.cpIndex as number;
      const parent = getHandleParent();
      if (parent && Array.isArray(parent.userData.controlPoints)) {
        const local = parent.worldToLocal(v.subTargetObject.position.clone());
        (parent.userData.controlPoints as THREE.Vector3[])[cpIndex].copy(local);
        refitParentGeometry(parent);
      }
    }
    if (!v.subTargetObject) {
      const handleParent = getHandleParent();
      if (handleParent && handleParent === v.targetObject) {
        const cps = handleParent.userData.controlPoints as THREE.Vector3[] | undefined;
        const handles = getHandles();
        if (cps) {
          handleParent.updateMatrixWorld(true);
          for (let i = 0; i < handles.length && i < cps.length; i++) {
            handles[i].position.copy(handleParent.localToWorld(cps[i].clone()));
          }
        }
      }
    }
  };
}

export function makeDraggingChangedListener(
  v: Viewer,
  g: TransformControls,
  ds: DragState,
  mode: "translate" | "rotate" | "scale",
  r4: (n: number) => number,
): (ev: THREE.Event) => void {
  return (ev) => {
    const dragging = (ev as THREE.Event & { value: boolean }).value;
    if (v.controls) v.controls.enabled = !dragging;
    for (const other of v.gizmos) {
      if (other !== g) other.enabled = !dragging;
    }
    if (dragging) {
      const snap = getSnap();
      if (mode === "translate") {
        g.setTranslationSnap(snap.snapOn && snap.gridOn ? snap.step : null);
      } else if (mode === "rotate") {
        const angleRad = (snap.angleStep * Math.PI) / 180;
        g.setRotationSnap(snap.snapOn && snap.polarOn ? angleRad : null);
        ds.shiftSnapHandler = (ev: KeyboardEvent) => {
          if (ev.key !== "Shift") return;
          const s = getSnap();
          const shiftHeld = ev.type === "keydown";
          g.setRotationSnap((shiftHeld || (s.snapOn && s.polarOn)) ? (s.angleStep * Math.PI) / 180 : null);
        };
        document.addEventListener("keydown", ds.shiftSnapHandler);
        document.addEventListener("keyup", ds.shiftSnapHandler);
      } else if (mode === "scale") {
        g.setScaleSnap(snap.snapOn ? 0.1 : null);
      }
    }
    if (!dragging && ds.shiftSnapHandler) {
      document.removeEventListener("keydown", ds.shiftSnapHandler);
      document.removeEventListener("keyup", ds.shiftSnapHandler);
      ds.shiftSnapHandler = null;
    }
    if (dragging && v.pivotProxy && v.targetObject) {
      if (v.targetObject instanceof THREE.Mesh) {
        dissolveGroupForMesh(v.targetObject.uuid, v.scene);
        resetWallCorners(v.targetObject);
        ds.resetNeighborIds = [];
        if (v.targetObject.userData?.creator === "wall") {
          const movedEps = v.targetObject.userData.endpoints as Array<{x: number; y: number}> | undefined;
          if (movedEps) {
            const NEIGHBOR_EPS = 0.05;
            v.scene.traverse((obj) => {
              if (!(obj instanceof THREE.Mesh) || obj === v.targetObject) return;
              if (obj.userData?.creator !== "wall") return;
              const otherEps = obj.userData.endpoints as Array<{x: number; y: number}> | undefined;
              if (!otherEps) return;
              for (const ep of movedEps) {
                for (const oep of otherEps) {
                  if (Math.hypot(ep.x - oep.x, ep.y - oep.y) < NEIGHBOR_EPS) {
                    resetWallCorners(obj);
                    ds.resetNeighborIds.push(obj.uuid);
                    return;
                  }
                }
              }
            });
          }
        }
      }
      v.pivotMatrixBeforeDrag.copy(v.pivotProxy.matrix);
      v.targetMatrixBeforeDrag.copy(v.targetObject.matrix);
      v.multiTargetMatricesBeforeDrag = v.multiTargets.map(mt => mt.matrix.clone());
      ds.snapshot = captureTransform(v.targetObject);
      ds.multiSnapshots = v.multiTargets.map(mt => captureTransform(mt));
      ds.wallOpeningEntries = [];
      if (v.targetObject.userData?.creator === "wall") {
        const _wallId = v.targetObject.userData.expressID as string | number | undefined;
        if (_wallId != null) {
          v.scene.traverse((obj) => {
            if (obj === v.targetObject) return;
            if (!isOpening(obj.userData?.creator as string | undefined)) return;
            if (obj.userData?.hostExpressID == _wallId) {
              ds.wallOpeningEntries.push([obj, obj.matrix.clone(), captureTransform(obj)]);
            }
          });
        }
      }
    } else if (!dragging && v.pivotProxy && v.targetObject) {
      const before = v.pivotMatrixBeforeDrag;
      const dWorld = new THREE.Matrix4().copy(v.pivotProxy.matrix).multiply(before.clone().invert());
      let fragment = "";
      if (mode === "translate") {
        const dx = r4(dWorld.elements[12]);
        const dy = r4(dWorld.elements[13]);
        const dz = r4(dWorld.elements[14]);
        if (dx !== 0 || dy !== 0 || dz !== 0) fragment = `.translate([${dx}, ${dy}, ${dz}])`;
      } else if (mode === "rotate") {
        const dPos = new THREE.Vector3();
        const dQuat = new THREE.Quaternion();
        const dScl = new THREE.Vector3();
        dWorld.decompose(dPos, dQuat, dScl);
        const s = Math.sqrt(1 - dQuat.w * dQuat.w);
        const axis = s < 1e-4 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(dQuat.x / s, dQuat.y / s, dQuat.z / s);
        const deg = r4((2 * Math.acos(Math.max(-1, Math.min(1, dQuat.w))) * 180) / Math.PI);
        if (deg !== 0) fragment = `.rotate(${deg}, [0,0,0], [${r4(axis.x)},${r4(axis.y)},${r4(axis.z)}])`;
      } else if (mode === "scale") {
        const dPos = new THREE.Vector3();
        const dQuat = new THREE.Quaternion();
        const dScl = new THREE.Vector3();
        dWorld.decompose(dPos, dQuat, dScl);
        const f = r4((dScl.x + dScl.y + dScl.z) / 3);
        if (f !== 1) fragment = `.scale(${f})`;
      }
      if (fragment && !v.subTargetObject) emitChainFragment(fragment);
      syncPivot(v);
      if (!v.subTargetObject && v.targetObject instanceof THREE.Mesh) {
        const _movedCreator = v.targetObject.userData?.creator as string | undefined;
        if (_movedCreator === "wall") {
          recomputeWallEndpoints(v.targetObject);
          attemptWallCornerJoins(v.targetObject, v.scene);
          for (const uuid of ds.resetNeighborIds) {
            const neighbor = v.scene.getObjectByProperty("uuid", uuid);
            if (neighbor instanceof THREE.Mesh) {
              recomputeWallEndpoints(neighbor);
              attemptWallCornerJoins(neighbor, v.scene);
            }
          }
          ds.resetNeighborIds = [];
          for (const [_op, , _opSnapBefore] of ds.wallOpeningEntries) {
            pushTransformAction(_op, _opSnapBefore);
          }
          ds.wallOpeningEntries = [];
        } else if (isOpening(_movedCreator) && ds.snapshot) {
          const _rehost = rehostVoidCut(v.targetObject, v.scene);
          if (_rehost) {
            const _oldHostId = (v.targetObject.userData as Record<string, unknown>).hostExpressID as string | undefined;
            const _newHostId = _rehost.newHostExpressID;
            beginTransaction("move-opening");
            pushTransformAction(v.targetObject, ds.snapshot);
            if (_rehost.isCrossWall) {
              if (_rehost.oldVoidGroup && _rehost.restoredWallMesh) {
                pushReplaceAction(_rehost.restoredWallMesh, [_rehost.oldVoidGroup], "wall-void-restore");
              }
              pushReplaceAction(_rehost.newVoidGroup, [_rehost.newHostMesh], "wall-void-cut");
              pushCustomAction(
                () => { (v.targetObject!.userData as Record<string, unknown>).hostExpressID = _oldHostId; },
                () => { (v.targetObject!.userData as Record<string, unknown>).hostExpressID = _newHostId; },
              );
            } else if (_rehost.oldVoidGroup) {
              pushReplaceAction(_rehost.newVoidGroup, [_rehost.oldVoidGroup], "wall-void-recut");
            }
            endTransaction();
            ds.snapshot = null;
          }
        }
        onElementCommitted(v.targetObject, v.scene);
      } else if (!v.subTargetObject && v.targetObject instanceof THREE.Group &&
                 v.targetObject.userData?.creator === "wall" && ds.wallOpeningEntries.length > 0) {
        for (const [_op, , _opSnapBefore] of ds.wallOpeningEntries) {
          pushTransformAction(_op, _opSnapBefore);
        }
        ds.wallOpeningEntries = [];
      }
      if (ds.snapshot && !v.subTargetObject) {
        pushTransformAction(v.targetObject, ds.snapshot);
        for (let _i = 0; _i < v.multiTargets.length; _i++) {
          if (ds.multiSnapshots[_i]) pushTransformAction(v.multiTargets[_i], ds.multiSnapshots[_i]);
        }
      }
      ds.snapshot = null;
      ds.multiSnapshots = [];
    }
  };
}

export function tightenAxisPickers(g: TransformControls, mode: "translate" | "scale"): void {
  const internal = g as unknown as { _gizmo: { picker: Record<string, THREE.Object3D>; gizmo: Record<string, THREE.Object3D> } };
  const pickerGroup = internal._gizmo.picker[mode];
  const pickerSize = mode === "scale" ? 0.4 : 0.25;
  if (pickerGroup) {
    pickerGroup.traverse((o: THREE.Object3D) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (o.name !== "X" && o.name !== "Y" && o.name !== "Z") return;
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox!;
      const cx = (bb.min.x + bb.max.x) / 2;
      const cy = (bb.min.y + bb.max.y) / 2;
      const cz = (bb.min.z + bb.max.z) / 2;
      let tx = 0, ty = 0, tz = 0;
      if (o.name === "X") tx = cx >= 0 ? 0.5 : -0.5;
      if (o.name === "Y") ty = cy >= 0 ? 0.5 : -0.5;
      if (o.name === "Z") tz = cz >= 0 ? 0.5 : -0.5;
      const newGeo = new THREE.BoxGeometry(pickerSize, pickerSize, pickerSize);
      newGeo.translate(tx, ty, tz);
      mesh.geometry.dispose();
      mesh.geometry = newGeo;
    });
  }
  const gizmoGroup = internal._gizmo.gizmo[mode];
  if (gizmoGroup) {
    gizmoGroup.traverse((o: THREE.Object3D) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (o.name !== "X" && o.name !== "Y" && o.name !== "Z") return;
      const geo = mesh.geometry as THREE.BufferGeometry & { parameters?: { radiusTop?: number; radiusBottom?: number } };
      const p = geo.parameters;
      if (p && p.radiusTop === 0.0075 && p.radiusBottom === 0.0075) {
        o.name = `${o.name}_shaft`;
      }
    });
  }
}

export function tightenRotatePickers(gRotate: TransformControls): void {
  const internal = gRotate as unknown as { _gizmo: { picker: { rotate: THREE.Object3D } } };
  internal._gizmo.picker.rotate.traverse((o: THREE.Object3D) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (o.name === "X" || o.name === "Y" || o.name === "Z") {
      const newGeo = new THREE.TorusGeometry(0.5, 0.04, 4, 24);
      mesh.geometry.dispose();
      mesh.geometry = newGeo;
    } else if (o.name === "XYZE") {
      mesh.geometry.dispose();
      mesh.geometry = new THREE.SphereGeometry(0.04, 8, 6);
    }
  });
}

export function captureScaleArmRefs(v: Viewer): void {
  const internal = v.gizmos[2] as unknown as { _gizmo: { gizmo: { scale: THREE.Object3D }; picker: { scale: THREE.Object3D } } };
  for (const axis of ["X", "Y", "Z"] as const) {
    const cubes: Array<{ mesh: THREE.Mesh; sign: number }> = [];
    const pickers: Array<{ mesh: THREE.Mesh; sign: number }> = [];
    internal._gizmo.gizmo.scale.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o.name !== axis) return;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox!;
      const c = axis === "X" ? (bb.min.x + bb.max.x) / 2 : axis === "Y" ? (bb.min.y + bb.max.y) / 2 : (bb.min.z + bb.max.z) / 2;
      cubes.push({ mesh: m, sign: c >= 0 ? 1 : -1 });
    });
    internal._gizmo.picker.scale.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o.name !== axis) return;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox!;
      const c = axis === "X" ? (bb.min.x + bb.max.x) / 2 : axis === "Y" ? (bb.min.y + bb.max.y) / 2 : (bb.min.z + bb.max.z) / 2;
      pickers.push({ mesh: m, sign: c >= 0 ? 1 : -1 });
    });
    v.scaleArmRefs.set(axis, { cubes, pickers });
  }
}

// Build all three TransformControls gumballs and attach to viewer.
export function buildGizmos(v: Viewer, perspPane: Pane): void {
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
  for (const mode of ["translate", "rotate", "scale"] as const) {
    const g = new TransformControls(perspPane.camera, perspPane.body);
    const ds: DragState = { snapshot: null, multiSnapshots: [], resetNeighborIds: [], wallOpeningEntries: [], shiftSnapHandler: null };
    g.setMode(mode);
    g.setSpace("local");
    if (mode === "translate") g.size = 1.0;
    if (mode === "rotate")    g.size = 1.5;
    if (mode === "scale")     g.size = 0.55;
    g.addEventListener("objectChange", makeObjectChangeListener(v, ds, mode));
    g.addEventListener("dragging-changed", makeDraggingChangedListener(v, g, ds, mode, r4));
    g.userData.noSnap = true;
    g.userData.noRenderMode = true;
    g.traverse((child) => { child.userData.noSnap = true; child.userData.noRenderMode = true; });
    v.scene.add(g);
    v.gizmos.push(g);
  }
  tightenAxisPickers(v.gizmos[0], "translate");
  tightenAxisPickers(v.gizmos[2], "scale");
  tightenRotatePickers(v.gizmos[1]);
  captureScaleArmRefs(v);
}

export function syncPivot(v: Viewer): void {
  if (!v.pivotProxy) return;
  if (v.multiTargets.length > 1) {
    const centroid = new THREE.Vector3();
    for (const mt of v.multiTargets) centroid.add(new THREE.Vector3().setFromMatrixPosition(mt.matrix));
    centroid.divideScalar(v.multiTargets.length);
    v.pivotProxy.position.copy(centroid);
    v.pivotProxy.quaternion.identity();
    v.pivotProxy.scale.set(1, 1, 1);
    v.pivotProxy.updateMatrix();
    v.pivotProxy.matrixWorldNeedsUpdate = true;
    return;
  }
  if (!v.targetObject) return;
  if (v.targetObject.userData?.expressID != null) {
    const box = new THREE.Box3().setFromObject(v.targetObject);
    box.getCenter(v.pivotProxy.position);
    v.pivotProxy.quaternion.identity();
    v.pivotProxy.scale.set(1, 1, 1);
    v.pivotProxy.updateMatrix();
    v.pivotProxy.matrixWorldNeedsUpdate = true;
    return;
  }
  v.pivotProxy.matrix.copy(v.targetObject.matrix).multiply(v.pivotOffset);
  v.pivotProxy.matrix.decompose(v.pivotProxy.position, v.pivotProxy.quaternion, v.pivotProxy.scale);
  v.pivotProxy.matrixWorldNeedsUpdate = true;
}

export function isAnyGumballDragging(v: Viewer): boolean {
  for (const g of v.gizmos) {
    if ((g as unknown as { dragging?: boolean }).dragging) return true;
  }
  return false;
}

export function updateRelocateBadge(v: Viewer): void {
  if (!v.relocateBadge) return;
  const visible = v.relocate.active && !!v.targetObject;
  v.relocateBadge.style.display = visible ? "flex" : "none";
  if (visible) {
    const verb = v.relocate.mode === "rotate" ? "ROTATE" : "MOVE";
    v.relocateBadge.textContent = `RELOCATE GUMBALL · ${verb} ${v.relocate.axis}`;
  }
}

export function selectObject(v: Viewer, obj: THREE.Object3D | null): void {
  v.multiTargets = [];
  v.multiTargetMatricesBeforeDrag = [];
  v.subTargetObject = null;
  if (v.targetObject) {
    v.pivotOffsetByUuid.set(v.targetObject.uuid, v.pivotOffset.clone());
  }
  v.targetObject = obj;
  if (obj) {
    const cached = v.pivotOffsetByUuid.get(obj.uuid);
    if (cached) v.pivotOffset.copy(cached);
    else v.pivotOffset.identity();
  } else {
    v.pivotOffset.identity();
  }
  v.relocate.active = false;
  updateRelocateBadge(v);
  const handleCreators = new Set(["line", "polyline", "curve", "wall"]);
  if (obj && handleCreators.has(obj.userData.creator as string)) {
    showHandlesFor(obj, v);
  } else {
    clearHandles(v);
  }
  if (!v.pivotProxy) return;
  if (obj) {
    syncPivot(v);
    if (v._gumballEnabled) {
      for (const g of v.gizmos) g.attach(v.pivotProxy);
    }
  } else {
    for (const g of v.gizmos) g.detach();
  }
}

export function setMultiTargets(v: Viewer, targets: THREE.Object3D[]): void {
  if (targets.length === 0) { selectObject(v, null); return; }
  v.multiTargets = [...targets];
  v.multiTargetMatricesBeforeDrag = [];
  v.subTargetObject = null;
  if (v.targetObject) {
    v.pivotOffsetByUuid.set(v.targetObject.uuid, v.pivotOffset.clone());
  }
  v.targetObject = targets[0];
  v.pivotOffset.identity();
  v.relocate.active = false;
  updateRelocateBadge(v);
  clearHandles(v);
  if (!v.pivotProxy) return;
  syncPivot(v);
  if (v._gumballEnabled) {
    for (const g of v.gizmos) g.attach(v.pivotProxy);
  }
}

export function setGumballEnabled(v: Viewer, enabled: boolean): void {
  v._gumballEnabled = enabled;
  if (!enabled) {
    for (const g of v.gizmos) g.detach();
  } else if (v.targetObject && v.pivotProxy) {
    syncPivot(v);
    for (const g of v.gizmos) g.attach(v.pivotProxy);
  }
}

export function selectSubObject(v: Viewer, handle: THREE.Object3D): void {
  v.subTargetObject = handle;
  if (v.targetObject) {
    v.pivotOffsetByUuid.set(v.targetObject.uuid, v.pivotOffset.clone());
  }
  v.targetObject = handle;
  v.pivotOffset.identity();
  v.relocate.active = false;
  updateRelocateBadge(v);
  if (!v.pivotProxy) return;
  syncPivot(v);
  for (const g of v.gizmos) g.attach(v.pivotProxy);
}

export function clearSubSelection(v: Viewer): void {
  if (!v.subTargetObject) return;
  v.subTargetObject = null;
  const parent = getHandleParent();
  if (parent && v.pivotProxy) {
    if (v.targetObject) {
      v.pivotOffsetByUuid.set(v.targetObject.uuid, v.pivotOffset.clone());
    }
    v.targetObject = parent;
    const cached = v.pivotOffsetByUuid.get(parent.uuid);
    if (cached) v.pivotOffset.copy(cached);
    else v.pivotOffset.identity();
    syncPivot(v);
    for (const g of v.gizmos) g.attach(v.pivotProxy);
  } else {
    v.targetObject = null;
    v.pivotOffset.identity();
    for (const g of v.gizmos) g.detach();
    clearHandles(v);
  }
}

export function deleteSelected(v: Viewer): boolean {
  const targets: THREE.Object3D[] = v.multiTargets.length > 0
    ? [...v.multiTargets]
    : (v.targetObject ? [v.targetObject] : []);
  if (targets.length === 0) return false;
  let anyRemoved = false;
  for (const removed of targets) {
    dissolveGroupForMesh(removed.uuid, v.scene);
    const clipLabel = removed.userData.clipLabel as string | undefined;
    if (clipLabel) removeClippingPlane(v, clipLabel);
    if (removed.userData.kind === "section-box") clearSectionBox(v);
    const removedParent = removed.parent;
    if (removed.parent === v.scene) {
      v.scene.remove(removed);
    } else if (removed.parent) {
      removed.parent.remove(removed);
    } else {
      continue;
    }
    const _creator = (removed.userData as Record<string, unknown>).creator as string | undefined;
    const _voidRestore = isOpening(_creator) ? restoreVoidCut(removed, v.scene) : null;
    if (_voidRestore) beginTransaction("delete-opening");
    pushDeleteAction(removed, removedParent);
    if (_voidRestore) {
      pushReplaceAction(_voidRestore.newWall, [_voidRestore.oldGroup], "wall-void-restore");
      endTransaction();
    }
    v.pivotOffsetByUuid.delete(removed.uuid);
    anyRemoved = true;
  }
  if (anyRemoved) {
    v.targetObject = null;
    v.multiTargets = [];
    v.pivotOffset.identity();
    v.relocate.active = false;
    for (const g of v.gizmos) g.detach();
    updateRelocateBadge(v);
    emitChainFragment(`// removed: ${targets.length} object(s)`);
    clearSelected();
    window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
    if (v._sectionPlanes.length > 0 || v._clipPlanes.length > 0) rebuildFill(v);
  }
  return anyRemoved;
}
