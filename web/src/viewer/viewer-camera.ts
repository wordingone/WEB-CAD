import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Viewer, Bounds } from "./viewer.js";
import { rebuildGridHelper } from "./viewer-rendering.js";
import { resolveCPlane } from "./cplane.js";

export function fitCamera(v: Viewer, bounds: Bounds): void {
  v.currentBounds = bounds;
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));

  const dist = diag * 1.7;
  const dir = new THREE.Vector3(1, 1, 1.5).normalize();
  v.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
  v.camera.updateProjectionMatrix();
  const perspPane = v.panes.find(p => p.view === "persp");
  if (perspPane) {
    perspPane.controls.target.set(cx, cy, cz);
    perspPane.controls.update();
  }

  const half = diag * 0.55;
  for (const pane of v.panes) {
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

  const gridSize = Math.max(20, Math.ceil(Math.max(dx, dy) * 2));
  if ((v.grid as any).__lastSize !== gridSize) {
    (v.grid as any).__lastSize = gridSize;
    rebuildGridHelper(v);
  }

  const triadLen = Math.max(2, Math.min(dx, dy, dz) * 0.5);
  v.scene.remove(v.axes);
  v.axes.dispose();
  v.axes = new THREE.AxesHelper(triadLen);
  v.axes.userData.noSnap = true;
  v.axes.visible = false;
  v.scene.add(v.axes);
  createAxisLabels(v, triadLen);
  for (const s of v.axisLabels) s.visible = false;
}

export function createAxisLabels(v: Viewer, length = 2): void {
  for (const s of v.axisLabels) {
    v.scene.remove(s);
    s.material.map?.dispose();
    s.material.dispose();
  }
  v.axisLabels = [];
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
  v.axisLabels = [
    make("X", "#ff5c5c", [tip, 0, 0]),
    make("Y", "#7ad36a", [0, tip, 0]),
    make("Z", "#5b8def", [0, 0, tip]),
  ];
  for (const s of v.axisLabels) v.scene.add(s);
}

export function frameObjectOnly(v: Viewer, obj: THREE.Object3D): void {
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
  v.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
  v.camera.updateProjectionMatrix();
  const perspPane = v.panes.find(p => p.view === "persp");
  if (perspPane) {
    perspPane.controls.target.set(cx, cy, cz);
    perspPane.controls.update();
  }
}

export function frameAllVisible(v: Viewer): void {
  v.scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  v.scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) && !(obj instanceof THREE.Group)) return;
    const ud = (obj as any).userData as Record<string, unknown>;
    if (ud?.kind !== "brep" && ud?.kind !== "compound") return;
    box.expandByObject(obj);
  });
  if (box.isEmpty() && v.currentBounds) {
    box.set(
      new THREE.Vector3(...v.currentBounds.min),
      new THREE.Vector3(...v.currentBounds.max),
    );
  }
  if (box.isEmpty() || !isFinite(box.min.x) || !isFinite(box.max.x)) return;
  const center = new THREE.Vector3();
  box.getCenter(center);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 0.5);
  const dist = (maxDim / 2) / Math.tan((v.camera.fov / 2) * (Math.PI / 180)) * 1.4;
  const dir = new THREE.Vector3(1, 1, 1.5).normalize();
  const perspPane = v.panes.find(p => p.view === "persp");
  // #709: flush accumulated OrbitControls sphericalDelta
  if (perspPane) {
    const prev = perspPane.controls.enableDamping;
    perspPane.controls.enableDamping = false;
    perspPane.controls.update();
    perspPane.controls.enableDamping = prev;
  }
  if (perspPane && perspPane.camera !== v.camera) {
    perspPane.camera = v.camera;
    perspPane.controls.object = v.camera;
    perspPane.controls.enableRotate = true;
    perspPane.controls.screenSpacePanning = false;
    perspPane.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    perspPane.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    perspPane.controls.zoomSpeed = 1;
    for (const g of v.gizmos) g.camera = v.camera;
  }
  v.camera.position.set(center.x + dir.x * dist, center.y + dir.y * dist, center.z + dir.z * dist);
  v.camera.updateProjectionMatrix();
  if (perspPane) {
    perspPane.controls.target.set(center.x, center.y, center.z);
    perspPane.controls.update();
  }
  v.activeView = "persp";
}

