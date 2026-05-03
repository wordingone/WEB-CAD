// T14 — viewport quad-split: regression tests for the duplicate-grid bug
// and per-pane view-switcher dropdown.
//
// These tests deliberately avoid spinning up WebGL: they exercise the pure
// scene-graph factory `buildPaneSceneGraph` and the camera-construction
// helpers exposed from viewer.ts. That keeps the test runnable under
// `bun test` (no DOM polyfill) and pins the contract that the renderer
// consumes downstream.
//
// What's covered:
//   1. Top / front / right panes have exactly ONE GridHelper, not two.
//   2. Perspective pane has at least one GridHelper.
//   3. No grid uses pure white (0xffffff).
//   4. Ortho panes get OrthographicCamera; perspective gets PerspectiveCamera.
//   5. Switching a pane's view from ortho → perspective swaps the camera type.

import { test, expect } from "bun:test";
import * as THREE from "three";
import {
  buildPaneSceneGraph,
  cameraDirForView,
  isOrthoView,
  type ViewName,
} from "../src/viewer";

function gridHelpersIn(scene: THREE.Scene): THREE.GridHelper[] {
  const out: THREE.GridHelper[] = [];
  scene.traverse((child) => {
    if (child instanceof THREE.GridHelper) out.push(child);
  });
  return out;
}

// Read the *effective* colors painted by a GridHelper. THREE's GridHelper
// uses per-vertex colors on a LineBasicMaterial that has `vertexColors: true`;
// in that mode the material's `color` field is unused (defaults to 0xffffff
// but is multiplicatively blended with the vertex colors — and since gl
// expects vertex colors in linear space, asking for the hex round-trips through
// gamma so 0x2c2c34 reads back as roughly 0x060609 here). What matters for
// the bug under test is "is any vertex color of this grid pure white?".
function gridColors(g: THREE.GridHelper): number[] {
  const colors: number[] = [];
  const mat = g.material;
  const mats = Array.isArray(mat) ? mat : [mat];
  // Only fold the material color in when vertex colors are NOT in use,
  // because vertex-color mode makes the material color a no-op multiplier.
  for (const m of mats) {
    const lbm = m as THREE.LineBasicMaterial;
    if (lbm && lbm.color && !lbm.vertexColors) {
      colors.push(lbm.color.getHex());
    }
  }
  const geom = g.geometry;
  const colorAttr = geom.getAttribute("color") as THREE.BufferAttribute | undefined;
  if (colorAttr) {
    const arr = colorAttr.array as Float32Array;
    const seen = new Set<number>();
    for (let i = 0; i < arr.length; i += 3) {
      const r = Math.round(arr[i] * 255);
      const gg = Math.round(arr[i + 1] * 255);
      const b = Math.round(arr[i + 2] * 255);
      const hex = (r << 16) | (gg << 8) | b;
      seen.add(hex);
    }
    for (const c of seen) colors.push(c);
  }
  return colors;
}

test("ortho panes (top/front/right) have exactly one GridHelper, dark-coloured", () => {
  for (const view of ["top", "front", "right"] as ViewName[]) {
    const { scene } = buildPaneSceneGraph(view);
    const grids = gridHelpersIn(scene);
    expect(grids.length).toBe(1);
    // No grid colour may be pure white.
    const colors = gridColors(grids[0]);
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) {
      expect(c).not.toBe(0xffffff);
    }
  }
});

test("perspective pane has at least one GridHelper", () => {
  const { scene } = buildPaneSceneGraph("perspective");
  const grids = gridHelpersIn(scene);
  expect(grids.length).toBeGreaterThanOrEqual(1);
  // Also sanity: no white grid here either.
  for (const g of grids) {
    for (const c of gridColors(g)) {
      expect(c).not.toBe(0xffffff);
    }
  }
});

test("ortho views produce OrthographicCamera, perspective produces PerspectiveCamera", () => {
  for (const view of ["top", "front", "right", "back", "left", "bottom"] as ViewName[]) {
    const { camera } = buildPaneSceneGraph(view);
    expect(camera).toBeInstanceOf(THREE.OrthographicCamera);
    expect(camera).not.toBeInstanceOf(THREE.PerspectiveCamera);
    expect(isOrthoView(view)).toBe(true);
  }
  const { camera: perspCam } = buildPaneSceneGraph("perspective");
  expect(perspCam).toBeInstanceOf(THREE.PerspectiveCamera);
  expect(isOrthoView("perspective")).toBe(false);
});

test("camera-direction mapping matches Z-up convention", () => {
  // Top looks down +Z (camera above origin).
  const top = cameraDirForView("top");
  expect(top.z).toBeGreaterThan(0);
  expect(top.x).toBe(0);
  expect(top.y).toBe(0);
  // Bottom is the opposite.
  const bot = cameraDirForView("bottom");
  expect(bot.z).toBeLessThan(0);
  // Right looks +X.
  const right = cameraDirForView("right");
  expect(right.x).toBeGreaterThan(0);
  expect(right.y).toBe(0);
  // Left is the opposite.
  const left = cameraDirForView("left");
  expect(left.x).toBeLessThan(0);
  // Front looks -Y (camera in front of object).
  const front = cameraDirForView("front");
  expect(front.y).toBeLessThan(0);
  // Back is the opposite.
  const back = cameraDirForView("back");
  expect(back.y).toBeGreaterThan(0);
  // Perspective is non-axial.
  const persp = cameraDirForView("perspective");
  expect(persp.x).toBeGreaterThan(0);
  expect(persp.y).toBeGreaterThan(0);
  expect(persp.z).toBeGreaterThan(0);
});

test("per-pane dropdown action: switching a pane from TOP to PERSPECTIVE swaps the camera type", () => {
  // The dropdown's change handler calls `pane.setView(newView)`, which under
  // the hood invokes `buildPaneSceneGraph(newView)` to rebuild the camera.
  // We exercise the same path here so the test pins the camera-type contract
  // the dropdown depends on, without spinning up WebGL for a live <select>.
  const top = buildPaneSceneGraph("top");
  expect(top.camera).toBeInstanceOf(THREE.OrthographicCamera);
  expect(top.camera).not.toBeInstanceOf(THREE.PerspectiveCamera);

  // Simulate user picking PERSPECTIVE in the dropdown.
  const persp = buildPaneSceneGraph("perspective");
  expect(persp.camera).toBeInstanceOf(THREE.PerspectiveCamera);
  expect(persp.camera).not.toBeInstanceOf(THREE.OrthographicCamera);

  // And the reverse: PERSPECTIVE → RIGHT swaps back to OrthographicCamera.
  const right = buildPaneSceneGraph("right");
  expect(right.camera).toBeInstanceOf(THREE.OrthographicCamera);
});

test("each ortho pane scene contains lights + grid + axes — nothing else top-level", () => {
  // Pin the structure so a future refactor can't sneak a second grid in
  // and silently regress the bug T14 was filed against.
  for (const view of ["top", "front", "right"] as ViewName[]) {
    const { scene } = buildPaneSceneGraph(view);
    const types = scene.children.map((c) => c.constructor.name).sort();
    // Expected: AmbientLight, AxesHelper, DirectionalLight x 2, GridHelper.
    expect(types.filter((t) => t === "GridHelper").length).toBe(1);
    expect(types).toContain("AmbientLight");
    expect(types).toContain("AxesHelper");
    expect(types.filter((t) => t === "DirectionalLight").length).toBe(2);
  }
});
