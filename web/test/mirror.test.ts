// SdMirror — mirror a BRep solid across a named (XY/YZ/XZ) or custom plane.
// Tests: schema, synonym routing, error paths, canonical record, volume preservation.

import { beforeEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import { dispatchSync, unregisterHandler, resolveVerb } from "../src/commands/dispatch";
import { getDictionary } from "../src/commands/dictionary";
import { registerTransformHandlers } from "../src/handlers/transforms";
import { registerAnnotationHandlers } from "../src/handlers/annotations";
import { registerNurbsHandlers } from "../src/handlers/nurbs";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
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
    getActiveObject: () => null,
    addMesh: (obj: THREE.Object3D, kind?: string, _opts?: unknown) => {
      if (kind) obj.userData.kind = kind;
      scene.add(obj);
      added.push(obj);
      return obj;
    },
    selectObject: (_obj: THREE.Object3D) => {},
  };
  return { viewer, scene, store, added };
}

beforeEach(() => {
  for (const name of ["SdMirror", "SdBox", "SdCylinder", "SdVolume",
    "SdMove", "SdScale", "SdRotate", "SdCopy",
    "SdArrayLinear", "SdArrayGrid", "SdArrayPolar", "SdArrayAlongCurve",
    "SdArray", "SdBoolean", "SdBooleanUnion", "SdBooleanDifference",
    "SdBooleanIntersection", "SdFillet", "SdChamfer", "SdShell",
    "SdSelect", "SdSelectAll", "SdSelectWindow", "SdSelectLasso",
    "SdSelectBoundary", "SdSelectByQuery", "SdAlignObjects",
    "SdBoolUnion", "SdBoolSubtract", "SdBoolIntersect",
  ]) {
    unregisterHandler(name);
  }
  document.body.innerHTML = "";
});

describe("SdMirror schema", () => {
  test("SdMirror is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdMirror");
    expect(entry).toBeDefined();
  });

  test("SdMirror requires target", () => {
    const entry = getDictionary().find((e) => e.name === "SdMirror");
    expect(entry?.parameters.required).toContain("target");
  });

  test("SdMirror does not require plane_name", () => {
    const entry = getDictionary().find((e) => e.name === "SdMirror");
    expect(entry?.parameters.required).not.toContain("plane_name");
  });

  test("synonym routing: 'mirror' resolves to SdMirror", () => {
    expect(resolveVerb("mirror")).toBe("SdMirror");
  });

  test("synonym routing: 'reflect' resolves to SdMirror", () => {
    expect(resolveVerb("reflect")).toBe("SdMirror");
  });

  test("synonym routing: 'flip' resolves to SdMirror", () => {
    expect(resolveVerb("flip")).toBe("SdMirror");
  });

  test("synonym routing: 'mirror across XY' resolves to SdMirror", () => {
    expect(resolveVerb("mirror across XY")).toBe("SdMirror");
  });
});

