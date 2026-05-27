import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import { inspectCanonicalClipping, inspectCanonicalGeometry, inspectCanonicalSelection } from "../src/geometry/canonical-introspection";
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

  test("resolves sub-object selection to the linked canonical surface record", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({
      kind: "surface",
      surface,
      source: "command",
      createdBy: "SdWall",
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(2, 3, 4);
    mesh.userData.creator = "wall";
    mesh.userData.kind = "brep";
    store.linkObject(mesh, record.id);
    const edgeProxy = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1));

    const selection = inspectCanonicalSelection(store, {
      topology: "edge",
      uuid: edgeProxy.uuid,
      object: edgeProxy,
      parent: mesh,
      parentUuid: mesh.uuid,
      edgeIndex: 7,
      transformTarget: mesh,
    });

    expect(selection).toMatchObject({
      topology: "edge",
      pickedObjectUuid: edgeProxy.uuid,
      ownerObjectUuid: mesh.uuid,
      canonicalGeometryId: record.id,
      edgeIndex: 7,
      recordSummary: {
        canonicalGeometryId: record.id,
        kind: "surface",
        surfaceKind: "sum",
        surfaceDomain: {
          u: [0, 2],
          v: [0, 3],
        },
      },
    });
    expect(selection?.ownerWorldMatrix).toEqual(mesh.matrixWorld.elements.slice());
  });

  test("reports active clip planes against linked canonical display objects", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({
      kind: "surface",
      surface,
      source: "command",
      createdBy: "SdWall",
    });
    const cutMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    cutMesh.userData.creator = "wall";
    cutMesh.userData.kind = "brep";
    store.linkObject(cutMesh, record.id);

    const keptMesh = cutMesh.clone();
    keptMesh.position.x = 5;
    store.linkObject(keptMesh, record.id);

    const outsideMesh = cutMesh.clone();
    outsideMesh.position.x = -5;
    store.linkObject(outsideMesh, record.id);

    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
    const snapshot = inspectCanonicalClipping(store, [cutMesh, keptMesh, outsideMesh], [
      { label: "clip-x0", source: "clipping-plane", plane },
    ]);

    expect(snapshot.planes).toEqual([
      {
        label: "clip-x0",
        source: "clipping-plane",
        origin: [0, 0, 0],
        normal: [1, 0, 0],
        constant: 0,
      },
    ]);
    expect(snapshot.objectLinks.map((link) => ({
      objectUuid: link.objectUuid,
      canonicalGeometryId: link.canonicalGeometryId,
      planeLabel: link.planeLabel,
      relation: link.relation,
    }))).toEqual([
      {
        objectUuid: cutMesh.uuid,
        canonicalGeometryId: record.id,
        planeLabel: "clip-x0",
        relation: "intersecting",
      },
      {
        objectUuid: outsideMesh.uuid,
        canonicalGeometryId: record.id,
        planeLabel: "clip-x0",
        relation: "outside",
      },
    ]);
  });
});
