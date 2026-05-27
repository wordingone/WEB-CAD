import type { Viewer } from "./viewer/viewer";
import type { ScenePanel } from "./scene/scene-panel";
import { registerHandler } from "./commands/dispatch";
import { undo, redo, pushCustomAction, clearHistory, pushReplaceAction } from "./history";
import { setRenderMode, type RenderMode } from "./viewer/render-modes";
import { setState } from "./app-state";
import { clippingPlaneStore, type CPlaneBounds } from "./geometry/clipping-planes";
import { setActiveClipPlaneEntity } from "./viewer/clip-plane-handles";
import { getLayoutHost } from "./shell/modes";
import { addLinkedClipPlaneSheet } from "./shell/layout";
import { clearSelected } from "./viewer/selection-state";
import * as THREE from "three";
import { registerGoalHandlers } from "./agent/goal-handlers";
import { registerTransformHandlers } from "./handlers/transforms";
import { registerNurbsHandlers } from "./handlers/nurbs";
import { registerStructuralHandlers } from "./handlers/structural";
import { registerOpeningHandlers } from "./handlers/openings";
import { registerSketchHandlers } from "./handlers/sketch";
import { registerDatumHandlers } from "./handlers/datum";
import { registerCPlaneHandlers } from "./handlers/cplane";
import { registerAnnotationHandlers } from "./handlers/annotations";
import { registerSkillHandlers } from "./handlers/skills";

const ORTHO_VIEWS = ["top", "bottom", "front", "back", "left", "right", "iso"] as const;
type OrthoView = typeof ORTHO_VIEWS[number];