describe("SdMirror error paths", () => {
  test("rejects missing target (ArgValidationError from schema)", () => {
    const { viewer } = makeViewer();
    registerTransformHandlers(viewer as never);
    const dr = dispatchSync("SdMirror", {});
    expect(dr.ok).toBe(false);
  });

  test("returns error for unknown target UUID", () => {
    const { viewer } = makeViewer();
    registerTransformHandlers(viewer as never);
    const dr = dispatchSync("SdMirror", { target: "00000000-dead-beef-0000-000000000000" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toMatch(/not found/);
  });

  test("returns error for non-Mesh target", () => {
    const { viewer, scene } = makeViewer();
    registerTransformHandlers(viewer as never);
    const group = new THREE.Group();
    scene.add(group);
    const dr = dispatchSync("SdMirror", { target: group.uuid });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("dispatch ok expected");
    expect((dr.result as { error?: string }).error).toBeTruthy();
  });
});

describe("SdMirror — canonical BRep path", () => {
  test("creates a new object (different UUID from source)", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerTransformHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 2, depth: 2, height: 2 });
    if (!box.ok) throw new Error("SdBox failed");
    const srcId = (box.result as { created: string }).created;
    const dr = dispatchSync("SdMirror", { target: srcId, plane_name: "XY" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdMirror failed");
    const r = dr.result as { created: string; plane: string; normal: number[] };
    expect(typeof r.created).toBe("string");
    expect(r.created).not.toBe(srcId);
    expect(r.plane).toBe("XY");
    expect(r.normal).toEqual([0, 0, 1]);
  });

  test("mirrored object has canonical BRep record (createdBy=SdMirror)", () => {
    const { viewer, store } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerTransformHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 3, depth: 4, height: 5 });
    if (!box.ok) throw new Error("SdBox failed");
    const srcId = (box.result as { created: string }).created;
    dispatchSync("SdMirror", { target: srcId, plane_name: "YZ" });
    const records = store.list().filter((r) => r.createdBy === "SdMirror");
    expect(records.length).toBe(1);
    const rec = records[0]!;
    expect(rec.kind).toBe("brep");
    expect(rec.metadata?.operation).toBe("mirror");
  });

  test("volume is preserved after mirror (box 3×4×5 = 60)", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerTransformHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 3, depth: 4, height: 5 });
    if (!box.ok) throw new Error("SdBox failed");
    const srcId = (box.result as { created: string }).created;
    const mir = dispatchSync("SdMirror", { target: srcId, plane_name: "XZ" });
    if (!mir.ok) throw new Error("SdMirror failed");
    const mirId = (mir.result as { created: string }).created;
    const dr = dispatchSync("SdVolume", { target: mirId });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdVolume on mirror failed");
    const r = dr.result as { volume: number };
    expect(r.volume).toBeCloseTo(60, 1);
  });

  test("YZ mirror plane: normal is [1,0,0]", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerTransformHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 2, depth: 2, height: 2 });
    if (!box.ok) throw new Error("SdBox failed");
    const srcId = (box.result as { created: string }).created;
    const dr = dispatchSync("SdMirror", { target: srcId, plane_name: "YZ" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdMirror failed");
    const r = dr.result as { normal: number[] };
    expect(r.normal[0]).toBeCloseTo(1, 5);
    expect(r.normal[1]).toBeCloseTo(0, 5);
    expect(r.normal[2]).toBeCloseTo(0, 5);
  });

  test("XZ mirror plane: normal is [0,1,0]", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerTransformHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 2, depth: 2, height: 2 });
    if (!box.ok) throw new Error("SdBox failed");
    const srcId = (box.result as { created: string }).created;
    const dr = dispatchSync("SdMirror", { target: srcId, plane_name: "XZ" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdMirror failed");
    const r = dr.result as { normal: number[] };
    expect(r.normal[0]).toBeCloseTo(0, 5);
    expect(r.normal[1]).toBeCloseTo(1, 5);
    expect(r.normal[2]).toBeCloseTo(0, 5);
  });

  test("custom plane: normal is normalized", () => {
    const { viewer } = makeViewer();
    registerNurbsHandlers(viewer as never);
    registerTransformHandlers(viewer as never);
    const box = dispatchSync("SdBox", { width: 2, depth: 2, height: 2 });
    if (!box.ok) throw new Error("SdBox failed");
    const srcId = (box.result as { created: string }).created;
    const dr = dispatchSync("SdMirror", { target: srcId, normal: [1, 1, 0] });
    expect(dr.ok).toBe(true);
    if (!dr.ok) throw new Error("SdMirror failed");
    const r = dr.result as { created: string; plane: string; normal: number[] };
    expect(r.plane).toBe("custom");
    const len = Math.sqrt(r.normal[0]**2 + r.normal[1]**2 + r.normal[2]**2);
    expect(len).toBeCloseTo(1, 5);
  });
});
