import * as THREE from "three";
import type { Viewer, ExportFacePoly } from "./viewer.js";
import { clipSegByPlanes, worldToPanelXY } from "./line-clip.js";
import { classifyMeshEdges, type ClassifiedEdgeSeg } from "./edge-classifier.js";
import { getSnap } from "./snap-state.js";
import { isDrafting, withoutDrafting } from "../geometry/drafting.js";

export function rebuildGridHelper(v: Viewer): void {
  const sceneSize = (v.grid as unknown as { __lastSize?: number }).__lastSize ?? 20;
  const step = Math.max(0.001, getSnap().step);
  const _rawDivisions = Math.min(500, Math.max(4, Math.round(sceneSize / step)));
  const divisions = _rawDivisions % 2 === 0 ? _rawDivisions : _rawDivisions + 1;
  const gridSize = divisions * step;
  v.scene.remove(v.grid);
  v.grid.geometry.dispose();
  v.grid = new THREE.GridHelper(gridSize, divisions, 0xa8a8b0, 0xd8d4cc);
  v.grid.rotation.x = Math.PI / 2;
  v.grid.renderOrder = -1;
  const gMat = Array.isArray(v.grid.material) ? v.grid.material : [v.grid.material];
  for (const m of gMat) {
    const lm = m as THREE.LineBasicMaterial;
    lm.depthWrite = false;
    lm.transparent = true;
    lm.opacity = 0.55;
    lm.needsUpdate = true;
  }
  v.grid.userData.noSnap = true;
  v.grid.userData.noRenderMode = true;
  (v.grid as unknown as { __lastSize?: number }).__lastSize = sceneSize;
  v.scene.add(v.grid);
}

export function applyClearColor(v: Viewer): void {
  const dummy = document.createElement("span");
  dummy.style.cssText = "position:fixed;left:-9999px;background:var(--canvas-bg)";
  document.body.appendChild(dummy);
  const bg = getComputedStyle(dummy).backgroundColor;
  document.body.removeChild(dummy);
  v.renderer.setClearColor(new THREE.Color(bg), 1.0);
}

// Body of the animate loop — called each RAF tick via the animate arrow fn in viewer.ts.
export function renderFrame(v: Viewer): void {
  if (!v.isAnyGumballDragging() && !v.relocate.active) v.syncPivot();
  const canvasRect = v.canvas.getBoundingClientRect();
  const canvasH = v.canvas.clientHeight;

  v.renderer.clear();

  for (const pane of v.panes) {
    const rect = pane.el.getBoundingClientRect();
    const x = Math.floor(rect.left - canvasRect.left);
    const gl_y = Math.floor(canvasH - (rect.top - canvasRect.top) - rect.height);
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w <= 0 || h <= 0) continue;
    pane.lastRenderedW = w;
    pane.lastRenderedH = h;

    v.renderer.setScissor(x, gl_y, w, h);
    v.renderer.setScissorTest(true);
    v.renderer.setViewport(x, gl_y, w, h);
    v.renderer.clearDepth();
    pane.controls.update();
    // #714: per-pane grid orientation
    const gridView = pane.view === "persp" ? v.activeView : pane.view;
    if (gridView === "front" || gridView === "back") {
      v.grid.rotation.set(0, 0, 0);
    } else if (gridView === "right" || gridView === "left") {
      v.grid.rotation.set(0, 0, Math.PI / 2);
    } else {
      v.grid.rotation.set(Math.PI / 2, 0, 0);
    }
    v.renderer.render(v.scene, pane.camera);
  }
  v.renderer.setScissorTest(false);
}

export function captureFrameHelper(v: Viewer, maxDim = 512): string | null {
  const canvasRect = v.canvas.getBoundingClientRect();
  const canvasH = v.canvas.clientHeight;
  v.renderer.clear();
  for (const pane of v.panes) {
    const rect = pane.el.getBoundingClientRect();
    const x = Math.floor(rect.left - canvasRect.left);
    const gl_y = Math.floor(canvasH - (rect.top - canvasRect.top) - rect.height);
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w <= 0 || h <= 0) continue;
    v.renderer.setScissor(x, gl_y, w, h);
    v.renderer.setScissorTest(true);
    v.renderer.setViewport(x, gl_y, w, h);
    v.renderer.clearDepth();
    pane.controls.update();
    v.renderer.render(v.scene, pane.camera);
  }
  v.renderer.setScissorTest(false);
  const cw = v.canvas.width;
  const ch = v.canvas.height;
  if (cw === 0 || ch === 0) return null;
  const scale = Math.min(1, maxDim / Math.max(cw, ch));
  const sw = Math.max(1, Math.round(cw * scale));
  const sh = Math.max(1, Math.round(ch * scale));
  const off = document.createElement("canvas");
  off.width = sw;
  off.height = sh;
  const ctx = off.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(v.canvas, 0, 0, sw, sh);
  } catch {
    return null;
  }
  return off.toDataURL("image/jpeg", 0.82);
}

