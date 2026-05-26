// Regression net for #30 G7: refitParentGeometry syncs nurbsCurve / nurbsSurface in userData.
//
// Tests that after handle movement (simulated by calling refitParentGeometry directly),
// userData.nurbsCurve (line/spline) and userData.nurbsSurface (wall) reflect the new geometry.
import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import { refitParentGeometry } from "../src/viewer/sub-object-handles";
import type { NurbsCurve } from "../src/nurbs/nurbs-curves";
import type { SumSurface } from "../src/nurbs/nurbs-surfaces";

function makeLine(ax: number, ay: number, bx: number, by: number): THREE.Line {
  const cx = (ax + bx) / 2, cy = (ay + by) / 2;
  const geom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(ax - cx, ay - cy, 0),
    new THREE.Vector3(bx - cx, by - cy, 0),
  ]);
  const mesh = new THREE.Line(geom, new THREE.LineBasicMaterial());
  mesh.position.set(cx, cy, 0);
  mesh.userData.creator = "line";
  mesh.userData.nurbsDegree = 1;
  mesh.userData.controlPoints = [
    new THREE.Vector3(ax - cx, ay - cy, 0),
    new THREE.Vector3(bx - cx, by - cy, 0),
  ];
  return mesh;
}

function makeSpline(pts: [number, number][]): THREE.Line {
  const geom = new THREE.BufferGeometry();
  const mesh = new THREE.Line(geom, new THREE.LineBasicMaterial());
  mesh.userData.creator = "spline";
  mesh.userData.nurbsDegree = 3;
  mesh.userData.controlPoints = pts.map(([x, y]) => new THREE.Vector3(x, y, 0));
  return mesh;
}

function makeWall(ax: number, ay: number, bx: number, by: number): THREE.Mesh {
  const cx = (ax + bx) / 2, cy = (ay + by) / 2;
  const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
  const t = 0.2, h = 3;
  const geom = new THREE.BoxGeometry(len, t, h);
  geom.translate(0, 0, h / 2);
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  mesh.position.set(cx, cy, 0);
  mesh.rotation.z = Math.atan2(by - ay, bx - ax);
  mesh.updateMatrixWorld(true);
  mesh.userData.creator = "wall";
  mesh.userData.wallThickness = t;
  mesh.userData.wallHeight = h;
  mesh.userData.controlPoints = [
    new THREE.Vector3(-len / 2, 0, 0),
    new THREE.Vector3(len / 2, 0, 0),
  ];
  return mesh;
}

describe("G7 — refitParentGeometry syncs nurbsCurve for line", () => {
  test("nurbsCurve updates when line CP moves", () => {
    const line = makeLine(0, 0, 4, 0);
    // Move second CP from (2,0,0) to (3,0,0) local
    (line.userData.controlPoints as THREE.Vector3[])[1].set(3, 0, 0);
    refitParentGeometry(line);
    const nc = line.userData.nurbsCurve as NurbsCurve;
    expect(nc).toBeDefined();
    expect(nc.kind).toBe("nurbs");
    expect(nc.order).toBe(2);
    expect(nc.cvCount).toBe(2);
    expect(nc.cvs[3]).toBeCloseTo(3, 5);   // B.x
    expect(nc.cvs[4]).toBeCloseTo(0, 5);   // B.y
    expect(line.userData.nurbsDegree).toBe(1);
  });

  test("nurbsCurve knots remain OpenNURBS length-2", () => {
    const line = makeLine(0, 0, 6, 0);
    refitParentGeometry(line);
    const nc = line.userData.nurbsCurve as NurbsCurve;
    expect(nc.knots.length).toBe(2);
  });
});

describe("G7 — refitParentGeometry syncs nurbsCurve for spline", () => {
  test("nurbsCurve updates when spline CP moves", () => {
    const sp = makeSpline([[0,0],[1,2],[3,1],[5,0]]);
    // Move second CP
    (sp.userData.controlPoints as THREE.Vector3[])[1].set(1, 3, 0);
    refitParentGeometry(sp);
    const nc = sp.userData.nurbsCurve as NurbsCurve;
    expect(nc).toBeDefined();
    expect(nc.kind).toBe("nurbs");
    expect(nc.order).toBe(4); // degree 3
    expect(sp.userData.nurbsDegree).toBe(3);
  });

  test("nurbsCVs alias kept in sync", () => {
    const sp = makeSpline([[0,0],[1,1],[3,0],[4,1]]);
    refitParentGeometry(sp);
    const nc = sp.userData.nurbsCurve as NurbsCurve;
    expect(sp.userData.nurbsCVs).toBe(nc.cvs);
  });
});

describe("G7 — refitParentGeometry syncs nurbsSurface for wall", () => {
  test("nurbsSurface updates when wall endpoint moves", () => {
    const wall = makeWall(0, 0, 4, 0);
    // Extend wall to length 6 by moving CP
    const cps = wall.userData.controlPoints as THREE.Vector3[];
    cps[1].set(3, 0, 0);   // local: was 2, now 3 → len = 6
    refitParentGeometry(wall);
    const ss = wall.userData.nurbsSurface as SumSurface;
    expect(ss).toBeDefined();
    expect(ss.kind).toBe("sum");
    expect(wall.userData.nurbsKind).toBe("surface");
  });

  test("nurbsSurface curveV spans wall height", () => {
    const wall = makeWall(0, 0, 4, 0);
    refitParentGeometry(wall);
    const ss = wall.userData.nurbsSurface as SumSurface;
    expect(ss.curveV.kind).toBe("line");
    // height = 3 (default)
    const lv = ss.curveV as { to: { z: number } };
    expect(lv.to.z).toBeCloseTo(3, 5);
  });
});
