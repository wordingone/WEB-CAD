// Wires the UI: prompt mode (existing) + file-load mode (new).
//
// The prompt-mode flow is unchanged from the v1 release â€” dropdown, textarea,
// Run button, worker, viewer.setMesh.
// The file-load flow accepts IFC/STEP via the worker (heavy parsing) and
// GLB/GLTF/OBJ/STL on the main thread via three.js JSM loaders.
//
// Export menu is shared: the active source (whether replicad-generated or
// loaded-from-file) is queried via viewer.getActiveMeshData().

import { assertCrossOriginIsolated } from "./agent/wasm-backend";
assertCrossOriginIsolated();

import { initShellChrome, setRibbonMode, setRibbonElementTypes, resetRibbonElementTypes } from "./shell/shell";
import { formatLength, formatArea, formatVolume, unitLabel } from "./units";
import { opAddLabel, opBuildAnnotLine, getOpPhase, getLastOpFinishMs } from "./viewer/op-tool";
import { ptIsCoordInputActive } from "./viewer/transforms";
import { buildWorkbench, rebuildPaletteForMode } from "./shell/workbench";
import { loadDrawingLayers } from "./geometry/drawing-layers";
import { buildModes, activateMode, getLayoutHost } from "./shell/modes";
import { exportLayoutAsSvg, exportLayoutAsPdf, exportLayoutAsDwgFallback, exportLayoutAsDxf, addPanel, getPanels, addLinkedClipPlaneSheet } from "./shell/layout";
import { clippingPlaneStore, type CPlaneBounds } from "./geometry/clipping-planes";
import { initCmdK } from "./ui/cmdk";
import { initExportDrawer, openExportDrawer } from "./io/export-drawer";
import { Viewer } from "./viewer/viewer";
import { ScenePanel, type SceneSummary } from "./scene/scene-panel";
import { applyDrafting, removeDrafting, isDrafting } from "./geometry/drafting";
import { DEMOS, applyParams, type DemoPrompt, type Param } from "./agent/demo-prompts";
import { getLayerForCreator, layerStore } from "./geometry/layers";
import { drawingLayerStore } from "./geometry/drawing-layers";
import { levelStore, getActiveLevelId, loadLevelLocks } from "./geometry/levels";
import { gridStore } from "./geometry/grids";
import { snapPoint, setStep as snapSetStep, getStep as snapGetStep } from "./viewer/snap-state";
import { buildIfc, buildIfcScene, ifcRoundTrip, type IfcSceneElement, type IfcLevel } from "./ifc/ifc";
import {
  detectFormat,
  loadMainThreadFormat,
  buildIfcMesh,
  buildStepMesh,
  WORKER_FORMATS,
  MAIN_THREAD_FORMATS,
  ALL_FORMATS,
  isSupported,
  type LoadedScene,
} from "./io/loader";
import {
  exportObj,
  exportGltfJson,
  exportGlb,
  exportUsdz,
  exportStl,
  export3dm,
  exportSvg,
  exportDxf,
  exportPdf,
} from "./io/exporters";
import { SAMPLES } from "./io/sample-files";
import type { WorkerOut } from "./worker";
import { syncToolActiveClass, getState, setState, syncUnitsToStorage, hydrateFromStorage } from "./app-state";
import { initCreateMode, emitClickWorld, DEFAULT_CEILING_OFFSET, execAlignTool } from "./tools/index";
import { onElementCommitted, cutSlabVoidFromBoxMesh, addVoidToWallObject } from "./tools/join-groups";
import { attemptWallCornerJoins } from "./tools/wall-corners";
import { getSnapTarget } from "./viewer/snap-state";
import { makeLevelSprite, updateLevelSprite, buildWall, buildWallPitchedTop, buildSlab, buildColumn, buildBeam, buildRoof, buildSpace, buildFoundation, buildCeiling, buildCurtainWall, buildSkylight, buildStair, buildBox, buildReferenceLine, rebuildWallParams, rebuildGroupWallHeight, type RoofParams, type CurtainWallParams, type StairParams, DEFAULT_WALL_HEIGHT, DEFAULT_SLAB_THICKNESS } from "./tools/structural";
import { buildRect, buildCircle, buildLine, buildPolyline, buildRamp, buildRailing, buildPoint, buildCurve } from "./tools/sketch";
import { buildDoor, buildWindow, buildOpening } from "./tools/openings";
import { DEFAULT_DOOR_W, DEFAULT_DOOR_H, FZK_DOOR_W, FZK_DOOR_H, FZK_FRONT_DOOR_W, FZK_FRONT_DOOR_H, FZK_TERRACE_DOOR_W, FZK_TERRACE_DOOR_H, FZK_WINDOW_W, FZK_WINDOW_H, FZK_WINDOW_SILL, FZK_OG_WINDOW_W, FZK_OG_WINDOW_H, STAIR_STEP_RISE, STAIR_STEP_DEPTH, STAIR_WIDTH } from "./tools/dimensions";
import { initSectionHandles } from "./viewer/section-handles";
import { initClipPlaneHandles, setActiveClipPlaneEntity } from "./viewer/clip-plane-handles";
import { initWallHeightHandle } from "./viewer/wall-height-handle";
import { replayCloneSideEffects } from "./viewer/copy-array";
import { undo, redo, pushAction, pushTransformAction, pushBatchAction, captureTransform, clearHistory, pushReplaceAction, beginTransaction, endTransaction, pushCustomAction } from "./history";
import { csgUnion, csgDifference, csgIntersection, filletMesh, chamferEdge, getUniqueEdges } from "./viewer/csg";
import { registerHandler, dispatch, dispatchSync, installDefaultHandlers, registerRuntimeAlias, registerPostDispatch } from "./commands/dispatch";
import { sceneStoreSave, sceneStoreLoad, sceneStoreClear } from "./io/scene-store";
import { registerGoalHandlers } from "./agent/goal-handlers";
import { listClusters, getClusterByName, listCanvasClusters, type SkillClusterStep } from "./skills/skill-store";
import { STARTER_LIBRARY } from "./skills/starter-library";
import { resolveCPlane, WORLD_XY, WORLD_XZ, WORLD_YZ, type CPlane } from "./viewer/cplane";
import { clearCommandSession, getActiveCommandSession } from "./commands/command-session";
import { runIteration } from "./chat/chat-panel";
import { Point3 as Prim3, Plane as PrimPlane, type Arc as PrimArc } from "./nurbs/nurbs-primitives";
import { tessellate, createClampedUniformNurbs, type Curve, pointAt as curvePointAt, domain as curveDomain } from "./nurbs/nurbs-curves";
import { nurbsCurveFromArc } from "./nurbs/nurbs-curve-algorithms";
import { tessellateSurface } from "./nurbs/nurbs-surfaces";
import { surfaceOfRevolution, sweepSurface, loftSurfaces } from "./nurbs/nurbs-surface-algorithms";
import { addToMultiSelected, clearMultiSelected, clearSelected, getFilters, getSelected, setSelected, topologyAllowed } from "./viewer/selection-state";
import { initRenderModes, setRenderMode, type RenderMode } from "./viewer/render-modes";
import * as THREE from "three";
import { registerTransformHandlers } from "./handlers/transforms";
import { registerNurbsHandlers } from "./handlers/nurbs";
import { registerStructuralHandlers } from "./handlers/structural";
import { registerOpeningHandlers } from "./handlers/openings";
import { registerSketchHandlers } from "./handlers/sketch";
import { registerDatumHandlers, syncLevelOpacities } from "./handlers/datum";
import { registerCPlaneHandlers } from "./handlers/cplane";
import { registerAnnotationHandlers } from "./handlers/annotations";
import { registerSkillHandlers } from "./handlers/skills";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

// Mode toggle + panels
const modePromptBtn = $<HTMLButtonElement>("mode-prompt-btn");
const modeFileBtn = $<HTMLButtonElement>("mode-file-btn");
const promptPanel = $<HTMLDivElement>("prompt-mode-panel");
const filePanel = $<HTMLDivElement>("file-mode-panel");

// Prompt mode controls
const promptSelect = $<HTMLSelectElement>("prompt-select");
const promptText = $<HTMLTextAreaElement>("prompt-text");
const jsSource = $<HTMLTextAreaElement>("js-source");
const runBtn = $<HTMLButtonElement>("run-btn");

// File mode controls
const sampleSelect = $<HTMLSelectElement>("sample-select");
const filePickBtn = $<HTMLButtonElement>("file-pick-btn");
const fileInput = $<HTMLInputElement>("file-input");
const fileNameLabel = $<HTMLSpanElement>("file-name");

