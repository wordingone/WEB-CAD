import { beforeEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import { dispatchSync, unregisterHandler } from "../src/commands/dispatch";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
  type CanonicalGeometryStore,
} from "../src/geometry/canonical-geometry";
import { inspectCanonicalGeometry, inspectCanonicalSelection } from "../src/geometry/canonical-introspection";
import { levelStore } from "../src/geometry/levels";
import { registerDatumHandlers } from "../src/handlers/datum";
import type { Viewer } from "../src/viewer/viewer";

function makeViewer(): {
  viewer: Viewer;
  scene: THREE.Scene;
  store: CanonicalGeometryStore;
  lastObject: () => THREE.Object3D | null;
} {
  const scene = new THREE.Scene();
  const store = createCanonicalGeometryStore();
  let last: THREE.Object3D | null = null;
  const viewer = {
    getCanonicalGeometryStore() {
      return store;
    },
    addMesh(obj: THREE.Object3D, kind?: string) {
      if (kind) obj.userData.kind = kind;
      scene.add(obj);
      last = obj;
    },
    getScene() {
      return scene;
    },
    forEachSceneChild(cb: (obj: THREE.Object3D) => void) {
      scene.children.forEach(cb);
    },
  } as unknown as Viewer;
  return { viewer, scene, store, lastObject: () => last };
}

beforeEach(() => {
  unregisterHandler("SdDatum");
  unregisterHandler("SdLevel");
  for (const level of levelStore.all().filter((l) => l.id !== "level/0")) {
    levelStore.remove(level.id);
  }
});

describe("canonical datum geometry", () => {
  test("SdDatum keeps marker display behavior while linking a canonical point", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerDatumHandlers(viewer);

    const result = dispatchSync("SdDatum", { position: [1, 2, 3], label: "Benchmark" });

    expect(result.ok).toBe(true);
    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Mesh);
    expect(obj?.userData.kind).toBe("brep");
    expect(obj?.userData.creator).toBe("datum");
    expect(obj?.userData.label).toBe("Benchmark");
    const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("point");
    expect(canonical.createdBy).toBe("SdDatum");
    if (canonical.kind !== "point") throw new Error("expected canonical point");
    expect(canonical.point).toEqual({ x: 1, y: 2, z: 3 });
    expect(canonical.displayMesh?.derivation).toBe("reference-marker");
    expect(canonical.metadata).toMatchObject({
      creator: "datum",
      label: "Benchmark",
    });
  });

  test("canonical datum points round-trip through the canonical store", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({
      kind: "point",
      point: { x: 4, y: 5, z: 6 },
      source: "command",
      createdBy: "SdDatum",
    });

    const imported = createCanonicalGeometryStore();
    expect(imported.importRecords(store.exportRecords())).toBe(1);
    expect(imported.require(record.id)).toEqual(record);
  });

  test("canonical introspection summarizes selected datum points", () => {
    const { viewer, scene, store, lastObject } = makeViewer();
    registerDatumHandlers(viewer);
    dispatchSync("SdDatum", { position: [7, 8, 9] });
    const obj = lastObject();
    if (!obj) throw new Error("expected datum object");
    const canonicalId = obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY] as string;

    const snapshot = inspectCanonicalGeometry(store, scene.children);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.objectLinks[0].canonicalGeometryId).toBe(canonicalId);

    const selection = inspectCanonicalSelection(store, {
      topology: "vertex",
      uuid: obj.uuid,
      object: obj,
      transformTarget: obj,
    });

    expect(selection?.recordSummary).toMatchObject({
      canonicalGeometryId: canonicalId,
      kind: "point",
      point: [7, 8, 9],
    });
  });

  test("SdLevel links its display plane to a canonical NURBS surface", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerDatumHandlers(viewer);

    const result = dispatchSync("SdLevel", { elevation: 3, height: 4, extent: 12 });

    if (!result.ok) throw new Error(result.detail ?? result.error);
    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Mesh);
    expect(obj?.userData.kind).toBe("brep");
    expect(obj?.userData.creator).toBe("IfcLevel");
    expect(obj?.position.z).toBe(3);
    const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("surface");
    expect(canonical.createdBy).toBe("SdLevel");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface).toMatchObject({
      kind: "plane",
      uDomain: { min: -6, max: 6 },
      vDomain: { min: -6, max: 6 },
      uExtent: { min: -6, max: 6 },
      vExtent: { min: -6, max: 6 },
    });
    expect(canonical.metadata).toMatchObject({
      creator: "IfcLevel",
      elevation: 3,
      height: 4,
      extent: 12,
    });
  });
});
