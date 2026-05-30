// Structural builders own display geometry only; command/create-mode layers link
// exact BRep/NURBS records into the canonical geometry store.
import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { buildBox, buildColumn, buildExtrude, buildSlab, buildWall } from "../src/tools/structural";

function expectDisplayOnly(mesh: THREE.Object3D, creator: string): void {
  expect(mesh).toBeInstanceOf(THREE.Object3D);
  expect(mesh.userData.creator).toBe(creator);
  expect(mesh.userData.kind).toBe("brep");
  expect(mesh.userData.nurbsSurface).toBeUndefined();
  expect(mesh.userData.nurbsKind).toBeUndefined();
}

describe("structural builders keep exact geometry out of userData", () => {
  test("buildWall keeps display geometry and wall metadata without a NURBS sidecar", () => {
    const { mesh } = buildWall({ x: 0, y: 0 }, { x: 4, y: 0 }, 3.5);

    expectDisplayOnly(mesh, "wall");
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.userData.wallThickness).toBe(0.2);
    expect(mesh.userData.wallHeight).toBe(3.5);
    expect(mesh.userData.controlPoints).toHaveLength(2);
  });

  test("buildSlab keeps display geometry and snap metadata without a NURBS sidecar", () => {
    const { mesh } = buildSlab({ x: 0, y: 0 }, { x: 5, y: 4 });

    expectDisplayOnly(mesh, "slab");
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.userData.endpoints).toHaveLength(4);
  });

  test("buildColumn keeps display geometry and placement metadata without a NURBS sidecar", () => {
    const { mesh } = buildColumn({ x: 1, y: 2 });

    expectDisplayOnly(mesh, "column");
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.position.x).toBe(1);
    expect(mesh.position.y).toBe(2);
  });

  test("buildBox keeps display geometry without a NURBS sidecar", () => {
    const { mesh } = buildBox({ x: 0, y: 0 }, { x: 3, y: 2 }, { x: 1.5, y: 2.5 });

    expectDisplayOnly(mesh, "box");
    expect(mesh).toBeInstanceOf(THREE.Mesh);
  });

  test("buildExtrude keeps display geometry without a NURBS sidecar", () => {
    const { mesh } = buildExtrude({ x: 0, y: 0 }, { x: 0, y: 3 });

    expectDisplayOnly(mesh, "extrude");
    expect(mesh).toBeInstanceOf(THREE.Mesh);
  });
});
