import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import { getActiveMeshData } from "../src/viewer/viewer-scene";
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
    to: { x: 0, y: 3, z: 0 },
    domain: { min: 0, max: 3 },
  },
};

function staleMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    100, 100, 100,
    101, 100, 100,
    100, 101, 100,
  ]), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

describe("canonical active mesh data", () => {
  test("uses linked canonical surface data before currentMesh display buffers", () => {
    const store = createCanonicalGeometryStore();
    const mesh = staleMesh();
    const record = store.create({
      kind: "surface",
      surface,
      source: "import",
      createdBy: "test-import",
    });
    store.linkObject(mesh, record.id);

    const data = getActiveMeshData({
      currentMesh: mesh,
      currentObject: null,
      getCanonicalGeometryForObject: (obj: THREE.Object3D) => store.resolveObject(obj),
    } as never);

    expect(data).not.toBeNull();
    expect(data!.vertices.length).toBeGreaterThan(9);
    expect(data!.vertices[0]).toBeCloseTo(0);
    expect(data!.vertices[1]).toBeCloseTo(0);
    expect(data!.vertices[2]).toBeCloseTo(0);
  });

  test("applies child world transforms when currentObject uses linked canonical geometry", () => {
    const store = createCanonicalGeometryStore();
    const root = new THREE.Group();
    const mesh = staleMesh();
    mesh.position.set(5, 0, 0);
    root.add(mesh);
    const record = store.create({
      kind: "surface",
      surface,
      source: "import",
      createdBy: "test-import",
    });
    store.linkObject(mesh, record.id);

    const data = getActiveMeshData({
      currentMesh: null,
      currentObject: root,
      getCanonicalGeometryForObject: (obj: THREE.Object3D) => store.resolveObject(obj),
    } as never);

    expect(data).not.toBeNull();
    expect(data!.vertices[0]).toBeCloseTo(5);
    expect(data!.vertices[1]).toBeCloseTo(0);
    expect(data!.vertices[2]).toBeCloseTo(0);
  });
});
