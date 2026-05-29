// Three.js viewer for replicad meshes.
//
// Receives a flat-array mesh from the worker, builds a BufferGeometry,
// and frames the camera on the result. Scissor-per-pane render loop
// supports single and quad viewport layouts. OrbitControls are per-pane.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { axesGizmoSVG } from "../ui/icons.js";
import { getState, subscribe } from "../app-state.js";
import {
  setSelected,
  clearSelected,
  clearMultiSelected,
  addToMultiSelected,
  getMultiSelected,
  topologyForObject,
  topologyAllowed,
  type Selection,
} from "./selection-state.js";
import { emitChainFragment } from "./transforms.js";
import { getSnap, subscribeSnap } from "./snap-state.js";
import { showHandlesFor, clearHandles, isSubObjectHandle, getHandles, getHandleParent, refitParentGeometry } from "./sub-object-handles.js";
import { getCurrentDispatchCtx } from "../commands/dispatch.js";
import { WORLD_XY, resolveCPlane, type CPlane } from "./cplane.js";
import { CPlaneGizmo } from "./cplane-gizmo.js";
import { pushAction, pushDeleteAction, pushReplaceAction, pushTransformAction, pushCustomAction, captureTransform, beginTransaction, endTransaction, type TransformSnapshot } from "../history.js";
import { dissolveGroupForMesh, isOpening, nearestGroupMember, onElementCommitted, rerecutVoid, rehostVoidCut, restoreVoidCut } from "../tools/join-groups.js";
import { resetWallCorners, recomputeWallEndpoints, attemptWallCornerJoins } from "../tools/wall-corners.js";
import { ClipFillManager } from "./clip-fill.js";
import { getLayerForCreator } from "../geometry/layers.js";
import { drawingLayerStore } from "../geometry/drawing-layers.js";
import type { ClassifiedEdgeSeg } from "./edge-classifier.js";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
  type CanonicalGeometry,
  type CanonicalGeometryStore,
} from "../geometry/canonical-geometry.js";
import { objectFromCanonicalGeometry } from "../geometry/canonical-display.js";
import {
  inspectCanonicalClipping,
  inspectCanonicalGeometry,
  type CanonicalClippingSnapshot,
  type CanonicalGeometrySnapshot,
} from "../geometry/canonical-introspection.js";
export type { ClassifiedEdgeSeg } from "./edge-classifier.js";
export { LINEWEIGHT, DASH_PATTERN, DXF_LWEIGHT, DXF_LINETYPE } from "./edge-classifier.js";

import * as Sections from "./viewer-sections.js";
import * as Camera from "./viewer-camera.js";
import * as Rendering from "./viewer-rendering.js";
import * as Gizmos from "./viewer-gizmos.js";
import * as GizmoInput from "./viewer-gizmo-input.js";
import * as Scene from "./viewer-scene.js";

export type ViewName = "top" | "persp" | "front" | "right";

/** Projected face polygon for 2D vector export fills (#1803). */
export type ExportFacePoly = {
  pts: [[number, number], [number, number], [number, number]];
  fill: string;
};
export type Pane = {
  id: string;
  view: ViewName;
  el: HTMLElement;
  body: HTMLElement;
  camera: THREE.Camera;
  controls: OrbitControls;
  /** Last pixel dimensions at which this pane was actually rendered. Persists when the MODEL tab is hidden so renderThumbnailTo can compute a stable scale reference without relying on camera.aspect (which is only updated on browser-window resize). */
  lastRenderedW: number;
  lastRenderedH: number;
};

export type MeshIn = {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

export type Bounds = {
  min: [number, number, number];
  max: [number, number, number];
};

// ── §B-mesh (#990): GPU resource disposal helpers ─────────────────────────────
// Called when an object is removed from the scene and will NOT be re-added via
// undo (i.e. removeObject() path — bypasses the undo stack by design).
// deleteSelected() intentionally skips these — clearHistory() handles that path.

function _disposeMaterial(mat: THREE.Material): void {
  for (const k of ["map", "normalMap", "roughnessMap", "aoMap", "emissiveMap"] as const) {
    (mat as unknown as Record<string, { dispose?: () => void }>)[k]?.dispose?.();
  }
  mat.dispose();
}

export function disposeMeshTree(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const m = child as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material;
    if (!mat) return;
    if (Array.isArray(mat)) (mat as THREE.Material[]).forEach(_disposeMaterial);
    else _disposeMaterial(mat as THREE.Material);
  });
}