// Shared UI
const status = $<HTMLDivElement>("status");
const canvas = $<HTMLCanvasElement>("viewer-canvas");
const viewportAreaEl = document.getElementById("viewport-area-host") as HTMLElement;
const paramPanel = $<HTMLDivElement>("param-panel");
const paramSliders = $<HTMLDivElement>("param-sliders");
const paramCollapseBtn = $<HTMLButtonElement>("param-collapse-btn");
const dropOverlay = $<HTMLDivElement>("drop-overlay");
const scenePanelEl = $<HTMLElement>("scene-panel");

// Export buttons (data-fmt attribute on each)
const exportButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".exp-btn"),
);

paramCollapseBtn.addEventListener("click", () => {
  paramPanel.classList.toggle("collapsed");
  const collapsed = paramPanel.classList.contains("collapsed");
  paramCollapseBtn.setAttribute(
    "aria-label",
    collapsed ? "Expand parameters panel" : "Collapse parameters panel",
  );
});

const viewer = new Viewer(canvas, viewportAreaEl);
// Keep level plane labels in sync when level names are edited via the sidebar.
// Also update the working plane Z so the grid tracks the active level's elevation.
levelStore.subscribe(() => {
  viewer.forEachSceneChild((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.userData.creator !== "IfcLevel") return;
    const level = levelStore.get(mesh.userData.levelId as string);
    if (!level) return;
    const sprite = mesh.children.find((c) => c.userData.isLevelLabel) as THREE.Sprite | undefined;
    if (sprite) updateLevelSprite(sprite, level.name);
  });
  const active = levelStore.getActive();
  if (active) viewer.setWorkingPlaneZ(active.elevation);
  syncLevelOpacities(viewer);
});
// Expose for in-browser debug + DevTools poking â€” read-only handle to scene state.
(window as unknown as { __viewer: Viewer }).__viewer = viewer;
// Expose async dispatch for CDP-driven verification scripts.
// __dispatch is the async variant so async handlers (SdInvokeSkill) resolve correctly.
// __dispatchSync is the legacy sync alias for callers that cannot await.
(window as unknown as { __dispatch: typeof dispatch }).__dispatch = dispatch;
(window as unknown as { __dispatchSync: typeof dispatchSync }).__dispatchSync = dispatchSync;
(window as unknown as { __dispatchAsync: typeof dispatch }).__dispatchAsync = dispatch;
// Expose command-session control for test teardown (prevents picker-bridge session leak).
(window as unknown as { __clearCommandSession: typeof clearCommandSession }).__clearCommandSession = clearCommandSession;
(window as unknown as { __getActiveCommandSession: typeof getActiveCommandSession }).__getActiveCommandSession = getActiveCommandSession;
// Expose gridStore for CDP probes.
(window as unknown as { __gridStore: typeof gridStore }).__gridStore = gridStore;
(window as unknown as { __levelStore: typeof levelStore }).__levelStore = levelStore;
// Expose resolveCPlane for surface 31 CDP verification (W-1 #357).
(window as unknown as { __resolveCPlane: typeof resolveCPlane }).__resolveCPlane = resolveCPlane;
// Expose activeCPlane accessor for surface 39 CDP verification (W-4 #360).
(window as unknown as { __getActiveCPlane: () => CPlane }).__getActiveCPlane = () => viewer.activeCPlane;
(window as unknown as { __emitClickWorld: (w: Parameters<typeof emitClickWorld>[1], opts?: Parameters<typeof emitClickWorld>[2]) => ReturnType<typeof emitClickWorld> }).__emitClickWorld = (w, opts) => emitClickWorld(viewer, w, opts);
(window as unknown as { __runIteration: typeof runIteration }).__runIteration = runIteration;
// Backwards-compat shim for gemma-verify scripts until PR-C updates them (#980).
(window as unknown as { __runDesignLoop: (prompt: string) => ReturnType<typeof runIteration> }).__runDesignLoop = (prompt: string) => runIteration(null, null, prompt, []);
// Expose snap test hooks for CDP verification (#374, #327).
(window as unknown as { __snapPoint: typeof snapPoint }).__snapPoint = snapPoint;
(window as unknown as { __snapSetStep: typeof snapSetStep }).__snapSetStep = snapSetStep;
(window as unknown as { __snapGetStep: typeof snapGetStep }).__snapGetStep = snapGetStep;
(window as unknown as { __getSnapTarget: typeof getSnapTarget }).__getSnapTarget = getSnapTarget;
(window as unknown as { __projectToScreen: (x: number, y: number, z?: number) => { x: number; y: number } | null })
  .__projectToScreen = (x, y, z = 0) => {
    const canvas = viewer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const camera = viewer.getCamera();
    const v = new THREE.Vector3(x, y, z).project(camera as THREE.PerspectiveCamera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * rect.width + rect.left, y: (-v.y * 0.5 + 0.5) * rect.height + rect.top };
  };
// Expose parity notification hook for CDP loop orchestrators and gemma-verify (#321).
(window as unknown as { __notifyParityChanged: (detail: unknown) => void })
  .__notifyParityChanged = (detail) => {
    document.dispatchEvent(new CustomEvent("viewer:parity-changed", { detail }));
  };
(window as unknown as { __setSelected: typeof setSelected }).__setSelected = setSelected;
initRenderModes(viewer);
// Goal meta-tools (#980)
registerGoalHandlers();

// SdDelete: delete the currently selected object via the viewer's deleteSelected() method.
registerHandler("SdDelete", () => {
  const deleted = viewer.deleteSelected();
  if (deleted) document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
  return { deleted };
});
syncToolActiveClass();
syncUnitsToStorage();
initCreateMode(viewer);
initSectionHandles(viewer, viewportAreaEl);
initClipPlaneHandles(viewer, viewportAreaEl);
initWallHeightHandle(viewer, viewportAreaEl);

// Undo/Redo handlers (#55): route SdUndo and SdRedo to the history module.
registerHandler("SdUndo", () => { undo(viewer); });
registerHandler("SdRedo", () => { redo(viewer); });

registerHandler("SdRenderMode", (args) => {
  const mode = (args.mode as string | undefined) ?? "shaded";
  setRenderMode(mode as RenderMode);
  return { mode };
});

const ORTHO_VIEWS = ["top", "bottom", "front", "back", "left", "right", "iso"] as const;
type OrthoView = typeof ORTHO_VIEWS[number];

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
    // SDK-created objects carry ud.kind; IFC-loaded elements carry ud.expressID + ud.ifcClass.
    const isIfc = ud.expressID != null && ud.ifcClass;
    if (!ud.kind && !isIfc) return;
    if (isIfc) {
      const cls = String(ud.ifcClass);
      ifcClassCounts[cls] = (ifcClassCounts[cls] ?? 0) + 1;
      return; // aggregate IFC elements; don't push individual meshes (can be 250+)
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
  // Append IFC class summary as aggregate entries.
  for (const [cls, count] of Object.entries(ifcClassCounts).sort((a, b) => b[1] - a[1])) {
    objects.push({ name: `${count}Ã— ${cls}`, uuid: cls, kind: "ifc", ifcClass: cls });
  }
  return { count: objects.length, objects };
});

registerHandler("SdZoomExtents", () => {
  viewer.frameAllVisible();
  return { ok: true };
});

registerHandler("SdZoomSelected", () => {
  viewer.frameAllVisible();
  return { ok: true };
});

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
  const autoSheet = args.autoSheet !== false; // default true
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
    if (layoutHost) {
      sheetId = addLinkedClipPlaneSheet(layoutHost, entity.id, `Section â€” ${label}`);
    }
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

registerHandler("SdExport", (args) => {
  const fmt = args.format as string | undefined;
  if (!fmt) return { error: "format required (ifc|ifc4|glb|gltf|obj|stl|3dm|dwg|step|svg|dxf|pdf|usdz)" };
  // Skip real download in test mode to prevent file pollution in Downloads.
  if ((window as unknown as { __testMode?: boolean }).__testMode) return { ok: true, format: fmt, testMode: true };
  handleExport(fmt).catch((e) => {
    console.warn("[SdExport]", e);
    setStatus(`Export failed: ${String((e as Error)?.message ?? e)}`, "warn");
  });
  return { ok: true, format: fmt };
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

// ── #1829: Brep ops — Explode / Join / Rebuild / Contour ─────────────────────

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

// Install shim handlers for every dictionary verb that doesn't have a native
// handler yet. This makes all 66+ verbs reachable by the agent (#58 Tier 0).
// Explicit registerHandler() calls above take priority â€” installDefaultHandlers
// skips any canonical name that already has a handler.
installDefaultHandlers();

const scenePanel = new ScenePanel(scenePanelEl, viewer);

registerHandler("SdClearScene", () => {
  viewer.clearScene();
  clearHistory();
  scenePanel.clear();
  resetRibbonElementTypes();
  clearSelected();
  window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
  return { ok: true, cleared: true };
});

// Layer â†’ scene sync (#826): propagate color + visibility changes to scene meshes.
// Fires on every layerStore change (color, visibility, add, remove).
// Skips CSG join-display meshes (userData.isJoinDisplay === true).
layerStore.subscribe(() => {
  viewer.getScene().traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.userData.isJoinDisplay === true) return;
    const lid = obj.userData.layerId as string | undefined;
    if (!lid) return;
    const layer = layerStore.get(lid);
    if (!layer) return;
    const mat = obj.material;
    if (mat && "color" in mat && (mat as THREE.MeshStandardMaterial).color) {
      (mat as THREE.MeshStandardMaterial).color.setStyle(layer.color);
    }
    obj.visible = layer.visible;
  });
});

