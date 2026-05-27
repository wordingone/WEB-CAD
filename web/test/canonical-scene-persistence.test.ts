import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
} from "../src/geometry/canonical-geometry";
import type { Surface } from "../src/nurbs/nurbs-surfaces";
import { __sceneSerializationForTests } from "../src/viewer/viewer";

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

describe("canonical scene persistence", () => {
  test("serializes canonical object links without duplicating NURBS sidecars into scene userData", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({
      kind: "surface",
      surface,
      source: "command",
      createdBy: "SdWall",
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 3), new THREE.MeshStandardMaterial());
    mesh.position.set(4, 5, 6);
    mesh.userData.kind = "brep";
    mesh.userData.creator = "wall";
    mesh.userData.nurbsKind = "surface";
    mesh.userData.nurbsSurface = surface;
    store.linkObject(mesh, record.id);

    const serialized = __sceneSerializationForTests.serializeSceneObj(mesh);

    expect(serialized?.userData[CANONICAL_GEOMETRY_USERDATA_KEY]).toBe(record.id);
    expect(serialized?.userData.nurbsKind).toBe("surface");
    expect(serialized?.userData.nurbsSurface).toBeUndefined();
  });

  test("deserialized scene objects resolve through imported canonical records by link id", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({
      kind: "surface",
      surface,
      source: "command",
      createdBy: "SdWall",
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 3), new THREE.MeshStandardMaterial());
    mesh.userData.kind = "brep";
    mesh.userData.creator = "wall";
    mesh.userData.nurbsSurface = surface;
    store.linkObject(mesh, record.id);
    const serialized = __sceneSerializationForTests.serializeSceneObj(mesh);
    if (!serialized) throw new Error("expected serialized object");

    const importedStore = createCanonicalGeometryStore();
    importedStore.importRecords(store.exportRecords());
    const restored = __sceneSerializationForTests.deserializeSceneObj(serialized);
    if (!restored) throw new Error("expected restored object");

    expect(restored.userData.nurbsSurface).toBeUndefined();
    expect(importedStore.resolveObject(restored)).toEqual(record);
  });
});
