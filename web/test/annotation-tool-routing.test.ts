import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { dispatchSync, unregisterHandler } from "../src/commands/dispatch";
import { registerAnnotationHandlers } from "../src/handlers/annotations";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import { registerNurbsHandlers } from "../src/handlers/nurbs";
import { WORLD_XY } from "../src/viewer/cplane";

function makeAnnotationViewer() {
  const scene = new THREE.Scene();
  const store = createCanonicalGeometryStore();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(4, 4, 4);
  camera.lookAt(0, 0, 0);
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
  };
  const added: THREE.Object3D[] = [];
  return {
    scene,
    added,
    viewer: {
      activeView: "top",
      activeCPlane: WORLD_XY,
      getScene: () => scene,
      getCanonicalGeometryStore: () => store,
      getCanvas: () => canvas,
      getActiveCamera: () => camera,
      addMesh: (obj: THREE.Object3D, kind?: string) => {
        if (kind) obj.userData.kind = kind;
        scene.add(obj);
        added.push(obj);
        return obj;
      },
    },
  };
}

beforeEach(() => {
  for (const name of ["SdAlignedDim", "SdAngularDim", "SdAreaDim", "SdVolumeDim", "SdLabel", "SdTransientMeasure", "SdChainedDim"]) {
    unregisterHandler(name);
  }
  for (const name of ["SdBox", "SdSphere", "SdCylinder", "SdCone", "SdExtrude"]) {
    unregisterHandler(name);
  }
  document.body.innerHTML = "";
});