export function renderThumbnailTo(v: Viewer, view: string, dest: HTMLCanvasElement, anchorX = 0, anchorY = 0, snapW = 0, snapH = 0, displayMode?: string): void {
  const pane = v.panes.find(p => p.view === view);
  if (!pane) return;
  if (!v._thumbRenderer) {
    v._thumbCanvas = document.createElement("canvas");
    v._thumbRenderer = new THREE.WebGLRenderer({
      canvas: v._thumbCanvas,
      antialias: false,
      alpha: false,
    });
    v._thumbRenderer.setPixelRatio(1);
    v._thumbRenderer.autoClear = true;
    v._thumbRenderer.setClearColor(0x808080, 1);
  }
  const w = Math.max(1, dest.width);
  const h = Math.max(1, dest.height);
  v._thumbRenderer.setSize(w, h, false);
  let cam: THREE.Camera;
  const dragging = snapW > 0 && snapH > 0;
  if (pane.camera instanceof THREE.OrthographicCamera) {
    const src = pane.camera;
    const worldTop    = src.top    || 5;
    const worldBottom = src.bottom || -5;
    const worldLeft   = src.left;
    const worldRight  = src.right;
    const worldH = worldTop - worldBottom;
    if (dragging) {
      const worldW = worldRight - worldLeft;
      const shownWorldH = worldH * h / snapH;
      const shownWorldW = worldW * w / snapW;
      const newLeft = anchorX === 0 ? worldLeft  : worldRight  - shownWorldW;
      const newTop  = anchorY === 0 ? worldTop   : worldBottom + shownWorldH;
      const tmp = new THREE.OrthographicCamera(
        newLeft, newLeft + shownWorldW,
        newTop,  newTop  - shownWorldH,
        src.near, src.far,
      );
      tmp.position.copy(src.position);
      tmp.quaternion.copy(src.quaternion);
      tmp.updateProjectionMatrix();
      cam = tmp;
    } else {
      const half = worldH / 2;
      const tmp = new THREE.OrthographicCamera(
        -half * w / h, half * w / h, worldTop, worldBottom, src.near, src.far,
      );
      tmp.position.copy(src.position);
      tmp.quaternion.copy(src.quaternion);
      tmp.updateProjectionMatrix();
      cam = tmp;
    }
  } else {
    const src = pane.camera as THREE.PerspectiveCamera;
    const tmp = src.clone() as THREE.PerspectiveCamera;
    if (dragging) {
      const offsetX = Math.round(anchorX * Math.max(0, snapW - w));
      const offsetY = Math.round(anchorY * Math.max(0, snapH - h));
      tmp.fov = src.fov;
      tmp.aspect = snapW / snapH;
      tmp.setViewOffset(snapW, snapH, offsetX, offsetY, w, h);
    } else {
      tmp.fov = src.fov;
      tmp.aspect = w / h;
      if (tmp.view) tmp.clearViewOffset();
    }
    tmp.updateProjectionMatrix();
    cam = tmp;
  }
  v._thumbRenderer!.setClearColor(displayMode === "technical" ? 0xffffff : 0x808080, 1);
  v._thumbRenderer!.localClippingEnabled = v.renderer.localClippingEnabled;
  const prevOverride = v.scene.overrideMaterial;
  if (displayMode === "wireframe") {
    if (!v._thumbMatWireframe) v._thumbMatWireframe = new THREE.MeshBasicMaterial({ color: 0x2a2a3a, wireframe: true });
    v.scene.overrideMaterial = v._thumbMatWireframe;
  } else if (displayMode === "ghosted") {
    if (!v._thumbMatGhosted) v._thumbMatGhosted = new THREE.MeshBasicMaterial({ color: 0x9ec5d8, transparent: true, opacity: 0.28, side: THREE.DoubleSide });
    v.scene.overrideMaterial = v._thumbMatGhosted;
  }
  const activeClips = [...v._sectionPlanes, ...v._clipPlanes];
  if (v._thumbMatWireframe) v._thumbMatWireframe.clippingPlanes = activeClips;
  if (v._thumbMatGhosted)   v._thumbMatGhosted.clippingPlanes   = activeClips;
  const needUndraftForThumb = displayMode !== "technical" && isDrafting(v.scene);
  const thumbRenderer = v._thumbRenderer!;
  const gizmoWasVisible = v.gizmos.map(g => g.visible);
  v.gizmos.forEach(g => { g.visible = false; });
  const axesWasVisible = v.axes.visible;
  const axisLabelWasVisible = v.axisLabels.map(s => s.visible);
  const gridWasVisible = v.grid.visible;
  v.axes.visible = false;
  v.axisLabels.forEach(s => { s.visible = false; });
  v.grid.visible = false;
  const clipMeshes: Array<{ obj: THREE.Object3D; wasVisible: boolean }> = [];
  v.scene.traverse((obj) => {
    const kind = obj.userData.kind as string | undefined;
    if (kind === "clip-plane" || kind === "section-box") {
      clipMeshes.push({ obj, wasVisible: obj.visible });
      obj.visible = false;
    }
  });
  thumbRenderer.localClippingEnabled = v._sectionPlanes.length > 0 || v._clipPlanes.length > 0;
  if (needUndraftForThumb) {
    withoutDrafting(v.scene, () => thumbRenderer.render(v.scene, cam));
  } else {
    thumbRenderer.render(v.scene, cam);
  }
  clipMeshes.forEach(({ obj, wasVisible }) => { obj.visible = wasVisible; });
  v.gizmos.forEach((g, i) => { g.visible = gizmoWasVisible[i]; });
  v.axes.visible = axesWasVisible;
  v.axisLabels.forEach((s, i) => { s.visible = axisLabelWasVisible[i]; });
  v.grid.visible = gridWasVisible;
  v.scene.overrideMaterial = prevOverride;
  const ctx = dest.getContext("2d");
  if (ctx) ctx.drawImage(v._thumbCanvas!, 0, 0, w, h);
}