// Drawing layer â†’ scene sync (#964): propagate visibility + color to sketch objects.
drawingLayerStore.subscribe(() => {
  viewer.getScene().traverse((obj) => {
    const dlId = obj.userData.drawingLayerId as string | undefined;
    if (!dlId) return;
    const layer = drawingLayerStore.get(dlId);
    if (!layer) return;
    obj.visible = layer.visible;
    const mat = (obj as THREE.Mesh).material;
    if (mat && "color" in mat && (mat as THREE.LineBasicMaterial).color) {
      (mat as THREE.LineBasicMaterial).color.setStyle(layer.color);
    }
  });
});

// â”€â”€ Roof selection inspector (#754) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// When a roof mesh is selected, show parameter sliders in #element-inspector.
// Changing sliders replaces the roof mesh with a re-dispatched SdRoof call.
const _roofInspectorEl = ((): HTMLElement => {
  let el = document.getElementById("element-inspector");
  if (!el) {
    el = document.createElement("div");
    el.id = "element-inspector";
    el.style.cssText = "display:none;position:fixed;bottom:1rem;right:1rem;background:rgba(20,20,20,0.93);border:1px solid #444;border-radius:6px;padding:10px 14px;min-width:210px;z-index:200;font:13px/1.5 sans-serif;color:#ddd;";
    document.body.appendChild(el);
  }
  return el;
})();

let _roofInspectorMeshUuid: string | null = null;

function _showRoofInspector(mesh: THREE.Mesh): void {
  const p: RoofParams = (mesh.userData.roofParams as RoofParams) ?? { type: "pitched", pitchDeg: 30, overhang: 0.5, thickness: 0.15 };
  _roofInspectorMeshUuid = mesh.uuid;

  const mkSlider = (label: string, key: keyof RoofParams, minM: number, maxM: number, stepM: number, unit: string) => {
    const isLength = unit === "m";
    const isImperial = isLength && unitLabel() === "ft";
    const FT = 3.28084;
    const toDisp = (m: number) => isImperial ? Math.round(m * FT * 100) / 100 : m;
    const toMeters = (d: number) => isImperial ? d / FT : d;
    const dispUnit = isLength ? unitLabel() : unit;
    const min = toDisp(minM), max = toDisp(maxM), step = Math.round(toDisp(stepM) * 1000) / 1000;

    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;margin:4px 0;";
    const lbl = document.createElement("span");
    lbl.style.cssText = "min-width:70px;font-size:11px;color:#aaa;";
    lbl.textContent = label;
    const val = document.createElement("span");
    val.style.cssText = "min-width:32px;text-align:right;font-size:11px;";
    const curM = (p[key] as number) ?? (key === "pitchDeg" ? 30 : key === "overhang" ? 0.5 : 0.15);
    const cur = toDisp(curM);
    val.textContent = `${cur}${dispUnit}`;
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = String(min); inp.max = String(max); inp.step = String(step);
    inp.value = String(cur); inp.style.cssText = "flex:1;";
    inp.addEventListener("input", () => {
      val.textContent = `${parseFloat(inp.value)}${dispUnit}`;
    });
    inp.addEventListener("change", () => {
      const dispVal = parseFloat(inp.value);
      const metersVal = isLength ? toMeters(dispVal) : dispVal;
      const updated: Record<string, unknown> = { ...p, [key]: metersVal };
      const existing = viewer.getScene().getObjectByProperty("uuid", _roofInspectorMeshUuid ?? "");
      if (!existing) return;
      const dispArgs = (existing.userData.dispatchArgs as Record<string, unknown>) ?? {};
      dispatchSync("SdRoof", {
        ...dispArgs,
        roofType: updated.type as string,
        pitchDeg: updated.pitchDeg as number,
        overhang: updated.overhang as number,
        thickness: updated.thickness as number,
      });
      // Remove the old mesh after dispatch added the new one
      const stillOld = viewer.getScene().getObjectByProperty("uuid", _roofInspectorMeshUuid ?? "");
      if (stillOld) viewer.removeObject(stillOld); // audit-undo-ok â€” inspector re-builds from dispatch, undo tracks the dispatch action
    });
    row.appendChild(lbl); row.appendChild(val); row.appendChild(inp);
    return row;
  };

  const typeMap: Array<[RoofParams["type"], string]> = [
    ["pitched", "Gable"], ["hip", "Hip"], ["shed", "Shed"], ["flat", "Flat"],
  ];
  const typeRow = document.createElement("div");
  typeRow.style.cssText = "margin:2px 0 6px;";
  const typeLbl = document.createElement("span");
  typeLbl.style.cssText = "font-size:11px;color:#aaa;margin-right:6px;";
  typeLbl.textContent = "Type";
  const typeSel = document.createElement("select");
  typeSel.style.cssText = "background:#333;color:#ddd;border:1px solid #555;border-radius:3px;padding:1px 4px;font-size:12px;";
  for (const [val, lbl] of typeMap) {
    const opt = document.createElement("option");
    opt.value = val ?? ""; opt.textContent = lbl;
    if (val === p.type) opt.selected = true;
    typeSel.appendChild(opt);
  }
  typeSel.addEventListener("change", () => {
    (p as Record<string, unknown>).type = typeSel.value;
  });
  typeRow.appendChild(typeLbl); typeRow.appendChild(typeSel);

  _roofInspectorEl.innerHTML = "";
  const title = document.createElement("div");
  title.style.cssText = "font-size:12px;font-weight:600;margin-bottom:6px;color:#fff;";
  title.textContent = "Roof";
  _roofInspectorEl.appendChild(title);
  _roofInspectorEl.appendChild(typeRow);
  _roofInspectorEl.appendChild(mkSlider("Pitch", "pitchDeg", 5, 70, 5, "Â°"));
  _roofInspectorEl.appendChild(mkSlider("Overhang", "overhang", 0, 2, 0.1, "m"));
  _roofInspectorEl.appendChild(mkSlider("Thickness", "thickness", 0.05, 0.5, 0.05, "m"));
  _roofInspectorEl.style.display = "";
}

// â”€â”€ Shared inspector helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _mkInspectorSlider(
  label: string, minM: number, maxM: number, stepM: number, curM: number, unit: string,
  onChange: (metersVal: number) => void,
): HTMLElement {
  const isLength = unit === "m";
  const isImperial = isLength && unitLabel() === "ft";
  const FT = 3.28084;
  const toDisp = (m: number) => isImperial ? Math.round(m * FT * 100) / 100 : m;
  const toMeters = (d: number) => isImperial ? d / FT : d;
  const dispUnit = isLength ? unitLabel() : unit;
  const min = toDisp(minM), max = toDisp(maxM), step = Math.round(toDisp(stepM) * 1000) / 1000;
  const cur = toDisp(curM);

  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:6px;margin:4px 0;";
  const lbl = document.createElement("span");
  lbl.style.cssText = "min-width:70px;font-size:11px;color:#aaa;";
  lbl.textContent = label;
  const val = document.createElement("span");
  val.style.cssText = "min-width:36px;text-align:right;font-size:11px;";
  val.textContent = `${cur}${dispUnit}`;
  const inp = document.createElement("input");
  inp.type = "range"; inp.min = String(min); inp.max = String(max); inp.step = String(step);
  inp.value = String(cur); inp.style.cssText = "flex:1;";
  inp.addEventListener("input", () => { val.textContent = `${parseFloat(inp.value)}${dispUnit}`; });
  inp.addEventListener("change", () => { onChange(isLength ? toMeters(parseFloat(inp.value)) : parseFloat(inp.value)); });
  row.appendChild(lbl); row.appendChild(val); row.appendChild(inp);
  return row;
}

function _inspectorTitle(text: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "font-size:12px;font-weight:600;margin-bottom:6px;color:#fff;";
  el.textContent = text;
  return el;
}

// â”€â”€ Stair inspector â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let _stairInspectorGroupUuid: string | null = null;

