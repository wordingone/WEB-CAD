import { beforeEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import { dispatchSync, unregisterHandler } from "../src/commands/dispatch";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
  type CanonicalGeometryStore,
} from "../src/geometry/canonical-geometry";
import { inspectCanonicalGeometry, inspectCanonicalSelection } from "../src/geometry/canonical-introspection";
import { registerStructuralHandlers } from "../src/handlers/structural";
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
  } as unknown as Viewer;
  return { viewer, scene, store, lastObject: () => last };
}

beforeEach(() => {
  unregisterHandler("SdReferenceLine");
});

describe("canonical reference geometry", () => {
  test("SdReferenceLine keeps line display behavior while linking a canonical curve", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerStructuralHandlers(viewer);

    const result = dispatchSync("SdReferenceLine", { origin: [1, 2], end: [4, 6] });

    expect(result.ok).toBe(true);
    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Line);
    expect(obj?.userData.kind).toBe("brep");
    expect(obj?.userData.creator).toBe("IfcReferenceLine");
    const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("curve");
    expect(canonical.createdBy).toBe("SdReferenceLine");
    if (canonical.kind !== "curve") throw new Error("expected canonical curve");
    expect(canonical.curve).toMatchObject({
      kind: "line",
      from: { x: 0, y: -2.5, z: 0 },
      to: { x: 0, y: 2.5, z: 0 },
      domain: { min: 0, max: 5 },
    });
    expect(canonical.metadata).toMatchObject({
      worldStart: [1, 2, 0],
      worldEnd: [4, 6, 0],
    });
  });

  test("canonical curve records round-trip through the canonical store", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({
      kind: "curve",
      curve: {
        kind: "line",
        from: { x: 0, y: 0, z: 0 },
        to: { x: 3, y: 0, z: 0 },
        domain: { min: 0, max: 3 },
      },
      source: "command",
      createdBy: "SdReferenceLine",
    });

    const imported = createCanonicalGeometryStore();
    expect(imported.importRecords(store.exportRecords())).toBe(1);
    expect(imported.require(record.id)).toEqual(record);
  });

  test("canonical introspection summarizes selected reference curves", () => {
    const { viewer, scene, store, lastObject } = makeViewer();
    registerStructuralHandlers(viewer);
    dispatchSync("SdReferenceLine", { origin: [0, 0], end: [0, 2] });
    const obj = lastObject();
    if (!obj) throw new Error("expected reference line");
    const canonicalId = obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY] as string;

    const snapshot = inspectCanonicalGeometry(store, scene.children);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.objectLinks[0].canonicalGeometryId).toBe(canonicalId);

    const selection = inspectCanonicalSelection(store, {
      topology: "curve",
      uuid: obj.uuid,
      object: obj,
      transformTarget: obj,
    });

    expect(selection?.recordSummary).toMatchObject({
      canonicalGeometryId: canonicalId,
      kind: "curve",
      curveKind: "line",
      curveDomain: [0, 2],
    });
  });
});
