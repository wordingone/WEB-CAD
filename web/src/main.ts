import { assertCrossOriginIsolated } from "./agent/wasm-backend";
assertCrossOriginIsolated();

import { initShellChrome, setRibbonMode } from "./shell/shell";
import { buildWorkbench, rebuildPaletteForMode } from "./shell/workbench";
import { buildModes, activateMode } from "./shell/modes";
import { initCmdK } from "./ui/cmdk";
import { initExportDrawer } from "./io/export-drawer";
import { Viewer } from "./viewer/viewer";
import { ScenePanel } from "./scene/scene-panel";
import { applyDrafting, removeDrafting } from "./geometry/drafting";
import { resetSheetCut } from "./shell/layout";
import { layerStore } from "./geometry/layers";
import { drawingLayerStore, loadDrawingLayers } from "./geometry/drawing-layers";
import { levelStore } from "./geometry/levels";
import { gridStore } from "./geometry/grids";
import { snapPoint, setStep as snapSetStep, getStep as snapGetStep, getSnapTarget } from "./viewer/snap-state";
import { clearCommandSession, getActiveCommandSession } from "./commands/command-session";
import { runIteration } from "./chat/chat-panel";
import { resolveCPlane, WORLD_XY, type CPlane } from "./viewer/cplane";
import { dispatch, dispatchSync, installDefaultHandlers } from "./commands/dispatch";
import { syncToolActiveClass, syncUnitsToStorage, hydrateFromStorage } from "./app-state";
import { initCreateMode, emitClickWorld } from "./tools/index";
import { initSectionHandles } from "./viewer/section-handles";
import { initClipPlaneHandles } from "./viewer/clip-plane-handles";
import { initWallHeightHandle } from "./viewer/wall-height-handle";
import { initRenderModes } from "./viewer/render-modes";
import { getSelected, setSelected } from "./viewer/selection-state";
import { syncLevelOpacities } from "./handlers/datum";
import { updateLevelSprite } from "./tools/structural";
import * as THREE from "three";
import { registerAllHandlers } from "./register-handlers";
import { initDomEvents } from "./dom-events";
import { initWasmKernel, wasmBooleanBackend } from "./nurbs/wasm-boolean-backend";
import { registerBackend, resolveBackend } from "./nurbs/brep-boolean";
(window as unknown as { __booleanBackendId: () => string | null }).__booleanBackendId = () => {
  const b = resolveBackend();
  return "code" in b ? null : b.id;
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>("viewer-canvas");
const viewportAreaEl = document.getElementById("viewport-area-host") as HTMLElement;
const scenePanelEl = $<HTMLElement>("scene-panel");

const viewer = new Viewer(canvas, viewportAreaEl);

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

(window as unknown as { __viewer: Viewer }).__viewer = viewer;
(window as unknown as { __dispatch: typeof dispatch }).__dispatch = dispatch;
(window as unknown as { __dispatchSync: typeof dispatchSync }).__dispatchSync = dispatchSync;
(window as unknown as { __dispatchAsync: typeof dispatch }).__dispatchAsync = dispatch;
(window as unknown as { __clearCommandSession: typeof clearCommandSession }).__clearCommandSession = clearCommandSession;
(window as unknown as { __getActiveCommandSession: typeof getActiveCommandSession }).__getActiveCommandSession = getActiveCommandSession;
(window as unknown as { __gridStore: typeof gridStore }).__gridStore = gridStore;
(window as unknown as { __levelStore: typeof levelStore }).__levelStore = levelStore;
(window as unknown as { __resolveCPlane: typeof resolveCPlane }).__resolveCPlane = resolveCPlane;
(window as unknown as { __getActiveCPlane: () => CPlane }).__getActiveCPlane = () => viewer.activeCPlane;
(window as unknown as { __emitClickWorld: (w: Parameters<typeof emitClickWorld>[1], opts?: Parameters<typeof emitClickWorld>[2]) => ReturnType<typeof emitClickWorld> }).__emitClickWorld = (w, opts) => emitClickWorld(viewer, w, opts);
(window as unknown as { __runIteration: typeof runIteration }).__runIteration = runIteration;
(window as unknown as { __runDesignLoop: (prompt: string) => ReturnType<typeof runIteration> }).__runDesignLoop = (prompt: string) => runIteration(null, null, prompt, []);
(window as unknown as { __snapPoint: typeof snapPoint }).__snapPoint = snapPoint;
(window as unknown as { __snapSetStep: typeof snapSetStep }).__snapSetStep = snapSetStep;
(window as unknown as { __snapGetStep: typeof snapGetStep }).__snapGetStep = snapGetStep;
(window as unknown as { __getSnapTarget: typeof getSnapTarget }).__getSnapTarget = getSnapTarget;
(window as unknown as { __projectToScreen: (x: number, y: number, z?: number) => { x: number; y: number } | null }).__projectToScreen = (x, y, z = 0) => {
  const c = viewer.getCanvas();
  const rect = c.getBoundingClientRect();
  const camera = viewer.getCamera();
  const v = new THREE.Vector3(x, y, z).project(camera as THREE.PerspectiveCamera);
  if (v.z > 1) return null;
  return { x: (v.x * 0.5 + 0.5) * rect.width + rect.left, y: (-v.y * 0.5 + 0.5) * rect.height + rect.top };
};
(window as unknown as { __notifyParityChanged: (detail: unknown) => void }).__notifyParityChanged = (detail) => {
  document.dispatchEvent(new CustomEvent("viewer:parity-changed", { detail }));
};
(window as unknown as { __setSelected: typeof setSelected }).__setSelected = setSelected;
(window as unknown as { __getSelected: typeof getSelected }).__getSelected = getSelected;

initRenderModes(viewer);
syncToolActiveClass();
syncUnitsToStorage();
initCreateMode(viewer);
initSectionHandles(viewer, viewportAreaEl);
initClipPlaneHandles(viewer, viewportAreaEl);
initWallHeightHandle(viewer, viewportAreaEl);

const scenePanel = new ScenePanel(scenePanelEl, viewer);

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

registerAllHandlers(viewer, scenePanel);
installDefaultHandlers();

// CDP sidecar entry — exposes validated dispatch to webcad-mcp.mjs via Runtime.evaluate.
// Read-only shim; no logic, no behavior change. See tools/mcp/webcad-mcp.mjs.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__wcDispatch =
    async (verb: string, args: Record<string, unknown>) =>
      JSON.stringify(await dispatch(verb, args));
}

// Boot WASM geometry kernel (async, non-blocking). Once loaded, wasmBooleanBackend
// (priority 20) supersedes NurbsBooleanBackend (priority 10) for SdBoolean* ops.
initWasmKernel().then(() => {
  registerBackend(wasmBooleanBackend);
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__kernWasmReady = true;
    window.dispatchEvent(new CustomEvent('kern:wasm-ready'));
  }
}).catch(() => {
  // kern.wasm absent or failed — NurbsBooleanBackend remains active.
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__kernWasmReady = false;
  }
});

const { dispose: disposeWorker } = initDomEvents(viewer, scenePanel);

// ── Boot ──────────────────────────────────────────────────────────────────
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
      resetSheetCut(viewer);
      if (k === "model") {
        viewer.setView("persp");
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
loadDrawingLayers();
initCmdK();
initExportDrawer();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    viewer.dispose();
    disposeWorker();
  });
}
