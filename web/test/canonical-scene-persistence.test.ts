import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
} from "../src/geometry/canonical-geometry";
import type { Brep, BrepFace } from "../src/nurbs/nurbs-brep";
import { BREP_DEFAULT_TOLERANCE } from "../src/nurbs/nurbs-brep";
import type { Curve } from "../src/nurbs/nurbs-curves";
import { Interval, Plane } from "../src/nurbs/nurbs-primitives";
import type { Surface } from "../src/nurbs/nurbs-surfaces";
import type { PlaneSurface } from "../src/nurbs/nurbs-surfaces";
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

function planeFace(): BrepFace {
  const surf: PlaneSurface = {
    kind: "plane",
    plane: Plane.fromPointNormal({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    uDomain: Interval.create(-1, 1),
    vDomain: Interval.create(-1, 1),
    uExtent: Interval.create(-1, 1),
    vExtent: Interval.create(-1, 1),
  };
  return {
    surface: surf,
    outerLoop: { curves: [], orientation: true },
    innerLoops: [],
    orientation: true,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

const brep: Brep = {
  shells: [{ faces: [planeFace()], edges: [], vertices: [], isClosed: false }],
};

const curve: Curve = {
  kind: "polyline",
  points: [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
  ],
  parameters: [0, 2],
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
    expect(serialized?.geometry).toBeUndefined();
    expect(serialized?.displaySource).toBe("canonical");
  });

  test("serializes canonical curve links without duplicating NURBS curve sidecars", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({
      kind: "curve",
      curve,
      source: "command",
      createdBy: "SdLine",
    });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(2, 0, 0),
    ]));
    line.userData.kind = "curve";
    line.userData.creator = "line";
    line.userData.nurbsCurve = curve;
    line.userData.nurbsCVs = curve.points;
    store.linkObject(line, record.id);

    const serialized = __sceneSerializationForTests.serializeSceneObj(line);

    expect(serialized?.userData[CANONICAL_GEOMETRY_USERDATA_KEY]).toBe(record.id);
    expect(serialized?.userData.nurbsCurve).toBeUndefined();
    expect(serialized?.userData.nurbsCVs).toBeUndefined();
    expect(serialized?.geometry).toBeUndefined();
    expect(serialized?.displaySource).toBe("canonical");
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

  test("canonical BRep records regenerate display geometry when scene mesh payload is omitted", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({
      kind: "brep",
      brep,
      source: "command",
      createdBy: "SdPlane",
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.1), new THREE.MeshStandardMaterial());
    mesh.userData.kind = "brep";
    mesh.userData.creator = "plane";
    store.linkObject(mesh, record.id);
    const serialized = __sceneSerializationForTests.serializeSceneObj(mesh);
    if (!serialized) throw new Error("expected serialized object");

    expect(serialized.geometry).toBeUndefined();
    expect(serialized.displaySource).toBe("canonical");

    const restored = __sceneSerializationForTests.deserializeSceneObj(serialized, store);
    expect(restored).toBeInstanceOf(THREE.Mesh);
    expect((restored as THREE.Mesh).geometry.getAttribute("position").count).toBeGreaterThan(0);
    expect(store.resolveObject(restored!)).toEqual(record);
  });
});
