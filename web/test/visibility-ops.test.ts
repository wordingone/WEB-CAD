// Visibility ops: SdHide, SdShow, SdLock, SdUnlock
// Tests: schema presence, synonym routing, handler round-trips, error paths.

import { beforeEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import { dispatchSync, unregisterHandler, resolveVerb } from "../src/commands/dispatch";
import { getDictionary } from "../src/commands/dictionary";
import { drawingLayerStore } from "../src/geometry/drawing-layers";
import { registerVisibilityHandlers } from "../src/handlers/visibility";

function makeViewer() {
  const scene = new THREE.Scene();
  const viewer = {
    activeView: "top",
    getScene: () => scene,
    getCanvas: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) }),
    getActiveCamera: () => { const c = new THREE.PerspectiveCamera(45, 1, 0.01, 1000); c.position.set(4, 4, 4); c.lookAt(0, 0, 0); return c; },
    addMesh: (obj: THREE.Object3D, kind?: string) => {
      if (kind) obj.userData.kind = kind;
      scene.add(obj);
      return obj;
    },
    deleteSelected: () => false,
    isolate: () => true,
    isolateOff: () => {},
    frameObjectOnly: () => {},
    clearClippingPlanes: () => {},
    addClippingPlane: () => {},
    setView: () => {},
    forEachSceneChild: (cb: (o: THREE.Object3D) => void) => scene.traverse(cb),
  } as never;
  return { viewer, scene };
}

beforeEach(() => {
  for (const name of ["SdHide", "SdShow", "SdLock", "SdUnlock"]) {
    unregisterHandler(name);
  }
  // Reset Layer 1 to unlocked
  const l = drawingLayerStore.all().find(l => l.name === "Layer 1");
  if (l) drawingLayerStore.setLocked(l.id, false);
  document.body.innerHTML = "";
});

// ── Schema ──────────────────────────────────────────────────────────────────

describe("schema presence", () => {
  for (const name of ["SdHide", "SdShow", "SdLock", "SdUnlock"]) {
    test(`${name} is in dictionary`, () => {
      expect(getDictionary().find(e => e.name === name)).toBeDefined();
    });
    test(`${name} requires target`, () => {
      expect(getDictionary().find(e => e.name === name)?.parameters.required).toContain("target");
    });
  }
});

describe("synonym routing", () => {
  test("'hide' resolves to SdHide", () => { expect(resolveVerb("hide")).toBe("SdHide"); });
  test("'conceal' resolves to SdHide", () => { expect(resolveVerb("conceal")).toBe("SdHide"); });
  test("'show' resolves to SdShow", () => { expect(resolveVerb("show")).toBe("SdShow"); });
  test("'unhide' resolves to SdShow", () => { expect(resolveVerb("unhide")).toBe("SdShow"); });
  test("'reveal' resolves to SdShow", () => { expect(resolveVerb("reveal")).toBe("SdShow"); });
  test("'lock' resolves to SdLock", () => { expect(resolveVerb("lock")).toBe("SdLock"); });
  test("'freeze' resolves to SdLock", () => { expect(resolveVerb("freeze")).toBe("SdLock"); });
  test("'unlock' resolves to SdUnlock", () => { expect(resolveVerb("unlock")).toBe("SdUnlock"); });
  test("'unfreeze' resolves to SdUnlock", () => { expect(resolveVerb("unfreeze")).toBe("SdUnlock"); });
});

// ── SdHide / SdShow ──────────────────────────────────────────────────────────

