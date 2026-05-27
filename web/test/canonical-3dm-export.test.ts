import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import { addKernelNurbsCurveToRhinoFile, addKernelNurbsSurfaceToRhinoFile, export3dm } from "../src/io/exporters";
import { surfaceToIfcNurbs } from "../src/ifc/canonical-ifc";
import type { NurbsCurve } from "../src/nurbs/nurbs-curves";
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
  const addedCurves: unknown[] = [];
  const createdSurfaces: Array<{
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
  const createdCurves: Array<{
    dim: number;
    isRational: boolean;
    order: number;
    count: number;
    points: Array<{ i: number; point: number[] }>;
    knots: number[];
    deleted: boolean;
  }> = [];

  class NurbsCurveFake {
    private readonly record: (typeof createdCurves)[number];

    constructor(dim: number, isRational: boolean, order: number, count: number) {
      this.record = {
        dim,
        isRational,
        order,
        count,
        points: [],
        knots: [],
        deleted: false,
      };
      createdCurves.push(this.record);
    }

    points() {
      return {
        set: (i: number, point: number[]) => this.record.points.push({ i, point }),
      };
    }

    knots() {
      return {
        count: this.record.count + this.record.order - 2,
        set: (i: number, knot: number) => { this.record.knots[i] = knot; },
      };
    }

    delete() {
      this.record.deleted = true;
    }
  }

  const rh = {
    NurbsCurve: NurbsCurveFake,
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
        createdSurfaces.push(record);
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
      addCurve: (nc: unknown) => addedCurves.push(nc),
      addSurface: (ns: unknown) => addedSurfaces.push(ns),
    }),
  };
  return { rh, file, createdCurves, createdSurfaces, addedCurves, addedSurfaces };
}

describe("canonical 3DM export", () => {
  test("writes kernel NURBS surfaces to Rhino File3dm surfaces", () => {
    const nurbs = surfaceToIfcNurbs(surface);
    if (!nurbs) throw new Error("expected NURBS surface");
    const fake = makeRhinoFake();

    addKernelNurbsSurfaceToRhinoFile(fake.rh, fake.file, nurbs);

    expect(fake.addedSurfaces).toHaveLength(1);
    expect(fake.createdSurfaces).toHaveLength(1);
    expect(fake.createdSurfaces[0]).toMatchObject({
      dim: 3,
      isRational: false,
      orderU: 2,
      orderV: 2,
      countU: 2,
      countV: 2,
      deleted: true,
    });
    expect(fake.createdSurfaces[0].points.map((p) => p.point)).toEqual([
      [0, 0, 0],
      [0, 3, 0],
      [2, 0, 0],
      [2, 3, 0],
    ]);
    expect(fake.createdSurfaces[0].knotsU).toEqual([0, 1]);
    expect(fake.createdSurfaces[0].knotsV).toEqual([0, 1]);
  });

  test("writes kernel NURBS curves to Rhino File3dm curves", () => {
    const curve: NurbsCurve = {
      kind: "nurbs",
      dim: 3,
      isRational: false,
      order: 2,
      cvCount: 2,
      knots: [0, 1],
      cvs: [0, 0, 0, 3, 4, 0],
      cvStride: 3,
    };
    const fake = makeRhinoFake();

    addKernelNurbsCurveToRhinoFile(fake.rh, fake.file, curve);

    expect(fake.addedCurves).toHaveLength(1);
    expect(fake.createdCurves).toHaveLength(1);
    expect(fake.createdCurves[0]).toMatchObject({
      dim: 3,
      isRational: false,
      order: 2,
      count: 2,
      deleted: true,
    });
    expect(fake.createdCurves[0].points.map((p) => p.point)).toEqual([
      [0, 0, 0],
      [3, 4, 0],
    ]);
    expect(fake.createdCurves[0].knots).toEqual([0, 1]);
  });

  test("writes rational kernel NURBS curves with homogeneous control points", () => {
    const curve: NurbsCurve = {
      kind: "nurbs",
      dim: 3,
      isRational: true,
      order: 3,
      cvCount: 3,
      knots: [0, 0, 1, 1],
      cvs: [1, 0, 0, 1, 2, 2, 0, 0.5, 0, 1, 0, 1],
      cvStride: 4,
    };
    const fake = makeRhinoFake();

    addKernelNurbsCurveToRhinoFile(fake.rh, fake.file, curve);

    expect(fake.createdCurves[0].points.map((p) => p.point)).toEqual([
      [1, 0, 0, 1],
      [2, 2, 0, 0.5],
      [0, 1, 0, 1],
    ]);
    expect(fake.createdCurves[0].knots).toEqual([0, 0, 1, 1]);
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