function buildExcludeSet(v: Viewer): Set<THREE.Object3D> {
  const s = new Set<THREE.Object3D>();
  for (const g of v.gizmos) g.traverse((o) => s.add(o));
  if (v.pivotProxy) v.pivotProxy.traverse((o) => s.add(o));
  v._cplaneGizmo.group.traverse((o) => s.add(o));
  v.grid.traverse((o) => s.add(o));
  v.axes.traverse((o) => s.add(o));
  return s;
}

function buildCamera(pane: { camera: THREE.Camera; el: HTMLElement }, panelW: number, panelH: number): THREE.Camera {
  if (pane.camera instanceof THREE.OrthographicCamera) {
    const src = pane.camera;
    const worldTop    = src.top    || 5;
    const worldBottom = src.bottom || -5;
    const worldH = worldTop - worldBottom;
    const half = worldH / 2;
    const tmp = new THREE.OrthographicCamera(
      -half * panelW / panelH, half * panelW / panelH,
      worldTop, worldBottom, src.near, src.far,
    );
    tmp.position.copy(src.position);
    tmp.quaternion.copy(src.quaternion);
    tmp.updateProjectionMatrix();
    return tmp;
  } else {
    const src = pane.camera as THREE.PerspectiveCamera;
    const tmp = src.clone() as THREE.PerspectiveCamera;
    tmp.aspect = panelW / panelH;
    tmp.updateProjectionMatrix();
    return tmp;
  }
}

