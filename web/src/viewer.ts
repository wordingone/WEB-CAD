// Three.js viewer for replicad meshes.
//
// Receives a flat-array mesh from the worker, builds a BufferGeometry,
// and frames the camera on the result. Scissor-per-pane render loop
// supports single and quad viewport layouts. OrbitControls are per-pane.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { axesGizmoSVG } from "./icons.js";
import { setSelected, clearSelected, subscribe, type Selection } from "./selection-state.js";

type ViewName = "top" | "persp" | "front" | "right";
type Pane = {
  id: string;
  view: ViewName;
  el: HTMLElement;
  body: HTMLElement;
  camera: THREE.Camera;
  controls: OrbitControls;
};

// Distinguish a click from an orbit-drag: if the pointer moves more than this
// many CSS pixels between mousedown and mouseup, treat as drag and skip
// raycasting. 4px matches OrbitControls' damping threshold so a deliberate
// click on a wall registers but a rotate-then-release does not.
const CLICK_DRAG_THRESHOLD_PX = 4;

export type MeshIn = {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

export type Bounds = {
  min: [number, number, number];
  max: [number, number, number];
};

export class Viewer {
  private canvas: HTMLCanvasElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls | null = null;
  private panes: Pane[] = [];
  private currentMesh: THREE.Mesh | null = null;
  private currentEdges: THREE.LineSegments | null = null;
  private currentObject: THREE.Object3D | null = null;
  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private axisLabels: THREE.Sprite[] = [];
  private currentBounds: Bounds | null = null;

  // Selection picking (T3). Single Raycaster reused per click; per-pane camera
  // determined at click time by hit-testing against pane bounding rects so the
  // ortho panes pick correctly even when the persp pane is the visual focus.
  private raycaster = new THREE.Raycaster();
  private clickStart: { x: number; y: number; pane: Pane | null } | null = null;
  // Cache the pre-highlight emissive color so deselect can restore it. We only
  // tweak emissive on the picked mesh — geometry, vertex colors, and base
  // diffuse are untouched, so the highlight is reversible without re-uploading
  // attributes.
  private prevHighlight: { mat: THREE.MeshStandardMaterial; color: THREE.Color } | null = null;
  private unsubscribeSelection: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, viewportAreaEl: HTMLElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = false;
    this.renderer.autoClear = false;

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

    // Reference grid + axes.
    this.grid = new THREE.GridHelper(20, 20, 0x6f6f78, 0xc8c2b4);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(2);
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
      this.panes.push({ id: el.id, view, el, body, camera, controls });

      const axesDiv = document.getElementById(`vp-axes-${idx + 1}`);
      if (axesDiv) axesDiv.innerHTML = axesGizmoSVG();
    });

    // Keep backward-compat controls reference pointing at persp pane.
    const perspPane = this.panes.find(p => p.view === "persp");
    if (perspPane) this.controls = perspPane.controls;

    this.handleResize();
    window.addEventListener("resize", () => this.handleResize());

    // Selection picking — Rhino-style click-to-select. Bind on the parent
    // viewport-area-host instead of the canvas so the ortho panes (which sit
    // above the canvas in DOM but render via scissor) still receive clicks.
    // Pane disambiguation by bounding-rect hit-test runs at mouseup time.
    const clickRoot = viewportAreaEl;
    clickRoot.addEventListener("mousedown", this.onMouseDown);
    clickRoot.addEventListener("mouseup", this.onMouseUp);

    // Mirror selection changes into the viewport as a visual highlight. The
    // store is the source of truth — Inspect tab, gizmos, Delete handler all
    // read getSelected(); the viewer just paints the result.
    this.unsubscribeSelection = subscribe((sel) => this.applyHighlight(sel));

    this.animate();
  }

  // --- Selection picking -----------------------------------------------------

  private paneAtClient(clientX: number, clientY: number): Pane | null {
    for (const p of this.panes) {
      const r = p.el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return p;
      }
    }
    return null;
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return; // left-click only
    const pane = this.paneAtClient(e.clientX, e.clientY);
    this.clickStart = { x: e.clientX, y: e.clientY, pane };
  };

  private onMouseUp = (e: MouseEvent): void => {
    const start = this.clickStart;
    this.clickStart = null;
    if (!start || e.button !== 0) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) return; // it was an orbit drag
    const pane = start.pane ?? this.paneAtClient(e.clientX, e.clientY);
    if (!pane) return;
    this.pickAt(e.clientX, e.clientY, pane);
  };

  // Hit-test the active scene content against the given pane's camera. Click
  // on geometry → setSelected; click on empty space → clearSelected.
  private pickAt(clientX: number, clientY: number, pane: Pane): void {
    const targets: THREE.Object3D[] = [];
    if (this.currentMesh) targets.push(this.currentMesh);
    if (this.currentObject) targets.push(this.currentObject);
    if (targets.length === 0) {
      clearSelected();
      return;
    }

    const r = pane.el.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -(((clientY - r.top) / r.height) * 2 - 1),
    );
    this.raycaster.setFromCamera(ndc, pane.camera);
    const hits = this.raycaster.intersectObjects(targets, true);
    if (hits.length === 0) {
      clearSelected();
      return;
    }

    // Walk up to the top-level scene member (currentMesh or currentObject root)
    // so the user sees a "select the wall" semantic, not "select the third
    // sub-mesh of the wall's compound." Sub-object picking (Ctrl+Shift) is
    // T3 future-work; this commit ships the coarse-mesh-level selection that
    // unblocks T4 transforms + T6 delete.
    const rootSet = new Set<THREE.Object3D>(targets);
    let target: THREE.Object3D = hits[0].object;
    while (target.parent && !rootSet.has(target)) target = target.parent;

    const sel: Selection = {
      topology: "mesh",
      uuid: target.uuid,
      object: hits[0].object,
      transformTarget: target,
    };
    if (target !== hits[0].object) {
      sel.parent = target;
      sel.parentUuid = target.uuid;
    }
    if (typeof hits[0].faceIndex === "number") sel.faceIndex = hits[0].faceIndex;
    setSelected(sel);
  }

  // Visual highlight on selection change. Tweak the first MeshStandardMaterial
  // we find under the selected root; restore the prior emissive on deselect.
  // Materials shared across multiple meshes will see the highlight on every
  // mesh that shares them — acceptable for v1 since current scenes assign
  // distinct materials per object.
  private applyHighlight(sel: Selection | null): void {
    if (this.prevHighlight) {
      this.prevHighlight.mat.emissive.copy(this.prevHighlight.color);
      this.prevHighlight = null;
    }
    if (!sel) return;
    let captured = false;
    sel.transformTarget.traverse((c) => {
      if (captured) return;
      const m = c as THREE.Mesh;
      if (m.isMesh && m.material instanceof THREE.MeshStandardMaterial) {
        this.prevHighlight = { mat: m.material, color: m.material.emissive.clone() };
        m.material.emissive.setHex(0xffaa00);
        captured = true;
      }
    });
  }

  private handleResize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    for (const pane of this.panes) {
      if (pane.camera instanceof THREE.OrthographicCamera) {
        const pr = pane.el.getBoundingClientRect();
        const aspect = pr.width > 0 && pr.height > 0 ? pr.width / pr.height : 1;
        const half = 5;
        pane.camera.left = -half * aspect;
        pane.camera.right = half * aspect;
        pane.camera.top = half;
        pane.camera.bottom = -half;
        pane.camera.updateProjectionMatrix();
      } else if (pane.camera instanceof THREE.PerspectiveCamera) {
        const pr = pane.el.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0) {
          (pane.camera as THREE.PerspectiveCamera).aspect = pr.width / pr.height;
          pane.camera.updateProjectionMatrix();
        }
      }
    }
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const canvasRect = this.canvas.getBoundingClientRect();
    const canvasH = this.canvas.clientHeight;

    this.renderer.clear();

    for (const pane of this.panes) {
      const rect = pane.el.getBoundingClientRect();
      const x = Math.floor(rect.left - canvasRect.left);
      // Y-flip: WebGL origin is bottom-left, DOM origin is top-left.
      const gl_y = Math.floor(canvasH - (rect.top - canvasRect.top) - rect.height);
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w <= 0 || h <= 0) continue;

      this.renderer.setScissor(x, gl_y, w, h);
      this.renderer.setScissorTest(true);
      this.renderer.setViewport(x, gl_y, w, h);
      this.renderer.clearDepth();
      pane.controls.update();
      this.renderer.render(this.scene, pane.camera);
    }
    this.renderer.setScissorTest(false);
  };

  private clearScene(): void {
    // Drop any selection pointing at the about-to-be-disposed objects.
    // Subscribers (Inspect panel, gizmos, this viewer's highlight) read
    // getSelected() — leaving a dangling Object3D reference there causes
    // disposed-material accesses in the next interactive frame.
    clearSelected();

    if (this.currentMesh) {
      this.scene.remove(this.currentMesh);
      this.currentMesh.geometry.dispose();
      (this.currentMesh.material as THREE.Material).dispose();
      this.currentMesh = null;
    }
    if (this.currentEdges) {
      this.scene.remove(this.currentEdges);
      this.currentEdges.geometry.dispose();
      (this.currentEdges.material as THREE.Material).dispose();
      this.currentEdges = null;
    }
    if (this.currentObject) {
      this.scene.remove(this.currentObject);
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

  setMesh(mesh: MeshIn, bounds: Bounds): void {
    this.clearScene();

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
    this.scene.add(m);
    this.currentMesh = m;

    const edges = new THREE.EdgesGeometry(geometry, 25);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x0e0e10,
      linewidth: 1,
      opacity: 0.6,
      transparent: true,
    });
    const edgeLines = new THREE.LineSegments(edges, edgeMat);
    this.scene.add(edgeLines);
    this.currentEdges = edgeLines;

    this.fitCamera(bounds);
  }

  setObject(object: THREE.Object3D, bounds: Bounds): void {
    this.clearScene();
    this.scene.add(object);
    this.currentObject = object;
    this.fitCamera(bounds);
  }

  getActiveObject(): THREE.Object3D | null {
    if (this.currentMesh) return this.currentMesh;
    if (this.currentObject) return this.currentObject;
    return null;
  }

  getScene(): THREE.Scene {
    return this.scene;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  addMesh(mesh: THREE.Mesh, _kind?: string): void {
    this.scene.add(mesh);
  }

  removeObject(obj: THREE.Object3D): boolean {
    if (!this.scene.children.includes(obj)) return false;
    this.scene.remove(obj);
    if (this.currentMesh === obj) this.currentMesh = null;
    if (this.currentEdges === obj) this.currentEdges = null;
    if (this.currentObject === obj) this.currentObject = null;
    return true;
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

  private fitCamera(bounds: Bounds): void {
    this.currentBounds = bounds;
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    const dx = bounds.max[0] - bounds.min[0];
    const dy = bounds.max[1] - bounds.min[1];
    const dz = bounds.max[2] - bounds.min[2];
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));

    // Persp camera — architectural direction, 1.7× for grid visibility.
    const dist = diag * 1.7;
    const dir = new THREE.Vector3(1, 1, 1.5).normalize();
    this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    this.camera.updateProjectionMatrix();
    const perspPane = this.panes.find(p => p.view === "persp");
    if (perspPane) {
      perspPane.controls.target.set(cx, cy, cz);
      perspPane.controls.update();
    }

    // Ortho panes — position along view axis, scale frustum to fit scene.
    const half = diag * 0.55;
    for (const pane of this.panes) {
      if (!(pane.camera instanceof THREE.OrthographicCamera)) continue;
      switch (pane.view) {
        case "top":   pane.camera.position.set(cx, cy, cz + diag * 2); break;
        case "front": pane.camera.position.set(cx, cy - diag * 2, cz); break;
        case "right": pane.camera.position.set(cx + diag * 2, cy, cz); break;
      }
      pane.camera.lookAt(cx, cy, cz);
      const pr = pane.el.getBoundingClientRect();
      const aspect = pr.width > 0 && pr.height > 0 ? pr.width / pr.height : 1;
      pane.camera.left = -half * aspect;
      pane.camera.right = half * aspect;
      pane.camera.top = half;
      pane.camera.bottom = -half;
      pane.camera.updateProjectionMatrix();
      pane.controls.target.set(cx, cy, cz);
      pane.controls.update();
    }

    // Re-scale grid so it brackets the object.
    const gridSize = Math.max(20, Math.ceil(Math.max(dx, dy) * 2));
    if ((this.grid as any).__lastSize !== gridSize) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid = new THREE.GridHelper(gridSize, gridSize, 0x444444, 0x2c2c34);
      this.grid.rotation.x = Math.PI / 2;
      (this.grid as any).__lastSize = gridSize;
      this.scene.add(this.grid);
    }

    // Re-scale axis triad + labels.
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
    this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    this.camera.updateProjectionMatrix();
    const perspPane = this.panes.find(p => p.view === "persp");
    if (perspPane) {
      perspPane.controls.target.set(cx, cy, cz);
      perspPane.controls.update();
    }
  }

  setView(name: "top" | "bottom" | "front" | "back" | "left" | "right" | "iso" | "extents"): void {
    const b = this.currentBounds ?? { min: [-5, -5, -5] as [number, number, number], max: [5, 5, 5] as [number, number, number] };
    const cx = (b.min[0] + b.max[0]) / 2;
    const cy = (b.min[1] + b.max[1]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const dx = b.max[0] - b.min[0];
    const dy = b.max[1] - b.min[1];
    const dz = b.max[2] - b.min[2];
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const dist = diag * 1.7;
    let dir: THREE.Vector3;
    switch (name) {
      case "top":     dir = new THREE.Vector3(0, 0, 1); break;
      case "bottom":  dir = new THREE.Vector3(0, 0, -1); break;
      case "front":   dir = new THREE.Vector3(0, -1, 0); break;
      case "back":    dir = new THREE.Vector3(0, 1, 0); break;
      case "right":   dir = new THREE.Vector3(1, 0, 0); break;
      case "left":    dir = new THREE.Vector3(-1, 0, 0); break;
      case "iso":     dir = new THREE.Vector3(1, 1, 1).normalize(); break;
      case "extents": dir = new THREE.Vector3(1, 1, 1.5).normalize(); break;
    }
    this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    this.camera.updateProjectionMatrix();
    const perspPane = this.panes.find(p => p.view === "persp");
    if (perspPane) {
      perspPane.controls.target.set(cx, cy, cz);
      perspPane.controls.update();
    }
  }

  splitMode(mode: "single" | "quad"): void {
    const area = this.canvas.parentElement;
    if (!area) return;
    area.classList.toggle("split-quad", mode === "quad");
    area.classList.toggle("split-single", mode === "single");
    this.handleResize();
  }
}
