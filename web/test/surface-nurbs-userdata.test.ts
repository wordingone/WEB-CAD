// Regression net for #30 G6: SdRevolve / SdSweep / SdLoft preserve NurbsSurface in userData.
//
// Tests the dispatch path: registerSketchHandlers → dispatch → mesh.userData.nurbsSurface.
import { describe, test, expect, beforeEach } from "bun:test";
import * as THREE from "three";
import type { Viewer } from "../src/viewer/viewer";
import { registerSketchHandlers } from "../src/handlers/sketch";
import { linkCanonicalSurface } from "../src/handlers/canonical-surface";
import { dispatchSync, unregisterHandler } from "../src/commands/dispatch";
import type { Surface } from "../src/nurbs/nurbs-surfaces";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
  type CanonicalGeometryStore,
} from "../src/geometry/canonical-geometry";

// Minimal mock viewer: captures the last mesh passed to addMesh.
function makeViewer(): { viewer: Viewer; store: CanonicalGeometryStore; lastMesh: () => THREE.Object3D | null } {
  let _last: THREE.Object3D | null = null;
  const store = createCanonicalGeometryStore();
  const v = {
    getCanonicalGeometryStore() { return store; },
    addMesh(m: THREE.Object3D) { _last = m; },
    getScene() { return new THREE.Scene(); },
  } as unknown as Viewer;
  return { viewer: v, store, lastMesh: () => _last };
}

beforeEach(() => {
  ["SdRevolve", "SdSweep", "SdLoft"].forEach(v => unregisterHandler(v));
});

type OkResult = { ok: true; canonical: string; result: { created: string } };

function testPlaneSurface(offsetX: number): Surface {
  return {
    kind: "plane",
    plane: {
      origin: { x: offsetX, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
    uDomain: { min: 0, max: 1 },
    vDomain: { min: 0, max: 1 },
    uExtent: { min: 0, max: 1 },
    vExtent: { min: 0, max: 1 },
  };
}

describe("canonical surface linking", () => {
  test("direct surface input wins over stale userData sidecars", () => {
    const { viewer, store } = makeViewer();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    const stale = testPlaneSurface(1);
    const exact = testPlaneSurface(2);
    mesh.userData.creator = "surface-test";
    mesh.userData.nurbsSurface = stale;

    linkCanonicalSurface(viewer, mesh, "surface-test", exact);

    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("surface");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface).toBe(exact);
    expect(canonical.surface).not.toBe(stale);
  });
});

describe("G6 — SdRevolve preserves nurbsSurface in userData", () => {
  test("revolve mesh has userData.nurbsSurface after dispatch", () => {
    const { viewer, store, lastMesh } = makeViewer();
    registerSketchHandlers(viewer);

    const dr = dispatchSync("SdRevolve", {
      profile: { kind: "line", from: [2, 0, 0], to: [2, 0, 3] },
      axisFrom: [0, 0, 0],
      axisTo:   [0, 0, 1],
      angleStart: 0,
      angleEnd:   Math.PI * 2,
    });

    expect(dr.ok).toBe(true);
    expect((dr as OkResult).result.created).toBe("revolution");
    const mesh = lastMesh()!;
    expect(mesh).not.toBeNull();
    const s = mesh.userData.nurbsSurface as Surface;
    expect(s).toBeDefined();
    expect(typeof s.kind).toBe("string");
    expect(mesh.userData.nurbsKind).toBe("surface");
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdRevolve");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface).toBe(s);
  });
});

describe("G6 — SdSweep preserves nurbsSurface in userData", () => {
  test("sweep mesh has userData.nurbsSurface after dispatch", () => {
    const { viewer, store, lastMesh } = makeViewer();
    registerSketchHandlers(viewer);

    const dr = dispatchSync("SdSweep", {
      profile: { kind: "line", from: [0, 0, 0], to: [0, 1, 0] },
      rail:    { kind: "line", from: [0, 0, 0], to: [5, 0, 0] },
    });

    expect(dr.ok).toBe(true);
    expect((dr as OkResult).result.created).toBe("sweep");
    const mesh = lastMesh()!;
    const s = mesh.userData.nurbsSurface as Surface;
    expect(s).toBeDefined();
    expect(mesh.userData.nurbsKind).toBe("surface");
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdSweep");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface).toBe(s);
  });
});

describe("G6 — SdLoft preserves nurbsSurface in userData", () => {
  test("loft mesh has userData.nurbsSurface after dispatch", () => {
    const { viewer, store, lastMesh } = makeViewer();
    registerSketchHandlers(viewer);

    const dr = dispatchSync("SdLoft", {
      curves: [
        { kind: "line", from: [0, 0, 0], to: [4, 0, 0] },
        { kind: "line", from: [0, 0, 3], to: [4, 0, 3] },
      ],
    });

    expect(dr.ok).toBe(true);
    expect((dr as OkResult).result.created).toBe("loft");
    const mesh = lastMesh()!;
    const s = mesh.userData.nurbsSurface as Surface;
    expect(s).toBeDefined();
    expect(mesh.userData.nurbsKind).toBe("surface");
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdLoft");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface).toBe(s);
  });
});
