// Three.js viewer for replicad meshes.
//
// Supports two layouts:
//   - "single"  → one pane covering the full viewport-area
//   - "quad"    → four panes (top / front / right / perspective) in a 2×2 grid
//
// Each pane is an isolated `ViewportPane` (own scene, camera, renderer, grid,
// OrbitControls) so we can switch one pane's camera without disturbing others.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type MeshIn = {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

export type Bounds = {
  min: [number, number, number];
  max: [number, number, number];
};

export type ViewName =
  | "perspective"
  | "top"
  | "front"
  | "right"
  | "back"
  | "left"
  | "bottom";

export type Layout = "single" | "quad";

const ORTHO_VIEWS: ViewName[] = ["top", "front", "right", "back", "left", "bottom"];

// Dark drafting-grid colors (subdued ink-on-vellum). These are the canonical
// drafting grid for ortho panes; the CSS `.vp-grid` overlay is suppressed on
// those panes via the `.vp-pane-ortho` class.
const GRID_DARK_MAJOR = 0x444444;
const GRID_DARK_MINOR = 0x2c2c34;

// Bundled viewport defaults (single-pane mode; matches pre-quad-split look).
const GRID_SOFT_MAJOR = 0x6f6f78;
const GRID_SOFT_MINOR = 0xc8c2b4;

export function isOrthoView(v: ViewName): boolean {
  return ORTHO_VIEWS.indexOf(v) >= 0;
}

// Camera direction (look direction toward origin) for a given view.
// In Z-up world: top looks down -Z, front looks +Y direction (camera at -Y looking +Y),
// right looks +X (camera at +X looking -X), etc. Returned vector is the camera
// position direction relative to scene center.
export function cameraDirForView(v: ViewName): THREE.Vector3 {
  switch (v) {
    case "top":         return new THREE.Vector3(0, 0, 1);
    case "bottom":      return new THREE.Vector3(0, 0, -1);
    case "front":       return new THREE.Vector3(0, -1, 0);
    case "back":        return new THREE.Vector3(0, 1, 0);
    case "right":       return new THREE.Vector3(1, 0, 0);
    case "left":        return new THREE.Vector3(-1, 0, 0);
    case "perspective": return new THREE.Vector3(1, 1, 1.5).normalize();
  }
}

// Pure scene-graph factory. Builds a THREE.Scene populated with the
// pane's lighting + grid + axes for a given view, plus the matching
// camera. Used by ViewportPane (renders it) AND by tests (which inspect
// the graph without a WebGL context).
//
// Returns the camera + scene + the grid helper itself (so tests don't need
// to traverse to find it). The caller is responsible for adding mesh content.
export function buildPaneSceneGraph(view: ViewName): {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  grid: THREE.GridHelper;
} {
  const scene = new THREE.Scene();

  // Lights — keyfill + rim (matches pre-refactor look).
  const ambient = new THREE.AmbientLight(0xffffff, 0.45);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(10, 10, 12);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x99ccff, 0.35);
  fill.position.set(-8, -6, 4);
  scene.add(fill);

  // Single drafting grid per pane. Color tier picked by view:
  //  - perspective → soft tan (matches single-pane bundle look)
  //  - ortho       → dark drafting (only grid; no CSS overlay)
  const [maj, min] = isOrthoView(view)
    ? [GRID_DARK_MAJOR, GRID_DARK_MINOR]
    : [GRID_SOFT_MAJOR, GRID_SOFT_MINOR];
  const grid = new THREE.GridHelper(20, 20, maj, min);
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);

  const axes = new THREE.AxesHelper(2);
  scene.add(axes);

  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  if (view === "perspective") {
    camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    camera.position.set(8, 8, 8);
    camera.up.set(0, 0, 1);
  } else {
    camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.01, 1000);
    camera.up.set(0, 0, 1);
    const dir = cameraDirForView(view);
    camera.position.set(dir.x * 50, dir.y * 50, dir.z * 50);
  }

  return { scene, camera, grid };
}

// One self-contained pane (scene + camera + renderer + grid + controls).
// Used both standalone (single-layout) and as a child of the quad layout.
export class ViewportPane {
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls;
  grid: THREE.GridHelper;
  axes: THREE.AxesHelper;
  view: ViewName;
  private axisLabels: THREE.Sprite[] = [];
  private bounds: Bounds | null = null;
  private contentRoot: THREE.Group;

