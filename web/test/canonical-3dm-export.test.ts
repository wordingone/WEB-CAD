import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import { addKernelNurbsSurfaceToRhinoFile, export3dm } from "../src/io/exporters";
import { surfaceToIfcNurbs } from "../src/ifc/canonical-ifc";
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

function makeRhinoFake() {
  const addedSurfaces: unknown[] = [];
  const created: Array<{
    dim: number;
    isRational: boolean;
    orderU: number;
    orderV: number;
    countU: number;
    countV: number;
    points: Array<{ i: number; j: number; point: number[] }>;
    knotsU: number[];
    knotsV: number[];
    deleted: boolean;
  }> = [];

  const rh = {
    NurbsSurface: {
      create(dim: number, isRational: boolean, orderU: number, orderV: number, countU: number, countV: number) {
        const record = {
          dim,
          isRational,
          orderU,
          orderV,
          countU,
          countV,
          points: [] as Array<{ i: number; j: number; point: number[] }>,
          knotsU: [] as number[],
          knotsV: [] as number[],
          deleted: false,
        };
        created.push(record);
        return {
          points: () => ({
            set: (i: number, j: number, point: number[]) => record.points.push({ i, j, point }),
          }),
          knotsU: () => ({
            count: countU + orderU - 2,
            set: (i: number, knot: number) => { record.knotsU[i] = knot; },
          }),
          knotsV: () => ({
            count: countV + orderV - 2,
            set: (i: number, knot: number) => { record.knotsV[i] = knot; },
          }),
          delete: () => { record.deleted = true; },
        };
      },
    },
  };
  const file = {
    objects: () => ({
      addSurface: (ns: unknown) => addedSurfaces.push(ns),
    }),
  };
  return { rh, file, created, addedSurfaces };
}

describe("canonical 3DM export", () => {
  test("writes kernel NURBS surfaces to Rhino File3dm surfaces", () => {
    const nurbs = surfaceToIfcNurbs(surface);
    if (!nurbs) throw new Error("expected NURBS surface");
    const fake = makeRhinoFake();

    addKernelNurbsSurfaceToRhinoFile(fake.rh, fake.file, nurbs);

    expect(fake.addedSurfaces).toHaveLength(1);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({
      dim: 3,
      isRational: false,
      orderU: 2,
      orderV: 2,
      countU: 2,
      countV: 2,
      deleted: true,
    });
    expect(fake.created[0].points.map((p) => p.point)).toEqual([
      [0, 0, 0],
      [0, 3, 0],
      [2, 0, 0],
      [2, 3, 0],
    ]);
    expect(fake.created[0].knotsU).toEqual([0, 1]);
    expect(fake.created[0].knotsV).toEqual([0, 1]);
  });

  test("export3dm accepts canonical geometry resolver option", () => {
    const store = createCanonicalGeometryStore();
    const record = store.create({ kind: "surface", surface, source: "command", createdBy: "SdWall" });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    store.linkObject(mesh, record.id);

    const options: Parameters<typeof export3dm>[1] = {
      getCanonicalGeometryForObject: (obj) => store.resolveObject(obj),
    };

    expect(options.getCanonicalGeometryForObject?.(mesh)).toBe(record);
  });
});
