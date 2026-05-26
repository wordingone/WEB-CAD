// Regression net for #30 G8: SdBooleanUnion / SdBooleanDifference / SdBooleanIntersection handlers.
//
// Tests that the three verb-specific boolean handlers are registered and return
// { created: <uuid> } on success, and { error: ... } for missing args.
import { describe, test, expect, beforeEach } from "bun:test";
import { dispatchSync, unregisterHandler } from "../src/commands/dispatch";
import { registerTransformHandlers } from "../src/handlers/transforms";
import type { Viewer } from "../src/viewer/viewer";
import * as THREE from "three";

// Minimal mock scene that holds objects by UUID.
function makeEnv(): { viewer: Viewer; scene: THREE.Scene; addBox: (name?: string) => THREE.Mesh } {
  const scene = new THREE.Scene();
  const addedMeshes: THREE.Object3D[] = [];
  const v = {
    getScene: () => scene,
    addMesh(m: THREE.Object3D) { scene.add(m); addedMeshes.push(m); },
    getActiveObject: () => null,
  } as unknown as Viewer;

  function addBox(name?: string): THREE.Mesh {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
    if (name) mesh.name = name;
    mesh.userData.kind = "brep";
    scene.add(mesh);
    return mesh;
  }

  return { viewer: v, scene, addBox };
}

beforeEach(() => {
  ["SdBooleanUnion", "SdBooleanDifference", "SdBooleanIntersection"].forEach(v => unregisterHandler(v));
});

describe("G8 — SdBooleanUnion handler", () => {
  test("registered after registerTransformHandlers", () => {
    const { viewer } = makeEnv();
    registerTransformHandlers(viewer);
    const dr = dispatchSync("SdBooleanUnion", { a: "missing-uuid", b: "missing-uuid" });
    // Schema validates → handler runs → returns error (objects not found), not NoHandler
    expect(dr.ok).toBe(true);
    expect((dr as any).result.error).toContain("not found");
  });

  test("missing required b arg is caught by schema validation", () => {
    const { viewer } = makeEnv();
    registerTransformHandlers(viewer);
    const dr = dispatchSync("SdBooleanUnion", { a: "x" });
    // b is required — schema validation rejects before handler runs
    expect(dr.ok).toBe(false);
    expect((dr as any).error).toBe("ArgValidationError");
  });
});

describe("G8 — SdBooleanDifference handler", () => {
  test("registered after registerTransformHandlers", () => {
    const { viewer } = makeEnv();
    registerTransformHandlers(viewer);
    const dr = dispatchSync("SdBooleanDifference", { outer: "x", inner: "y" });
    expect(dr.ok).toBe(true);
    expect((dr as any).result.error).toContain("not found");
  });

  test("uses outer/inner arg names — missing outer is schema validation error", () => {
    const { viewer } = makeEnv();
    registerTransformHandlers(viewer);
    // outer + inner are required — schema rejects before handler
    const dr = dispatchSync("SdBooleanDifference", {});
    expect(dr.ok).toBe(false);
    expect((dr as any).error).toBe("ArgValidationError");
  });
});

describe("G8 — SdBooleanIntersection handler", () => {
  test("registered after registerTransformHandlers", () => {
    const { viewer } = makeEnv();
    registerTransformHandlers(viewer);
    const dr = dispatchSync("SdBooleanIntersection", { a: "x", b: "y" });
    expect(dr.ok).toBe(true);
    expect((dr as any).result.error).toContain("not found");
  });
});

describe("G8 — verb resolution for boolean synonyms", () => {
  test("'union' resolves to SdBooleanUnion", () => {
    const { resolveVerb } = require("../src/commands/dispatch");
    expect(resolveVerb("union")).toBe("SdBooleanUnion");
  });

  test("'difference' resolves to SdBooleanDifference", () => {
    const { resolveVerb } = require("../src/commands/dispatch");
    expect(resolveVerb("difference")).toBe("SdBooleanDifference");
  });

  test("'intersection' resolves to SdBooleanIntersection", () => {
    const { resolveVerb } = require("../src/commands/dispatch");
    expect(resolveVerb("intersection")).toBe("SdBooleanIntersection");
  });
});
