// Create-mode click-to-place pipeline (T4 Phase 3).
//
// When a tool button in the left palette is active (Line / Rect / Circle /
// Wall / Slab / Column / Door / Window / etc.), viewport mousedown becomes a
// sketch event. This module wires the active-tool state, captures clicks,
// unprojects them to world coords on the XY plane (z=0 per
// docs/tier1-conventions.md), runs the per-tool handler, builds the matching
// Three.js mesh, and pushes a replicad-chain string into the construction
// sequence.
//
// What is fully wired (working):
//   - Wall, Rect, Circle, Line, Door, Window, Slab, Column
//
// What is stubbed (logs to console, awaits parent task to wire kernel call):
//   - Polyline, Polygon, Arc, Spline, Stair, Extrude, Revolve

import * as THREE from "three";
import type { Viewer } from "./viewer";
import { setState } from "./app-state";
import { snapPoint } from "./snap-state";

// Default heights / sizes from tier1-conventions.
const DEFAULT_WALL_HEIGHT = 3;
const DEFAULT_WALL_THICKNESS = 0.2;
const DEFAULT_SLAB_THICKNESS = 0.2;
const DEFAULT_COLUMN_HEIGHT = 4;
const DEFAULT_RECT_HEIGHT = 2.8;
const DEFAULT_DOOR_W = 0.9;
const DEFAULT_DOOR_H = 2.1;
const DEFAULT_WINDOW_W = 1.2;
const DEFAULT_WINDOW_H = 1.4;
const DEFAULT_WINDOW_SILL = 1.0;

// Append-only construction sequence.
const _createSequence: string[] = [];

export function getCreateSequence(): string[] {
  return [..._createSequence];
}

export function clearCreateSequence(): void {
  _createSequence.length = 0;
}

// Pending click buffer
let _pending: Array<{ x: number; y: number }> = [];
// Temporary scene objects — removed when the tool completes or is cancelled.
let _previewMesh: THREE.Mesh | null = null;
let _markerMesh: THREE.Mesh | null = null;
// Viewer reference set once by initCreateMode — used by resetPending.
let _viewer: Viewer | null = null;

function readActiveTool(): string | null {
  const btn = document.querySelector<HTMLElement>(".palette-btn.active");
  const id = btn?.dataset.tool ?? null;
  if (!id || id === "select" || id === "move" || id === "rotate" || id === "scale") return null;
  return id;
}

// Unproject canvas-space (px) to world coords on the XY plane (z=0).
function unprojectToXY(viewer: Viewer, clientX: number, clientY: number): THREE.Vector3 | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const camera = viewer.getCamera();
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera as THREE.PerspectiveCamera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const point = new THREE.Vector3();
  const hit = raycaster.ray.intersectPlane(plane, point);
  return hit ? point : null;
}

// --- Tool handlers ---