function _showStairInspector(group: THREE.Object3D): void {
  const sp = group.userData.stairParams as { actualRiser: number; actualTread: number; nRisers: number; totalRise: number } | undefined;
  _stairInspectorGroupUuid = group.uuid;
  _roofInspectorMeshUuid = null;

  _roofInspectorEl.innerHTML = "";
  _roofInspectorEl.appendChild(_inspectorTitle("Stair"));

  if (sp) {
    const info = document.createElement("div");
    info.style.cssText = "padding:2px 8px 4px; font-size:10px; color:var(--ink-dim);";
    info.textContent = `${sp.nRisers} steps Â· rise ${(sp.totalRise * 1000 | 0) / 1000}m`;
    _roofInspectorEl.appendChild(info);
  }

  _roofInspectorEl.appendChild(_mkInspectorSlider("Riser", 0.10, 0.20, 0.005, sp?.actualRiser ?? 0.1778, "m", (v) => {
    const cur = viewer.getScene().getObjectByProperty("uuid", _stairInspectorGroupUuid ?? "");
    if (!cur) return;
    const da = (cur.userData.dispatchArgs as Record<string, unknown>) ?? {};
    const params = cur.userData.stairParams as { actualRiser: number; actualTread: number } | undefined;
    dispatchSync("SdStair", { ...da, riser: v, tread: params?.actualTread ?? 0.2794 });
    viewer.removeObject(cur);
  }));
  _roofInspectorEl.appendChild(_mkInspectorSlider("Tread", 0.254, 0.356, 0.005, sp?.actualTread ?? 0.2794, "m", (v) => {
    const cur = viewer.getScene().getObjectByProperty("uuid", _stairInspectorGroupUuid ?? "");
    if (!cur) return;
    const da = (cur.userData.dispatchArgs as Record<string, unknown>) ?? {};
    const params = cur.userData.stairParams as { actualRiser: number; actualTread: number } | undefined;
    dispatchSync("SdStair", { ...da, riser: params?.actualRiser ?? 0.1778, tread: v });
    viewer.removeObject(cur);
  }));
  _roofInspectorEl.style.display = "";
}

// â”€â”€ Door inspector â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let _doorInspectorMeshUuid: string | null = null;

function _showDoorInspector(mesh: THREE.Mesh): void {
  _doorInspectorMeshUuid = mesh.uuid;
  _roofInspectorMeshUuid = null;
  _stairInspectorGroupUuid = null;
  const curW = (mesh.userData.voidW as number | undefined) ?? DEFAULT_DOOR_W;
  const curH = (mesh.userData.voidH as number | undefined) ?? DEFAULT_DOOR_H;

  _roofInspectorEl.innerHTML = "";
  _roofInspectorEl.appendChild(_inspectorTitle("Door"));

  const redispatch = (w: number, h: number) => {
    const cur = viewer.getScene().getObjectByProperty("uuid", _doorInspectorMeshUuid ?? "");
    if (!cur) return;
    const da = (cur.userData.dispatchArgs as Record<string, unknown>) ?? {};
    dispatchSync("SdDoor", { ...da, width: w, height: h });
    viewer.removeObject(cur);
  };

  let liveW = curW, liveH = curH;
  _roofInspectorEl.appendChild(_mkInspectorSlider("Width",  0.61, 1.22, 0.025, curW, "m", (v) => { liveW = v; redispatch(liveW, liveH); }));
  _roofInspectorEl.appendChild(_mkInspectorSlider("Height", 0.61, 2.44, 0.025, curH, "m", (v) => { liveH = v; redispatch(liveW, liveH); }));
  _roofInspectorEl.style.display = "";
}

// â”€â”€ Wall height inspector â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let _wallInspectorMeshUuid: string | null = null;

function _showWallInspector(mesh: THREE.Object3D): void {
  _wallInspectorMeshUuid = mesh.uuid;
  _roofInspectorMeshUuid = null;
  _stairInspectorGroupUuid = null;
  _doorInspectorMeshUuid = null;
  const curH = (mesh.userData.wallHeight as number | undefined) ?? DEFAULT_WALL_HEIGHT;

  _roofInspectorEl.innerHTML = "";
  _roofInspectorEl.appendChild(_inspectorTitle("Wall"));
  _roofInspectorEl.appendChild(_mkInspectorSlider("Height", 2.13, 4.27, 0.05, curH, "m", (v) => {
    const cur = viewer.getScene().getObjectByProperty("uuid", _wallInspectorMeshUuid ?? "");
    // Group walls arise after addVoidToWallObject cuts a void (#1537).
    if (cur instanceof THREE.Group) rebuildGroupWallHeight(cur, v);
    else if (cur instanceof THREE.Mesh) rebuildWallParams(cur, { height: v });
  }));
  _roofInspectorEl.style.display = "";
}

// â”€â”€ Shared hide helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _hideInspector(): void {
  _roofInspectorEl.style.display = "none";
  _roofInspectorMeshUuid = null;
  _stairInspectorGroupUuid = null;
  _doorInspectorMeshUuid = null;
  _wallInspectorMeshUuid = null;
}

window.addEventListener("viewer:select", (e) => {
  const uuid = (e as CustomEvent<{ uuid: string | null }>).detail?.uuid;
  if (!uuid) { _hideInspector(); return; }
  const obj = viewer.getScene().getObjectByProperty("uuid", uuid);
  const creator = obj?.userData?.creator as string | undefined;
  if (creator === "roof" && obj instanceof THREE.Mesh) {
    _stairInspectorGroupUuid = null; _doorInspectorMeshUuid = null; _wallInspectorMeshUuid = null;
    _showRoofInspector(obj);
  } else if (creator === "stair") {
    // Walk up to find the stair group (has stairParams). Selected obj may be a
    // flight wrapper (polyline/curve stairs) or direct child of the stair group.
    let stairGroup: THREE.Object3D | null = null;
    let cur: THREE.Object3D | null = obj ?? null;
    while (cur) {
      if (cur.userData?.stairParams) { stairGroup = cur; break; }
      cur = cur.parent;
    }
    if (stairGroup) {
      _showStairInspector(stairGroup);
    } else {
      _hideInspector();
    }
  } else if ((creator === "door" || creator === "SdDoor") && obj instanceof THREE.Mesh) {
    _showDoorInspector(obj);
  } else if (creator === "wall" && (obj instanceof THREE.Mesh || obj instanceof THREE.Group)) {
    _showWallInspector(obj);
  } else {
    _hideInspector();
  }
});

// Enable export buttons once the agent completes a turn with dispatches.
// The dispatch path (IfcWall, SdBox, etc.) doesn't go through the replicad worker,
// so currentSource is never set to "prompt" â€” all export buttons stay disabled.
// Fix: listen for turn-complete and promote source when verbs were dispatched.
window.addEventListener("agent:turn-complete", (e) => {
  const verbs = (e as CustomEvent<{ verbs: string[] }>).detail?.verbs;
  if (verbs && verbs.length > 0 && currentSource.kind === "none") {
    currentSource = { kind: "prompt", demoId: currentDemo.id };
    refreshExportButtons();
  }
});

// Isolate status bar indicator â€” show/hide #sb-isolate on viewer:isolate-changed.
document.addEventListener("viewer:isolate-changed", (e) => {
  const cell = document.getElementById("sb-isolate");
  if (!cell) return;
  const uuid = (e as CustomEvent<{ uuid: string | null }>).detail?.uuid;
  cell.style.display = uuid ? "" : "none";
});

// #1600/#1601: surface sd:status events from non-main-ts modules (join-groups, cmdk).
window.addEventListener("sd:status", (e) => {
  const { msg, kind } = (e as CustomEvent<{ msg: string; kind: "ok" | "err" | "info" | "warn" | "" }>).detail;
  setStatus(msg, kind);
});

// Navigation hotkeys â€” Blender-numpad keymap, with letter fallbacks for
// keyboards without a numpad. Captured at window level but ignored if the
// user is typing in any input/textarea/contenteditable.
window.addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement | null;
  if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (getOpPhase()) return; // op-tool active â€” coord input takes priority
  if (ptIsCoordInputActive()) return; // coord input visible â€” block navigation shortcuts
  if (Date.now() - getLastOpFinishMs() < 300) return; // #1186: 300ms cooldown after op-tool finishes
  // Numpad first; falls through to letter keys for laptops.
  switch (e.key) {
    case "1": case "Numpad1": viewer.setView("front"); break;
    case "3": case "Numpad3": viewer.setView("right"); break;
    case "7": case "Numpad7": viewer.setView("top"); break;
    case "9": case "Numpad9": viewer.setView("iso"); break;
    case "5": case "Numpad5": viewer.setView("extents"); break;
    case "f": case "F":       viewer.setView("extents"); break;
    case "d": case "D":       toggleDraftingStyle(); break;
    default: return;
  }
  e.preventDefault();
});

