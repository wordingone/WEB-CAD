// SELECTION/QUERY ops: SdDeselect, SdQuery, SdMeasure, SdMeasureBetween
// SdSelect / SdSelectAll / SdSelectByQuery already tested via transforms.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import { dispatchSync, unregisterHandler, resolveVerb } from "../src/commands/dispatch";
import { getDictionary } from "../src/commands/dictionary";
import { drawingLayerStore } from "../src/geometry/drawing-layers";
import { setSelected, clearSelected, getSelected } from "../src/viewer/selection-state";
import { registerSelectionQueryHandlers } from "../src/handlers/selection-query";
import { registerTransformHandlers } from "../src/handlers/transforms";

function makeViewer() {
  const scene = new THREE.Scene();
  const viewer = {
    activeView: "top",
    getScene: () => scene,
    getCanvas: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) }),
    getActiveCamera: () => { const c = new THREE.PerspectiveCamera(45, 1, 0.01, 1000); c.position.set(4, 4, 4); c.lookAt(0, 0, 0); return c; },
    addMesh: (obj: THREE.Object3D, kind?: string) => { if (kind) obj.userData.kind = kind; scene.add(obj); return obj; },
    deleteSelected: () => false,
    isolate: () => true,
    isolateOff: () => {},
    frameObjectOnly: () => {},
    frameAllVisible: () => {},
    clearClippingPlanes: () => {},
    addClippingPlane: () => {},
    setView: () => {},
    selectObject: (_obj: THREE.Object3D | null) => {},
    forEachSceneChild: (cb: (o: THREE.Object3D) => void) => scene.traverse(cb),
  } as never;
  return { viewer, scene };
}

function addBox(scene: THREE.Scene, kind = "box", opts: { visible?: boolean; layer?: string } = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.userData.kind = kind;
  mesh.userData.creator = kind;
  if (opts.layer) mesh.userData.layerId = opts.layer;
  if (opts.visible === false) mesh.visible = false;
  scene.add(mesh);
  return mesh;
}

beforeEach(() => {
  for (const name of ["SdDeselect", "SdQuery", "SdMeasure", "SdMeasureBetween"]) {
    unregisterHandler(name);
  }
  clearSelected();
});

afterEach(() => {
  clearSelected();
});

// ── Schema ────────────────────────────────────────────────────────────────

describe("schema presence", () => {
  for (const name of ["SdDeselect", "SdQuery", "SdMeasure", "SdMeasureBetween"]) {
    test(`${name} is in dictionary`, () => {
      expect(getDictionary().find((e) => e.name === name)).toBeDefined();
    });
  }
  test("SdMeasureBetween requires from + to", () => {
    const entry = getDictionary().find((e) => e.name === "SdMeasureBetween");
    expect(entry?.parameters.required).toContain("from");
    expect(entry?.parameters.required).toContain("to");
  });
});

describe("synonym routing", () => {
  test("'deselect' resolves to SdDeselect", () => { expect(resolveVerb("deselect")).toBe("SdDeselect"); });
  test("'query' resolves to SdQuery", () => { expect(resolveVerb("query")).toBe("SdQuery"); });
  test("'count objects' resolves to SdQuery", () => { expect(resolveVerb("count objects")).toBe("SdQuery"); });
  test("'how many' resolves to SdQuery", () => { expect(resolveVerb("how many")).toBe("SdQuery"); });
  test("'measure between' resolves to SdMeasureBetween", () => { expect(resolveVerb("measure between")).toBe("SdMeasureBetween"); });
});

// ── SdDeselect ────────────────────────────────────────────────────────────

describe("SdDeselect handler", () => {
  test("clears single selection and fires viewer:select event", () => {
    const { viewer, scene } = makeViewer();
    registerTransformHandlers(viewer);

    const mesh = new THREE.Mesh();
    mesh.userData.kind = "box";
    scene.add(mesh);
    setSelected({ topology: "mesh", uuid: mesh.uuid, object: mesh, transformTarget: mesh });

    let eventFired = false;
    let eventUuid: string | null = "not-set";
    const handler = (e: Event) => { eventFired = true; eventUuid = (e as CustomEvent).detail?.uuid ?? null; };
    window.addEventListener("viewer:select", handler);

    const dr = dispatchSync("SdDeselect", {});
    window.removeEventListener("viewer:select", handler);

    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdDeselect failed");
    expect((dr.result as { deselected: boolean }).deselected).toBe(true);
    expect(eventFired).toBe(true);
    expect(eventUuid).toBeNull();
  });

  test("SdDeselect on empty selection is a no-op (no error)", () => {
    const { viewer } = makeViewer();
    registerTransformHandlers(viewer);
    clearSelected();
    const dr = dispatchSync("SdDeselect", {});
    expect(dr.ok).toBe(true);
  });
});

// ── SdQuery ───────────────────────────────────────────────────────────────