export function setView(v: Viewer, name: "top" | "bottom" | "front" | "back" | "left" | "right" | "iso" | "extents" | "persp"): void {
  v.activeView = name;
  window.dispatchEvent(new CustomEvent("viewer:cplane-derived", {
    detail: { cplane: resolveCPlane("SdBox", {}, v), view: name },
  }));
  const perspPane = v.panes.find(p => p.view === "persp");
  // #709: flush accumulated OrbitControls sphericalDelta
  if (perspPane) {
    const prev = perspPane.controls.enableDamping;
    perspPane.controls.enableDamping = false;
    perspPane.controls.update();
    perspPane.controls.enableDamping = prev;
  }
  if (name === "persp") {
    v.grid.rotation.set(Math.PI / 2, 0, 0);
    v.grid.position.set(0, 0, v._workingPlaneZ);
    if (perspPane && perspPane.camera !== v.camera) {
      perspPane.camera = v.camera;
      perspPane.controls.object = v.camera;
      perspPane.controls.enableRotate = true;
      perspPane.controls.screenSpacePanning = false;
      perspPane.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      perspPane.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      perspPane.controls.zoomSpeed = 1;
      perspPane.controls.update();
      for (const g of v.gizmos) g.camera = v.camera;
    }
    return;
  }
  const b = v.currentBounds ?? { min: [-5, -5, -5] as [number, number, number], max: [5, 5, 5] as [number, number, number] };
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
    default:        dir = new THREE.Vector3(1, 1, 1.5).normalize(); break;
  }

  // #594: orient floor grid to match the ortho view's working plane.
  switch (name) {
    case "front": case "back":
      v.grid.rotation.set(0, 0, 0);
      v.grid.position.set(0, 0, 0);
      break;
    case "right": case "left":
      v.grid.rotation.set(0, 0, Math.PI / 2);
      v.grid.position.set(0, 0, 0);
      break;
    default:
      v.grid.rotation.set(Math.PI / 2, 0, 0);
      v.grid.position.set(0, 0, v._workingPlaneZ);
      break;
  }
  const ORTHO_VIEWS = new Set(["top", "bottom", "front", "back", "left", "right", "iso"]);
  if (ORTHO_VIEWS.has(name) && perspPane) {
    if (!v._orthoViewCamera) {
      v._orthoViewCamera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.01, 10000);
    }
    const oc = v._orthoViewCamera;
    const half = diag * 1.1;
    const pr = perspPane.el.getBoundingClientRect();
    const aspect = pr.width > 0 && pr.height > 0 ? pr.width / pr.height : 1;
    oc.left = -half * aspect;
    oc.right = half * aspect;
    oc.top = half;
    oc.bottom = -half;
    oc.near = 0.01;
    oc.far = diag * 200;
    if (name === "top" || name === "bottom") oc.up.set(0, 1, 0);
    else oc.up.set(0, 0, 1);
    oc.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    oc.lookAt(cx, cy, cz);
    oc.updateProjectionMatrix();
    perspPane.camera = oc;
    perspPane.controls.object = oc;
    perspPane.controls.enableRotate = true;
    perspPane.controls.screenSpacePanning = true;
    perspPane.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    perspPane.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    perspPane.controls.zoomSpeed = 1;
    perspPane.controls.target.set(cx, cy, cz);
    perspPane.controls.update();
    for (const g of v.gizmos) g.camera = oc;
  } else {
    if (perspPane && perspPane.camera !== v.camera) {
      perspPane.camera = v.camera;
      perspPane.controls.object = v.camera;
      perspPane.controls.enableRotate = true;
      perspPane.controls.screenSpacePanning = false;
      perspPane.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      perspPane.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      perspPane.controls.zoomSpeed = 1;
      for (const g of v.gizmos) g.camera = v.camera;
    }
    v.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    v.camera.updateProjectionMatrix();
    if (perspPane) {
      perspPane.controls.target.set(cx, cy, cz);
      perspPane.controls.update();
    }
  }
}

export function setWorkingPlaneZ(v: Viewer, z: number): void {
  v._workingPlaneZ = z;
  const activeView = v.activeView ?? "persp";
  const xyViews = new Set(["top", "bottom", "iso", "extents", "persp"]);
  if (xyViews.has(activeView)) {
    v.grid.position.z = z;
  }
}

export function setTargetElevation(v: Viewer, z: number): void {
  const perspPane = v.panes.find(p => p.view === "persp");
  if (!perspPane) return;
  const dz = z - perspPane.controls.target.z;
  perspPane.controls.target.z = z;
  v.camera.position.z += dz;
  perspPane.controls.update();
  v.camera.updateProjectionMatrix();
}

export function splitMode(v: Viewer, mode: "single" | "quad"): void {
  const area = v.canvas.parentElement;
  if (!area) return;
  area.classList.toggle("split-quad", mode === "quad");
  area.classList.toggle("split-single", mode === "single");
  handleResize(v);
}

export function handleResize(v: Viewer): void {
  const rect = v.canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  v.renderer.setSize(w, h, false);
  for (const pane of v.panes) {
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

export function createNavControls(v: Viewer, view: string, domElement: HTMLElement): { dispose(): void } {
  const pane = v.panes.find(p => p.view === view);
  if (!pane) return { dispose() {} };
  const oc = new OrbitControls(pane.camera, domElement);
  if (pane.camera instanceof THREE.OrthographicCamera) {
    oc.enableRotate = false;
  }
  oc.enableDamping = false;
  return oc;
}