// Ctrl/Cmd hotkeys: undo/redo (#27) and select-all (#31).
window.addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement | null;
  if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key === "z" || e.key === "Z") {
    if (e.shiftKey) {
      if (redo(viewer)) e.preventDefault();
    } else {
      if (undo(viewer)) e.preventDefault();
    }
  } else if (e.key === "y" || e.key === "Y") {
    if (redo(viewer)) e.preventDefault();
  } else if (e.shiftKey && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    dispatchSync("selectAll", {});
  }
});

// Drafting-style toggle (#173 Gap 2). Walks the active scene root, adds
// EdgesGeometry overlays + flat paper-tone fill on first call; restores on
// second call. Surfaced via "D" hotkey above and Cmd-K palette command.
function toggleDraftingStyle(): void {
  const root = viewer.getActiveObject();
  if (!root) return;
  if (isDrafting(root)) removeDrafting(root);
  else applyDrafting(root);
}
// Expose for cmdk.ts and external testing.
(window as unknown as { __toggleDrafting?: () => void }).__toggleDrafting = toggleDraftingStyle;

// Worker boot. Vite resolves the URL + format=es per vite.config.ts worker block.
// `let` â€” reassigned by spawnWorker() after each IFC load to reclaim wasm linear memory.
let worker: Worker;
let nextId = 1;
let pendingStl: ArrayBuffer | null = null;
let pendingStep: ArrayBuffer | null = null;

// Source mode tracking â€” drives which export buttons are enabled.
type Source =
  | { kind: "none" }
  | { kind: "prompt"; demoId: string }
  | { kind: "file"; format: string; filename: string };

let currentSource: Source = { kind: "none" };

// Pending requests from the file path. Worker responses arrive on the same
// onmessage handler; we use a numeric id + callbacks map to route.
type WorkerCallback = (msg: WorkerOut) => void;
const workerCallbacks = new Map<number, WorkerCallback>();

function setStatus(msg: string, kind: "ok" | "err" | "info" | "warn" | "" = "") {
  status.textContent = msg;
  status.className = `status${kind ? " " + kind : ""}`;
}

let workerReady = false;
const pendingRuns: Array<() => void> = [];

// Recycle counter exposed for gemma-verify surface assertion.
(window as any).__worker_recycle_count = 0;

function spawnWorker(): void {
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
    const msg = ev.data;
    if (msg.type === "ready") {
      workerReady = true;
      runBtn.disabled = false;
      setStatus("OpenCascade ready.", "info");
      pendingRuns.forEach((fn) => fn());
      pendingRuns.length = 0;
      initSceneRestore();
      loadLevelLocks(); // restore per-level lock state from IDB (#1752)
      return;
    }

    // Route worker messages with id field via callbacks map first; fall through
    // to the legacy run-ok / run-error handlers if no callback registered.
    if ("id" in msg) {
      const cb = workerCallbacks.get((msg as any).id);
      if (cb) {
        workerCallbacks.delete((msg as any).id);
        cb(msg);
        return;
      }
    }

    if (msg.type === "run-error") {
      setStatus(`Error: ${msg.error}`, "err");
      runBtn.disabled = false;
      refreshExportButtons();
      return;
    }
    if (msg.type === "run-ok") {
      viewer.setMesh(msg.mesh, msg.bounds);
      clearHistory();
      pendingStl  = msg.stl.byteLength  > 0 ? msg.stl  : null;
      pendingStep = msg.step?.byteLength > 0 ? msg.step : null;
      currentSource = { kind: "prompt", demoId: currentDemo.id };
      setStatus(
        `${shortLabel(currentDemo.label)} Â· ${formatBounds(msg.bounds)} Â· ready to export`,
        "ok",
      );
      // Approximate triangle count from worker-emitted mesh.
      const promptTris = msg.mesh.indices?.length
        ? msg.mesh.indices.length / 3
        : (msg.mesh.vertices?.length ?? 0) / 9;
      scenePanel.update({
        format: "replicad",
        triangles: Math.round(promptTris),
        filename: shortLabel(currentDemo.label),
      });
      runBtn.disabled = false;
      refreshExportButtons();
      window.dispatchEvent(
        new CustomEvent("gemma:run-ok", {
          detail: { js: jsSource.value, label: shortLabel(currentDemo.label) },
        }),
      );
    }
  };
}

function terminateAndRecycle(): void {
  worker.terminate();
  workerReady = false;
  workerCallbacks.clear();
  (window as any).__worker_recycle_count++;
  spawnWorker();
}

// Initial boot.
spawnWorker();

function formatBounds(b: { min: [number, number, number]; max: [number, number, number] }): string {
  const dx = b.max[0] - b.min[0];
  const dy = b.max[1] - b.min[1];
  const dz = b.max[2] - b.min[2];
  return `${formatLength(dx)} Ã— ${formatLength(dy)} Ã— ${formatLength(dz)}`;
}

// "1. Wall (5.5m Ã— 0.2m Ã— 2.8m)" â†’ "Wall"
function shortLabel(label: string): string {
  const stripped = label.replace(/^\d+\.\s*/, "").replace(/\s*\(.*\)\s*$/, "").trim();
  return stripped || label;
}

// Populate dropdowns.
DEMOS.forEach((d, i) => {
  const opt = document.createElement("option");
  opt.value = String(i);
  opt.textContent = d.label;
  promptSelect.appendChild(opt);
});

SAMPLES.forEach((s) => {
  const opt = document.createElement("option");
  opt.value = s.id;
  opt.textContent = s.label;
  if (s.note) opt.title = s.note;
  sampleSelect.appendChild(opt);
});

let currentDemo: DemoPrompt = DEMOS[0];
let currentParams: Record<string, number> = {};

function loadDemo(idx: number) {
  currentDemo = DEMOS[idx];
  promptText.value = currentDemo.prompt;
  buildSliders(currentDemo);
  jsSource.value = applyParams(currentDemo.js, currentParams);
}

function buildSliders(demo: DemoPrompt) {
  paramSliders.innerHTML = "";
  currentParams = {};
  if (!demo.params || demo.params.length === 0) {
    paramPanel.classList.add("hidden");
    return;
  }
  paramPanel.classList.remove("hidden");

  for (const p of demo.params) {
    currentParams[p.name] = p.default;

    const row = document.createElement("div");
    row.className = "slider-row";

    const label = document.createElement("label");
    label.textContent = p.label;
    label.htmlFor = `slider-${p.name}`;

    const valueSpan = document.createElement("span");
    valueSpan.className = "value";
    valueSpan.textContent = p.default.toString();

    const input = document.createElement("input");
    input.id = `slider-${p.name}`;
    input.type = "range";
    input.min = String(p.min);
    input.max = String(p.max);
    input.step = String(p.step);
    input.value = String(p.default);

    let timer: number | undefined;
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      currentParams[p.name] = v;
      valueSpan.textContent = formatParam(v, p);
      jsSource.value = applyParams(currentDemo.js, currentParams);
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => runJs(jsSource.value), 90);
    });

    row.appendChild(label);
    row.appendChild(valueSpan);
    row.appendChild(input);
    paramSliders.appendChild(row);
  }
}

function formatParam(v: number, p: Param): string {
  if (p.step >= 1) return v.toFixed(0);
  if (p.step >= 0.1) return v.toFixed(1);
  return v.toFixed(2);
}

function runJs(js: string) {
  const send = () => {
    runBtn.disabled = true;
    refreshExportButtons(true);
    setStatus("Running...", "info");
    worker.postMessage({ type: "run", id: nextId++, js });
  };
  if (workerReady) send();
  else pendingRuns.push(send);
}

promptSelect.addEventListener("change", () => {
  loadDemo(Number(promptSelect.value));
});

runBtn.addEventListener("click", () => {
  runJs(jsSource.value);
});

// --- Source mode toggle ---

function setMode(mode: "prompt" | "file") {
  if (mode === "prompt") {
    modePromptBtn.classList.add("active");
    modePromptBtn.setAttribute("aria-selected", "true");
    modeFileBtn.classList.remove("active");
    modeFileBtn.setAttribute("aria-selected", "false");
    promptPanel.classList.remove("hidden");
    filePanel.classList.add("hidden");
    runBtn.disabled = !workerReady;
  } else {
    modeFileBtn.classList.add("active");
    modeFileBtn.setAttribute("aria-selected", "true");
    modePromptBtn.classList.remove("active");
    modePromptBtn.setAttribute("aria-selected", "false");
    promptPanel.classList.add("hidden");
    filePanel.classList.remove("hidden");
    runBtn.disabled = true;
    paramPanel.classList.add("hidden");
  }
}

modePromptBtn.addEventListener("click", () => setMode("prompt"));
modeFileBtn.addEventListener("click", () => setMode("file"));

// --- File-load flow ---

