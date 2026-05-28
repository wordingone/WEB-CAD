// Regression net for canonical surface command ownership.
//
// Tests the dispatch path: registerSketchHandlers -> dispatch -> canonical surface store.
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
  ["SdRevolve", "SdSweep", "SdLoft", "SdPlane", "SdSurface"].forEach(v => unregisterHandler(v));
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

describe("G6 - SdRevolve stores exact surface canonically", () => {
  test("revolve mesh links to a canonical surface after dispatch", () => {
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
    expect(mesh.userData.nurbsSurface).toBeUndefined();
    expect(mesh.userData.nurbsKind).toBeUndefined();
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdRevolve");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface.kind).toBe("rev");
  });
});

describe("G6 - SdSweep stores exact surface canonically", () => {
  test("sweep mesh links to a canonical surface after dispatch", () => {
    const { viewer, store, lastMesh } = makeViewer();
    registerSketchHandlers(viewer);

    const dr = dispatchSync("SdSweep", {
      profile: { kind: "line", from: [0, 0, 0], to: [0, 1, 0] },
      rail:    { kind: "line", from: [0, 0, 0], to: [5, 0, 0] },
    });

    expect(dr.ok).toBe(true);
    expect((dr as OkResult).result.created).toBe("sweep");
    const mesh = lastMesh()!;
    expect(mesh.userData.nurbsSurface).toBeUndefined();
    expect(mesh.userData.nurbsKind).toBeUndefined();
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdSweep");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface.kind).toBe("nurbs");
  });
});

describe("G6 - SdLoft stores exact surface canonically", () => {
  test("loft mesh links to a canonical surface after dispatch", () => {
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
    expect(mesh.userData.nurbsSurface).toBeUndefined();
    expect(mesh.userData.nurbsKind).toBeUndefined();
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdLoft");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface.kind).toBe("nurbs");
  });
});

describe("G6 - planar surface tools store exact canonical CAD geometry", () => {
  test("plane command links the displayed quad to a canonical plane surface", () => {
    const { viewer, store, lastMesh } = makeViewer();
    registerSketchHandlers(viewer);

    const dr = dispatchSync("SdPlane", {
      origin: [1, 2, 3],
      xAxis: [6, 2, 3],
      yAxis: [1, 5, 3],
    });

    expect(dr.ok).toBe(true);
    expect((dr as OkResult).result.created).toBe("plane");
    const mesh = lastMesh()!;
    expect(mesh.userData.nurbsSurface).toBeUndefined();
    expect(mesh.userData.nurbsKind).toBeUndefined();
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdPlane");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface).toMatchObject({
      kind: "plane",
      plane: { origin: { x: 1, y: 2, z: 3 } },
      uDomain: { min: 0, max: 5 },
      vDomain: { min: 0, max: 3 },
      uExtent: { min: 0, max: 5 },
      vExtent: { min: 0, max: 3 },
    });
  });

  test("surface command links a filled profile to a trimmed planar BRep", () => {
    const { viewer, store, lastMesh } = makeViewer();
    registerSketchHandlers(viewer);

    const points = [[0, 0, 2], [4, 0, 2], [4, 3, 2], [0, 3, 2]];
    const dr = dispatchSync("SdSurface", { profile: { points } });

    expect(dr.ok).toBe(true);
    expect((dr as OkResult).result.created).toBe("surface");
    const mesh = lastMesh()!;
    expect(mesh.userData.nurbsSurface).toBeUndefined();
    expect(mesh.userData.nurbsKind).toBeUndefined();
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdSurface");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    const shell = canonical.brep.shells[0];
    expect(shell.isClosed).toBe(false);
    expect(shell.faces).toHaveLength(1);
    expect(shell.edges).toHaveLength(4);
    expect(shell.vertices).toHaveLength(4);
    expect(shell.faces[0].surface.kind).toBe("plane");
    expect(shell.faces[0].outerLoop.curves).toHaveLength(1);
    const trim = shell.faces[0].outerLoop.curves[0];
    expect(trim.kind).toBe("polyline");
    if (trim.kind !== "polyline") throw new Error("expected polyline trim");
    expect(trim.points).toHaveLength(5);
    expect(trim.points[0]).toEqual(trim.points[4]);
  });
});