describe("annotation and measurement palette command parity", () => {
  test("op-tool completion routes visible annotation tools through their Sd handlers", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");

    expect(source).toContain('dispatchSync("SdAlignedDim"');
    expect(source).toContain('dispatchSync("SdAngularDim"');
    expect(source).toContain('dispatchSync("SdAreaDim"');
    expect(source).toContain('dispatchSync("SdVolumeDim"');
    expect(source).toContain('dispatchSync("SdLabel"');
    expect(source).toContain('dispatchSync("SdTransientMeasure"');
  });

  test("Sd annotation handlers create user-visible measurement geometry or labels", () => {
    const { scene, added, viewer } = makeAnnotationViewer();
    const solid = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), new THREE.MeshBasicMaterial());
    scene.add(solid);
    registerAnnotationHandlers(viewer as never);

    expect(dispatchSync("SdAlignedDim", { a: [0, 0, 0], b: [3, 4, 0] }).ok).toBe(true);
    expect(dispatchSync("SdAngularDim", { vertex: [0, 0, 0], ray1: [1, 0, 0], ray2: [0, 1, 0] }).ok).toBe(true);
    expect(dispatchSync("SdAreaDim", { points: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]] }).ok).toBe(true);
    expect(dispatchSync("SdVolumeDim", { id: solid.uuid }).ok).toBe(true);
    expect(dispatchSync("SdLabel", { text: "A", position: [0, 0, 0] }).ok).toBe(true);
    expect(dispatchSync("SdTransientMeasure", { a: [0, 0, 0], b: [1, 0, 0] }).ok).toBe(true);

    expect(added.length).toBeGreaterThanOrEqual(4);
    expect(document.body.textContent).toContain("A");
    expect(document.body.textContent).toContain("Area:");
    expect(document.body.textContent).toContain("Vol:");
  });

  test("Sd annotation and measurement linework is canonical curve geometry", () => {
    const { scene, viewer } = makeAnnotationViewer();
    const solid = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), new THREE.MeshBasicMaterial());
    scene.add(solid);
    registerAnnotationHandlers(viewer as never);

    expect(dispatchSync("SdAlignedDim", { a: [0, 0, 0], b: [3, 4, 0] }).ok).toBe(true);
    expect(dispatchSync("SdAngularDim", { vertex: [0, 0, 0], ray1: [1, 0, 0], ray2: [0, 1, 0] }).ok).toBe(true);
    expect(dispatchSync("SdAreaDim", { points: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]] }).ok).toBe(true);
    expect(dispatchSync("SdVolumeDim", { id: solid.uuid }).ok).toBe(true);
    expect(dispatchSync("SdTransientMeasure", { a: [0, 0, 0], b: [1, 0, 0] }).ok).toBe(true);

    const records = viewer.getCanonicalGeometryStore().list();
    expect(records.map((record) => record.createdBy)).toEqual([
      "SdAlignedDim",
      "SdAngularDim",
      "SdAreaDim",
      "SdVolumeDim",
      "SdTransientMeasure",
    ]);
    for (const record of records) {
      expect(record.kind).toBe("curve");
      expect(record.metadata?.annotation).toBe(true);
      if (record.kind !== "curve") throw new Error("expected canonical curve");
      expect(record.curve.kind).toBe("polyline");
      if (record.curve.kind !== "polyline") throw new Error("expected polyline annotation curve");
      expect(record.curve.points.length).toBeGreaterThanOrEqual(2);
    }
    const area = records.find((record) => record.createdBy === "SdAreaDim");
    expect(area?.metadata?.closed).toBe(true);
  });

  test("SdChainedDim produces N-1 segment dims plus overall total", () => {
    const { viewer, added } = makeAnnotationViewer();
    registerAnnotationHandlers(viewer as never);

    const result = dispatchSync("SdChainedDim", {
      points: [[0, 0, 0], [2, 0, 0], [5, 0, 0]],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected SdChainedDim to succeed");
    const r = result.result as { segments: number; totalDist: number; unit: string };
    expect(r.segments).toBe(2);
    expect(r.totalDist).toBeCloseTo(5, 4);

    // 2 segment groups + 1 overall group = 3 objects added
    expect(added.length).toBe(3);

    // Total label should appear
    expect(document.body.textContent).toMatch(/Total:/);
  });

  test("SdChainedDim withOverall:false omits overall span", () => {
    const { viewer, added } = makeAnnotationViewer();
    registerAnnotationHandlers(viewer as never);

    const result = dispatchSync("SdChainedDim", {
      points: [[0, 0, 0], [1, 0, 0], [3, 0, 0]],
      withOverall: false,
    });
    expect(result.ok).toBe(true);
    expect(added.length).toBe(2); // only the 2 segments, no overall
    expect(document.body.textContent).not.toMatch(/Total:/);
  });

  test("SdChainedDim records canonical annotation curves for each segment and overall", () => {
    const { viewer } = makeAnnotationViewer();
    registerAnnotationHandlers(viewer as never);

    dispatchSync("SdChainedDim", { points: [[0, 0, 0], [3, 0, 0], [7, 0, 0]] });

    const records = viewer.getCanonicalGeometryStore().list().filter((r) => r.createdBy === "SdChainedDim");
    // 2 segments + 1 overall = 3 records
    expect(records.length).toBe(3);
    for (const rec of records) {
      expect(rec.metadata?.annotation).toBe(true);
      if (rec.kind !== "curve") throw new Error("expected curve");
      expect(rec.curve.kind).toBe("polyline");
    }
    const overall = records.find((r) => r.metadata?.isOverall === true);
    expect(overall).toBeDefined();
  });

  test("SdChainedDim rejects fewer than 3 points", () => {
    const { viewer } = makeAnnotationViewer();
    registerAnnotationHandlers(viewer as never);

    const result = dispatchSync("SdChainedDim", { points: [[0, 0, 0], [1, 0, 0]] });
    expect(result.ok).toBe(true); // dispatch ok but returns error payload
    if (!result.ok) throw new Error("expected dispatch to succeed");
    const r = result.result as { error?: string };
    expect(r.error).toBeTruthy();
  });

  test("solid primitive results expose chainable UUIDs for downstream measurement commands", () => {
    const { viewer } = makeAnnotationViewer();
    registerNurbsHandlers(viewer as never);
    registerAnnotationHandlers(viewer as never);

    const box = dispatchSync("SdBox", { width: 2, depth: 3, height: 4 });
    expect(box.ok).toBe(true);
    if (!box.ok) throw new Error("expected SdBox to succeed");
    const created = (box.result as { created?: string; object_id?: string; canonical_id?: string });
    expect(typeof created.created).toBe("string");
    expect(created.created).toBe(created.object_id);
    expect(typeof created.canonical_id).toBe("string");

    const volume = dispatchSync("SdVolumeDim", { id: created.created });
    expect(volume.ok).toBe(true);
    if (!volume.ok) throw new Error("expected SdVolumeDim dispatch to succeed");
    expect((volume.result as { measured?: string }).measured).toBe("volume");

    const volumeRecord = viewer.getCanonicalGeometryStore().list()
      .find((record) => record.createdBy === "SdVolumeDim");
    expect(volumeRecord?.kind).toBe("curve");
    expect(volumeRecord?.metadata?.annotation).toBe(true);
    expect(volumeRecord?.metadata?.target).toBe(created.created);
  });
});