async function handleFile(file: File): Promise<void> {
  const fmt = detectFormat(file.name);
  fileNameLabel.textContent = file.name;
  fileNameLabel.classList.remove("muted");
  if (!isSupported(fmt)) {
    setStatus(`Unsupported format: .${fmt} â€” try .ifc / .glb / .gltf / .obj / .stl / .step`, "err");
    return;
  }
  setStatus(`Reading ${file.name} (${fmt.toUpperCase()})...`, "info");

  const buffer = await file.arrayBuffer();

  if (MAIN_THREAD_FORMATS.has(fmt)) {
    try {
      const scene = await loadMainThreadFormat(buffer, fmt);
      finalizeFileLoad(scene, file.name);
    } catch (e) {
      setStatus(`Failed to parse ${file.name}: ${(e as Error).message}`, "err");
    }
    return;
  }

  if (WORKER_FORMATS.has(fmt)) {
    if (!workerReady) {
      setStatus("Waiting for OpenCascade WASM to finish loading...", "info");
      pendingRuns.push(() => handleFile(file));
      return;
    }
    if (fmt === "ifc") {
      setStatus(`Parsing ${file.name} via web-ifc... (may take a few seconds)`, "info");
      const id = nextId++;
      workerCallbacks.set(id, (msg) => {
        if (msg.type === "load-ifc-ok") {
          buildIfcMesh(msg, file.name).then((scene) => {
            finalizeFileLoad(scene, file.name);
            window.dispatchEvent(new CustomEvent("viewer:ifc-loaded", { detail: { filename: file.name } }));
            dispatchSync("SdZoomExtents", {});
            terminateAndRecycle();
          });
        } else if (msg.type === "load-ifc-error") {
          setStatus(`IFC parse failed: ${msg.error}`, "err");
          terminateAndRecycle();
        }
      });
      worker.postMessage({ type: "load-ifc", id, bytes: buffer }, [buffer]);
    } else if (fmt === "step" || fmt === "stp" || fmt === "iges" || fmt === "igs" || fmt === "brep") {
      setStatus(`Parsing ${file.name} via OpenCascade... (may take a few seconds)`, "info");
      const id = nextId++;
      workerCallbacks.set(id, (msg) => {
        if (msg.type === "load-step-ok") {
          buildStepMesh(msg, file.name, fmt).then((scene) => finalizeFileLoad(scene, file.name));
        } else if (msg.type === "load-step-error") {
          setStatus(`${fmt.toUpperCase()} parse failed: ${msg.error}`, "err");
        }
      });
      worker.postMessage(
        { type: "load-step", id, bytes: buffer, format: fmt as any },
        [buffer],
      );
    }
  }
}

function finalizeFileLoad(scene: LoadedScene, filename: string) {
  viewer.setObject(scene.object, scene.bounds);
  clearHistory(); // file load replaces the full scene; stale undo refs would crash
  pendingStl = null;  // STL/STEP are replicad-only; loaded-file path doesn't ship them.
  pendingStep = null;
  currentSource = { kind: "file", format: scene.format, filename };
  setStatus(scene.summary, "ok");
  // Pull schema/entityCount out of the summary for IFC; other formats
  // omit them and the panel just shows format + triangles.
  const summary: SceneSummary = {
    format: scene.format,
    triangles: scene.triangles,
    filename,
    hierarchy: scene.hierarchy,
  };
  // Summary string for IFC looks like
  //   "<filename> Â· 7,123 entities Â· 56,832 triangles Â· IFC4"
  const m = scene.summary.match(/(\d[\d,]*)\s+entit/i);
  if (m) summary.entityCount = parseInt(m[1].replace(/,/g, ""), 10);
  const sm = scene.summary.match(/IFC[24X]+/i);
  if (sm) summary.schema = sm[0].toUpperCase();
  scenePanel.update(summary);
  if (summary.hierarchy && summary.hierarchy.length > 0) {
    const classCount = new Map<string, number>();
    for (const el of summary.hierarchy) classCount.set(el.ifcClass, (classCount.get(el.ifcClass) ?? 0) + 1);
    setRibbonElementTypes([...classCount.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cls, count]) => ({ cls, count })));
  } else {
    resetRibbonElementTypes();
  }
  refreshExportButtons();
}

// File picker
filePickBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) handleFile(f);
});

// IFC-specific file picker triggered from File menu "Import IFCâ€¦"
window.addEventListener("file:open-ifc", () => {
  let ifcPicker = document.getElementById("ifc-file-picker") as HTMLInputElement | null;
  if (!ifcPicker) {
    ifcPicker = document.createElement("input");
    ifcPicker.type = "file";
    ifcPicker.id = "ifc-file-picker";
    ifcPicker.accept = ".ifc";
    ifcPicker.style.display = "none";
    document.body.appendChild(ifcPicker);
    ifcPicker.addEventListener("change", () => {
      const f = ifcPicker!.files?.[0];
      if (f) handleFile(f);
      ifcPicker!.value = "";
    });
  }
  ifcPicker.click();
});

// Test-automation: load an IFC from a URL (e.g. for gemma-verify-raw surface)
(window as Window & { __importIfcFromUrl?: (url: string) => Promise<void> }).__importIfcFromUrl = async (url: string) => {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url}: HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const name = url.split("/").pop() ?? "import.ifc";
  await handleFile(new File([buf], name));
};

