// SdArea — compute total surface area of a BRep solid via display mesh triangle areas.
// Tests: schema, synonym routing, error paths, box(3,4,5)≈94, annotation metadata.

import { beforeEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import { dispatchSync, unregisterHandler, resolveVerb } from "../src/commands/dispatch";
import { getDictionary } from "../src/commands/dictionary";
import { registerAnnotationHandlers } from "../src/handlers/annotations";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import { registerNurbsHandlers } from "../src/handlers/nurbs";
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
  for (const name of ["SdArea", "SdBox", "SdCylinder", "SdVolume", "SdFaceArea", "SdEdgeLength"]) {
    unregisterHandler(name);
  }
  document.body.innerHTML = "";
});

describe("SdArea schema", () => {
  test("SdArea is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdArea");
    expect(entry).toBeDefined();
  });

  test("SdArea requires target", () => {
    const entry = getDictionary().find((e) => e.name === "SdArea");
    expect(entry?.parameters.required).toContain("target");
  });

  test("synonym routing: 'area' resolves to SdArea", () => {
    expect(resolveVerb("area")).toBe("SdArea");
  });

  test("synonym routing: 'total area' resolves to SdArea", () => {
    expect(resolveVerb("total area")).toBe("SdArea");
  });

  test("synonym routing: 'total surface area' resolves to SdArea", () => {
    expect(resolveVerb("total surface area")).toBe("SdArea");
  });
});

describe("SdArea error paths", () => {
  test("rejects missing target (ArgValidationError from schema)", () => {
    const { viewer } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const dr = dispatchSync("SdArea", {});
    expect(dr.ok).toBe(false);
  });

  test("returns error for unknown target UUID", () => {
    const { viewer } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const dr = dispatchSync("SdArea", { target: "00000000-dead-beef-0000-000000000000" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toMatch(/not found/);
  });

  test("returns error for non-Mesh target (Group)", () => {
    const { viewer, scene } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const group = new THREE.Group();
    scene.add(group);
    const dr = dispatchSync("SdArea", { target: group.uuid });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toBeTruthy();
  });

  test("returns error for plain mesh with no canonical BRep", () => {
    const { viewer, scene } = makeViewer();
    registerAnnotationHandlers(viewer as never);
    const plain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    scene.add(plain);
    const dr = dispatchSync("SdArea", { target: plain.uuid });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toBeTruthy();
  });
});

describe("SdArea — box surface area (exact)", () => {
  // SdBox(w,d,h) → total surface area = 2*(w*d + w*h + d*h)
  // box(3,4,5) → 2*(12+15+20) = 2*47 = 94

  test("surface area of box(3,4,5) ≈ 94", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 3, depth: 4, height: 5 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    const dr = dispatchSync("SdArea", { target: id });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdArea failed");
    const r = dr.result as { measured: string; area: number; unit: string; object_id: string; canonical_id: string };
    expect(r.measured).toBe("surface-area");
    expect(typeof r.object_id).toBe("string");
    expect(typeof r.canonical_id).toBe("string");
    expect(r.area).toBeCloseTo(94, 1);
  });

  test("surface area of unit box(1,1,1) ≈ 6", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 1, depth: 1, height: 1 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    const dr = dispatchSync("SdArea", { target: id });
    if (!dr.ok) throw new Error("SdArea failed");
    expect((dr.result as { area: number }).area).toBeCloseTo(6, 1);
  });

  test("annotation canonical record stored with correct metadata", () => {
    const { viewer, store } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 2, depth: 3, height: 4 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    dispatchSync("SdArea", { target: id });
    const records = store.list().filter((r) => r.createdBy === "SdArea");
    expect(records.length).toBe(1);
    const rec = records[0]!;
    expect(rec.metadata?.annotation).toBe(true);
    expect(rec.metadata?.measured).toBe("surface-area");
    expect(rec.metadata?.target).toBe(id);
  });

  test("area(box(2,3,4)) ≈ 2*(6+8+12) = 52", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 2, depth: 3, height: 4 });
    if (!box.ok) throw new Error("SdBox failed");
    const id = (box.result as { created: string }).created;
    const dr = dispatchSync("SdArea", { target: id });
    if (!dr.ok) throw new Error("SdArea failed");
    expect((dr.result as { area: number }).area).toBeCloseTo(52, 1);
  });
});

describe("SdArea — cylinder (curved solid)", () => {
  // SdCylinder(r=2, h=5) → total surface area = 2π*r² + 2π*r*h = 2π*4 + 2π*10 = 28π ≈ 87.96
  test("cylinder r=2 h=5: total surface area ≈ 28π", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const cyl = dispatchSync("SdCylinder", { radius: 2, height: 5 });
    if (!cyl.ok) throw new Error("SdCylinder failed");
    const id = (cyl.result as { created: string }).created;
    const dr = dispatchSync("SdArea", { target: id });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdArea on cylinder failed");
    const r = dr.result as { area: number };
    // 28π ≈ 87.965; allow 2% for polygon tessellation of circular faces
    expect(r.area).toBeCloseTo(28 * Math.PI, 0);
  });
});
