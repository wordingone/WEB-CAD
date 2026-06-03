// Regression net for #30 G8: SdBooleanUnion / SdBooleanDifference / SdBooleanIntersection handlers.
// #459: "Fuse"/"fuse"/"FUSE" synonym case-invariant dispatch → SdBooleanUnion geometric result.
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
  ["SdBooleanUnion", "SdBooleanDifference", "SdBooleanIntersection",
   "SdBoolUnion", "SdBoolSubtract", "SdBoolIntersect"].forEach(v => unregisterHandler(v));
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

// §WEB-CAD#246 — short-form verbs
describe("#246 — SdBoolUnion handler", () => {
  test("registered after registerTransformHandlers", () => {
    const { viewer } = makeEnv();
    registerTransformHandlers(viewer);
    const dr = dispatchSync("SdBoolUnion", { a: "missing-uuid", b: "missing-uuid" });
    expect(dr.ok).toBe(true);
    expect((dr as any).result.error).toContain("not found");
  });

  test("missing b is caught by schema validation", () => {
    const { viewer } = makeEnv();
    registerTransformHandlers(viewer);
    const dr = dispatchSync("SdBoolUnion", { a: "x" });
    expect(dr.ok).toBe(false);
    expect((dr as any).error).toBe("ArgValidationError");
  });
});

describe("#246 — SdBoolSubtract handler", () => {
  test("registered after registerTransformHandlers", () => {
    const { viewer } = makeEnv();
    registerTransformHandlers(viewer);
    const dr = dispatchSync("SdBoolSubtract", { outer: "x", inner: "y" });
    expect(dr.ok).toBe(true);
    expect((dr as any).result.error).toContain("not found");
  });

  test("missing outer/inner caught by schema", () => {
    const { viewer } = makeEnv();
    registerTransformHandlers(viewer);
    const dr = dispatchSync("SdBoolSubtract", {});
    expect(dr.ok).toBe(false);
    expect((dr as any).error).toBe("ArgValidationError");
  });
});

describe("#246 — SdBoolIntersect handler", () => {
  test("registered after registerTransformHandlers", () => {
    const { viewer } = makeEnv();
    registerTransformHandlers(viewer);
    const dr = dispatchSync("SdBoolIntersect", { a: "x", b: "y" });
    expect(dr.ok).toBe(true);
    expect((dr as any).result.error).toContain("not found");
  });
});

// #459 — Synonym/case-invariant dispatch routing table.
// Shape: { emitted, canonical } — reusable scaffold for the broader verb-synonym audit.
// Extend this table as additional model-emitted synonyms are confirmed or audited.
// Geometric gate (per Leo AC#3): assert result geometry produced, not just a dispatch flag.
const SYNONYM_ROUTING_TABLE: { emitted: string; canonical: string }[] = [
  // "Fuse" case variants — #459 baseline
  { emitted: "Fuse",  canonical: "SdBooleanUnion" },
  { emitted: "fuse",  canonical: "SdBooleanUnion" },
  { emitted: "FUSE",  canonical: "SdBooleanUnion" },
  // existing lowercase synonyms already in alias index (sanity-pin)
  { emitted: "union", canonical: "SdBooleanUnion" },
];

describe("#459 — synonym routing table: emitted-verb → canonical", () => {
  const { resolveVerb } = require("../src/commands/dispatch");
  for (const { emitted, canonical } of SYNONYM_ROUTING_TABLE) {
    test(`resolveVerb("${emitted}") === "${canonical}"`, () => {
      expect(resolveVerb(emitted)).toBe(canonical);
    });
  }
});

// Geometric gate: CSG union actually runs (two solids → one fused mesh in scene).
// Viewer mock with getCanonicalGeometryStore returning null brep → falls to CSG path.
describe("#459 — Fuse synonym dispatch: real union geometry produced", () => {
  function makeEnvFull() {
    const scene = new THREE.Scene();
    const v = {
      getScene: () => scene,
      addMesh(m: THREE.Object3D) { scene.add(m); },
      getActiveObject: () => null,
      getCanonicalGeometryStore: () => ({
        resolveObjectOrAncestor: () => null,
        create: () => ({ id: "mock-brep" }),
      }),
    } as unknown as Viewer;

    function addOverlappingBoxes(): [THREE.Mesh, THREE.Mesh] {
      const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
      a.position.set(0, 0, 0);
      a.updateMatrixWorld(true);
      a.userData.kind = "brep";
      scene.add(a);
      const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
      b.position.set(0.4, 0, 0);
      b.updateMatrixWorld(true);
      b.userData.kind = "brep";
      scene.add(b);
      return [a, b];
    }

    return { viewer: v, scene, addOverlappingBoxes };
  }

  for (const { emitted } of SYNONYM_ROUTING_TABLE.filter(r => r.canonical === "SdBooleanUnion")) {
    test(`"${emitted}" → SdBooleanUnion: result.created UUID in scene, operands removed`, () => {
      const { viewer, scene, addOverlappingBoxes } = makeEnvFull();
      registerTransformHandlers(viewer);
      const [a, b] = addOverlappingBoxes();
      const dr = dispatchSync(emitted, { a: a.uuid, b: b.uuid });
      expect(dr.ok).toBe(true);
      const result = (dr as any).result as Record<string, unknown>;
      expect(typeof result.created).toBe("string");
      expect(result.op).toBe("union");
      expect(scene.getObjectByProperty("uuid", a.uuid)).toBeUndefined();
      expect(scene.getObjectByProperty("uuid", b.uuid)).toBeUndefined();
      expect(scene.getObjectByProperty("uuid", result.created as string)).toBeTruthy();
    });
  }
});