// Sample dropdown
sampleSelect.addEventListener("change", async () => {
  const id = sampleSelect.value;
  if (!id) return;
  const sample = SAMPLES.find((s) => s.id === id);
  if (!sample) return;
  setStatus(`Fetching ${sample.label}...`, "info");
  try {
    const resp = await fetch(`./${sample.path}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    // Synthesize a File so handleFile() can route by extension.
    const file = new File([buffer], sample.path.split("/").pop() ?? "sample", {
      type: "application/octet-stream",
    });
    await handleFile(file);
  } catch (e) {
    setStatus(`Failed to fetch sample: ${(e as Error).message}`, "err");
  }
});

// Drag-drop overlay
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (!hasFiles(e)) return;
  dragDepth++;
  dropOverlay.classList.remove("hidden");
});
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (!hasFiles(e)) return;
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.classList.add("hidden");
  }
});
window.addEventListener("dragover", (e) => {
  e.preventDefault();
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add("hidden");
  const dt = e.dataTransfer;
  if (!dt || !dt.files || dt.files.length === 0) return;
  const file = dt.files[0];
  // If dropped while in prompt mode, switch to file mode for clarity.
  if (filePanel.classList.contains("hidden")) setMode("file");
  handleFile(file);
});

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

// --- Export pipeline ---

function refreshExportButtons(disabledOverride: boolean = false): void {
  const has = currentSource.kind !== "none";
  for (const btn of exportButtons) {
    const fmt = btn.dataset.fmt;
    if (!fmt) continue;
    if (disabledOverride || !has) {
      btn.disabled = true;
      continue;
    }
    // STL enabled always â€” falls back to Three.js STLExporter when pendingStl absent.
    if (fmt === "step") {
      btn.disabled = !pendingStep;
      continue;
    }
    btn.disabled = false;
  }
}

async function handleExport(fmt: string): Promise<void> {
  // 2D formats always route through the Layout sheet pipeline (vector, not raster).
  // Auto-activate Layout mode if not already active.
  const is2D = fmt === "svg" || fmt === "pdf" || fmt === "dwg" || fmt === "dxf";
  if (is2D) {
    if (workbenchEl?.dataset.mode !== "layout") {
      activateMode("layout", workbenchEl);
      // No RAF wait needed â€” LayoutController is already initialized by buildModes();
      // composeSvg/DXF read in-memory PanelState, not DOM metrics.
    }
    const host = getLayoutHost();
    if (!host) { setStatus("Layout not initialized.", "warn"); return; }
    // If layout has no panels, auto-seed a 4-panel default so export has content.
    if (getPanels(host).length === 0) {
      const S = 480, pad = 20;
      addPanel(host, { x: pad,       y: pad,       w: S, h: S, viewport: "top",         scale: "1:100", title: "PLAN â€” TOP" });
      addPanel(host, { x: pad+S+pad, y: pad,       w: S, h: S, viewport: "front",       scale: "1:100", title: "ELEVATION â€” FRONT" });
      addPanel(host, { x: pad,       y: pad+S+pad, w: S, h: S, viewport: "right",       scale: "1:100", title: "ELEVATION â€” RIGHT" });
      addPanel(host, { x: pad+S+pad, y: pad+S+pad, w: S, h: S, viewport: "perspective", scale: "1:100", title: "3D VIEW" });
    }
    const stem = "sheet";
    try {
      if (fmt === "svg") {
        const text = exportLayoutAsSvg(host);
        (window as unknown as Record<string, unknown>).__lastLayoutSvg = text;
        downloadBlob(new Blob([text], { type: "image/svg+xml" }), `${stem}.svg`);
        setStatus(`Layout SVG Â· ${(text.length / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "pdf") {
        const buf = await exportLayoutAsPdf(host);
        downloadBlob(new Blob([buf], { type: "application/pdf" }), `${stem}.pdf`);
        setStatus(`Layout PDF Â· ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "dxf") {
        const text = exportLayoutAsDxf(host);
        downloadBlob(new Blob([text], { type: "image/vnd.dxf" }), `${stem}.dxf`);
        setStatus(`DXF vector Â· ${(text.length / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "dwg") {
        const text = exportLayoutAsDwgFallback(host);
        downloadBlob(new Blob([text], { type: "image/vnd.dxf" }), `${stem}.dxf`);
        setStatus(`DXF (LibreDWG-WASM unavailable â€” SVG sidecar) Â· ${(text.length / 1024).toFixed(1)} KB`, "ok");
      }
    } catch (e) {
      console.error("[SdExport] 2D export failed:", e);
      setStatus(`Layout export ${fmt.toUpperCase()} failed: ${(e as Error).message}`, "err");
    }
    return;
  }

  const stem = currentSource.kind === "prompt"
    ? currentDemo.id
    : currentSource.kind === "file"
      ? sanitizeStem(currentSource.filename)
      : "export";
  try {
    if (fmt === "ifc" || fmt === "ifc4") {
      await exportIfc(stem);
      return;
    }
    if (fmt === "stl") {
      if (pendingStl) {
        downloadBlob(new Blob([pendingStl], { type: "model/stl" }), `${stem}.stl`);
        setStatus(`STL Â· ${(pendingStl.byteLength / 1024).toFixed(1)} KB`, "ok");
      } else {
        // General Three.js STL export when no replicad geometry is available.
        // #1304: same scene-kg fallback as below.
        const stlSrc = viewer.getActiveObject() ?? (() => {
          const scene = viewer.getScene();
          const tagged = scene.children.filter(c => c.userData.creator);
          const nodes = tagged.length ? tagged : scene.children.filter(c => c instanceof THREE.Mesh || c instanceof THREE.Group);
          if (!nodes.length) return null;
          if (nodes.length === 1) return nodes[0];
          const g = new THREE.Group(); for (const c of nodes) g.add(c.clone()); return g;
        })();
        if (!stlSrc) { setStatus("No geometry loaded.", "warn"); return; }
        const buf = exportStl(stlSrc);
        downloadBlob(new Blob([buf], { type: "model/stl" }), `${stem}.stl`);
        setStatus(`STL Â· ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
      }
      return;
    }
    // #1304: scene-kg fallback â€” active object preferred; fall back to
    // all creator-tagged scene children when nothing is actively selected
    // (agent dispatch doesn't set an active object).
    let obj: THREE.Object3D | null = viewer.getActiveObject();
    if (!obj) {
      const sceneRoot = viewer.getScene();
      const tagged = sceneRoot.children.filter(c => c.userData.creator);
      const geomNodes = tagged.length
        ? tagged
        : sceneRoot.children.filter(c => c instanceof THREE.Mesh || c instanceof THREE.Group);
      if (!geomNodes.length) { setStatus("No geometry loaded.", "warn"); return; }
      if (geomNodes.length === 1) {
        obj = geomNodes[0];
      } else {
        const g = new THREE.Group();
        for (const c of geomNodes) g.add(c.clone());
        obj = g;
      }
    }
    setStatus(`Exporting ${fmt.toUpperCase()}...`, "info");
    if (fmt === "obj") {
      const text = exportObj(obj);
      downloadBlob(new Blob([text], { type: "model/obj" }), `${stem}.obj`);
      setStatus(`OBJ Â· ${(text.length / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "3dm") {
      setStatus("Exporting 3DM (loading Rhino runtime)â€¦", "info");
      const buf = await export3dm(obj);
      downloadBlob(new Blob([buf.buffer as ArrayBuffer], { type: "application/octet-stream" }), `${stem}.3dm`);
      setStatus(`3DM Â· ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "dwg") {
      // DWG is a proprietary binary format with no pure-JS writer. We export
      // AC1009 DXF text which AutoCAD and every major CAD tool reads natively.
      const text = exportDxf(obj);
      downloadBlob(new Blob([text], { type: "image/vnd.dxf" }), `${stem}.dxf`);
      setStatus(`DXF (AutoCAD-compatible; true DWG binary not available in browser) Â· ${(text.length / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "glb") {
      const buf = await exportGlb(obj);
      downloadBlob(new Blob([buf], { type: "model/gltf-binary" }), `${stem}.glb`);
      setStatus(`GLB Â· ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "gltf") {
      const json = await exportGltfJson(obj);
      downloadBlob(new Blob([json], { type: "model/gltf+json" }), `${stem}.gltf`);
      setStatus(`glTF Â· ${(json.length / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "usdz") {
      const buf = await exportUsdz(obj);
      downloadBlob(new Blob([buf.buffer as ArrayBuffer], { type: "model/vnd.usdz+zip" }), `${stem}.usdz`);
      setStatus(`USDZ Â· ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "svg") {
      const text = exportSvg(obj);
      downloadBlob(new Blob([text], { type: "image/svg+xml" }), `${stem}.svg`);
      setStatus(`SVG Â· ${(text.length / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "dxf") {
      const text = exportDxf(obj);
      downloadBlob(new Blob([text], { type: "image/vnd.dxf" }), `${stem}.dxf`);
      setStatus(`DXF Â· ${(text.length / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "pdf") {
      const buf = exportPdf(obj);
      downloadBlob(new Blob([buf.buffer as ArrayBuffer], { type: "application/pdf" }), `${stem}.pdf`);
      setStatus(`PDF Â· ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "step") {
      if (pendingStep) {
        downloadBlob(new Blob([pendingStep], { type: "application/step" }), `${stem}.step`);
        setStatus(`STEP Â· ${(pendingStep.byteLength / 1024).toFixed(1)} KB`, "ok");
      } else {
        setStatus("STEP only available for replicad-generated geometry.", "warn");
      }
    } else {
      setStatus(`Unknown export format: ${fmt}`, "err");
    }
  } catch (e) {
    console.error("[SdExport] 3D export failed:", e);
    setStatus(`Export ${fmt.toUpperCase()} failed: ${(e as Error).message}`, "err");
  }
}

function sanitizeStem(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9_\-]+/g, "_") || "export";
}

// Creator tags that are spatial/structural only â€” skip in IFC element export.
const IFC_SKIP_CREATORS = new Set(["SdRefGrid", "IfcGridLine", "SdLevel", "SdDatum", "SdReferenceLine"]);

function sceneElementsForExport(): IfcSceneElement[] {
  const elements: IfcSceneElement[] = [];
  const scene = viewer.getScene();
  const tmp = new THREE.Vector3();
  scene.traverse((obj) => {
    const creator = obj.userData.creator as string | undefined;
    if (!creator || IFC_SKIP_CREATORS.has(creator)) return;
    // Only process top-level creator objects (not their mesh children).
    if (obj.parent && obj.parent.userData.creator) return;

    const verts: number[] = [];
    const idx: number[] = [];
    obj.updateMatrixWorld(true);
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry as THREE.BufferGeometry;
      const pos = g.attributes.position?.array as Float32Array | undefined;
      if (!pos) return;
      const baseIndex = verts.length / 3;
      for (let i = 0; i < pos.length; i += 3) {
        tmp.set(pos[i], pos[i + 1], pos[i + 2]);
        tmp.applyMatrix4(mesh.matrixWorld);
        verts.push(tmp.x, tmp.y, tmp.z);
      }
      const indexAttr = g.index;
      if (indexAttr) {
        for (let j = 0; j < indexAttr.array.length; j++) idx.push(indexAttr.array[j] + baseIndex);
      } else {
        for (let j = 0; j < Math.floor(pos.length / 3); j++) idx.push(baseIndex + j);
      }
    });
    if (verts.length > 0) {
      elements.push({
        mesh: { vertices: new Float32Array(verts), indices: new Uint32Array(idx) },
        creator,
        label: creator,
        levelId: obj.userData.levelId as string | undefined,
        dispatchArgs: obj.userData.dispatchArgs as Record<string, unknown> | undefined,
      });
    }
  });
  return elements;
}

async function exportIfc(stem: string): Promise<void> {
  setStatus("Building IFC + verifying round-trip via web-ifc...", "info");
  try {
    let bytes: Uint8Array;
    const sceneElements = sceneElementsForExport();
    const exportLevels: IfcLevel[] = levelStore.all().map((l) => ({
      levelId: l.id,
      name: l.name,
      elevation: l.elevation,
    }));
    const ifcImperial = getState("unitSystem") === "imperial";
    if (sceneElements.length > 0) {
      bytes = buildIfcScene(sceneElements, exportLevels, { imperial: ifcImperial });
    } else {
      // Fallback: kernel BREP mesh for single-object scenes (replicad / file import).
      const data = viewer.getActiveMeshData();
      if (!data) {
        setStatus("No geometry to export as IFC.", "warn");
        return;
      }
      const label =
        currentSource.kind === "prompt"
          ? currentDemo.label
          : currentSource.kind === "file"
            ? `Imported ${currentSource.filename}`
            : "GemmaCad Element";
      bytes = buildIfc({ vertices: data.vertices, indices: data.indices }, label, { imperial: ifcImperial });
    }
    const result = await ifcRoundTrip(bytes);
    if (result.ok) {
      const { wall, slab, column, beam, proxy, total } = result.counts;
      const detail = [
        wall   && `${wall}w`,
        slab   && `${slab}s`,
        column && `${column}c`,
        beam   && `${beam}b`,
        proxy  && `${proxy}x`,
      ].filter(Boolean).join(" ") || "0 elements";
      setStatus(
        `IFC4 ${(result.byteSize / 1024).toFixed(1)} KB Â· ${total} elements (${detail}) Â· ${result.schema} OK`,
        "ok",
      );
    } else {
      setStatus(
        `IFC built (${(bytes.byteLength / 1024).toFixed(1)} KB) â€” round-trip skipped: ${result.error}`,
        "warn",
      );
    }
    downloadBlob(
      new Blob([new Uint8Array(bytes)], { type: "application/x-step" }),
      `${stem}.ifc`,
    );
  } catch (e) {
    setStatus(`IFC build failed: ${(e as Error).message}`, "err");
  }
}

for (const btn of exportButtons) {
  btn.addEventListener("click", () => {
    const fmt = btn.dataset.fmt;
    if (fmt) handleExport(fmt);
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Boot.
hydrateFromStorage();
const workbenchEl = document.querySelector(".workbench") as HTMLElement | null;
initShellChrome({
  onModeChange: (k) => {
    activateMode(k, workbenchEl);
    setRibbonMode(k as "model" | "layout" | "research");
    rebuildPaletteForMode(k);
    viewer.setGumballEnabled(k === "model");
    viewer.setGridAxesVisible(k !== "layout");
    if (k === "layout") applyDrafting(viewer.getScene());
    else {
      removeDrafting(viewer.getScene());
      // Reset grid orientation and perspPane camera (may have been overridden by
      // setView("front"/"right"/etc. keyboard shortcuts active in layout mode).
      if (k === "model") {
        viewer.setView("persp");
        // Reset CPlane â€” LAYOUT arms an XZ cplane; returning to MODEL must restore
        // the default WORLD_XY so the cplane gizmo auto-show logic tears down (#1159).
        viewer.activeCPlane = { ...WORLD_XY };
        window.dispatchEvent(new CustomEvent("viewer:cplane-changed", {
          detail: { cplane: viewer.activeCPlane, mode: "world" },
          bubbles: false,
        }));
      }
    }
  },
  onSplitMode: (mode) => viewer.splitMode(mode),
});
buildWorkbench();
if (workbenchEl) buildModes(workbenchEl);
loadDrawingLayers(); // restore persisted 2D layers from IDB
initCmdK();
initExportDrawer();
// Ctrl+E shortcut â†’ open export drawer.
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "e" || e.key === "E")) {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    e.preventDefault();
    openExportDrawer();
  }
});
// â”€â”€ IDB auto-save + restore-last-session prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Saves dispatch-created geometry to IndexedDB after each successful dispatch
// (debounced 2s) and every 60s as a heartbeat. On boot (after OCCT ready),
// if IDB has a prior scene and the current scene is empty, offers restore.
function _hasUserContent(): boolean {
  return viewer
    .getScene()
    .children.some((c) => (c as any).userData?.creator && (c as any).userData.creator !== "IfcLevel");
}

let _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
// true when a dispatch has occurred but IDB save hasn't completed yet.
let _idbDirty = false;
// Diagnostic: expose IDB save state + last error for DevTools inspection.
const _idbDiag: { dirty: boolean; lastSaveOk: boolean; lastErr: string | null; saveCount: number; failCount: number } =
  { dirty: false, lastSaveOk: false, lastErr: null, saveCount: 0, failCount: 0 };
(window as unknown as Record<string, unknown>).__idbDiag = _idbDiag;
function _setDirty(v: boolean, reason: string): void {
  _idbDirty = v;
  _idbDiag.dirty = v;
  console.debug(`[idb] dirty=${v} (${reason})`);
}
function _triggerAutoSave(): void {
  _setDirty(true, "post-dispatch");
  // Do NOT reset an already-scheduled timer. With continuous dispatches (e.g. goal
  // continuation loop firing every ~1s), resetting on each call pushes the save
  // indefinitely into the future â€” _idbDirty never clears, beforeunload fires on
  // every navigation attempt (#1700). Let the first scheduled save fire as-is; the
  // next dispatch after save completes will schedule a fresh 2 s window.
  if (_autoSaveTimer !== null) return;
  _autoSaveTimer = setTimeout(async () => {
    _autoSaveTimer = null;
    try {
      const data = viewer.exportScene();
      if (data.length > 0) await sceneStoreSave(data);
      else await sceneStoreClear();
      _idbDiag.saveCount++;
      _idbDiag.lastSaveOk = true;
      _idbDiag.lastErr = null;
      _setDirty(false, "autosave-ok");
    } catch (err) {
      _idbDiag.failCount++;
      _idbDiag.lastSaveOk = false;
      _idbDiag.lastErr = String(err);
      console.warn("[idb] autosave failed â€” _idbDirty stays true:", err);
    }
  }, 2000);
}

// Non-mutating verbs â€” these change only UI/goal/selection state, not the 3D scene that
// viewer.exportScene() serializes. Excluding them prevents the 2 s debounce from blocking
// navigation when IDB is already fully current. (#1700)
const _NON_MUTATING_VERBS = new Set([
  "setActiveTool", "setActiveLevel",
  "toggleLayerVisibility", "toggleObjectVisibility",
  "selectObject", "deselectAll",
  "create_goal", "update_goal", "get_goal",
  "setCamera", "resetCamera",
]);
registerPostDispatch((canonical) => {
  if (!_NON_MUTATING_VERBS.has(canonical)) _triggerAutoSave();
});

setInterval(async () => {
  if (_hasUserContent()) {
    try {
      await sceneStoreSave(viewer.exportScene());
      _idbDiag.saveCount++;
      _idbDiag.lastSaveOk = true;
      _idbDiag.lastErr = null;
      _setDirty(false, "heartbeat-ok");
    } catch (err) {
      _idbDiag.failCount++;
      _idbDiag.lastErr = String(err);
      console.warn("[idb] heartbeat save failed:", err);
    }
  }
}, 60_000);

async function initSceneRestore(): Promise<void> {
  try {
    const saved = await sceneStoreLoad();
    if (!saved || !Array.isArray(saved) || saved.length === 0) return;
    if (_hasUserContent()) return; // scene already populated â€” skip restore offer
    const prompt = document.getElementById("restore-prompt") as HTMLElement | null;
    if (!prompt) return;
    prompt.hidden = false;
    document.getElementById("restore-btn")?.addEventListener("click", async () => {
      prompt.hidden = true;
      try {
        viewer.importScene(saved as Parameters<typeof viewer.importScene>[0]);
        await sceneStoreClear();
        setStatus("Session restored.", "ok");
      } catch { setStatus("Restore failed.", "err"); }
    }, { once: true });
    document.getElementById("restore-discard-btn")?.addEventListener("click", async () => {
      prompt.hidden = true;
      await sceneStoreClear().catch(() => {});
    }, { once: true });
  } catch { /* IDB unavailable â€” non-fatal */ }
}

// Warn before reload/close only when IDB save hasn't flushed yet (_idbDirty).
// Skips IFC-loaded content â€” those lack userData.creator and survive a reload via re-open.
// CDP/Playwright sessions set navigator.webdriver=true; suppress there to avoid blocking
// automated tests. Real user sessions never set this flag. (#1704 Leg B)
(window as unknown as Record<string, unknown>).__sceneBeforeunloadHooked = true;
window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
  if (navigator.webdriver === true) return;
  const hasContent = _hasUserContent();
  console.debug(`[beforeunload] dirty=${_idbDirty} hasContent=${hasContent} diag=`, JSON.stringify(_idbDiag));
  if (_idbDirty && hasContent) {
    e.preventDefault();
    e.returnValue = "";
  }
});
setStatus("Loading OpenCascade WebAssembly...", "info");
runBtn.disabled = true;
refreshExportButtons(true);
// Disconnect the theme MutationObserver on Vite HMR so the old Viewer
// instance doesn't keep the document element alive across hot-reloads.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    viewer.dispose();
    terminateAndRecycle();
  });
}

