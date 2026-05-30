import { beforeEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import { dispatchSync, unregisterHandler } from "../src/commands/dispatch";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
  type CanonicalGeometryStore,
} from "../src/geometry/canonical-geometry";
import { inspectCanonicalGeometry, inspectCanonicalSelection } from "../src/geometry/canonical-introspection";
import { registerSketchHandlers } from "../src/handlers/sketch";
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
  [
    "SdPoint",
    "SdLine",
    "SdPolyline",
    "SdArc",
    "SdCircle",
    "SdEllipse",
    "SdSpline",
    "SdCurve",
  ].forEach(unregisterHandler);
});

describe("canonical sketch geometry", () => {
  test("SdLine keeps display behavior while linking a canonical curve", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerSketchHandlers(viewer);

    const result = dispatchSync("SdLine", { start: [1, 2], end: [4, 6] });

    expect(result.ok).toBe(true);
    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.LineSegments);
    expect(obj?.userData.kind).toBe("mesh");
    expect(obj?.userData.creator).toBe("line");
    const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("curve");
    expect(canonical.createdBy).toBe("SdLine");
    if (canonical.kind !== "curve") throw new Error("expected canonical curve");
    expect(canonical.curve.kind).toBe("nurbs");
    expect(canonical.metadata).toMatchObject({
      worldStart: [1, 2, 0],
      worldEnd: [4, 6, 0],
    });
  });

  test("SdPolyline links its local display path to a canonical polyline curve", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerSketchHandlers(viewer);

    const points = [[0, 0], [3, 0], [3, 4]];
    const result = dispatchSync("SdPolyline", { points });

    expect(result.ok).toBe(true);
    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Line);
    const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY] as string;
    const canonical = store.require(canonicalId);
    expect(canonical.kind).toBe("curve");
    if (canonical.kind !== "curve") throw new Error("expected canonical curve");
    expect(canonical.curve.kind).toBe("polyline");
    if (canonical.curve.kind !== "polyline") throw new Error("expected polyline curve");
    expect(canonical.curve.parameters).toEqual([0, 3, 7]);
    expect(canonical.metadata).toMatchObject({
      worldPoints: [[0, 0, 0], [3, 0, 0], [3, 4, 0]],
      closed: false,
    });
  });

  test("SdCircle links its display loop to a canonical full arc curve", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerSketchHandlers(viewer);

    const result = dispatchSync("SdCircle", { center: [5, 6], radius: 2 });

    expect(result.ok).toBe(true);
    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.LineLoop);
    const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY] as string;
    const canonical = store.require(canonicalId);
    expect(canonical.kind).toBe("curve");
    if (canonical.kind !== "curve") throw new Error("expected canonical curve");
    expect(canonical.curve).toMatchObject({
      kind: "arc",
      center: { x: 0, y: 0, z: 0 },
      radius: 2,
      startAngle: 0,
      endAngle: 2 * Math.PI,
      domain: { min: 0, max: 4 * Math.PI },
    });
    expect(canonical.metadata).toMatchObject({
      worldCenter: [5, 6, 0],
      radius: 2,
    });
  });

  test("SdPoint links its display marker to a canonical point", () => {
    const { viewer, scene, store, lastObject } = makeViewer();
    registerSketchHandlers(viewer);

    const result = dispatchSync("SdPoint", { position: [9, 10] });

    expect(result.ok).toBe(true);
    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Points);
    const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY] as string;
    const canonical = store.require(canonicalId);
    expect(canonical.kind).toBe("point");
    if (canonical.kind !== "point") throw new Error("expected canonical point");
    expect(canonical.point).toEqual({ x: 0, y: 0, z: 0 });
    expect(canonical.metadata).toMatchObject({ worldPoint: [9, 10, 0] });

    const snapshot = inspectCanonicalGeometry(store, scene.children);
    expect(snapshot.objectLinks[0].canonicalGeometryId).toBe(canonicalId);
    const selection = inspectCanonicalSelection(store, {
      topology: "vertex",
      uuid: obj!.uuid,
      object: obj!,
      transformTarget: obj!,
    });
    expect(selection?.recordSummary).toMatchObject({
      canonicalGeometryId: canonicalId,
      kind: "point",
      point: [0, 0, 0],
    });
  });
});
