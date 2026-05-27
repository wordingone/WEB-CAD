import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  CANONICAL_GEOMETRY_SCHEMA_VERSION,
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
  isCanonicalGeometry,
} from "../src/geometry/canonical-geometry";
import { brepFromSurface } from "../src/nurbs/nurbs-brep";
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

describe("canonical geometry store", () => {
  test("stores NURBS surface records as canonical geometry, separate from display meshes", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({
      kind: "surface",
      surface,
      source: "command",
      createdBy: "SdBox",
      displayMesh: {
        revision: 1,
        generatedAt: 1,
        vertexCount: 8,
        triangleCount: 12,
        derivation: "tessellated-surface",
      },
    });

    expect(record.schemaVersion).toBe(CANONICAL_GEOMETRY_SCHEMA_VERSION);
    expect(record.units).toBe("m");
    expect(record.kind).toBe("surface");
    if (record.kind !== "surface") throw new Error("expected surface record");
    expect(record.surface).toBe(surface);
    expect(record.displayMesh?.derivation).toBe("tessellated-surface");
    expect(isCanonicalGeometry(record)).toBe(true);
  });

  test("stores BRep records using the existing BRep model", () => {
    const store = createCanonicalGeometryStore();
    const brep = brepFromSurface(surface);
    const record = store.create({
      kind: "brep",
      brep,
      source: "conversion",
      createdBy: "mesh-to-brep",
    });

    expect(record.kind).toBe("brep");
    if (record.kind !== "brep") throw new Error("expected brep record");
    expect(record.brep).toBe(brep);
    expect(record.brep.shells).toHaveLength(1);
  });

  test("links Three.js display objects to canonical records through userData only", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({ kind: "surface", surface, source: "command" });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));

    store.linkObject(mesh, record.id);

    expect(mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY]).toBe(record.id);
    expect(store.getLinkedId(mesh)).toBe(record.id);
    expect(store.resolveObject(mesh)).toBe(record);
    expect(mesh.userData.kind).toBeUndefined();
  });

  test("refuses to link objects to unknown canonical records", () => {
    const store = createCanonicalGeometryStore();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));

    expect(() => store.linkObject(mesh, "missing")).toThrow("Unknown canonical geometry id: missing");
  });

  test("exports and imports canonical records for project persistence", () => {
    const sourceStore = createCanonicalGeometryStore();
    const record = sourceStore.create({
      kind: "surface",
      surface,
      source: "command",
      createdBy: "SdBox",
    });

    const exported = sourceStore.exportRecords();
    const targetStore = createCanonicalGeometryStore();
    const imported = targetStore.importRecords(exported);

    expect(imported).toBe(1);
    expect(targetStore.require(record.id)).toEqual(record);
  });
});