describe("SdQuery handler", () => {
  test("returns all dispatch-tagged objects when no filter", () => {
    const { viewer, scene } = makeViewer();
    registerSelectionQueryHandlers(viewer);
    addBox(scene, "box");
    addBox(scene, "wall");
    const dr = dispatchSync("SdQuery", {});
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdQuery failed");
    const res = dr.result as { count: number; objects: unknown[] };
    expect(res.count).toBeGreaterThanOrEqual(2);
  });

  test("filters by kind", () => {
    const { viewer, scene } = makeViewer();
    registerSelectionQueryHandlers(viewer);
    addBox(scene, "box");
    addBox(scene, "box");
    addBox(scene, "wall");
    const dr = dispatchSync("SdQuery", { kind: "box" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error();
    const res = dr.result as { count: number };
    expect(res.count).toBe(2);
  });

  test("filters by visible=false (hidden objects only)", () => {
    const { viewer, scene } = makeViewer();
    registerSelectionQueryHandlers(viewer);
    addBox(scene, "box", { visible: true });
    addBox(scene, "box", { visible: false });
    addBox(scene, "box", { visible: false });
    const dr = dispatchSync("SdQuery", { visible: false });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error();
    const res = dr.result as { count: number; objects: Array<{ visible: boolean }> };
    expect(res.count).toBe(2);
    res.objects.forEach((o) => expect(o.visible).toBe(false));
  });

  test("SdQuery is read-only — does not change selection", () => {
    const { viewer, scene } = makeViewer();
    registerSelectionQueryHandlers(viewer);
    const mesh = addBox(scene, "box");
    setSelected({ topology: "mesh", uuid: mesh.uuid, object: mesh, transformTarget: mesh });

    dispatchSync("SdQuery", { kind: "box" });

    // Selection must be unchanged
    const sel = getSelected();
    expect(sel?.uuid).toBe(mesh.uuid);
  });

  test("returns count:0 and empty array when no matches", () => {
    const { viewer, scene } = makeViewer();
    registerSelectionQueryHandlers(viewer);
    addBox(scene, "box");
    const dr = dispatchSync("SdQuery", { kind: "nonexistent-kind-xyz" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error();
    const res = dr.result as { count: number; objects: unknown[] };
    expect(res.count).toBe(0);
    expect(res.objects).toHaveLength(0);
  });
});

// ── SdMeasure ─────────────────────────────────────────────────────────────

describe("SdMeasure handler", () => {
  test("returns distance between two [x,y,z] points", () => {
    const { viewer } = makeViewer();
    registerSelectionQueryHandlers(viewer);
    const dr = dispatchSync("SdMeasure", { from: [0, 0, 0], to: [3, 4, 0] });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error();
    const res = dr.result as { distance: number };
    expect(res.distance).toBeCloseTo(5, 4); // 3-4-5 triangle
  });

  test("zero distance for same-point measurement", () => {
    const { viewer } = makeViewer();
    registerSelectionQueryHandlers(viewer);
    const dr = dispatchSync("SdMeasure", { from: [1, 2, 3], to: [1, 2, 3] });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error();
    const res = dr.result as { distance: number };
    expect(res.distance).toBe(0);
  });

  test("returns error when from/to missing", () => {
    const { viewer } = makeViewer();
    registerSelectionQueryHandlers(viewer);
    const dr = dispatchSync("SdMeasure", { from: [0, 0, 0] });
    // Schema validation will reject missing 'to' (required field)
    expect(dr.ok).toBe(false);
  });
});

// ── SdMeasureBetween ──────────────────────────────────────────────────────

describe("SdMeasureBetween handler", () => {
  test("measures centroid-to-centroid distance", () => {
    const { viewer, scene } = makeViewer();
    registerSelectionQueryHandlers(viewer);
    const a = new THREE.Mesh();
    a.position.set(0, 0, 0);
    a.userData.kind = "box";
    scene.add(a);
    const b = new THREE.Mesh();
    b.position.set(5, 0, 0);
    b.userData.kind = "box";
    scene.add(b);

    const dr = dispatchSync("SdMeasureBetween", { from: a.uuid, to: b.uuid });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdMeasureBetween failed");
    const res = dr.result as { distance: number; from_uuid: string; to_uuid: string };
    expect(res.distance).toBeCloseTo(5, 3);
    expect(res.from_uuid).toBe(a.uuid);
    expect(res.to_uuid).toBe(b.uuid);
  });

  test("returns error for unknown UUID", () => {
    const { viewer } = makeViewer();
    registerSelectionQueryHandlers(viewer);
    const dr = dispatchSync("SdMeasureBetween", { from: "00000000-dead-beef-0000-aaa", to: "00000000-dead-beef-0000-bbb" });
    expect(dr.ok).toBe(true); // dispatch ok, but result has error
    if (!dr.ok) throw new Error();
    expect((dr.result as { error?: string }).error).toMatch(/not found/);
  });
});
