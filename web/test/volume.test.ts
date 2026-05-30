// SdVolume — compute geometric volume of a closed BRep solid via divergence theorem.
// Tests: schema, synonym routing, error paths, box volume (exact), cylinder volume (≈πr²h).

import { beforeEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import { dispatchSync, unregisterHandler, resolveVerb } from "../src/commands/dispatch";
import { getDictionary } from "../src/commands/dictionary";
import { registerAnnotationHandlers } from "../src/handlers/annotations";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import { registerNurbsHandlers } from "../src/handlers/nurbs";
import { WORLD_XY } from "../src/viewer/cplane";
// Note: SdRevolve not used — revolution solid display mesh lacks cap faces, making divergence theorem inaccurate.

function makeViewer() {
  const scene = new THREE.Scene();
  const store = createCanonicalGeometryStore();
  const added: THREE.Object3D[] = [];
  const viewer = {
    activeView: "top",
    activeCPlane: WORLD_XY,
    getScene: () => scene,
    getCanonicalGeometryStore: () => store,
    getCanvas: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) }),
    getActiveCamera: () => { const c = new THREE.PerspectiveCamera(45, 1, 0.01, 1000); c.position.set(4, 4, 4); c.lookAt(0, 0, 0); return c; },
    addMesh: (obj: THREE.Object3D, kind?: string, _opts?: unknown) => {
      if (kind) obj.userData.kind = kind;
      scene.add(obj);
      added.push(obj);
      return obj;
    },
  };
  return { viewer, scene, store, added };
}

beforeEach(() => {
  for (const name of ["SdVolume", "SdBox", "SdCylinder", "SdEdgeLength", "SdFaceArea"]) {
    unregisterHandler(name);
  }
  document.body.innerHTML = "";
});

describe("SdVolume schema", () => {
  test("SdVolume is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdVolume");
    expect(entry).toBeDefined();
  });

  test("SdVolume requires target", () => {
    const entry = getDictionary().find((e) => e.name === "SdVolume");
    expect(entry?.parameters.required).toContain("target");
  });

  test("synonym routing: 'volume' resolves to SdVolume", () => {
    expect(resolveVerb("volume")).toBe("SdVolume");
  });

  test("synonym routing: 'solid volume' resolves to SdVolume", () => {
    expect(resolveVerb("solid volume")).toBe("SdVolume");
  });
});

describe("SdVolume error paths", () => {
  test("rejects missing target (ArgValidationError from schema)", () => {
    const { viewer } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const dr = dispatchSync("SdVolume", {});
    expect(dr.ok).toBe(false);
  });

  test("returns error for unknown target UUID", () => {
    const { viewer } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const dr = dispatchSync("SdVolume", { target: "00000000-dead-beef-0000-000000000000" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toMatch(/not found/);
  });

  test("returns error for non-BRep target", () => {
    const { viewer, scene } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const plain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    scene.add(plain);
    const dr = dispatchSync("SdVolume", { target: plain.uuid });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toBeTruthy();
  });

  test("returns error when target is a plain scene object (no canonical BRep)", () => {
    const { viewer, scene } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const plain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    scene.add(plain);
    const dr = dispatchSync("SdVolume", { target: plain.uuid });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toBeTruthy();
  });
});

describe("SdVolume — box (exact)", () => {
  // SdBox(w,d,h) → volume = w × d × h

  test("volume of box(3,4,5) = 60", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 3, depth: 4, height: 5 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    const dr = dispatchSync("SdVolume", { target: id });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdVolume failed");
    const r = dr.result as { measured: string; volume: number; unit: string; object_id: string; canonical_id: string };
    expect(r.measured).toBe("volume");
    expect(typeof r.object_id).toBe("string");
    expect(typeof r.canonical_id).toBe("string");
    expect(r.volume).toBeCloseTo(60, 1);
  });

  test("volume of unit box(1,1,1) = 1", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 1, depth: 1, height: 1 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    const dr = dispatchSync("SdVolume", { target: id });
    if (!dr.ok) throw new Error("SdVolume failed");
    expect((dr.result as { volume: number }).volume).toBeCloseTo(1, 1);
  });

  test("annotation canonical record stored with correct metadata", () => {
    const { viewer, store } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 2, depth: 3, height: 4 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    dispatchSync("SdVolume", { target: id });
    const records = store.list().filter((r) => r.createdBy === "SdVolume");
    expect(records.length).toBe(1);
    const rec = records[0]!;
    expect(rec.metadata?.annotation).toBe(true);
    expect(rec.metadata?.measured).toBe("volume");
    expect(rec.metadata?.target).toBe(id);
  });
});

describe("SdVolume — cylinder primitive (curved solid)", () => {
  // SdCylinder(r=2, h=5) → volume = π*r²*h = π*4*5 ≈ 62.832
  // Display mesh accuracy: ~0.6% error due to polygon approximation of circular cross-section.
  test("cylinder r=2 h=5: volume ≈ π*r²*h ≈ 62.83", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);

    const cyl = dispatchSync("SdCylinder", { radius: 2, height: 5 });
    expect(cyl.ok).toBe(true);
    if (!cyl.ok) throw new Error("SdCylinder failed");
    const id = (cyl.result as { created: string }).created;

    const dr = dispatchSync("SdVolume", { target: id });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdVolume on cylinder failed");
    const r = dr.result as { volume: number };
    // π * 4 * 5 ≈ 62.832; allow 1% error for polygon tessellation
    expect(r.volume).toBeCloseTo(Math.PI * 4 * 5, 0);
  });
});
