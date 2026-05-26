// Regression net for #30 G1+G3: buildLine + buildArc store NurbsCurve in userData.
import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import { buildLine, buildArc, buildSpline } from "../src/tools/sketch";
import type { NurbsCurve } from "../src/nurbs/nurbs-curves";

describe("sketch NURBS userData — G3 buildLine", () => {
  test("buildLine stores degree-1 NurbsCurve in userData", () => {
    const { mesh } = buildLine({ x: 0, y: 0 }, { x: 4, y: 0 });
    const nc = mesh.userData.nurbsCurve as NurbsCurve;
    expect(nc).toBeDefined();
    expect(nc.kind).toBe("nurbs");
    expect(nc.order).toBe(2);           // degree 1
    expect(nc.cvCount).toBe(2);
    expect(nc.isRational).toBe(false);
    expect(nc.dim).toBe(3);
    expect(mesh.userData.nurbsDegree).toBe(1);
  });

  test("buildLine nurbsCurve CVs are centroid-relative", () => {
    const { mesh } = buildLine({ x: 2, y: 0 }, { x: 6, y: 0 });
    // centroid at (4, 0); local A = (-2, 0, 0), local B = (2, 0, 0)
    const nc = mesh.userData.nurbsCurve as NurbsCurve;
    expect(nc.cvs[0]).toBeCloseTo(-2, 5);  // A.x
    expect(nc.cvs[1]).toBeCloseTo(0, 5);   // A.y
    expect(nc.cvs[2]).toBeCloseTo(0, 5);   // A.z
    expect(nc.cvs[3]).toBeCloseTo(2, 5);   // B.x
    expect(nc.cvs[4]).toBeCloseTo(0, 5);   // B.y
    expect(nc.cvs[5]).toBeCloseTo(0, 5);   // B.z
  });

  test("buildLine knot vector is OpenNURBS-convention length 2", () => {
    const { mesh } = buildLine({ x: 0, y: 0 }, { x: 1, y: 1 });
    const nc = mesh.userData.nurbsCurve as NurbsCurve;
    // OpenNURBS: knots.length = order + cvCount - 2 = 2 + 2 - 2 = 2
    expect(nc.knots.length).toBe(2);
    expect(nc.knots[0]).toBe(0);
    expect(nc.knots[1]).toBe(1);
  });
});

describe("sketch NURBS userData — G2 buildSpline", () => {
  const fourPts = [
    { x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 1 }, { x: 4, y: 3 },
  ];

  test("buildSpline stores cubic NurbsCurve in userData", () => {
    const result = buildSpline(fourPts);
    expect(result).not.toBeNull();
    const nc = result!.mesh.userData.nurbsCurve as NurbsCurve;
    expect(nc).toBeDefined();
    expect(nc.kind).toBe("nurbs");
    expect(nc.order).toBe(4);            // degree 3 = cubic = order 4
    expect(nc.isRational).toBe(false);
    expect(result!.mesh.userData.nurbsDegree).toBe(3);
  });

  test("buildSpline nurbsCVs matches nurbsCurve.cvs", () => {
    const result = buildSpline(fourPts);
    const nc = result!.mesh.userData.nurbsCurve as NurbsCurve;
    expect(result!.mesh.userData.nurbsCVs).toBe(nc.cvs);
  });

  test("buildSpline returns null for fewer than 4 points", () => {
    expect(buildSpline([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }])).toBeNull();
  });
});

describe("sketch NURBS userData — G1 buildArc", () => {
  test("buildArc stores rational quadratic NurbsCurve in userData", () => {
    const { mesh } = buildArc({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 });
    const nc = mesh.userData.nurbsCurve as NurbsCurve;
    expect(nc).toBeDefined();
    expect(nc.kind).toBe("nurbs");
    expect(nc.isRational).toBe(true);     // rational quadratic arc
    expect(nc.order).toBe(3);             // degree 2 = order 3
    expect(nc.cvStride).toBe(4);          // homogeneous (x*w, y*w, z*w, w)
    expect(mesh.userData.nurbsDegree).toBe(2);
  });

  test("buildArc NurbsCurve has correct CV count for quarter-arc", () => {
    // quarter-arc: startAng=0, endAng=pi/2 → 1 span → 3 CVs
    const { mesh } = buildArc(
      { x: 0, y: 0 },   // center
      { x: 1, y: 0 },   // radius pt (r=1, startAng=0)
      { x: 0, y: 1 },   // end pt (endAng ~ pi/2)
    );
    const nc = mesh.userData.nurbsCurve as NurbsCurve;
    // Quarter arc ≤ π/2: 1 span → 3 CVs; rational quadratic order=3
    expect(nc.cvCount).toBe(3);
    expect(nc.order).toBe(3);
  });

  test("buildArc render unchanged — mesh is THREE.Line", () => {
    const { mesh } = buildArc({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 });
    expect(mesh).toBeInstanceOf(THREE.Line);
  });
});
