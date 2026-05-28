import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
} from "../src/geometry/canonical-geometry";
import { linkPlanarizedMeshImportBrep } from "../src/handlers/mesh-planar-brep";

function triangleMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    0, 0, 0,
    2, 0, 0,
    0, 3, 0,
  ]), 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

describe("canonical import geometry", () => {
  test("links imported display meshes to canonical planar BRep records", () => {
    const store = createCanonicalGeometryStore();
    const mesh = triangleMesh();

    expect(linkPlanarizedMeshImportBrep(store, mesh, "obj-import", {
      source: "setObject",
      format: "obj",
    })).toBe(true);

    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY] as string;
    const record = store.require(canonicalId);
    expect(record).toMatchObject({
      kind: "brep",
      source: "import",
      createdBy: "obj-import",
      displayMesh: {
        vertexCount: 3,
        triangleCount: 1,
        derivation: "tessellated-brep",
      },
      metadata: {
        source: "setObject",
        format: "obj",
        derivation: "planarized-import-mesh",
      },
    });
    expect(record.kind === "brep" ? record.brep.shells[0]?.faces.length : 0).toBe(1);
  });

  test("does not replace an existing canonical import link", () => {
    const store = createCanonicalGeometryStore();
    const mesh = triangleMesh();
    expect(linkPlanarizedMeshImportBrep(store, mesh, "obj-import", {})).toBe(true);
    const originalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];

    expect(linkPlanarizedMeshImportBrep(store, mesh, "obj-import", {})).toBe(false);
    expect(mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY]).toBe(originalId);
    expect(store.list()).toHaveLength(1);
  });
});
