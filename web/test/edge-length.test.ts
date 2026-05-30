// SdEdgeLength — measure arc length of a BRep edge by target UUID + edge index.
// Tests: schema presence, synonym routing, error paths, box-edge lengths (linear),
// and curved-edge length (revolve solid, expected ≈ 2π*r).

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
  const lastAdded = () => added[added.length - 1] ?? null;
  return { viewer, scene, store, added, lastAdded };
}

beforeEach(() => {
  for (const name of ["SdEdgeLength", "SdBox", "SdRevolve", "SdAlignedDim", "SdTransientMeasure"]) {
    unregisterHandler(name);
  }
  document.body.innerHTML = "";
});

describe("SdEdgeLength schema", () => {
  test("SdEdgeLength is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdEdgeLength");
    expect(entry).toBeDefined();
  });

  test("SdEdgeLength requires target and edge", () => {
    const entry = getDictionary().find((e) => e.name === "SdEdgeLength");
    expect(entry?.parameters.required).toContain("target");
    expect(entry?.parameters.required).toContain("edge");
  });

  test("synonym routing: 'edge length' resolves to SdEdgeLength", () => {
    expect(resolveVerb("edge length")).toBe("SdEdgeLength");
  });

  test("synonym routing: 'arc length' resolves to SdEdgeLength", () => {
    expect(resolveVerb("arc length")).toBe("SdEdgeLength");
  });
});

describe("SdEdgeLength error paths", () => {
  test("rejects missing target (ArgValidationError from schema)", () => {
    const { viewer } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const dr = dispatchSync("SdEdgeLength", { edge: 0 });
    expect(dr.ok).toBe(false);
  });

  test("rejects missing edge index (ArgValidationError from schema)", () => {
    const { viewer } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const dr = dispatchSync("SdEdgeLength", { target: "nonexistent-uuid" });
    expect(dr.ok).toBe(false);
  });

  test("returns error for unknown target UUID", () => {
    const { viewer } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const dr = dispatchSync("SdEdgeLength", { target: "00000000-dead-beef-0000-000000000000", edge: 0 });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toMatch(/not found/);
  });

  test("returns error for out-of-range edge index", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 1, depth: 1, height: 1 });
    expect(box.ok).toBe(true);
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    const dr = dispatchSync("SdEdgeLength", { target: id, edge: 999 });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toMatch(/edge 999 not found/);
  });

  test("returns error for non-BRep target (plain mesh has no canonical BRep)", () => {
    const { viewer, scene } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const plain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    scene.add(plain);
    const dr = dispatchSync("SdEdgeLength", { target: plain.uuid, edge: 0 });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toBeTruthy();
  });
});

describe("SdEdgeLength — box (linear) edge measurement", () => {
  test("measures a box edge and returns correct shape", () => {
    const { viewer, lastAdded } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 3, depth: 4, height: 5 });
    expect(box.ok).toBe(true);
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;

    const dr = dispatchSync("SdEdgeLength", { target: id, edge: 0 });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdEdgeLength failed");
    const r = dr.result as { measured: string; length: number; edge: number; shell: number; unit: string; object_id: string; canonical_id: string };
    expect(r.measured).toBe("edge-length");
    expect(r.edge).toBe(0);
    expect(r.shell).toBe(0);
    expect(typeof r.object_id).toBe("string");
    expect(typeof r.canonical_id).toBe("string");
    // Edge 0: p000→p100, length = width = 3
    expect(r.length).toBeCloseTo(3, 3);
    const group = lastAdded();
    expect(group).not.toBeNull();
    expect(group!.uuid).toBe(r.object_id);
  });

  test("edge 1 of box(3,4,5) has length = depth = 4", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 3, depth: 4, height: 5 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    const dr = dispatchSync("SdEdgeLength", { target: id, edge: 1 });
    if (!dr.ok) throw new Error("SdEdgeLength failed");
    expect((dr.result as { length: number }).length).toBeCloseTo(4, 3);
  });

  test("edge 8 of box(3,4,5) has length = height = 5", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 3, depth: 4, height: 5 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    const dr = dispatchSync("SdEdgeLength", { target: id, edge: 8 });
    if (!dr.ok) throw new Error("SdEdgeLength failed");
    expect((dr.result as { length: number }).length).toBeCloseTo(5, 3);
  });

  test("annotation canonical curve is stored with correct metadata", () => {
    const { viewer, store } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 2, depth: 2, height: 2 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    dispatchSync("SdEdgeLength", { target: id, edge: 0 });

    const records = store.list().filter((r) => r.createdBy === "SdEdgeLength");
    expect(records.length).toBe(1);
    const rec = records[0]!;
    expect(rec.kind).toBe("curve");
    expect(rec.metadata?.annotation).toBe(true);
    expect(rec.metadata?.measured).toBe("edge-length");
    expect(rec.metadata?.target).toBe(id);
    expect(rec.metadata?.edge).toBe(0);
  });
});

describe("SdEdgeLength — revolve solid (curved) edge measurement", () => {
  test("circle edge of revolve-solid r=2 has length ≈ 2π*2", () => {
    const { viewer } = makeViewer();
    registerSketchHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);

    // Solid cylinder: profile = line [2,0,0]→[2,0,3], full 360° revolution
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

    // Edge 0 is the bottom circle, edge 1 is the top circle (both radius=2)
    const dr = dispatchSync("SdEdgeLength", { target: id, edge: 0 });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdEdgeLength on revolve failed");
    const r = dr.result as { length: number };
    // Circumference = 2π*2 ≈ 12.566
    expect(r.length).toBeCloseTo(2 * Math.PI * 2, 1);
  });
});