  constructor(container: HTMLElement, canvas: HTMLCanvasElement, view: ViewName) {
    this.container = container;
    this.canvas = canvas;
    this.view = view;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = false;

    // Build the scene graph + camera + grid via the pure factory so tests
    // can build the same graph without spinning up WebGL.
    const built = buildPaneSceneGraph(view);
    this.scene = built.scene;
    this.camera = built.camera;
    this.grid = built.grid;
    // AxesHelper was the second-to-last child added by the factory; pull it
    // back out so we can dispose / replace it on reframes.
    this.axes = this.scene.children.find((c) => c instanceof THREE.AxesHelper) as THREE.AxesHelper;

    this.contentRoot = new THREE.Group();
    this.scene.add(this.contentRoot);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    if (isOrthoView(view)) {
      // Ortho panes: lock rotation so they stay axis-aligned. Pan + zoom only.
      this.controls.enableRotate = false;
    }

    this.createAxisLabels();

    this.applyOrthoCssGuard();
    this.handleResize();
  }

  // CSS guard: ortho panes hide the `.vp-grid` background overlay
  // (the bundle's light "graph paper" rule lines that look white over
  // the dark THREE.js grid). Only the dark drafting grid remains.
  private applyOrthoCssGuard(): void {
    if (isOrthoView(this.view)) {
      this.container.classList.add("vp-pane-ortho");
    } else {
      this.container.classList.remove("vp-pane-ortho");
    }
  }

  // Replace this pane's camera with a different view. Re-runs framing so the
  // user lands on a sensible default position. OrbitControls is rebuilt so
  // its target/zoom state matches the new camera type.
  setView(view: ViewName): void {
    this.view = view;
    this.controls.dispose();
    // Build a fresh camera via the same factory used by tests / new panes.
    // (Cameras don't hold GPU resources, so the old one is GC'd.)
    const rebuilt = buildPaneSceneGraph(view);
    this.camera = rebuilt.camera;
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    if (isOrthoView(view)) this.controls.enableRotate = false;

    // Replace grid with the colour tier appropriate for the new view.
    const [maj, min] = isOrthoView(view)
      ? [GRID_DARK_MAJOR, GRID_DARK_MINOR]
      : [GRID_SOFT_MAJOR, GRID_SOFT_MINOR];
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    const gridSize = (this.grid as unknown as { __lastSize?: number }).__lastSize ?? 20;
    this.grid = new THREE.GridHelper(gridSize, gridSize, maj, min);
    this.grid.rotation.x = Math.PI / 2;
    (this.grid as unknown as { __lastSize?: number }).__lastSize = gridSize;
    this.scene.add(this.grid);

    this.applyOrthoCssGuard();
    if (this.bounds) this.fitCamera(this.bounds);
    this.handleResize();
  }