export class Viewer {
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls | null = null;
  panes: Pane[] = [];
  currentMesh: THREE.Mesh | null = null;
  currentEdges: THREE.LineSegments | null = null;
  currentObject: THREE.Object3D | null = null;
  grid: THREE.GridHelper;
  _workingPlaneZ = 0;
  axes: THREE.AxesHelper;
  axisLabels: THREE.Sprite[] = [];
  currentBounds: Bounds | null = null;
  raycaster: THREE.Raycaster;
  // Rhino-style Gumball — three TransformControls instances on the same
  // selection at once: translate arrows + rotation rings + scale boxes all
  // visible. Each only raycasts its own handle group, so clicks disambiguate
  // by which handle the pointer hits. Gumball mode hotkeys (G/R/S) and the
  // palette Move/Rotate/Scale buttons are no longer required for switching.
  gizmos: TransformControls[] = [];
  private gizmoCaptured: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 } | null = null;
  _gumballEnabled = true;
  _opToolActive = false;
  // Pivot proxy — Rhino "relocate gumball" needs the gumball pose to be
  // separable from the geometry pose. The three TransformControls always
  // attach to this proxy, never directly to the geometry. The proxy's
  // matrix is computed each frame as targetObject.matrix * pivotOffset.
  // In normal mode, dragging the proxy is mirrored as a world-space delta
  // applied to targetObject (so geometry follows). In relocate mode,
  // dragging only updates pivotOffset — geometry stays put.
  pivotProxy: THREE.Object3D | null = null;
  pivotOffset: THREE.Matrix4 = new THREE.Matrix4();
  // Per-object pivot offset cache. Survives deselect → reselect cycles so a
  // user-relocated gumball returns to where the user put it on the last
  // visit, not back to the geometry origin.
  pivotOffsetByUuid: Map<string, THREE.Matrix4> = new Map();
  targetObject: THREE.Object3D | null = null;
  pivotMatrixBeforeDrag: THREE.Matrix4 = new THREE.Matrix4();
  targetMatrixBeforeDrag: THREE.Matrix4 = new THREE.Matrix4();
  // Multi-select: all selected objects. When length > 1, the gumball pivot
  // sits at their centroid and objectChange applies the delta to each.
  multiTargets: THREE.Object3D[] = [];
  multiTargetMatricesBeforeDrag: THREE.Matrix4[] = [];
  relocateBadge: HTMLElement | null = null;
  private _themeObserver: MutationObserver | null = null;
  // Cursor-follow relocate: when active, normal gumball drag is disabled
  // and pointer-move updates the pivot directly until the user clicks to
  // exit. Mode + axis are captured at the dblclick that entered the mode.
  relocate: {
    active: boolean;
    mode: "translate" | "rotate" | "scale";
    axis: string;
    pivotStart: THREE.Matrix4;
    cursorStart: THREE.Vector3;
    pane: Pane | null;
  } = {
    active: false,
    mode: "translate",
    axis: "",
    pivotStart: new THREE.Matrix4(),
    cursorStart: new THREE.Vector3(),
    pane: null,
  };
  lastHover: { mode: "translate" | "rotate" | "scale"; axis: string; ts: number } | null = null;
  lastClickTs: number = 0;
  lastClickPos: { x: number; y: number } = { x: 0, y: 0 };
  dblclickPivotStart: THREE.Matrix4 = new THREE.Matrix4();
  dblclickTargetStart: THREE.Matrix4 = new THREE.Matrix4();
  _orthoViewCamera: THREE.OrthographicCamera | null = null;
  scaleArmFactor: { X: number; Y: number; Z: number } = { X: 1, Y: 1, Z: 1 };
  scaleArmRefs: Map<"X" | "Y" | "Z", { cubes: Array<{ mesh: THREE.Mesh; sign: number }>; pickers: Array<{ mesh: THREE.Mesh; sign: number }> }> = new Map();
  scaleArmStartLength: number = 1;
  snapCandidates: THREE.Vector3[] = [];
  snapEdges: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = [];
  snapHysteresis = false;
  snapMarker: THREE.Mesh | null = null;
  _thumbCanvas: HTMLCanvasElement | null = null;
  _thumbRenderer: THREE.WebGLRenderer | null = null;
  _thumbMatWireframe: THREE.MeshBasicMaterial | null = null;
  _thumbMatGhosted: THREE.MeshBasicMaterial | null = null;
  subTargetObject: THREE.Object3D | null = null;
  private subSelectionHighlights: THREE.Object3D[] = [];
  private subSelectionHover: THREE.Object3D | null = null;
  _isolatedUuid: string | null = null;
  _preIsolationVisible: Map<string, boolean> = new Map();
  _sectionPlanes: THREE.Plane[] = [];
  _clipPlanes: THREE.Plane[] = [];
  _clipLabels: Map<string, THREE.Plane> = new Map();
  _clipFill = new ClipFillManager();
  _fillMode = "shaded";
  // Construction plane (W-1). Updated by setView(); overridden by SdSetCPlane (W-4).
  activeView:   string = "persp";
  activeCPlane: CPlane = WORLD_XY;
  private canonicalGeometryStore: CanonicalGeometryStore = createCanonicalGeometryStore();
  // CPlane gizmo (#361) — grid + axis lines rendered at the active construction plane.
  _cplaneGizmo: CPlaneGizmo = new CPlaneGizmo();
  // W-6 host-pick (#343): when set, the next canvas click picks a face and derives a CPlane from its normal.
  private _hostPickCallback: ((cplane: CPlane) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, viewportAreaEl: HTMLElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = false;
    this.renderer.autoClear = false;
    this._applyClearColor();
    // Re-sync clear color when theme toggles (data-mode attribute changes).
    this._themeObserver = new MutationObserver(() => this._applyClearColor());
    this._themeObserver.observe(document.documentElement, {
      attributes: true, attributeFilter: ["data-mode"],
    });
    // Track render mode for fill color (shaded→gray, technical→black, wireframe→dark-gray).
    window.addEventListener("render-mode-changed", (e) => {
      const detail = (e as CustomEvent).detail as { mode: string };
      this._fillMode = detail.mode;
      this._clipFill.updateColor(detail.mode);
      // Technical mode adds LineSegments overlays via applyDrafting; re-apply so
      // those new overlays get the active clip planes (Sub-bug 4 fix).
      if (this._sectionPlanes.length > 0 || this._clipPlanes.length > 0) {
        this._applyClippingPlanes();
      }
    });

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(8, 8, 8);
    this.camera.up.set(0, 0, 1);

    // Lights — keyfill + rim for shape readability without shadows.
    const ambient = new THREE.AmbientLight(0xffffff, 0.45);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(10, 10, 12);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x99ccff, 0.35);
    fill.position.set(-8, -6, 4);
    this.scene.add(fill);

    // Reference grid + axes — lighter lineweight so drawn geometry reads over it.
    // Divisions derive from snap step so visible lines coincide with snap targets
    // from the first frame; rebuildGrid uses the same formula on snap changes.
    const initSize = 20;
    const initStep = Math.max(0.001, getSnap().step);
    // Round to next even number so center line (x=0) is always a grid line.
    const _initRaw = Math.min(500, Math.max(4, Math.round(initSize / initStep)));
    const initDivs = _initRaw % 2 === 0 ? _initRaw : _initRaw + 1;
    const initGridSize = initDivs * initStep; // exact multiple of step → lines land on snap targets
    this.grid = new THREE.GridHelper(initGridSize, initDivs, 0xa8a8b0, 0xd8d4cc);
    (this.grid as unknown as { __lastSize?: number }).__lastSize = initSize;
    this.grid.rotation.x = Math.PI / 2;
    this.grid.renderOrder = -1;
    const gridMat = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material];
    for (const m of gridMat) {
      const lm = m as THREE.LineBasicMaterial;
      lm.depthWrite = false;
      lm.transparent = true;
      lm.opacity = 0.55;
      lm.needsUpdate = true;
    }
    this.grid.userData.noSnap = true;
    this.grid.userData.noRenderMode = true;
    this.scene.add(this.grid);

    // CPlane gizmo (#361) — subscribe to cplane-changed, update on each event.
    this.scene.add(this._cplaneGizmo.group);
    window.addEventListener("viewer:cplane-changed", (e) => {
      const cplane = (e as CustomEvent).detail?.cplane as CPlane | undefined;
      if (cplane) this._cplaneGizmo.update(cplane);
    });

    // Layer panel child-row click → programmatic selection by UUID.
    window.addEventListener("viewer:select-uuid", (e) => {
      const uuid = (e as CustomEvent).detail?.uuid as string | undefined;
      if (!uuid) return;
      const obj = this.scene.getObjectByProperty("uuid", uuid) ?? null;
      this.selectObject(obj);
      if (obj) {
        setSelected({
          topology: topologyForObject(obj, this.getCanonicalGeometryForObject(obj)?.kind),
          uuid: obj.uuid,
          object: obj,
          transformTarget: obj,
        });
        window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: obj.uuid } }));
      } else {
        clearSelected();
        window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
      }
    });

    this.axes = new THREE.AxesHelper(2);
    this.axes.userData.noSnap = true;
    this.axes.userData.noRenderMode = true;
    this.scene.add(this.axes);
    this.createAxisLabels();

    // Build per-pane cameras and controls from DOM.
    viewportAreaEl.querySelectorAll<HTMLElement>(".viewport[data-view]").forEach((el, idx) => {
      const view = el.dataset.view as ViewName;
      const body = el.querySelector<HTMLElement>(".vp-body") ?? el;
      let camera: THREE.Camera;
      if (view === "persp") {
        camera = this.camera;
      } else {
        const half = 5;
        camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, 1000);
      }
      switch (view) {
        case "top":   camera.position.set(0, 0, 50);  camera.up.set(0, 1, 0); break;
        case "front": camera.position.set(0, -50, 0); camera.up.set(0, 0, 1); break;
        case "right": camera.position.set(50, 0, 0);  camera.up.set(0, 0, 1); break;
        case "persp": break;
      }
      camera.lookAt(0, 0, 0);
      const controls = new OrbitControls(camera, body);
      controls.enableDamping = true;
      controls.dampingFactor = 0.1;
      if (camera instanceof THREE.OrthographicCamera) controls.screenSpacePanning = true;
      body.addEventListener("contextmenu", (e) => e.preventDefault());
      this.panes.push({ id: el.id, view, el, body, camera, controls, lastRenderedW: 0, lastRenderedH: 0 });

      const axesDiv = document.getElementById(`vp-axes-${idx + 1}`);
      if (axesDiv) axesDiv.innerHTML = axesGizmoSVG();
    });

    // Keep backward-compat controls reference pointing at persp pane.
    const perspPane = this.panes.find(p => p.view === "persp");
    if (perspPane) this.controls = perspPane.controls;

    this.handleResize();
    window.addEventListener("resize", () => this.handleResize());
    // Defense-in-depth: catch layout-driven canvas size changes (e.g. sidebar
    // tab switches that grow/shrink the workbench row) that don't fire window.resize.
    new ResizeObserver(() => this.handleResize()).observe(this.canvas);

    // Raycaster for object picking. The canvas has CSS pointer-events:none
    // (lets clicks fall through to the per-pane .vp-body which hosts the
    // OrbitControls), so binding to canvas never fires. Bind to the parent
    // viewport-area-host instead — events bubble up there from .vp-body.
    //
    // Use pointerdown not mousedown: OrbitControls (three 0.162) calls
    // event.preventDefault() inside its pointerdown handler when state
    // becomes ROTATE/PAN/DOLLY, which suppresses the corresponding
    // compatibility mousedown event entirely. Pointerdown listeners stack
    // — preventDefault on the same pointerdown does NOT stop other
    // pointerdown listeners on the same event.
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 0.15;
    this.raycaster.params.Points.threshold = 0.2;
    viewportAreaEl.addEventListener("pointerdown", (e: PointerEvent) => this.onCanvasMouseDown(e));

    if (perspPane && perspPane.camera instanceof THREE.PerspectiveCamera) {
      this.pivotProxy = new THREE.Object3D();
      this.pivotProxy.userData.noSnap = true;
      this.pivotProxy.userData.noRenderMode = true;
      this.scene.add(this.pivotProxy);
      Gizmos.buildGizmos(this, perspPane);
      GizmoInput.registerGumballListeners(this, perspPane);
    }

    // Palette Move/Rotate/Scale + G/R/S hotkeys are still wired in app-state
    // but no longer toggle a single gizmo mode (all three modes visible at
    // all times in the Rhino-style Gumball). The activeTool subscription
    // intentionally goes nowhere on the viewer side now — palette selection
    // still affects sketch tools (Wall/Slab/Line/etc.) via tools/index.ts.
    subscribe("activeTool", () => { /* no-op for gumball; tools/index.ts owns sketch tools */ });

    // Del / Backspace removes the selected object. Operates on
    // targetObject (the geometry) rather than gizmo.object (the pivot
    // proxy) since the gumball is always attached to the proxy.
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if (this.gizmos.length === 0 || document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
      // ESC: sub-object → parent → none (Rhino sub-object model)
      if (e.key === "Escape") {
        if (this.subTargetObject) {
          this.clearSubSelection();
          e.preventDefault();
          return;
        }
        if (this.targetObject) {
          this.selectObject(null);
          clearSelected();
          window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
          e.preventDefault();
          return;
        }
      }
      if (e.key === "f" || e.key === "F") {
        this.frameAllVisible();
        e.preventDefault();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // Ignore Delete while in sub-object mode — ESC back to parent first.
        if (this.subTargetObject) return;
        // deleteSelected() handles both direct scene children and IFC sub-meshes
        // (children of the IFC wrapper Group, not direct scene children).
        this.deleteSelected();
      }
    });

    // Floating badge in the persp pane that flips visible/hidden when
    // relocate mode toggles. Inserted into viewport-area-host so it
    // sits above the canvas without disturbing the workbench layout.
    this.relocateBadge = document.createElement("div");
    this.relocateBadge.className = "relocate-badge";
    this.relocateBadge.textContent = "RELOCATE GUMBALL";
    this.relocateBadge.style.display = "none";
    viewportAreaEl.appendChild(this.relocateBadge);

    // Rebuild the grid whenever the snap step changes so the visible grid
    // lines match the snap increment exactly. Without this, dragging snaps
    // to a step that has no visible reference and looks wrong.
    subscribeSnap(() => this.rebuildGrid());
    // Sync initial grid to the snap step that was set before this constructor
    // ran (e.g. imperial 0.3048 m from PR #799 unitSystem init in snap-state.ts).
    this.rebuildGrid();

    this.animate();
  }

  private rebuildGrid(): void { Rendering.rebuildGridHelper(this); }
  private _applyClearColor(): void { Rendering.applyClearColor(this); }

  private handleResize(): void { Camera.handleResize(this); }

  private visibleHit(hit: THREE.Intersection): boolean {
    let o: THREE.Object3D | null = hit.object;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    const dlId = hit.object.userData.drawingLayerId as string | undefined;
    if (dlId) {
      const dl = drawingLayerStore.get(dlId);
      if (dl && (!dl.visible || dl.locked)) return false;
    }
    return true;
  }

  private getCanonicalBrepOwner(obj: THREE.Object3D | null | undefined): { owner: THREE.Object3D; record: CanonicalGeometry & { kind: "brep" } } | null {
    let current: THREE.Object3D | null | undefined = obj;
    while (current) {
      const record = this.canonicalGeometryStore.resolveObject(current);
      if (record?.kind === "brep") return { owner: current, record };
      current = current.parent;
    }
    return null;
  }

  private pointToWorld(owner: THREE.Object3D, point: { x: number; y: number; z: number }): THREE.Vector3 {
    return new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(owner.matrixWorld);
  }

  private subObjectPickTolerance(ray: THREE.Ray): number {
    const cameraPos = this.getActiveCamera().getWorldPosition(new THREE.Vector3());
    const atRay = ray.at(1, new THREE.Vector3());
    return Math.max(0.05, Math.min(0.3, cameraPos.distanceTo(atRay) * 0.01));
  }

  private candidateBrepMeshes(hits: THREE.Intersection[]): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      if (!this.visibleHit(hit)) continue;
      if (!(hit.object instanceof THREE.Mesh)) continue;
      if (!this.getCanonicalBrepOwner(hit.object)) continue;
      if (seen.has(hit.object.uuid)) continue;
      seen.add(hit.object.uuid);
      meshes.push(hit.object);
    }
    return meshes;
  }

  private visibleSceneBrepMeshes(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    this.scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (!this.getCanonicalBrepOwner(obj)) return;
      let current: THREE.Object3D | null = obj;
      while (current) {
        if (!current.visible) return;
        current = current.parent;
      }
      meshes.push(obj);
    });
    return meshes;
  }

  private meshVertexWorld(mesh: THREE.Mesh, index: number): THREE.Vector3 | null {
    const pos = mesh.geometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos || index < 0 || index >= pos.count) return null;
    return new THREE.Vector3(pos.getX(index), pos.getY(index), pos.getZ(index)).applyMatrix4(mesh.matrixWorld);
  }

  private pickBrepDisplayVertex(ray: THREE.Ray, meshes: THREE.Mesh[]): Selection | null {
    if (!topologyAllowed("vertex")) return null;
    const threshold = this.subObjectPickTolerance(ray);
    let best: { distance: number; mesh: THREE.Mesh; owner: THREE.Object3D; vertexIndex: number } | null = null;
    for (const mesh of meshes) {
      const owner = this.getCanonicalBrepOwner(mesh)?.owner;
      const pos = mesh.geometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (!owner || !pos) continue;
      const seen = new Set<string>();
      for (let i = 0; i < pos.count; i++) {
        const worldPoint = this.meshVertexWorld(mesh, i);
        if (!worldPoint) continue;
        const key = `${worldPoint.x.toFixed(6)},${worldPoint.y.toFixed(6)},${worldPoint.z.toFixed(6)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const distance = ray.distanceToPoint(worldPoint);
        if (distance <= threshold && (!best || distance < best.distance)) {
          best = { distance, mesh, owner, vertexIndex: i };
        }
      }
    }
    if (!best) return null;
    return {
      topology: "vertex",
      uuid: best.mesh.uuid,
      object: best.mesh,
      parent: best.owner,
      parentUuid: best.owner.uuid,
      vertexIndex: best.vertexIndex,
      transformTarget: best.owner,
    };
  }

  private groupedBoundaryEdges(mesh: THREE.Mesh): Array<[number, number, number]> {
    const geometry = mesh.geometry;
    const pos = geometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!geometry || !pos) return [];
    const index = geometry.getIndex();
    const groups = geometry.groups.length > 0
      ? geometry.groups
      : [{ start: 0, count: index ? index.count : pos.count, materialIndex: 0 }];
    const edges: Array<[number, number, number]> = [];
    for (const group of groups) {
      const counts = new Map<string, { a: number; b: number; count: number }>();
      const readIndex = (i: number) => index ? index.getX(i) : i;
      for (let i = group.start; i + 2 < group.start + group.count; i += 3) {
        const tri = [readIndex(i), readIndex(i + 1), readIndex(i + 2)];
        for (const [a0, b0] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
          const a = Math.min(a0, b0);
          const b = Math.max(a0, b0);
          const key = `${a}:${b}`;
          const prev = counts.get(key);
          if (prev) prev.count++;
          else counts.set(key, { a, b, count: 1 });
        }
      }
      for (const edge of counts.values()) {
        if (edge.count === 1) edges.push([edge.a, edge.b, group.materialIndex ?? 0]);
      }
    }
    return edges;
  }

  private pickBrepDisplayEdge(ray: THREE.Ray, meshes: THREE.Mesh[]): Selection | null {
    if (!topologyAllowed("edge")) return null;
    const thresholdSq = this.subObjectPickTolerance(ray) ** 2;
    let best: { distanceSq: number; mesh: THREE.Mesh; owner: THREE.Object3D; edgeIndex: number } | null = null;
    for (const mesh of meshes) {
      const owner = this.getCanonicalBrepOwner(mesh)?.owner;
      if (!owner) continue;
      const edges = this.groupedBoundaryEdges(mesh);
      for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
        const [ia, ib] = edges[edgeIndex];
        const a = this.meshVertexWorld(mesh, ia);
        const b = this.meshVertexWorld(mesh, ib);
        if (!a || !b) continue;
        const distanceSq = ray.distanceSqToSegment(a, b);
        if (distanceSq <= thresholdSq && (!best || distanceSq < best.distanceSq)) {
          best = { distanceSq, mesh, owner, edgeIndex };
        }
      }
    }
    if (!best) return null;
    return {
      topology: "edge",
      uuid: best.mesh.uuid,
      object: best.mesh,
      parent: best.owner,
      parentUuid: best.owner.uuid,
      edgeIndex: best.edgeIndex,
      transformTarget: best.owner,
    };
  }

  private pickBrepFace(hits: THREE.Intersection[]): Selection | null {
    if (!topologyAllowed("face")) return null;
    const hit = hits.find((h) => this.visibleHit(h) && this.getCanonicalBrepOwner(h.object));
    if (!hit) return null;
    const owner = this.getCanonicalBrepOwner(hit.object)?.owner;
    if (!owner) return null;
    const geometry = (hit.object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    let faceIndex = hit.faceIndex ?? 0;
    if (geometry?.groups?.length) {
      const triStart = faceIndex * 3;
      const groupIndex = geometry.groups.findIndex((group) => triStart >= group.start && triStart < group.start + group.count);
      if (groupIndex >= 0) faceIndex = groupIndex;
    }
    return {
      topology: "face",
      uuid: hit.object.uuid,
      object: hit.object,
      parent: owner,
      parentUuid: owner.uuid,
      faceIndex,
      transformTarget: owner,
    };
  }

  private pickBrepSubObject(hits: THREE.Intersection[]): Selection | null {
    const meshes = this.candidateBrepMeshes(hits);
    if (meshes.length === 0) meshes.push(...this.visibleSceneBrepMeshes());
    if (meshes.length === 0) return null;
    return (
      this.pickBrepDisplayVertex(this.raycaster.ray, meshes)
      ?? this.pickBrepDisplayEdge(this.raycaster.ray, meshes)
      ?? this.pickBrepFace(hits)
    );
  }

  private disposeSubSelectionOverlay(obj: THREE.Object3D): void {
    this.scene.remove(obj);
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose?.();
    });
  }

  private clearSubSelectionHighlight(): void {
    for (const obj of this.subSelectionHighlights) this.disposeSubSelectionOverlay(obj);
    this.subSelectionHighlights = [];
  }

  public clearSubSelectionHover(): void {
    if (!this.subSelectionHover) return;
    this.disposeSubSelectionOverlay(this.subSelectionHover);
    this.subSelectionHover = null;
  }

  private createSubSelectionOverlay(sel: Selection, opts: { color: number; opacity: number }): THREE.Object3D | null {
    if (!(sel.object instanceof THREE.Mesh)) return null;
    const mesh = sel.object;
    mesh.updateMatrixWorld(true);
    const pos = mesh.geometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return null;
    const applyWorldMatrix = (obj: THREE.Object3D) => {
      obj.matrixAutoUpdate = false;
      obj.matrix.copy(mesh.matrixWorld);
      obj.renderOrder = 999;
      obj.userData.noSnap = true;
      obj.userData.noRenderMode = true;
      obj.userData.brepSubObject = true;
      obj.userData.selectionTopology = sel.topology;
      obj.userData.parentUuid = sel.parentUuid;
      if (sel.faceIndex !== undefined) obj.userData.faceIndex = sel.faceIndex;
      if (sel.edgeIndex !== undefined) obj.userData.edgeIndex = sel.edgeIndex;
      if (sel.vertexIndex !== undefined) obj.userData.vertexIndex = sel.vertexIndex;
      this.scene.add(obj);
      return obj;
    };
    if (sel.topology === "face" && sel.faceIndex !== undefined) {
      const group = mesh.geometry.groups[sel.faceIndex];
      if (!group) return null;
      const srcIndex = mesh.geometry.getIndex();
      const readIndex = (i: number) => srcIndex ? srcIndex.getX(i) : i;
      const positions: number[] = [];
      const indices: number[] = [];
      for (let i = group.start; i + 2 < group.start + group.count; i += 3) {
        const base = positions.length / 3;
        for (const vi of [readIndex(i), readIndex(i + 1), readIndex(i + 2)]) {
          positions.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
        }
        indices.push(base, base + 1, base + 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const mat = new THREE.MeshBasicMaterial({ color: opts.color, transparent: true, opacity: opts.opacity, depthTest: false, side: THREE.DoubleSide });
      return applyWorldMatrix(new THREE.Mesh(geo, mat));
    }
    if (sel.topology === "edge" && sel.edgeIndex !== undefined) {
      const edge = this.groupedBoundaryEdges(mesh)[sel.edgeIndex];
      if (!edge) return null;
      const [ia, ib] = edge;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(pos.getX(ia), pos.getY(ia), pos.getZ(ia)),
        new THREE.Vector3(pos.getX(ib), pos.getY(ib), pos.getZ(ib)),
      ]);
      const mat = new THREE.LineBasicMaterial({ color: opts.color, depthTest: false });
      return applyWorldMatrix(new THREE.Line(geo, mat));
    }
    if (sel.topology === "vertex" && sel.vertexIndex !== undefined) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(pos.getX(sel.vertexIndex), pos.getY(sel.vertexIndex), pos.getZ(sel.vertexIndex)),
      ]);
      const mat = new THREE.PointsMaterial({ color: opts.color, size: 14, sizeAttenuation: false, depthTest: false });
      return applyWorldMatrix(new THREE.Points(geo, mat));
    }
    return null;
  }

  private showSubSelectionHighlight(sel: Selection): void {
    this.clearSubSelectionHighlight();
    const obj = this.createSubSelectionOverlay(sel, { color: 0xffc247, opacity: 0.42 });
    if (obj) this.subSelectionHighlights = [obj];
  }

  private showSubSelectionHighlights(selections: Selection[]): THREE.Object3D[] {
    this.clearSubSelectionHighlight();
    this.subSelectionHighlights = selections
      .map((sel) => this.createSubSelectionOverlay(sel, { color: 0xffc247, opacity: 0.42 }))
      .filter((obj): obj is THREE.Object3D => obj !== null);
    return this.subSelectionHighlights;
  }

  private raycastSceneAt(clientX: number, clientY: number): THREE.Intersection[] | null {
    const hitPane = this.panes.find(p => {
      const r = p.el.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    });
    if (!hitPane) return null;
    const pr = hitPane.el.getBoundingClientRect();
    const ndcX = ((clientX - pr.left) / pr.width) * 2 - 1;
    const ndcY = -((clientY - pr.top) / pr.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), hitPane.camera);
    const gizmoSet = new Set<THREE.Object3D>(this.gizmos);
    const pickables = this.scene.children.filter(
      c => c !== this.grid && c !== this.axes && !(c instanceof THREE.Sprite) &&
           !(c instanceof THREE.DirectionalLight) && !(c instanceof THREE.AmbientLight) &&
           !gizmoSet.has(c) && c !== this.pivotProxy && c !== this._cplaneGizmo.group &&
           c !== this.subSelectionHover && !this.subSelectionHighlights.includes(c)
    );
    return this.raycaster.intersectObjects(pickables, true);
  }

  public previewBrepSubObjectAt(clientX: number, clientY: number): Selection | null {
    const hits = this.raycastSceneAt(clientX, clientY);
    if (!hits) {
      this.clearSubSelectionHover();
      return null;
    }
    const sel = this.pickBrepSubObject(hits);
    this.clearSubSelectionHover();
    if (!sel) return null;
    this.subSelectionHover = this.createSubSelectionOverlay(sel, { color: 0x44aaff, opacity: 0.28 });
    return sel;
  }

  private onCanvasMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    // W-6 host-pick: intercept before all other logic.
    if (this._hostPickCallback) {
      const cb = this._hostPickCallback;
      this._hostPickCallback = null;
      this.canvas.style.cursor = "";
      const cx = e.clientX, cy = e.clientY;
      const hitPane = this.panes.find(p => {
        const r = p.el.getBoundingClientRect();
        return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
      });
      if (hitPane) {
        const pr = hitPane.el.getBoundingClientRect();
        const ndcX = ((cx - pr.left) / pr.width) * 2 - 1;
        const ndcY = -((cy - pr.top) / pr.height) * 2 + 1;
        this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), hitPane.camera);
        const gizmoSet = new Set<THREE.Object3D>(this.gizmos);
        const pickables = this.scene.children.filter(
          c => c !== this.grid && c !== this.axes && !(c instanceof THREE.Sprite) &&
               !(c instanceof THREE.DirectionalLight) && !(c instanceof THREE.AmbientLight) &&
               !gizmoSet.has(c) && c !== this.pivotProxy && c !== this._cplaneGizmo.group
        );
        const hits = this.raycaster.intersectObjects(pickables, true);
        const hit = hits[0];
        if (hit?.face) {
          const worldNormal = hit.face.normal.clone()
            .transformDirection(hit.object.matrixWorld)
            .normalize();
          const up = new THREE.Vector3(0, 0, 1);
          let xAxis = new THREE.Vector3().crossVectors(up, worldNormal);
          if (xAxis.lengthSq() < 1e-6) xAxis.set(1, 0, 0);
          xAxis.normalize();
          const yAxis = new THREE.Vector3().crossVectors(worldNormal, xAxis).normalize();
          const cplane: CPlane = {
            origin: hit.point.clone(),
            xAxis, yAxis,
            normal: worldNormal,
            name: "Host Face",
            kind: "host-derived" as const,
          };
          cb(cplane);
        }
      }
      return;
    }

    const tool = getState("activeTool");
    // move/rotate/scale mousedown just ensures the gizmo mode is set (already
    // wired via subscribe). Picking a new object is "select"-only — other
    // tools should not change the current selection on click.
    if (tool !== "select" && tool !== "move" && tool !== "rotate" && tool !== "scale") return;

    // Identify which pane was clicked by checking which pane rect contains the pointer.
    const cx = e.clientX, cy = e.clientY;
    const hitPane = this.panes.find(p => {
      const r = p.el.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    });
    if (!hitPane) return;

    // Transform tools skip re-picking when something is already selected so
    // OrbitControls/TransformControls own the drag natively. But with nothing
    // selected, fall through to the picker so the user can click to select.
    if ((tool === "move" || tool === "rotate" || tool === "scale") && this.targetObject !== null) return;
    // If an op-tool (extrude, boolean, fillet, …) is active, its vpBody handler
    // takes priority. Skip the selection picker so the gumball doesn't flash on
    // the clicked object before the op-tool handler processes the click.
    if (this._opToolActive) return;
    // If a gumball handle is hovered/active (axis set) or dragging, do not
    // run selection picking on this pointerdown. Otherwise selection updates
    // race with TransformControls pointerdown and break handle drags.
    if (this.gizmos.some((g) => (g as unknown as { axis: string | null }).axis !== null)) return;
    if (this.isAnyGumballDragging()) return;

    const pr = hitPane.el.getBoundingClientRect();
    const ndcX = ((cx - pr.left) / pr.width) * 2 - 1;
    const ndcY = -((cy - pr.top) / pr.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), hitPane.camera);
    const gizmoSet = new Set<THREE.Object3D>(this.gizmos);
    const pickables = this.scene.children.filter(
      c => c !== this.grid && c !== this.axes && !(c instanceof THREE.Sprite) &&
           !(c instanceof THREE.DirectionalLight) && !(c instanceof THREE.AmbientLight) &&
           !gizmoSet.has(c) && c !== this.pivotProxy && c !== this._cplaneGizmo.group &&
           c !== this.subSelectionHover && !this.subSelectionHighlights.includes(c)
    );
    const hits = this.raycaster.intersectObjects(pickables, true);
    // Handles render without depth-test so they must be selectable even when
    // geometrically behind walls. If any handle appears in the hit list (at any
    // depth), prefer it over closer wall hits.
    const handleSet = new Set(getHandles());
    const handleHit = hits.find(h => handleSet.has(h.object) || (h.object.parent !== null && handleSet.has(h.object.parent)));
    // #950: Three.js intersectObjects does not check visibility — filter out objects
    // whose effective visibility is false (hidden level, hidden layer, etc.).
    const visibleHit = hits.find(h => this.visibleHit(h));
    let hit = (handleHit ?? visibleHit)?.object ?? null;
    const drilldown = e.ctrlKey && e.shiftKey;
    if (drilldown && !handleHit) {
      const subSelection = this.pickBrepSubObject(hits);
      if (subSelection) {
        const existing = getMultiSelected();
        if (existing.some((sel) => !sel.parentUuid || !["face", "edge", "vertex"].includes(sel.topology))) {
          clearMultiSelected();
        }
        addToMultiSelected(subSelection);
        const subSelections = getMultiSelected().filter((sel) => sel.parentUuid && ["face", "edge", "vertex"].includes(sel.topology));
        this.showSubSelectionHighlights(subSelections);
        this.clearSubSelectionHover();
        this.selectObject(null);
        setSelected(subSelection);
        window.dispatchEvent(new CustomEvent("viewer:select", {
          detail: {
            uuid: null,
            subObject: true,
            topology: subSelection.topology,
            parentUuid: subSelection.parentUuid,
            faceIndex: subSelection.faceIndex,
            edgeIndex: subSelection.edgeIndex,
            vertexIndex: subSelection.vertexIndex,
            subObjectCount: subSelections.length,
          },
        }));
        return;
      }
    }
    // CSG display mesh hit: redirect selection to the nearest logical member
    // WITHOUT dissolving the group — the join stays intact until the user drags.
    if (hit?.userData?.isJoinDisplay) {
      const groupId = hit.userData.joinGroupId as string | undefined;
      if (groupId) {
        const hitPoint = hits[0]?.point ?? new THREE.Vector3();
        const nearest = nearestGroupMember(groupId, hitPoint, this.scene);
        if (nearest) hit = nearest;
      }
    }
    // IFC-imported meshes carry expressID and represent individual elements —
    // use the hit mesh directly. Other objects: walk to parent group/mesh.
    const isIfcElement = (hit?.userData?.expressID) != null;
    const transformTarget = isIfcElement
      ? hit
      : (hit?.parent instanceof THREE.Mesh || hit?.parent instanceof THREE.Group ? hit.parent : hit);
    const uuid = transformTarget?.uuid ?? null;
    // Sub-object handle click: enter handle-level selection without clearing parent handles.
    if (transformTarget && isSubObjectHandle(transformTarget)) {
      this.clearSubSelectionHover();
      this.clearSubSelectionHighlight();
      this.selectSubObject(transformTarget);
      return;
    }
    if (transformTarget) {
      this.clearSubSelectionHover();
      this.clearSubSelectionHighlight();
      this.selectObject(transformTarget);
      setSelected({
        topology: topologyForObject(transformTarget, this.getCanonicalGeometryForObject(transformTarget)?.kind),
        uuid: transformTarget.uuid,
        object: transformTarget,
        transformTarget,
      });
      window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid } }));
    } else {
      // Defer deselect to pointerup so orbit drags don't clear the gumball.
      const px0 = e.clientX, py0 = e.clientY;
      const host = e.currentTarget as HTMLElement;
      const clearOnUp = (up: PointerEvent) => {
        host.removeEventListener("pointerup", clearOnUp);
        if ((up.clientX - px0) ** 2 + (up.clientY - py0) ** 2 < 64) {
          this.selectObject(null);
          clearSelected();
          this.clearSubSelectionHover();
          this.clearSubSelectionHighlight();
          window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
        }
      };
      host.addEventListener("pointerup", clearOnUp);
    }
  }

  /** Attach the Rhino-style Gumball to an object (null = detach). The
   *  three TransformControls always attach to the pivot proxy, never to
   *  the geometry directly. A genuine selection change (different object)
   *  resets pivotOffset to identity so the gumball recenters on the new
   *  target. Re-selecting the SAME object preserves any prior relocate
   *  offset — otherwise every click after relocate would snap the gumball
   *  back to the centroid. */
  selectObject(obj: THREE.Object3D | null): void { Gizmos.selectObject(this, obj); }

  setMultiTargets(targets: THREE.Object3D[]): void { Gizmos.setMultiTargets(this, targets); }

  getTargetObject(): THREE.Object3D | null { return this.targetObject; }

  deselectCurrent(): void { this.clearSubSelectionHover(); this.clearSubSelectionHighlight(); Gizmos.selectObject(this, null); clearSelected(); window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } })); }

  setGumballEnabled(enabled: boolean): void { Gizmos.setGumballEnabled(this, enabled); }

  selectSubObject(handle: THREE.Object3D): void { Gizmos.selectSubObject(this, handle); }

  clearSubSelection(): void { Gizmos.clearSubSelection(this); }

  deleteSelected(): boolean { return Gizmos.deleteSelected(this); }

  updateRelocateBadge(): void { Gizmos.updateRelocateBadge(this); }

  toggleCPlaneGizmo(): void { this._cplaneGizmo.toggle(); }
  startHostPick(cb: (cplane: CPlane) => void): void { this._hostPickCallback = cb; this.canvas.style.cursor = "crosshair"; }
  cancelHostPick(): void { this._hostPickCallback = null; this.canvas.style.cursor = ""; }
  setOpToolActive(active: boolean): void { this._opToolActive = active; }
  setGridAxesVisible(visible: boolean): void { this.grid.visible = visible; this.axes.visible = visible; this._cplaneGizmo.group.visible = visible; }

  syncPivot(): void { Gizmos.syncPivot(this); }
  isAnyGumballDragging(): boolean { return Gizmos.isAnyGumballDragging(this); }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    Rendering.renderFrame(this);
  };

  clearScene(): void { Scene.clearScene(this); }
  setMesh(mesh: MeshIn, bounds: Bounds): void { Scene.setMesh(this, mesh, bounds); }
  setObject(object: THREE.Object3D, bounds: Bounds): void { Scene.setObject(this, object, bounds); }

  getActiveObject(): THREE.Object3D | null {
    if (this.currentMesh) return this.currentMesh;
    if (this.currentObject) return this.currentObject;
    return null;
  }

  getScene(): THREE.Scene {
    return this.scene;
  }

  getCanonicalGeometryStore(): CanonicalGeometryStore {
    return this.canonicalGeometryStore;
  }

  getCanonicalGeometryForObject(obj: THREE.Object3D): CanonicalGeometry | undefined {
    return this.canonicalGeometryStore.resolveObjectOrAncestor(obj);
  }

  exportCanonicalGeometry(): CanonicalGeometry[] {
    const linked = _collectCanonicalGeometryIds(this.exportScene());
    return this.canonicalGeometryStore.exportRecords().filter((record) => linked.has(record.id));
  }

  importCanonicalGeometry(records: unknown[]): number {
    return this.canonicalGeometryStore.importRecords(records);
  }

  inspectCanonicalGeometry(): CanonicalGeometrySnapshot {
    return inspectCanonicalGeometry(this.canonicalGeometryStore, this.scene.children);
  }

  inspectCanonicalClipping(): CanonicalClippingSnapshot {
    const sectionPlanes = this._sectionPlanes.map((plane, index) => ({
      label: `section-box-${index}`,
      source: "section-box" as const,
      plane,
    }));
    const clipLabels = new Map<THREE.Plane, string>();
    this._clipLabels.forEach((plane, label) => clipLabels.set(plane, label));
    const clipPlanes = this._clipPlanes.map((plane, index) => ({
      label: clipLabels.get(plane) ?? `clip-${index}`,
      source: "clipping-plane" as const,
      plane,
    }));
    return inspectCanonicalClipping(this.canonicalGeometryStore, this.scene.children, [...sectionPlanes, ...clipPlanes]);
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  captureFrame(maxDim = 512): string | null { return Rendering.captureFrameHelper(this, maxDim); }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  // Returns the camera currently active for the main viewport pane.
  // In ortho views this is the OrthographicCamera; in persp it's this.camera.
  getActiveCamera(): THREE.Camera {
    const perspPane = this.panes.find(p => p.view === "persp");
    return perspPane?.camera ?? this.camera;
  }

  raycastForHover(clientX: number, clientY: number): THREE.Object3D | null { return Scene.raycastForHover(this, clientX, clientY); }
  raycastForCreator(clientX: number, clientY: number, validCreators: string[]): THREE.Object3D | null { return Scene.raycastForCreator(this, clientX, clientY, validCreators); }

  // noHistory: true opts out of the automatic undo push. Use for callers that
  // manage their own history entry (SdArray → pushBatchAction).
  addMesh(mesh: THREE.Object3D, _kind?: string, opts?: { noHistory?: boolean }): void {
    const ctx = getCurrentDispatchCtx();
    if (ctx && mesh.userData.dispatchArgs === undefined) {
      mesh.userData.dispatchVerb = ctx.canonical;
      mesh.userData.dispatchArgs = { ...ctx.args };
    }
    if (!mesh.userData.layerId && mesh.userData.creator) {
      mesh.userData.layerId = getLayerForCreator(mesh.userData.creator as string);
    }
    this.scene.add(mesh);
    this._applyActiveClipPlanesToSubtree(mesh);
    if (!opts?.noHistory) {
      pushAction(mesh, (mesh.userData.creator as string | undefined) ?? "object");
    }
    // Rebuild fill when a new solid is added into an active clip zone.
    if (this._sectionPlanes.length > 0 || this._clipPlanes.length > 0) this._rebuildFill();
  }

  /** Walk scene children; callback may mutate visible/material but not add/remove. */
  forEachSceneChild(fn: (obj: THREE.Object3D) => void): void {
    for (const child of this.scene.children) fn(child);
  }

  removeObject(obj: THREE.Object3D): boolean {
    if (!this.scene.children.includes(obj)) return false;
    const clipLabel = obj.userData.clipLabel as string | undefined;
    if (clipLabel) this.removeClippingPlane(clipLabel);
    obj.traverse((child) => {
      const labels = (child.userData as { dimLabelEls?: HTMLElement[] }).dimLabelEls;
      if (labels) labels.forEach((el) => el.remove());
    });
    this.scene.remove(obj);
    disposeMeshTree(obj); // §B-mesh (#990): release GPU geometry + materials
    if (this.currentMesh === obj) this.currentMesh = null;
    if (this.currentEdges === obj) this.currentEdges = null;
    if (this.currentObject === obj) this.currentObject = null;
    return true;
  }

  getActiveMeshData(): { vertices: Float32Array; indices: Uint32Array } | null { return Scene.getActiveMeshData(this); }

  private fitCamera(bounds: Bounds): void { Camera.fitCamera(this, bounds); }
  private createAxisLabels(length = 2): void { Camera.createAxisLabels(this, length); }
  frameObjectOnly(obj: THREE.Object3D): void { Camera.frameObjectOnly(this, obj); }
  isolate(uuid: string): boolean { return Sections.isolate(this, uuid); }
  isolateOff(): void { Sections.isolateOff(this); }
  getIsolatedUuid(): string | null { return Sections.getIsolatedUuid(this); }
  getSceneBounds(): THREE.Box3 | null { return Sections.getSceneBounds(this); }
  setSectionBox(min: [number, number, number], max: [number, number, number], enabled = true): void { Sections.setSectionBox(this, min, max, enabled); }
  clearSectionBox(): void { Sections.clearSectionBox(this); }
  getSectionBox(): { min: [number, number, number]; max: [number, number, number] } | null { return Sections.getSectionBox(this); }
  pushSectionFace(face: '+x' | '-x' | '+y' | '-y' | '+z' | '-z', delta: number): void { Sections.pushSectionFace(this, face, delta); }
  getSectionFacePosition(face: '+x' | '-x' | '+y' | '-y' | '+z' | '-z'): number | null { return Sections.getSectionFacePosition(this, face); }
  addClippingPlane(origin: [number, number, number], normal: [number, number, number], label?: string): void { Sections.addClippingPlane(this, origin, normal, label); }
  clearClippingPlanes(): void { Sections.clearClippingPlanes(this); }
  removeClippingPlane(label: string): boolean { return Sections.removeClippingPlane(this, label); }
  getClippingPlaneCount(): number { return Sections.getClippingPlaneCount(this); }
  getClippingPlanes(): Array<{ label: string; origin: [number, number, number]; normal: [number, number, number] }> { return Sections.getClippingPlanes(this); }
  updateClippingPlane(label: string, mesh: THREE.Mesh): void { Sections.updateClippingPlane(this, label, mesh); }
  getEdgeSegmentsForView(view: ViewName, panelW: number, panelH: number): [number, number, number, number][] { return Rendering.getEdgeSegmentsForView(this, view, panelW, panelH); }
  getFacePolygonsForView(view: ViewName, panelW: number, panelH: number): ExportFacePoly[] { return Rendering.getFacePolygonsForView(this, view, panelW, panelH); }
  getClassifiedEdgeSegmentsForView(view: ViewName, panelW: number, panelH: number): ClassifiedEdgeSeg[] { return Rendering.getClassifiedEdgeSegmentsForView(this, view, panelW, panelH); }
  private _rebuildFill(): void { Sections.rebuildFill(this); }
  private _applyClippingPlanes(): void { Sections.applyClippingPlanes(this); }
  private _applyActiveClipPlanesToSubtree(root: THREE.Object3D): void { Sections.applyActiveClipPlanesToSubtree(this, root); }
  frameAllVisible(): void { Camera.frameAllVisible(this); }
  setView(name: "top" | "bottom" | "front" | "back" | "left" | "right" | "iso" | "extents" | "persp"): void { Camera.setView(this, name); }
  setWorkingPlaneZ(z: number): void { Camera.setWorkingPlaneZ(this, z); }
  setTargetElevation(z: number): void { Camera.setTargetElevation(this, z); }
  splitMode(mode: "single" | "quad"): void { Camera.splitMode(this, mode); }
  createNavControls(view: string, domElement: HTMLElement): { dispose(): void } { return Camera.createNavControls(this, view, domElement); }
  renderThumbnailTo(view: ViewName, dest: HTMLCanvasElement, anchorX = 0, anchorY = 0, snapW = 0, snapH = 0, displayMode?: string): void { Rendering.renderThumbnailTo(this, view, dest, anchorX, anchorY, snapW, snapH, displayMode); }

  exportScene(): SerializedSceneObj[] {
    const infraSet = new Set<THREE.Object3D>([
      this.grid, this.axes, ...this.axisLabels,
      ...(this.pivotProxy ? [this.pivotProxy] : []),
      ...(this.snapMarker ? [this.snapMarker] : []),
      ...this.gizmos,
      this._cplaneGizmo.group,
    ]);
    const out: SerializedSceneObj[] = [];
    for (const child of this.scene.children) {
      if (infraSet.has(child) || child instanceof THREE.Light) continue;
      const s = _serializeSceneObj(child);
      if (s) out.push(s);
    }
    return out;
  }

  importScene(objects: SerializedSceneObj[]): void {
    for (const s of objects) {
      const obj = _deserializeSceneObj(s, this.canonicalGeometryStore);
      if (obj) this.scene.add(obj);
    }
  }

  dispose(): void {
    this._themeObserver?.disconnect();
    this._themeObserver = null;
    this._thumbMatWireframe?.dispose();
    this._thumbMatGhosted?.dispose();
    this._clipFill.dispose(this.scene);
  }
}

// --- Edge-projection helpers (used by getEdgeSegmentsForView) ---
// Implementations live in line-clip.ts (exported for testing).

// --- Scene serialization helpers ---

export type SerializedSceneObj = {
  uuid: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  color?: number;
  geometry?: { position: number[]; normal?: number[]; index?: number[] };
  displaySource?: "canonical" | "serialized-geometry";
  userData: Record<string, unknown>;
  children?: SerializedSceneObj[];
};

function _serializeSceneObj(obj: THREE.Object3D): SerializedSceneObj | null {
  const hasCanonicalLink = typeof obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY] === "string";
  if (obj.userData.creator == null && obj.userData.kind == null && !hasCanonicalLink) return null;
  const userData = { ...obj.userData };
  if (typeof userData[CANONICAL_GEOMETRY_USERDATA_KEY] === "string") {
    delete userData.nurbsSurface;
    delete userData.nurbsCurve;
    delete userData.nurbsCVs;
  }
  const s: SerializedSceneObj = {
    uuid: obj.uuid,
    position: obj.position.toArray() as [number, number, number],
    quaternion: [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w],
    scale: obj.scale.toArray() as [number, number, number],
    userData,
  };
  const mesh = obj as THREE.Mesh;
  const canonicalId = typeof userData[CANONICAL_GEOMETRY_USERDATA_KEY] === "string"
    ? userData[CANONICAL_GEOMETRY_USERDATA_KEY] as string
    : null;
  if (mesh.isMesh && mesh.geometry && canonicalId === null) {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const posAttr = geo.getAttribute("position") as THREE.BufferAttribute;
    const normAttr = geo.getAttribute("normal") as THREE.BufferAttribute | undefined;
    const idx = geo.index;
    s.geometry = {
      position: Array.from(posAttr.array as Float32Array),
      ...(normAttr ? { normal: Array.from(normAttr.array as Float32Array) } : {}),
      ...(idx ? { index: Array.from(idx.array as Uint32Array | Uint16Array) } : {}),
    };
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (mat && "color" in mat) s.color = (mat as THREE.MeshStandardMaterial).color.getHex();
    s.displaySource = "serialized-geometry";
  } else if (canonicalId !== null) {
    s.displaySource = "canonical";
  }
  if (obj.children.length > 0) {
    const kids: SerializedSceneObj[] = [];
    for (const c of obj.children) { const cs = _serializeSceneObj(c); if (cs) kids.push(cs); }
    if (kids.length) s.children = kids;
  }
  return s;
}

function _collectCanonicalGeometryIds(objects: SerializedSceneObj[]): Set<string> {
  const ids = new Set<string>();
  const visit = (obj: SerializedSceneObj): void => {
    const id = obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    if (typeof id === "string") ids.add(id);
    for (const child of obj.children ?? []) visit(child);
  };
  for (const obj of objects) visit(obj);
  return ids;
}

function geometryFromCanonical(record: CanonicalGeometry): THREE.Object3D | null {
  return objectFromCanonicalGeometry(record);
}

function _deserializeSceneObj(s: SerializedSceneObj, canonicalStore?: CanonicalGeometryStore): THREE.Object3D | null {
  let obj: THREE.Object3D;
  if (s.geometry) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(s.geometry.position), 3));
    if (s.geometry.normal) geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(s.geometry.normal), 3));
    if (s.geometry.index) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(s.geometry.index), 1));
    const mat = new THREE.MeshStandardMaterial({ color: s.color ?? 0x888888, roughness: 0.6, metalness: 0.1 });
    obj = new THREE.Mesh(geo, mat);
  } else {
    const canonicalId = s.userData?.[CANONICAL_GEOMETRY_USERDATA_KEY];
    const canonical = typeof canonicalId === "string" ? canonicalStore?.get(canonicalId) : undefined;
    obj = canonical ? (geometryFromCanonical(canonical) ?? new THREE.Group()) : new THREE.Group();
  }
  obj.position.fromArray(s.position);
  obj.quaternion.set(s.quaternion[0], s.quaternion[1], s.quaternion[2], s.quaternion[3]);
  obj.scale.fromArray(s.scale);
  obj.userData = { ...s.userData };
  if (s.children) {
    for (const cs of s.children) { const child = _deserializeSceneObj(cs, canonicalStore); if (child) obj.add(child); }
  }
  return obj;
}

export const __sceneSerializationForTests = {
  serializeSceneObj: _serializeSceneObj,
  deserializeSceneObj: _deserializeSceneObj,
  collectCanonicalGeometryIds: _collectCanonicalGeometryIds,
};