function buildWall(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const t = DEFAULT_WALL_THICKNESS;
  const h = DEFAULT_WALL_HEIGHT;
  const geom = new THREE.BoxGeometry(length, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(midX, midY, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "wall";
  const chain = `const wall = makeBox(${round(length)}, ${round(t)}, ${round(h)}).rotate(${round(angDeg)}, [0, 0, 0], [0, 0, 1]).translate([${round(midX)}, ${round(midY)}, 0]);`;
  return { mesh, chain };
}

function buildRect(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x);
  const d = Math.abs(b.y - a.y);
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const h = DEFAULT_RECT_HEIGHT;
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9b18a, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "rect";
  const chain = `const rect = drawRectangle(${round(w)}, ${round(d)}).sketchOnPlane("XY").extrude(${round(h)}).translate([${round(cx)}, ${round(cy)}, 0]);`;
  return { mesh, chain };
}

function buildCircle(center: { x: number; y: number }, radial: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = radial.x - center.x;
  const dy = radial.y - center.y;
  const r = Math.max(0.05, Math.sqrt(dx * dx + dy * dy));
  const h = DEFAULT_RECT_HEIGHT;
  const geom = new THREE.CylinderGeometry(r, r, h, 32);
  geom.rotateX(Math.PI / 2);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xb6d59a, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(center.x, center.y, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "circle";
  const chain = `const cyl = makeCylinder(${round(r)}, ${round(h)}).translate([${round(center.x)}, ${round(center.y)}, 0]);`;
  return { mesh, chain };
}

function buildLine(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const w = Math.max(length, 0.001);
  const t = 0.02;
  const h = 0.001;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x0e0e10 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(midX, midY, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "line";
  const chain = `const line = drawPolyline([[${round(a.x)}, ${round(a.y)}], [${round(b.x)}, ${round(b.y)}]]).sketchOnPlane("XY").extrude(0.001);`;
  return { mesh, chain };
}

function buildDoor(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = DEFAULT_DOOR_W;
  const t = DEFAULT_WALL_THICKNESS;
  const h = DEFAULT_DOOR_H;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff5c5c, transparent: true, opacity: 0.4 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, 0);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "door";
  const chain = `// door: cut against host wall — wall.cut(makeBox(${round(w)}, ${round(t)}, ${round(h)}).translate([${round(p.x)}, ${round(p.y)}, 0]))`;
  return { mesh, chain };
}

function buildWindow(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = DEFAULT_WINDOW_W;
  const t = DEFAULT_WALL_THICKNESS;
  const h = DEFAULT_WINDOW_H;
  const sill = DEFAULT_WINDOW_SILL;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x5b8def, transparent: true, opacity: 0.4 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, sill);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "window";
  const chain = `// window: cut against host wall — wall.cut(makeBox(${round(w)}, ${round(t)}, ${round(h)}).translate([${round(p.x)}, ${round(p.y)}, ${round(sill)}]))`;
  return { mesh, chain };
}

function buildSlab(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x);
  const d = Math.abs(b.y - a.y);
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const t = DEFAULT_SLAB_THICKNESS;
  const geom = new THREE.BoxGeometry(w, d, t);
  geom.translate(0, 0, t / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xa8a097, roughness: 0.7, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "slab";
  const chain = `const slab = drawRectangle(${round(w)}, ${round(d)}).sketchOnPlane("XY").extrude(${round(t)}).translate([${round(cx)}, ${round(cy)}, 0]);`;
  return { mesh, chain };
}

function buildColumn(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const s = 0.3;
  const h = DEFAULT_COLUMN_HEIGHT;
  const geom = new THREE.BoxGeometry(s, s, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd1c5b0, roughness: 0.6, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "column";
  const chain = `const col = drawRectangle(${round(s)}, ${round(s)}).sketchOnPlane("XY").extrude(${round(h)}).translate([${round(p.x)}, ${round(p.y)}, 0]);`;
  return { mesh, chain };
}

type ToolHandler = {
  clicks: number;
  handler: (pts: Array<{ x: number; y: number }>) => { mesh: THREE.Mesh; chain: string };
};

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  wall:   { clicks: 2, handler: ([a, b]) => buildWall(a, b) },
  rect:   { clicks: 2, handler: ([a, b]) => buildRect(a, b) },
  circle: { clicks: 2, handler: ([a, b]) => buildCircle(a, b) },
  line:   { clicks: 2, handler: ([a, b]) => buildLine(a, b) },
  slab:   { clicks: 2, handler: ([a, b]) => buildSlab(a, b) },
  door:   { clicks: 1, handler: ([p]) => buildDoor(p) },
  window: { clicks: 1, handler: ([p]) => buildWindow(p) },
  column: { clicks: 1, handler: ([p]) => buildColumn(p) },
};

const TOOL_TODOS: Record<string, string> = {
  polyline:  "drawPolyline(pts).sketchOnPlane('XY').extrude(thickness)",
  polygon:   "drawPolyline(N-vertex regular polygon).sketchOnPlane('XY').extrude(h)",
  arc:       "draw(start).arcTo(end, [via]).sketchOnPlane('XY').extrude(thickness)",
  spline:    "draw(start).bezierTo(end, [c1], [c2]).sketchOnPlane('XY').extrude(thickness)",
  stair:     "compound of risers + treads — needs a multi-segment kernel call",
  extrude:   "select profile then height — TODO 2-step gizmo flow",
  revolve:   "select profile then axis then angle — TODO 3-step gizmo flow",
  fillet:    "select edges, set radius — TODO post-selection edit op",
  boolean:   "select two solids, choose op (fuse/cut/intersect)",
  move:      "select then drag — already covered by transform gizmo",
  rotate:    "select then drag — already covered by transform gizmo",
  scale:     "select then drag — already covered by transform gizmo",
};

// --- Temporary scene object management ---

function setMarker(viewer: Viewer, pt: { x: number; y: number }): void {
  clearMarker(viewer);
  const geom = new THREE.SphereGeometry(0.06, 8, 8);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff8800, depthTest: false });
  _markerMesh = new THREE.Mesh(geom, mat);
  _markerMesh.position.set(pt.x, pt.y, 0.05);
  _markerMesh.renderOrder = 999;
  viewer.getScene().add(_markerMesh);
}