  handleResize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    } else if (this.camera instanceof THREE.OrthographicCamera) {
      // Re-derive frustum from current camera bounds + aspect ratio.
      const aspect = w / h;
      const halfH = (this.camera.top - this.camera.bottom) / 2;
      const halfW = halfH * aspect;
      const cx = (this.camera.left + this.camera.right) / 2;
      const cy = (this.camera.bottom + this.camera.top) / 2;
      this.camera.left = cx - halfW;
      this.camera.right = cx + halfW;
      this.camera.bottom = cy - halfH;
      this.camera.top = cy + halfH;
      this.camera.updateProjectionMatrix();
    }
  }

  // Single render call (driven by Viewer.animate). Kept on the pane so Viewer
  // can iterate `panes.forEach(p => p.render())` regardless of layout.
  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  contentNode(): THREE.Group {
    return this.contentRoot;
  }

  // Frame the camera on a bounds box. Same scaling logic as the
  // pre-refactor single-pane Viewer.
  fitCamera(bounds: Bounds): void {
    this.bounds = bounds;
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    const dx = bounds.max[0] - bounds.min[0];
    const dy = bounds.max[1] - bounds.min[1];
    const dz = bounds.max[2] - bounds.min[2];
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const dist = diag * 1.5;
    const dir = cameraDirForView(this.view);

    this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    this.controls.target.set(cx, cy, cz);

    if (this.camera instanceof THREE.OrthographicCamera) {
      // Frame using the larger of the two axes perpendicular to view direction.
      const halfH = diag * 0.6;
      const rect = this.canvas.getBoundingClientRect();
      const aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
      const halfW = halfH * aspect;
      this.camera.left = -halfW;
      this.camera.right = halfW;
      this.camera.bottom = -halfH;
      this.camera.top = halfH;
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();

    // Re-scale grid to bracket the scene.
    const gridSize = Math.max(20, Math.ceil(Math.max(dx, dy) * 1.3));
    if ((this.grid as unknown as { __lastSize?: number }).__lastSize !== gridSize) {
      const [maj, min] = isOrthoView(this.view)
        ? [GRID_DARK_MAJOR, GRID_DARK_MINOR]
        : [GRID_DARK_MAJOR, GRID_DARK_MINOR];
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid = new THREE.GridHelper(gridSize, gridSize, maj, min);
      this.grid.rotation.x = Math.PI / 2;
      (this.grid as unknown as { __lastSize?: number }).__lastSize = gridSize;
      this.scene.add(this.grid);
    }

    // Re-scale axis triad to match scene size.
    const triadLen = Math.max(2, Math.min(dx, dy, dz) * 0.5);
    this.scene.remove(this.axes);
    this.axes.dispose();
    this.axes = new THREE.AxesHelper(triadLen);
    this.scene.add(this.axes);
    this.createAxisLabels(triadLen);
  }

  private createAxisLabels(length = 2): void {
    for (const s of this.axisLabels) {
      this.scene.remove(s);
      s.material.map?.dispose();
      s.material.dispose();
    }
    this.axisLabels = [];
    const make = (text: string, color: string, pos: [number, number, number]): THREE.Sprite => {
      const c = document.createElement("canvas");
      c.width = 96; c.height = 96;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, 96, 96);
      ctx.fillStyle = color;
      ctx.font = "700 64px 'Inter', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 48, 50);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(pos[0], pos[1], pos[2]);
      const s = Math.max(0.4, length * 0.18);
      sprite.scale.set(s, s, 1);
      sprite.renderOrder = 999;
      return sprite;
    };
    const tip = length * 1.12;
    this.axisLabels = [
      make("X", "#ff5c5c", [tip, 0, 0]),
      make("Y", "#7ad36a", [0, tip, 0]),
      make("Z", "#5b8def", [0, 0, tip]),
    ];
    for (const s of this.axisLabels) this.scene.add(s);
  }

  dispose(): void {
    this.controls.dispose();
    this.renderer.dispose();
  }
}

export class Viewer {
  // Public for in-browser debug + tests.
  readonly area: HTMLElement;
  panes: ViewportPane[] = [];
  layout: Layout = "single";
  private currentMesh: THREE.Mesh | null = null;
  private currentEdges: THREE.LineSegments | null = null;
  private currentObject: THREE.Object3D | null = null;
  private currentBounds: Bounds | null = null;
  private animationStarted = false;

  // Original constructor signature kept for back-compat: pass the legacy
  // canvas inside `#viewport-1`. The Viewer wraps it as the first pane.
  constructor(initialCanvas: HTMLCanvasElement) {
    const area = document.querySelector<HTMLElement>(".viewport-area");
    if (!area) throw new Error(".viewport-area host missing");
    this.area = area;

    // Wrap the existing canvas in a ViewportPane (perspective).
    const initialPane = initialCanvas.closest<HTMLElement>(".viewport") ?? area;
    const pane = new ViewportPane(initialPane, initialCanvas, "perspective");
    this.panes.push(pane);
    this.attachDropdownIfMissing(initialPane, pane);

    window.addEventListener("resize", () => this.onResize());

    this.startAnimation();
  }

  private startAnimation(): void {
    if (this.animationStarted) return;
    this.animationStarted = true;
    const tick = (): void => {
      requestAnimationFrame(tick);
      for (const p of this.panes) p.render();
    };
    tick();
  }

  private onResize(): void {
    for (const p of this.panes) p.handleResize();
  }

