// SdFaceArea — measure surface area of a BRep face by target UUID + face index.
// Tests: schema, synonym routing, error paths, box face areas (exact), revolve face area (≈2πrh).

import { beforeEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import { dispatchSync, unregisterHandler, resolveVerb } from "../src/commands/dispatch";
import { getDictionary } from "../src/commands/dictionary";
import { registerAnnotationHandlers } from "../src/handlers/annotations";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import { registerNurbsHandlers } from "../src/handlers/nurbs";
import { registerSketchHandlers } from "../src/handlers/sketch";
import { WORLD_XY } from "../src/viewer/cplane";

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
  for (const name of ["SdFaceArea", "SdBox", "SdRevolve", "SdTransientMeasure", "SdEdgeLength"]) {
    unregisterHandler(name);
  }
  document.body.innerHTML = "";
});

describe("SdFaceArea schema", () => {
  test("SdFaceArea is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdFaceArea");
    expect(entry).toBeDefined();
  });

  test("SdFaceArea requires target and face", () => {
    const entry = getDictionary().find((e) => e.name === "SdFaceArea");
    expect(entry?.parameters.required).toContain("target");
    expect(entry?.parameters.required).toContain("face");
  });

  test("synonym routing: 'face area' resolves to SdFaceArea", () => {
    expect(resolveVerb("face area")).toBe("SdFaceArea");
  });

  test("synonym routing: 'surface area' resolves to SdFaceArea", () => {
    expect(resolveVerb("surface area")).toBe("SdFaceArea");
  });
});

describe("SdFaceArea error paths", () => {
  test("rejects missing target (ArgValidationError from schema)", () => {
    const { viewer } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const dr = dispatchSync("SdFaceArea", { face: 0 });
    expect(dr.ok).toBe(false);
  });

  test("rejects missing face index (ArgValidationError from schema)", () => {
    const { viewer } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const dr = dispatchSync("SdFaceArea", { target: "nonexistent-uuid" });
    expect(dr.ok).toBe(false);
  });

  test("returns error for unknown target UUID", () => {
    const { viewer } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const dr = dispatchSync("SdFaceArea", { target: "00000000-dead-beef-0000-000000000000", face: 0 });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toMatch(/not found/);
  });

  test("returns error for out-of-range face index", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 1, depth: 1, height: 1 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    const dr = dispatchSync("SdFaceArea", { target: id, face: 999 });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toMatch(/face 999 not found/);
  });

  test("returns error for non-BRep target", () => {
    const { viewer, scene } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const plain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    scene.add(plain);
    const dr = dispatchSync("SdFaceArea", { target: plain.uuid, face: 0 });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toBeTruthy();
  });
});

describe("SdFaceArea — box face areas (planar, exact)", () => {
  // axisAlignedNurbsBoxBrep face order:
  //   face 0 (-X): depth × height   e.g. 4 × 5 = 20
  //   face 2 (-Y): width × height   e.g. 3 × 5 = 15
  //   face 4 (-Z): width × depth    e.g. 3 × 4 = 12

  test("face 0 (-X) of box(3,4,5) has area = depth × height = 20", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 3, depth: 4, height: 5 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    const dr = dispatchSync("SdFaceArea", { target: id, face: 0 });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdFaceArea failed");
    const r = dr.result as { measured: string; area: number; face: number; shell: number; unit: string; object_id: string; canonical_id: string };
    expect(r.measured).toBe("face-area");
    expect(r.face).toBe(0);
    expect(r.shell).toBe(0);
    expect(typeof r.object_id).toBe("string");
    expect(typeof r.canonical_id).toBe("string");
    expect(r.area).toBeCloseTo(20, 1);
  });

  test("face 2 (-Y) of box(3,4,5) has area = width × height = 15", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 3, depth: 4, height: 5 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    const dr = dispatchSync("SdFaceArea", { target: id, face: 2 });
    if (!dr.ok) throw new Error("SdFaceArea failed");
    expect((dr.result as { area: number }).area).toBeCloseTo(15, 1);
  });

  test("face 4 (-Z) of box(3,4,5) has area = width × depth = 12", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 3, depth: 4, height: 5 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    const dr = dispatchSync("SdFaceArea", { target: id, face: 4 });
    if (!dr.ok) throw new Error("SdFaceArea failed");
    expect((dr.result as { area: number }).area).toBeCloseTo(12, 1);
  });

  test("annotation canonical record stored with correct metadata", () => {
    const { viewer, store } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 2, depth: 2, height: 2 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    dispatchSync("SdFaceArea", { target: id, face: 0 });
    const records = store.list().filter((r) => r.createdBy === "SdFaceArea");
    expect(records.length).toBe(1);
    const rec = records[0]!;
    expect(rec.metadata?.annotation).toBe(true);
    expect(rec.metadata?.measured).toBe("face-area");
    expect(rec.metadata?.target).toBe(id);
    expect(rec.metadata?.face).toBe(0);
  });
});

describe("SdFaceArea — revolve solid face (curved surface)", () => {
  test("lateral face of revolve(r=2, h=3, 360°) has area ≈ 2π*2*3", () => {
    const { viewer } = makeViewer();
    registerSketchHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);

    // Solid cylinder r=2, h=3
    const rev = dispatchSync("SdRevolve", {
      profile: { kind: "line", from: [2, 0, 0], to: [2, 0, 3] },
      axisFrom: [0, 0, 0],
      axisTo: [0, 0, 1],
      angleStart: 0,
      angleEnd: Math.PI * 2,
      solid: true,
    });
    expect(rev.ok).toBe(true);
    if (!rev.ok) throw new Error("SdRevolve failed");
    const id = (rev.result as { created: string }).created;

    // Face 0 = revolution surface (lateral), area = 2π*r*h = 2π*2*3 ≈ 37.699
    const dr = dispatchSync("SdFaceArea", { target: id, face: 0 });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdFaceArea on revolve failed");
    const r = dr.result as { area: number };
    expect(r.area).toBeCloseTo(2 * Math.PI * 2 * 3, 0);
  });
});