function clearMarker(viewer: Viewer): void {
  if (!_markerMesh) return;
  viewer.getScene().remove(_markerMesh);
  _markerMesh.geometry.dispose();
  (_markerMesh.material as THREE.Material).dispose();
  _markerMesh = null;
}

function clearPreview(viewer: Viewer): void {
  if (!_previewMesh) return;
  viewer.getScene().remove(_previewMesh);
  _previewMesh.geometry.dispose();
  const mat = _previewMesh.material;
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else (mat as THREE.Material).dispose();
  _previewMesh = null;
}

function clearTemporary(viewer: Viewer): void {
  clearPreview(viewer);
  clearMarker(viewer);
}

function updateRubberBand(viewer: Viewer, handler: ToolHandler, livePoint: { x: number; y: number }): void {
  clearPreview(viewer);
  if (_pending.length !== 1) return;

  // Skip degenerate preview (cursor on top of first click).
  const dx = livePoint.x - _pending[0].x;
  const dy = livePoint.y - _pending[0].y;
  if (dx * dx + dy * dy < 1e-4) return;

  try {
    const out = handler.handler([_pending[0], livePoint]);
    const preview = out.mesh;
    // Replace material with translucent preview version.
    const origMat = Array.isArray(preview.material) ? preview.material[0] : preview.material;
    const previewMat = new THREE.MeshStandardMaterial({
      color: (origMat as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color(0x888888),
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    if (Array.isArray(preview.material)) {
      preview.material.forEach((m) => m.dispose());
    } else {
      (preview.material as THREE.Material).dispose();
    }
    preview.material = previewMat;
    _previewMesh = preview;
    viewer.getScene().add(preview);
  } catch {
    // Degenerate geometry — skip preview
  }
}

// Test hook — emit a click programmatically given world-space coords.
export function emitClickWorld(viewer: Viewer, world: { x: number; y: number }, opts?: { tool?: string }): { mesh: THREE.Mesh; chain: string } | null {
  const tool = opts?.tool ?? readActiveTool();
  if (!tool) return null;
  const handler = TOOL_HANDLERS[tool];
  if (!handler) {
    const todo = TOOL_TODOS[tool] ?? "no kernel mapping yet";
    console.log(`[create-mode] tool '${tool}' is TODO — ${todo}`);
    return null;
  }
  _pending.push(world);
  // Show point marker on first click of a multi-click tool.
  if (_pending.length === 1 && handler.clicks > 1) {
    setMarker(viewer, world);
  }
  if (_pending.length < handler.clicks) return null;

  // All clicks collected — build final mesh.
  clearTemporary(viewer);
  const out = handler.handler(_pending);
  _pending = [];
  viewer.addMesh(out.mesh, out.mesh.userData.kind ?? "brep");
  _createSequence.push(out.chain);
  return out;
}

// Reset pending click buffer — used when switching tools.
export function resetPending(): void {
  if (_viewer) clearTemporary(_viewer);
  _pending = [];
}

// Bind the create-mode pipeline to viewport mousedown. Coexists with the
// selection raycaster — when no create-tool is active, mousedown just falls
// through to viewer.onPointerDown for selection.
export function initCreateMode(viewer: Viewer): void {
  _viewer = viewer;
  const canvas = viewer.getCanvas();

  // Capture-phase listener — runs before the viewer's own pointerdown so we
  // can swallow the event when a create-tool is active.
  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const tool = readActiveTool();
    if (!tool) return;
    const world = unprojectToXY(viewer, ev.clientX, ev.clientY);
    if (!world) return;
    ev.stopImmediatePropagation();
    const snapped = snapPoint(world.x, world.y);
    emitClickWorld(viewer, snapped, { tool });
  }, { capture: true });

  // Rubber-band preview: update preview mesh as cursor moves between clicks.
  canvas.addEventListener("pointermove", (ev) => {
    if (_pending.length === 0) return;
    const tool = readActiveTool();
    if (!tool) return;
    const handler = TOOL_HANDLERS[tool];
    if (!handler || handler.clicks < 2) return;
    const world = unprojectToXY(viewer, ev.clientX, ev.clientY);
    if (!world) return;
    const snapped = snapPoint(world.x, world.y);
    updateRubberBand(viewer, handler, snapped);
  });

  // Esc cancels the in-progress placement.
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && _pending.length > 0) {
      clearTemporary(viewer);
      _pending = [];
      setState("activeTool", "select");
    }
  });

  // Reset pending buffer when palette tool changes.
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement | null;
    if (!t) return;
    if (t.closest(".palette-btn")) {
      resetPending();
    }
  }, { capture: true });
}

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}
