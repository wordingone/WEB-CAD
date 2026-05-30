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

type OkResult = { ok: true; canonical: string; result: { created: string; object_id?: string; canonical_id?: string; primitive?: string; solid?: boolean; [k: string]: unknown } };

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
    const r0 = (dr as OkResult).result;
    expect(typeof r0.created).toBe("string");
    expect(r0.object_id).toBe(r0.created);
    expect(typeof r0.canonical_id).toBe("string");
    expect(r0.primitive).toBe("revolution");
    const mesh = lastMesh()!;
    expect(mesh).not.toBeNull();
    expect(mesh.uuid).toBe(r0.created);
    expect(mesh.userData.nurbsSurface).toBeUndefined();
    expect(mesh.userData.nurbsKind).toBeUndefined();
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdRevolve");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface.kind).toBe("rev");
  });

  test("solid revolve links a full 360 line-profile revolution to a capped closed BRep", () => {
    const { viewer, store, lastMesh } = makeViewer();
    registerSketchHandlers(viewer);

    const dr = dispatchSync("SdRevolve", {
      profile: { kind: "line", from: [2, 0, 0], to: [2, 0, 3] },
      axisFrom: [0, 0, 0],
      axisTo: [0, 0, 1],
      angleStart: 0,
      angleEnd: Math.PI * 2,
      solid: true,
    });

    expect(dr.ok).toBe(true);
    const r1 = (dr as OkResult).result;
    expect(typeof r1.created).toBe("string");
    expect(r1.object_id).toBe(r1.created);
    expect(typeof r1.canonical_id).toBe("string");
    expect(r1.primitive).toBe("revolution");
    expect(r1.solid).toBe(true);
    const mesh = lastMesh()!;
    expect(mesh.uuid).toBe(r1.created);
    expect(mesh.userData.kind).toBe("brep");
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdRevolve");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    const shell = canonical.brep.shells[0];
    expect(shell.isClosed).toBe(true);
    expect(shell.faces.map((face) => face.surface.kind)).toEqual(["rev", "plane", "plane"]);
    expect(shell.edges).toHaveLength(2);
    expect(shell.vertices).toHaveLength(2);
    expect(shell.edges.every((edge) => edge.faceIndex2 !== null)).toBe(true);
    expect(shell.vertices.every((vertex) => vertex.edgeIndices.length > 0)).toBe(true);
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
    const r2 = (dr as OkResult).result;
    expect(typeof r2.created).toBe("string");
    expect(r2.object_id).toBe(r2.created);
    expect(typeof r2.canonical_id).toBe("string");
    expect(r2.primitive).toBe("sweep");
    const mesh = lastMesh()!;
    expect(mesh.uuid).toBe(r2.created);
    expect(mesh.userData.nurbsSurface).toBeUndefined();
    expect(mesh.userData.nurbsKind).toBeUndefined();
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdSweep");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface.kind).toBe("nurbs");
  });

  test("solid sweep links a closed profile on a straight rail to a capped closed BRep", () => {
    const { viewer, store, lastMesh } = makeViewer();
    registerSketchHandlers(viewer);

    const dr = dispatchSync("SdSweep", {
      profile: { points: [[0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0], [0, 0, 0]] },
      rail: { kind: "line", from: [0, 0, 0], to: [0, 0, 3] },
      solid: true,
    });

    expect(dr.ok).toBe(true);
    const r3 = (dr as OkResult).result;
    expect(typeof r3.created).toBe("string");
    expect(r3.object_id).toBe(r3.created);
    expect(typeof r3.canonical_id).toBe("string");
    expect(r3.primitive).toBe("sweep");
    expect(r3.solid).toBe(true);
    const mesh = lastMesh()!;
    expect(mesh.uuid).toBe(r3.created);
    expect(mesh.userData.kind).toBe("brep");
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdSweep");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    const shell = canonical.brep.shells[0];
    expect(shell.isClosed).toBe(true);
    expect(shell.faces.map((face) => face.surface.kind)).toEqual(["sum", "sum", "sum", "sum", "plane", "plane"]);
    expect(shell.faces).toHaveLength(6);
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
    const r4 = (dr as OkResult).result;
    expect(typeof r4.created).toBe("string");
    expect(r4.object_id).toBe(r4.created);
    expect(typeof r4.canonical_id).toBe("string");
    expect(r4.primitive).toBe("loft");
    const mesh = lastMesh()!;
    expect(mesh.uuid).toBe(r4.created);
    expect(mesh.userData.nurbsSurface).toBeUndefined();
    expect(mesh.userData.nurbsKind).toBeUndefined();
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdLoft");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface.kind).toBe("nurbs");
  });

  test("solid loft links closed section curves to a capped closed BRep", () => {
    const { viewer, store, lastMesh } = makeViewer();
    registerSketchHandlers(viewer);

    const dr = dispatchSync("SdLoft", {
      curves: [
        { points: [[0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0], [0, 0, 0]] },
        { points: [[0.25, 0.25, 3], [1.75, 0.25, 3], [1.75, 0.75, 3], [0.25, 0.75, 3], [0.25, 0.25, 3]] },
      ],
      solid: true,
    });

    expect(dr.ok).toBe(true);
    const r5 = (dr as OkResult).result;
    expect(typeof r5.created).toBe("string");
    expect(r5.object_id).toBe(r5.created);
    expect(typeof r5.canonical_id).toBe("string");
    expect(r5.primitive).toBe("loft");
    expect(r5.solid).toBe(true);
    const mesh = lastMesh()!;
    expect(mesh.uuid).toBe(r5.created);
    expect(mesh.userData.kind).toBe("brep");
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdLoft");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    const shell = canonical.brep.shells[0];
    expect(shell.isClosed).toBe(true);
    expect(shell.faces.map((face) => face.surface.kind)).toEqual(["nurbs", "plane", "plane"]);
    expect(shell.edges).toHaveLength(8);
    expect(shell.vertices).toHaveLength(8);
    expect(shell.edges.every((edge) => edge.faceIndex2 !== null)).toBe(true);
  });
});

describe("G6 - planar surface tools store exact canonical CAD geometry", () => {
  test("rectangle command links the displayed loop to a canonical closed polyline curve", () => {
    const { viewer, store, lastMesh } = makeViewer();
    registerSketchHandlers(viewer);

    const dr = dispatchSync("SdRectangle", { center: [2, 3], width: 4, height: 6 });

    expect(dr.ok).toBe(true);
    expect((dr as OkResult).result.created).toBe("rectangle");
    const mesh = lastMesh()!;
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.createdBy).toBe("SdRectangle");
    if (canonical.kind !== "curve") throw new Error("expected canonical curve");
    expect(canonical.curve.kind).toBe("polyline");
    if (canonical.curve.kind !== "polyline") throw new Error("expected polyline rectangle");
    expect(canonical.curve.points).toHaveLength(5);
    expect(canonical.curve.points[0]).toEqual(canonical.curve.points[4]);
    expect(canonical.metadata).toMatchObject({
      creator: "rect",
      closed: true,
      worldCenter: [2, 3, 0],
    });
  });

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