  // Dropdown UI: small select in upper-left of pane that switches its camera.
  private attachDropdownIfMissing(container: HTMLElement, pane: ViewportPane): void {
    if (container.querySelector<HTMLSelectElement>(".vp-view-select")) return;
    const select = document.createElement("select");
    select.className = "vp-view-select";
    select.setAttribute("aria-label", "Pane view");
    const VIEWS: ViewName[] = ["perspective", "top", "front", "right", "back", "left", "bottom"];
    for (const v of VIEWS) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v.toUpperCase();
      if (v === pane.view) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      const v = select.value as ViewName;
      pane.setView(v);
      // Re-mount existing mesh/object into the (already-shared) scene root.
      // Each pane has its own scene, so on layout switch we re-attach via
      // setLayout — here we only need to re-fit the camera.
      if (this.currentBounds) pane.fitCamera(this.currentBounds);
    });
    container.appendChild(select);
  }

  // Switch between layouts. "single" keeps the original canvas; "quad"
  // builds 3 additional panes (perspective + top + front + right) in a 2×2.
  setLayout(layout: Layout): void {
    if (this.layout === layout) return;
    if (layout === "quad") this.toQuad();
    else this.toSingle();
    this.layout = layout;
  }

  private toQuad(): void {
    // Apply CSS class so the .viewport-area renders as 2×2 grid.
    this.area.classList.remove("split-single");
    this.area.classList.add("split-quad");

    // Pane 1 already exists (perspective). Add 3 more.
    // Convention for the four panes (left→right, top→bottom):
    //   row 1: TOP    | FRONT
    //   row 2: RIGHT  | PERSPECTIVE (existing pane is reassigned to row 2 col 2)
    // Build new pane elements appended to .viewport-area.
    const existing = this.panes[0];
    // Reorder existing pane into row 2 col 2 by setting grid-area inline.
    existing.container.style.gridArea = "2 / 2";

    const cfgs: { id: string; view: ViewName; gridArea: string }[] = [
      { id: "viewport-2", view: "top",   gridArea: "1 / 1" },
      { id: "viewport-3", view: "front", gridArea: "1 / 2" },
      { id: "viewport-4", view: "right", gridArea: "2 / 1" },
    ];
    for (const cfg of cfgs) {
      const div = document.createElement("div");
      div.className = "viewport";
      div.id = cfg.id;
      div.style.gridArea = cfg.gridArea;
      const cv = document.createElement("canvas");
      cv.className = "vp-canvas";
      div.appendChild(cv);
      this.area.appendChild(div);
      const pane = new ViewportPane(div, cv, cfg.view);
      this.panes.push(pane);
      this.attachDropdownIfMissing(div, pane);
      this.replicateContentInto(pane);
      if (this.currentBounds) pane.fitCamera(this.currentBounds);
    }
    this.onResize();
  }

  private toSingle(): void {
    this.area.classList.remove("split-quad");
    this.area.classList.add("split-single");
    // Dispose extra panes.
    while (this.panes.length > 1) {
      const p = this.panes.pop()!;
      p.dispose();
      p.container.remove();
    }
    // Restore the first pane's grid-area.
    if (this.panes[0]) this.panes[0].container.style.gridArea = "";
    this.onResize();
  }

  // Replicate current mesh / object into a new pane's scene. Each pane has
  // its own scene (so it can have its own grid + axes), so we re-attach a
  // *clone* of the active geometry (cheap — geometry buffers are shared via
  // `geometry.clone()` on BufferGeometry).
  private replicateContentInto(pane: ViewportPane): void {
    if (this.currentMesh) {
      const m = this.currentMesh;
      const cloneMesh = new THREE.Mesh(m.geometry, m.material);
      pane.contentNode().add(cloneMesh);
    }
    if (this.currentEdges) {
      const e = this.currentEdges;
      const cloneEdges = new THREE.LineSegments(e.geometry, e.material);
      pane.contentNode().add(cloneEdges);
    }
    if (this.currentObject) {
      pane.contentNode().add(this.currentObject.clone(true));
    }
  }

  // -------- Public API kept for main.ts back-compat ----------

  setMesh(mesh: MeshIn, bounds: Bounds): void {
    this.clearAllContent();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

    const material = new THREE.MeshStandardMaterial({
      color: 0x7ad3a3,
      roughness: 0.55,
      metalness: 0.05,
      flatShading: false,
    });
    const m = new THREE.Mesh(geometry, material);
    this.currentMesh = m;

    const edges = new THREE.EdgesGeometry(geometry, 25);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x0e0e10,
      linewidth: 1,
      opacity: 0.6,
      transparent: true,
    });
    const edgeLines = new THREE.LineSegments(edges, edgeMat);
    this.currentEdges = edgeLines;

    // Place a copy in each pane.
    for (const p of this.panes) {
      p.contentNode().add(new THREE.Mesh(geometry, material));
      p.contentNode().add(new THREE.LineSegments(edges, edgeMat));
    }

    this.fitAllPanes(bounds);
  }

  setObject(object: THREE.Object3D, bounds: Bounds): void {
    this.clearAllContent();
    this.currentObject = object;
    // Original (canonical) object goes in pane 0; clones go in the rest so
    // the scenes remain independent.
    if (this.panes[0]) this.panes[0].contentNode().add(object);
    for (let i = 1; i < this.panes.length; i++) {
      this.panes[i].contentNode().add(object.clone(true));
    }
    this.fitAllPanes(bounds);
  }

  private fitAllPanes(bounds: Bounds): void {
    this.currentBounds = bounds;
    for (const p of this.panes) p.fitCamera(bounds);
  }

  private clearAllContent(): void {
    for (const p of this.panes) {
      const root = p.contentNode();
      while (root.children.length > 0) root.remove(root.children[0]);
    }
    if (this.currentMesh) {
      this.currentMesh.geometry.dispose();
      const mm = this.currentMesh.material;
      if (Array.isArray(mm)) mm.forEach((mat) => mat.dispose());
      else if (mm) (mm as THREE.Material).dispose();
      this.currentMesh = null;
    }
    if (this.currentEdges) {
      this.currentEdges.geometry.dispose();
      const em = this.currentEdges.material;
      if (Array.isArray(em)) em.forEach((mat) => mat.dispose());
      else if (em) (em as THREE.Material).dispose();
      this.currentEdges = null;
    }
    if (this.currentObject) {
      this.currentObject.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mat = mesh.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else if (mat) (mat as THREE.Material).dispose();
        }
      });
      this.currentObject = null;
    }
  }

  getActiveObject(): THREE.Object3D | null {
    if (this.currentMesh) return this.currentMesh;
    if (this.currentObject) return this.currentObject;
    return null;
  }

  getActiveMeshData(): { vertices: Float32Array; indices: Uint32Array } | null {
    if (this.currentMesh) {
      const g = this.currentMesh.geometry;
      const pos = g.attributes.position?.array as Float32Array | undefined;
      const idx = g.index?.array;
      if (!pos || !idx) return null;
      return { vertices: new Float32Array(pos), indices: new Uint32Array(idx) };
    }
    if (this.currentObject) {
      const verts: number[] = [];
      const idx: number[] = [];
      const tmp = new THREE.Vector3();
      const matWorld = new THREE.Matrix4();
      this.currentObject.updateMatrixWorld(true);
      this.currentObject.traverse((child) => {
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

  // Re-frame pane 0 (the perspective pane in single-mode; preserves prior
  // hotkey behavior — e.g. "extents" / "f" keys).
  frameObjectOnly(obj: THREE.Object3D): void {
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty() || !isFinite(box.min.x) || !isFinite(box.max.x)) return;
    const cx = (box.min.x + box.max.x) / 2;
    const cy = (box.min.y + box.max.y) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const dx = box.max.x - box.min.x;
    const dy = box.max.y - box.min.y;
    const dz = box.max.z - box.min.z;
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const dist = diag * 1.7;
    const dir = new THREE.Vector3(1, 1, 1.5).normalize();
    const pane = this.panes[0];
    if (!pane) return;
    pane.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    pane.controls.target.set(cx, cy, cz);
    if (pane.camera instanceof THREE.PerspectiveCamera) pane.camera.updateProjectionMatrix();
    else pane.camera.updateProjectionMatrix();
    pane.controls.update();
  }

  // Snap pane 0's camera to a named view (preserves Numpad / letter hotkeys).
  setView(name: "top" | "bottom" | "front" | "back" | "left" | "right" | "iso" | "extents"): void {
    const pane = this.panes[0];
    if (!pane) return;
    // Map "iso" / "extents" → perspective; other names → ortho.
    const isOrtho = name === "top" || name === "bottom" || name === "front" || name === "back" || name === "left" || name === "right";
    const view: ViewName = isOrtho ? (name as ViewName) : "perspective";
    pane.setView(view);
    // Update the dropdown UI to reflect the new view.
    const sel = pane.container.querySelector<HTMLSelectElement>(".vp-view-select");
    if (sel) sel.value = view;
  }
}
