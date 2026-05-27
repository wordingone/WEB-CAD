import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import { inspectCanonicalGeometry } from "../src/geometry/canonical-introspection";
import type { Surface } from "../src/nurbs/nurbs-surfaces";

const surface: Surface = {
  kind: "sum",
  basepoint: { x: 0, y: 0, z: 0 },
  curveU: {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to: { x: 2, y: 0, z: 0 },
    domain: { min: 0, max: 2 },
  },
  curveV: {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to: { x: 0, y: 0, z: 3 },
    domain: { min: 0, max: 3 },
  },
};

describe("canonical geometry introspection", () => {
  test("reports canonical records and linked scene objects for agents", () => {
    const store = createCanonicalGeometryStore();
    const linkedRecord = store.create({
      kind: "surface",
      surface,
      source: "command",
      createdBy: "SdWall",
    });
    const unlinkedRecord = store.create({
      kind: "surface",
      surface,
      source: "command",
      createdBy: "SdSlab",
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.name = "wall-display";
    mesh.position.set(4, 5, 6);
    mesh.scale.set(2, 3, 4);
    mesh.updateMatrixWorld(true);
    mesh.userData.creator = "wall";
    mesh.userData.kind = "brep";
    store.linkObject(mesh, linkedRecord.id);

    const snapshot = inspectCanonicalGeometry(store, [mesh]);

    expect(snapshot.records.map((record) => record.id).sort()).toEqual([linkedRecord.id, unlinkedRecord.id].sort());
    expect(snapshot.objectLinks).toEqual([
      {
        objectUuid: mesh.uuid,
        objectName: "wall-display",
        canonicalGeometryId: linkedRecord.id,
        creator: "wall",
        runtimeKind: "brep",
        position: [4, 5, 6],
        quaternion: [0, 0, 0, 1],
        scale: [2, 3, 4],
        worldMatrix: mesh.matrixWorld.elements.slice(),
      },
    ]);
    expect(snapshot.linkedRecordIds).toEqual([linkedRecord.id]);
    expect(snapshot.unlinkedRecordIds).toEqual([unlinkedRecord.id]);
  });
});