describe("SdHide handler", () => {
  test("hides object by uuid — obj.visible=false, userData.hidden=true", () => {
    const { viewer, scene } = makeViewer();
    registerVisibilityHandlers(viewer);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    scene.add(mesh);
    expect(mesh.visible).toBe(true);

    const dr = dispatchSync("SdHide", { target: mesh.uuid });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdHide failed");
    expect(mesh.visible).toBe(false);
    expect(mesh.userData.hidden).toBe(true);
    expect((dr.result as { uuid: string }).uuid).toBe(mesh.uuid);
  });

  test("returns error for unknown uuid", () => {
    const { viewer } = makeViewer();
    registerVisibilityHandlers(viewer);
    const dr = dispatchSync("SdHide", { target: "00000000-dead-beef-0000-000000000000" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch unexpectedly failed");
    expect((dr.result as { error?: string }).error).toMatch(/not found/);
  });

  test("returns error when target missing", () => {
    const { viewer } = makeViewer();
    registerVisibilityHandlers(viewer);
    const dr = dispatchSync("SdHide", {});
    expect(dr.ok).toBe(false); // schema validation rejects missing required field
  });
});

describe("SdShow handler", () => {
  test("shows a previously hidden object", () => {
    const { viewer, scene } = makeViewer();
    registerVisibilityHandlers(viewer);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.visible = false;
    mesh.userData.hidden = true;
    scene.add(mesh);

    const dr = dispatchSync("SdShow", { target: mesh.uuid });
    expect(dr.ok).toBe(true);
    expect(mesh.visible).toBe(true);
    expect(mesh.userData.hidden).toBe(false);
  });

  test("SdShow target='all' reveals all hidden objects", () => {
    const { viewer, scene } = makeViewer();
    registerVisibilityHandlers(viewer);
    const m1 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const m2 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    m1.visible = false; m1.userData.hidden = true;
    m2.visible = false; m2.userData.hidden = true;
    scene.add(m1, m2);

    const dr = dispatchSync("SdShow", { target: "all" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdShow all failed");
    expect((dr.result as { revealed: number }).revealed).toBe(2);
    expect(m1.visible).toBe(true);
    expect(m2.visible).toBe(true);
    expect(m1.userData.hidden).toBe(false);
    expect(m2.userData.hidden).toBe(false);
  });

  test("SdHide + SdShow round-trips visibility correctly", () => {
    const { viewer, scene } = makeViewer();
    registerVisibilityHandlers(viewer);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    scene.add(mesh);

    dispatchSync("SdHide", { target: mesh.uuid });
    expect(mesh.visible).toBe(false);

    dispatchSync("SdShow", { target: mesh.uuid });
    expect(mesh.visible).toBe(true);
    expect(mesh.userData.hidden).toBe(false);
  });

  test("returns error for unknown uuid", () => {
    const { viewer } = makeViewer();
    registerVisibilityHandlers(viewer);
    const dr = dispatchSync("SdShow", { target: "00000000-dead-beef-0000-000000000000" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch unexpectedly failed");
    expect((dr.result as { error?: string }).error).toMatch(/not found/);
  });
});

// ── SdLock / SdUnlock ────────────────────────────────────────────────────────

describe("SdLock handler", () => {
  test("locks a layer by name", () => {
    const { viewer } = makeViewer();
    registerVisibilityHandlers(viewer);
    const dr = dispatchSync("SdLock", { target: "Layer 1" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdLock failed");
    const layer = drawingLayerStore.all().find(l => l.name === "Layer 1");
    expect(layer?.locked).toBe(true);
    expect((dr.result as { layer_name: string }).layer_name).toBe("Layer 1");
  });

  test("locks a layer by id", () => {
    const { viewer } = makeViewer();
    registerVisibilityHandlers(viewer);
    const layer = drawingLayerStore.all()[0]!;
    drawingLayerStore.setLocked(layer.id, false);
    const dr = dispatchSync("SdLock", { target: layer.id });
    expect(dr.ok).toBe(true);
    expect(drawingLayerStore.get(layer.id)?.locked).toBe(true);
  });

  test("returns error for unknown layer", () => {
    const { viewer } = makeViewer();
    registerVisibilityHandlers(viewer);
    const dr = dispatchSync("SdLock", { target: "NonExistentLayer" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch unexpectedly failed");
    expect((dr.result as { error?: string }).error).toMatch(/not found/);
  });
});

describe("SdUnlock handler", () => {
  test("unlocks a locked layer by name", () => {
    const { viewer } = makeViewer();
    registerVisibilityHandlers(viewer);
    const layer = drawingLayerStore.all().find(l => l.name === "Layer 1")!;
    drawingLayerStore.setLocked(layer.id, true);
    expect(layer.locked).toBe(true);

    const dr = dispatchSync("SdUnlock", { target: "Layer 1" });
    expect(dr.ok).toBe(true);
    expect(layer.locked).toBe(false);
  });

  test("SdLock + SdUnlock round-trips", () => {
    const { viewer } = makeViewer();
    registerVisibilityHandlers(viewer);
    const layer = drawingLayerStore.all().find(l => l.name === "Layer 1")!;
    drawingLayerStore.setLocked(layer.id, false);

    dispatchSync("SdLock", { target: "Layer 1" });
    expect(layer.locked).toBe(true);

    dispatchSync("SdUnlock", { target: "Layer 1" });
    expect(layer.locked).toBe(false);
  });

  test("returns error for unknown layer", () => {
    const { viewer } = makeViewer();
    registerVisibilityHandlers(viewer);
    const dr = dispatchSync("SdUnlock", { target: "GhostLayer" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch unexpectedly failed");
    expect((dr.result as { error?: string }).error).toMatch(/not found/);
  });
});