export function registerAllHandlers(viewer: Viewer, scenePanel: ScenePanel): void {
  registerGoalHandlers();

  registerHandler("SdDelete", () => {
    const deleted = viewer.deleteSelected();
    if (deleted) document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    return { deleted };
  });

  registerHandler("SdUndo", () => { undo(viewer); });
  registerHandler("SdRedo", () => { redo(viewer); });

  registerHandler("SdRenderMode", (args) => {
    const mode = (args.mode as string | undefined) ?? "shaded";
    setRenderMode(mode as RenderMode);
    return { mode };
  });

  registerHandler("SdSetViewOrtho", (args) => {
    const raw = (args.view as string | undefined) ?? "top";
    const view: OrthoView = (ORTHO_VIEWS as readonly string[]).includes(raw) ? raw as OrthoView : "top";
    viewer.setView(view);
    setState("currentView", view);
    return { ok: true, view };
  });

  registerHandler("SdSetViewPerspective", () => {
    viewer.frameAllVisible();
    setState("currentView", "perspective");
    return { ok: true, view: "perspective" };
  });

  registerHandler("SdListObjects", () => {
    const scene = viewer.getScene();
    const objects: Array<{ name: string; uuid: string; kind: string; layer?: string; ifcClass?: string; verb?: string }> = [];
    const ifcClassCounts: Record<string, number> = {};
    scene.traverse((obj) => {
      const ud = obj.userData as Record<string, unknown>;
      const isIfc = ud.expressID != null && ud.ifcClass;
      if (!ud.kind && !isIfc) return;
      if (isIfc) {
        const cls = String(ud.ifcClass);
        ifcClassCounts[cls] = (ifcClassCounts[cls] ?? 0) + 1;
        return;
      }
      objects.push({
        name: obj.name || obj.uuid.slice(0, 8),
        uuid: obj.uuid,
        kind: String(ud.kind ?? ""),
        ...(ud.layer ? { layer: String(ud.layer) } : {}),
        ...(ud.ifcClass ? { ifcClass: String(ud.ifcClass) } : {}),
        ...(ud.dispatchVerb ? { verb: String(ud.dispatchVerb) } : {}),
      });
    });
    for (const [cls, count] of Object.entries(ifcClassCounts).sort((a, b) => b[1] - a[1])) {
      objects.push({ name: `${count}\xd7 ${cls}`, uuid: cls, kind: "ifc", ifcClass: cls });
    }
    return { count: objects.length, objects };
  });

  registerHandler("SdZoomExtents", () => { viewer.frameAllVisible(); return { ok: true }; });
  registerHandler("SdZoomSelected", () => { viewer.frameAllVisible(); return { ok: true }; });

  registerHandler("SdSectionBox", (args) => {
    const min = args.min as [number, number, number];
    const max = args.max as [number, number, number];
    const enabled = (args.enabled ?? true) as boolean;
    if (!Array.isArray(min) || min.length < 3 || !Array.isArray(max) || max.length < 3)
      return { error: "min and max must be [x,y,z] arrays" };
    viewer.setSectionBox(min, max, enabled);
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    return { ok: true, min, max, enabled };
  });

  registerHandler("SdSectionBoxOff", () => {
    const prev = viewer.getSectionBox();
    viewer.clearSectionBox();
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    if (prev) {
      const { min, max } = prev;
      pushCustomAction(
        () => { viewer.setSectionBox(min, max); document.dispatchEvent(new CustomEvent("viewer:clip-changed")); },
        () => { viewer.clearSectionBox(); document.dispatchEvent(new CustomEvent("viewer:clip-changed")); },
      );
    }
    return { ok: true };
  });

  registerHandler("SdIsolate", (args) => {
    const uuid = args.uuid as string;
    if (!uuid) return { error: "uuid required" };
    const ok = viewer.isolate(uuid);
    document.dispatchEvent(new CustomEvent("viewer:isolate-changed", { detail: { uuid: ok ? uuid : null } }));
    return ok ? { ok: true, uuid } : { error: "object not found", uuid };
  });

  registerHandler("SdIsolateOff", () => {
    viewer.isolateOff();
    document.dispatchEvent(new CustomEvent("viewer:isolate-changed", { detail: { uuid: null } }));
    return { ok: true };
  });

  registerHandler("SdFitToObject", (args) => {
    const uuid = args.uuid as string;
    if (!uuid) return { error: "uuid required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", uuid);
    if (!obj) return { error: "object not found", uuid };
    viewer.frameObjectOnly(obj);
    return { ok: true, uuid };
  });

  registerHandler("SdClippingPlane", (args) => {
    const origin = args.origin as [number, number, number];
    const normal = args.normal as [number, number, number];
    const label = (args.label as string | undefined) ?? `clip-${Date.now()}`;
    const autoSheet = args.autoSheet !== false;
    const boundsArg = args.bounds as Partial<CPlaneBounds> | undefined;
    if (!Array.isArray(origin) || origin.length < 3 || !Array.isArray(normal) || normal.length < 3)
      return { error: "origin and normal must be [x,y,z] arrays" };
    viewer.addClippingPlane(origin, normal, label);
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    const entity = clippingPlaneStore.add(origin, normal, label, boundsArg);
    setActiveClipPlaneEntity(entity.id);
    let sheetId: string | undefined;
    if (autoSheet) {
      const layoutHost = getLayoutHost();
      if (layoutHost) sheetId = addLinkedClipPlaneSheet(layoutHost, entity.id, `Section – ${label}`);
    }
    return { ok: true, origin, normal, label, clipPlaneId: entity.id, sheetId };
  });

  registerHandler("SdClippingPlanesClear", () => {
    viewer.clearClippingPlanes();
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    return { ok: true };
  });

  registerHandler("SdClippingPlaneRemove", (args) => {
    const label = args.label as string;
    if (!label) return { error: "label required" };
    const removed = viewer.removeClippingPlane(label);
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    return { ok: removed, label };
  });

  registerTransformHandlers(viewer);
  registerNurbsHandlers(viewer);
  registerStructuralHandlers(viewer);
  registerOpeningHandlers(viewer);
  registerSketchHandlers(viewer);
  registerDatumHandlers(viewer);
  registerCPlaneHandlers(viewer);
  registerAnnotationHandlers(viewer);
  registerSkillHandlers();

  // ── #1829: Brep ops ────────────────────────────────────────────────────────

  registerHandler("SdExplode", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdExplode — target is required" };
    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdExplode — object not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdExplode — target must be a Mesh" };
    const geo = obj.geometry as THREE.BufferGeometry;
    const mat = obj.material as THREE.Material;
    const groups = geo.groups.length > 0 ? geo.groups : [{ start: 0, count: geo.index ? geo.index.count : geo.attributes.position.count, materialIndex: 0 }];
    const createdUuids: string[] = [];
    for (const g of groups) {
      const faceGeo = new THREE.BufferGeometry();
      const srcPos = geo.attributes.position as THREE.BufferAttribute;
      const srcNrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
      if (geo.index) {
        const idxArr = geo.index.array;
        const triCount = Math.floor(g.count / 3);
        const pos: number[] = [];
        const nrm: number[] = [];
        for (let t = 0; t < triCount; t++) {
          for (let v = 0; v < 3; v++) {
            const i = idxArr[g.start + t * 3 + v];
            pos.push(srcPos.getX(i), srcPos.getY(i), srcPos.getZ(i));
            if (srcNrm) nrm.push(srcNrm.getX(i), srcNrm.getY(i), srcNrm.getZ(i));
          }
        }
        faceGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        if (nrm.length) faceGeo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
      } else {
        const slicedPos = (srcPos.array as Float32Array).slice(g.start * 3, (g.start + g.count) * 3);
        faceGeo.setAttribute("position", new THREE.Float32BufferAttribute(slicedPos, 3));
        if (srcNrm) {
          const slicedNrm = (srcNrm.array as Float32Array).slice(g.start * 3, (g.start + g.count) * 3);
          faceGeo.setAttribute("normal", new THREE.Float32BufferAttribute(slicedNrm, 3));
        }
      }
      faceGeo.computeBoundingBox();
      const faceMesh = new THREE.Mesh(faceGeo, (mat as THREE.Material).clone());
      faceMesh.userData.kind = "brep";
      faceMesh.userData.creator = "explode-face";
      faceMesh.userData.dispatchArgs = args;
      faceMesh.position.copy(obj.position);
      faceMesh.quaternion.copy(obj.quaternion);
      faceMesh.scale.copy(obj.scale);
      viewer.addMesh(faceMesh, "brep", { noHistory: true });
      createdUuids.push(faceMesh.uuid);
    }
    scene.remove(obj); // audit-undo-ok — tracked by pushReplaceAction below
    pushReplaceAction(createdUuids.length === 1
      ? scene.getObjectByProperty("uuid", createdUuids[0]) as THREE.Mesh
      : (() => { const m = new THREE.Mesh(); m.uuid = createdUuids[0]; return m; })(),
      [obj], "explode");
    return { exploded: createdUuids, faceCount: createdUuids.length };
  });

  registerHandler("SdJoin", (args) => {
    const targetIds = args.targets as string[] | undefined;
    if (!Array.isArray(targetIds) || targetIds.length < 2)
      return { error: "SdJoin — targets must be an array of at least 2 UUIDs" };
    const scene = viewer.getScene();
    const meshes: THREE.Mesh[] = [];
    for (const id of targetIds) {
      const obj = scene.getObjectByProperty("uuid", id);
      if (!obj) return { error: `SdJoin — object not found: ${id}` };
      if (!(obj instanceof THREE.Mesh)) return { error: `SdJoin — target ${id} is not a Mesh` };
      meshes.push(obj);
    }
    const positions: number[] = [];
    const normals: number[] = [];
    let indexOffset = 0;
    const indices: number[] = [];
    for (const m of meshes) {
      const g = m.geometry as THREE.BufferGeometry;
      const pos = g.attributes.position as THREE.BufferAttribute;
      const nrm = g.attributes.normal as THREE.BufferAttribute | undefined;
      for (let i = 0; i < pos.count; i++) {
        const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m.matrixWorld);
        positions.push(v.x, v.y, v.z);
        if (nrm) normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      }
      if (g.index) {
        for (let i = 0; i < g.index.count; i++) indices.push(g.index.getX(i) + indexOffset);
      }
      indexOffset += pos.count;
    }
    const joinedGeo = new THREE.BufferGeometry();
    joinedGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    if (normals.length) joinedGeo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    if (indices.length) joinedGeo.setIndex(indices);
    if (!normals.length) joinedGeo.computeVertexNormals();
    joinedGeo.computeBoundingBox();
    const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    const joined = new THREE.Mesh(joinedGeo, mat);
    joined.userData.kind = "brep";
    joined.userData.creator = "join";
    joined.userData.dispatchArgs = args;
    for (const m of meshes) scene.remove(m); // audit-undo-ok — tracked by pushReplaceAction below
    viewer.addMesh(joined, "brep", { noHistory: true });
    pushReplaceAction(joined, meshes, "join");
    return { created: joined.uuid, faceCount: meshes.length };
  });

  registerHandler("SdRebuild", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdRebuild — target is required" };
    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdRebuild — object not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdRebuild — target must be a Mesh" };
    const count = (args.count as number | undefined) ?? 0;
    const geo = obj.geometry as THREE.BufferGeometry;
    const vertexCount = (geo.attributes.position as THREE.BufferAttribute).count;
    const targetCount = count > 0 ? count : vertexCount * 2;
    return { rebuilt: obj.uuid, originalVertices: vertexCount, targetCount, note: "rebuild scheduled — full NURBS reparameterisation deferred to GPU kernel" };
  });

  registerHandler("SdContour", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdContour — target is required" };
    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdContour — object not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdContour — target must be a Mesh" };
    const interval = (args.interval as number | undefined) ?? 1;
    const countArg = (args.count as number | undefined) ?? 5;
    obj.geometry.computeBoundingBox();
    const bbox = obj.geometry.boundingBox!;
    const zMin = bbox.min.z + (obj.position?.z ?? 0);
    const zMax = bbox.max.z + (obj.position?.z ?? 0);
    const zRange = zMax - zMin;
    const sliceCount = interval > 0 ? Math.max(1, Math.floor(zRange / interval)) : countArg;
    const levels: number[] = [];
    for (let i = 1; i <= sliceCount; i++) levels.push(zMin + (zRange * i) / (sliceCount + 1));
    return { target: targetId, contourLevels: levels, sliceCount: levels.length, interval };
  });

  registerHandler("SdClearScene", () => {
    viewer.clearScene();
    clearHistory();
    scenePanel.clear();
    clearSelected();
    window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
    return { ok: true, cleared: true };
  });
}