export function getEdgeSegmentsForView(v: Viewer, view: string, panelW: number, panelH: number): [number, number, number, number][] {
  const pane = v.panes.find(p => p.view === view);
  if (!pane || panelW < 1 || panelH < 1) return [];
  const cam = buildCamera(pane, panelW, panelH);
  const planes = [...v._sectionPlanes, ...v._clipPlanes];
  const projMat = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const segments: [number, number, number, number][] = [];
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const _noExport = buildExcludeSet(v);
  v.scene.updateMatrixWorld(false);
  v.scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (_noExport.has(child) || child.userData.noRenderMode) return;
    const geom = (mesh.geometry as THREE.BufferGeometry | undefined);
    if (!geom?.attributes.position) return;
    const edges = new THREE.EdgesGeometry(geom, 25);
    const pos = edges.attributes.position.array as Float32Array;
    const mat4 = mesh.matrixWorld;
    for (let i = 0; i < pos.length; i += 6) {
      tmpA.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(mat4);
      tmpB.set(pos[i + 3], pos[i + 4], pos[i + 5]).applyMatrix4(mat4);
      const clipped = clipSegByPlanes(tmpA, tmpB, planes);
      if (!clipped) continue;
      const a2 = worldToPanelXY(clipped[0], projMat, panelW, panelH);
      const b2 = worldToPanelXY(clipped[1], projMat, panelW, panelH);
      if (!a2 || !b2) continue;
      segments.push([a2[0], a2[1], b2[0], b2[1]]);
    }
    edges.dispose();
  });
  return segments;
}

export function getFacePolygonsForView(v: Viewer, view: string, panelW: number, panelH: number): ExportFacePoly[] {
  const pane = v.panes.find(p => p.view === view);
  if (!pane || panelW < 1 || panelH < 1) return [];
  const cam = buildCamera(pane, panelW, panelH);
  const projMat = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const viewDir = new THREE.Vector3();
  cam.getWorldDirection(viewDir);
  const _noExport = buildExcludeSet(v);
  const polys: ExportFacePoly[] = [];
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  v.scene.updateMatrixWorld(false);
  v.scene.traverse((child) => {
    if (_noExport.has(child) || child.userData.noRenderMode) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom?.attributes.position) return;
    const creator = (mesh.userData as { creator?: string }).creator;
    const fill = exportFillForCreator(creator);
    const mat4 = mesh.matrixWorld;
    const pos = geom.attributes.position.array as Float32Array;
    const idx = geom.index?.array as Uint32Array | Uint16Array | undefined;
    const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(pos.length / 9);
    for (let t = 0; t < triCount; t++) {
      let ai: number, bi: number, ci: number;
      if (idx) {
        ai = idx[t * 3] * 3;
        bi = idx[t * 3 + 1] * 3;
        ci = idx[t * 3 + 2] * 3;
      } else {
        ai = t * 9; bi = t * 9 + 3; ci = t * 9 + 6;
      }
      tmpA.set(pos[ai], pos[ai + 1], pos[ai + 2]).applyMatrix4(mat4);
      tmpB.set(pos[bi], pos[bi + 1], pos[bi + 2]).applyMatrix4(mat4);
      tmpC.set(pos[ci], pos[ci + 1], pos[ci + 2]).applyMatrix4(mat4);
      tmpN.crossVectors(tmpB.clone().sub(tmpA), tmpC.clone().sub(tmpA));
      if (tmpN.dot(viewDir) > 0) continue;
      const a2 = worldToPanelXY(tmpA, projMat, panelW, panelH);
      const b2 = worldToPanelXY(tmpB, projMat, panelW, panelH);
      const c2 = worldToPanelXY(tmpC, projMat, panelW, panelH);
      if (!a2 || !b2 || !c2) continue;
      polys.push({ pts: [a2, b2, c2], fill });
    }
  });
  return polys;
}

export function getClassifiedEdgeSegmentsForView(v: Viewer, view: string, panelW: number, panelH: number): ClassifiedEdgeSeg[] {
  const pane = v.panes.find(p => p.view === view);
  if (!pane || panelW < 1 || panelH < 1) return [];
  const cam = buildCamera(pane, panelW, panelH);
  const projMat = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const viewDir = new THREE.Vector3();
  cam.getWorldDirection(viewDir);
  const sectionPlanes = [...v._sectionPlanes, ...v._clipPlanes];
  const _noExport = buildExcludeSet(v);
  const out: ClassifiedEdgeSeg[] = [];
  v.scene.updateMatrixWorld(false);
  v.scene.traverse((child) => {
    if (_noExport.has(child) || child.userData.noRenderMode) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom?.attributes.position) return;
    const segs = classifyMeshEdges(geom, mesh.matrixWorld, projMat, viewDir, panelW, panelH, sectionPlanes);
    for (const s of segs) out.push(s);
  });
  return out;
}

export function exportFillForCreator(creator: string | undefined): string {
  switch (creator) {
    case "wall":
    case "column":
    case "beam":       return "#1a1a22";
    case "slab":
    case "foundation": return "#55555f";
    case "roof":       return "#8888a0";
    default:           return "#d8d8e0";
  }
}
