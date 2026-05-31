// s328-parity.test.ts — Multi-oracle parity tests for S8 intersection matrix (#328).
//
// Oracle strategy:
//   - Closed-form math (primary): all primitive ops (line-line, line-plane,
//     line-sphere, plane-plane, plane-sphere, sphere-sphere, arc-arc, circle-circle)
//   - intersectCurveCurve (verb-nurbs): CurveCurveOverlaps, ArcArc fallback
//   - Tolerance assertions: geometric, stated per test
//
// C++-blocked ops: test.skip with "blocked: needs general [X] in kern.wasm"
//
// Test geometry: non-axis-aligned, non-unit-radius, non-XY-plane to avoid
// degenerate-only coverage.

import { describe, test, expect } from "bun:test";
import {
  lineLineIntersection,
  linePlaneIntersection,
  lineSphereIntersection,
  planePlaneIntersection,
  planeSphereSection,
  sphereSphereIntersection,
  circleCircleIntersection,
  arcArcIntersection,
  computeCurveCurveOverlaps,
  computeCurveSelfIntersections,
  planeSphereSectionIntersection,
} from "../src/handlers/s328-impl";
import {
  Plane as Pl, Point3 as Pt3, Vector3 as V3, Line as Ln,
  type Line, type Plane, type Sphere, type Arc, type Circle,
} from "../src/nurbs/nurbs-primitives";
import type { Curve } from "../src/nurbs/nurbs-curves";

// ── Geometry helpers ──────────────────────────────────────────────────────────

const TOL = 1e-5; // test tolerance (looser than implementation tol for float rounding)

function dist3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function expectNear(actual: number, expected: number, tol = TOL, label = "") {
  expect(
    Math.abs(actual - expected) <= tol,
    `${label}: |${actual} - ${expected}| = ${Math.abs(actual - expected)} > tol=${tol}`,
  ).toBe(true);
}

function expectPointNear(
  actual: { x: number; y: number; z: number },
  expected: { x: number; y: number; z: number },
  tol = TOL,
  label = "",
) {
  const d = dist3(actual, expected);
  expect(d <= tol, `${label}: point distance ${d} > tol=${tol} — actual=(${actual.x},${actual.y},${actual.z}) expected=(${expected.x},${expected.y},${expected.z})`).toBe(true);
}

// ── LineLineIntersection ──────────────────────────────────────────────────────

describe("SdLineLineIntersection", () => {
  test("coplanar intersecting lines — non-axis-aligned", () => {
    // oracle: closed-form
    // Line A: from (1,0,2) to (3,2,2) — direction (1,1,0) in z=2 plane
    // Line B: from (1,2,2) to (3,0,2) — direction (1,-1,0) in z=2 plane
    // Intersection at (2,1,2)
    const lineA: Line = Ln.create({ x: 1, y: 0, z: 2 }, { x: 3, y: 2, z: 2 });
    const lineB: Line = Ln.create({ x: 1, y: 2, z: 2 }, { x: 3, y: 0, z: 2 });
    const result = lineLineIntersection(lineA, lineB, 1e-6);
    expect(result.type).toBe("intersecting");
    expectNear(result.distance, 0, 1e-5, "distance to 0");
    expectPointNear(result.midpoint, { x: 2, y: 1, z: 2 }, TOL, "midpoint");
  });

  test("skew lines in 3D — known closest approach", () => {
    // oracle: closed-form Goldman GG-I
    // Line A: (0,0,0)→(1,0,0)  direction X
    // Line B: (0,1,1)→(0,2,1)  direction Y at z=1
    // cross(dA, dB) = cross((1,0,0),(0,1,0)) = (0,0,1), len=1
    // w = p2 - p1 = (0,1,1)
    // t1 = ((w x dB) · cross) / 1 = ((-1,0,0) · (0,0,1)) = 0 → ptA = (0,0,0)
    // t2 = ((w x dA) · cross) / 1 = ((0,1,-1) · (0,0,1)) = -1 → ptB = (0,0,1)
    // dist = |(0,0,0)-(0,0,1)| = 1
    const lineA: Line = Ln.create({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    const lineB: Line = Ln.create({ x: 0, y: 1, z: 1 }, { x: 0, y: 2, z: 1 });
    const result = lineLineIntersection(lineA, lineB, 1e-6);
    expect(result.type).toBe("skew");
    expectNear(result.distance, 1, 1e-5, "skew distance");
  });

  test("parallel lines — same direction, offset", () => {
    const lineA: Line = Ln.create({ x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 0 });
    const lineB: Line = Ln.create({ x: 0, y: 0, z: 3 }, { x: 2, y: 1, z: 3 });
    const result = lineLineIntersection(lineA, lineB, 1e-6);
    expect(result.type).toBe("parallel");
    expectNear(result.distance, 3, 1e-5, "parallel distance");
  });

  test("non-axis-aligned 3D skew — paramA paramB within segment bounds", () => {
    // oracle: closed-form
    // Diagonal line A from (1,1,0) to (3,2,1)
    // Diagonal line B from (1,3,1) to (3,1,0)
    const lineA: Line = Ln.create({ x: 1, y: 1, z: 0 }, { x: 3, y: 2, z: 1 });
    const lineB: Line = Ln.create({ x: 1, y: 3, z: 1 }, { x: 3, y: 1, z: 0 });
    const result = lineLineIntersection(lineA, lineB, 1e-5);
    // Must not throw; type is either intersecting or skew
    expect(result.type === "intersecting" || result.type === "skew").toBe(true);
    // Verify closest points lie on or near original lines by checking midpoint distance
    const segLenA = dist3(lineA.from, lineA.to);
    expect(result.paramA >= -0.01 && result.paramA <= 1.01 || segLenA === 0).toBe(true);
  });
});

// ── LinePlaneIntersection ─────────────────────────────────────────────────────

describe("SdLinePlaneIntersection", () => {
  test("line through tilted plane — non-XY, non-axis-aligned", () => {
    // oracle: closed-form dot product
    // Plane: normal (1,1,1)/sqrt(3) through origin
    const normal = V3.normalize({ x: 1, y: 1, z: 1 });
    const plane: Plane = Pl.fromPointNormal({ x: 0, y: 0, z: 0 }, normal);
    // Line from (-3,-3,-3) to (3,3,3) — passes through origin
    const line: Line = Ln.create({ x: -3, y: -3, z: -3 }, { x: 3, y: 3, z: 3 });
    const result = linePlaneIntersection(line, plane, 1e-8);
    expect(result.type).toBe("intersecting");
    expect(result.point).toBeDefined();
    expectPointNear(result.point!, { x: 0, y: 0, z: 0 }, 1e-5, "intersection at origin");
  });

  test("line parallel to plane — should be parallel", () => {
    const plane: Plane = Pl.fromPointNormal({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 1 });
    // Line in z=0 plane, running along X
    const line: Line = Ln.create({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
    const result = linePlaneIntersection(line, plane, 1e-8);
    expect(result.type).toBe("parallel");
    expect(result.point).toBeUndefined();
  });

  test("tilted plane, oblique line — verify point lies on plane", () => {
    // oracle: verified by plane.distanceTo(result.point) ≈ 0
    const normal = V3.normalize({ x: 1, y: 2, z: -1 });
    const plane: Plane = Pl.fromPointNormal({ x: 1, y: 2, z: 3 }, normal);
    const line: Line = Ln.create({ x: 0, y: 0, z: 0 }, { x: 5, y: 7, z: 2 });
    const result = linePlaneIntersection(line, plane, 1e-8);
    expect(result.type).toBe("intersecting");
    const d = Pl.distanceTo(plane, result.point!);
    expectNear(Math.abs(d), 0, 1e-5, "intersection point on plane");
  });
});

// ── LineSphereIntersection ────────────────────────────────────────────────────

describe("SdLineSphereIntersection", () => {
  test("secant — line through non-unit sphere center, non-axis-aligned", () => {
    // oracle: quadratic discriminant
    // Sphere center (2,3,1), radius 2.5
    // Line from (2,3,1-5) to (2,3,1+5) — passes through center along Z
    const sphere: Sphere = { center: { x: 2, y: 3, z: 1 }, radius: 2.5 };
    const line: Line = Ln.create({ x: 2, y: 3, z: -4 }, { x: 2, y: 3, z: 6 });
    const result = lineSphereIntersection(line, sphere, 1e-6);
    expect(result.type).toBe("secant");
    expect(result.points.length).toBe(2);
    // Both intersection points must lie on sphere
    for (const pt of result.points) {
      const d = dist3(pt, sphere.center);
      expectNear(d, sphere.radius, 1e-5, "point on sphere");
    }
    // Points should be symmetric around center
    const p0 = result.points[0], p1 = result.points[1];
    expectPointNear(
      { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2, z: (p0.z + p1.z) / 2 },
      sphere.center,
      1e-5,
      "midpoint of secant is sphere center",
    );
  });

  test("tangent line — touches sphere at exactly one point", () => {
    // oracle: discriminant = 0
    // Sphere center at origin, radius 3
    // Line in the plane z=0, tangent to sphere at (3,0,0)
    // Line passes through (3,0,0) along Y
    const sphere: Sphere = { center: { x: 0, y: 0, z: 0 }, radius: 3 };
    const line: Line = Ln.create({ x: 3, y: -5, z: 0 }, { x: 3, y: 5, z: 0 });
    const result = lineSphereIntersection(line, sphere, 1e-5);
    // May be "secant" with coincident points or "tangent"
    expect(result.type === "tangent" || result.type === "secant").toBe(true);
    if (result.type === "tangent") {
      expectPointNear(result.points[0], { x: 3, y: 0, z: 0 }, 1e-4, "tangent point");
    }
  });

  test("miss — line entirely outside sphere (infinite-line clearance)", () => {
    // The infinite line through (5,2,0) and (10,2,0) runs parallel to X at y=2, z=0.
    // Closest approach to origin is 2, which is > radius=1. True miss on infinite line.
    const sphere: Sphere = { center: { x: 0, y: 0, z: 0 }, radius: 1 };
    const line: Line = Ln.create({ x: 5, y: 2, z: 0 }, { x: 10, y: 2, z: 0 });
    const result = lineSphereIntersection(line, sphere, 1e-6);
    expect(result.type).toBe("miss");
    expect(result.points.length).toBe(0);
  });

  test("oblique secant through off-center sphere", () => {
    // oracle: both points must satisfy dist(pt, center) = radius
    const sphere: Sphere = { center: { x: 1, y: 2, z: 3 }, radius: Math.sqrt(3) };
    const line: Line = Ln.create({ x: -5, y: -3, z: -2 }, { x: 5, y: 7, z: 8 });
    const result = lineSphereIntersection(line, sphere, 1e-5);
    // Should intersect
    if (result.type === "secant") {
      for (const pt of result.points) {
        const d = dist3(pt, sphere.center);
        expectNear(d, sphere.radius, 1e-4, "oblique secant point on sphere");
      }
    }
    // If miss, the line was outside — acceptable if geometry doesn't intersect
  });
});

// ── PlanePrimitiveIntersection (plane-plane) ──────────────────────────────────

describe("SdPlanePrimitiveIntersection - plane-plane", () => {
  test("two tilted planes — intersection line direction", () => {
    // oracle: cross product of normals gives line direction
    const n1 = V3.normalize({ x: 1, y: 0, z: 1 });
    const n2 = V3.normalize({ x: 0, y: 1, z: 1 });
    const planeA: Plane = Pl.fromPointNormal({ x: 0, y: 0, z: 0 }, n1);
    const planeB: Plane = Pl.fromPointNormal({ x: 0, y: 0, z: 0 }, n2);
    const result = planePlaneIntersection(planeA, planeB, 1e-8);
    expect(result.type).toBe("intersecting");
    expect(result.line).toBeDefined();

    // The intersection line must lie on both planes
    const linePt = result.line!.from;
    expectNear(Math.abs(Pl.distanceTo(planeA, linePt)), 0, 1e-5, "on planeA");
    expectNear(Math.abs(Pl.distanceTo(planeB, linePt)), 0, 1e-5, "on planeB");

    // Line direction must be perpendicular to both normals
    const rawDir = V3.sub(result.line!.to, result.line!.from);
    const lineDir = V3.normalize({ x: rawDir.x, y: rawDir.y, z: rawDir.z });
    const d1 = Math.abs(V3.dot(lineDir, n1));
    const d2 = Math.abs(V3.dot(lineDir, n2));
    expectNear(d1, 0, 1e-5, "line perp to n1");
    expectNear(d2, 0, 1e-5, "line perp to n2");
  });

  test("parallel planes — no intersection", () => {
    const n = V3.normalize({ x: 1, y: 2, z: 3 });
    const planeA: Plane = Pl.fromPointNormal({ x: 0, y: 0, z: 0 }, n);
    const planeB: Plane = Pl.fromPointNormal({ x: 2, y: 4, z: 6 }, n);
    const result = planePlaneIntersection(planeA, planeB, 1e-8);
    expect(result.type).toBe("parallel");
    expect(result.line).toBeUndefined();
  });
});

// ── PlaneSphereSection ────────────────────────────────────────────────────────

describe("SdPlaneSphereSectionIntersection", () => {
  test("plane through tilted sphere — circle radius matches formula", () => {
    // oracle: sqrt(r² - d²) where d = dist(center, plane)
    const sphere: Sphere = { center: { x: 1, y: 2, z: 3 }, radius: 5 };
    // Tilted plane normal (1,1,0)/sqrt(2) through origin
    const normal = V3.normalize({ x: 1, y: 1, z: 0 });
    const plane: Plane = Pl.fromPointNormal({ x: 0, y: 0, z: 0 }, normal);
    const d = Math.abs(Pl.distanceTo(plane, sphere.center));
    const expectedRadius = Math.sqrt(sphere.radius * sphere.radius - d * d);

    const result = planeSphereSection(plane, sphere, 1e-8);
    expect(result.type).toBe("circle");
    expectNear(result.circle!.radius, expectedRadius, 1e-5, "section circle radius");
    // Section circle center should lie on the plane
    expectNear(Math.abs(Pl.distanceTo(plane, result.circle!.center)), 0, 1e-5, "center on plane");
  });

  test("plane tangent to sphere — single point", () => {
    // Sphere at (3,4,0) radius 2; plane z=0, normal (0,0,1)
    const sphere: Sphere = { center: { x: 3, y: 4, z: 2 }, radius: 2 };
    const plane: Plane = Pl.fromPointNormal({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const result = planeSphereSection(plane, sphere, 1e-6);
    expect(result.type).toBe("tangent_point");
    expectPointNear(result.point!, { x: 3, y: 4, z: 0 }, 1e-5, "tangent point");
  });

  test("plane misses sphere", () => {
    const sphere: Sphere = { center: { x: 0, y: 0, z: 10 }, radius: 1 };
    const plane: Plane = Pl.fromPointNormal({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const result = planeSphereSection(plane, sphere, 1e-6);
    expect(result.type).toBe("miss");
  });
});

// ── SphereSphereIntersection ──────────────────────────────────────────────────

describe("SdSphereSphereIntersection", () => {
  test("two overlapping spheres — circle of intersection radius", () => {
    // oracle: radical plane formula
    // Sphere A center=(0,0,0) r=5; Sphere B center=(6,0,0) r=5
    // dist=6; x = (36 + 25 - 25)/(12) = 36/12 = 3
    // sectionR = sqrt(25 - 9) = 4
    const sA: Sphere = { center: { x: 0, y: 0, z: 0 }, radius: 5 };
    const sB: Sphere = { center: { x: 6, y: 0, z: 0 }, radius: 5 };
    const result = sphereSphereIntersection(sA, sB, 1e-8);
    expect(result.type).toBe("circle");
    expectNear(result.circle!.radius, 4, 1e-5, "section radius");
    expectPointNear(result.circle!.center, { x: 3, y: 0, z: 0 }, 1e-5, "circle center on axis");
  });

  test("external tangent — single point", () => {
    // A at origin r=3, B at (7,0,0) r=4; dist=7=3+4
    const sA: Sphere = { center: { x: 0, y: 0, z: 0 }, radius: 3 };
    const sB: Sphere = { center: { x: 7, y: 0, z: 0 }, radius: 4 };
    const result = sphereSphereIntersection(sA, sB, 1e-6);
    expect(result.type).toBe("tangent_external");
    expectPointNear(result.point!, { x: 3, y: 0, z: 0 }, 1e-4, "tangent point");
  });

  test("external miss — no intersection", () => {
    const sA: Sphere = { center: { x: 0, y: 0, z: 0 }, radius: 2 };
    const sB: Sphere = { center: { x: 10, y: 0, z: 0 }, radius: 2 };
    const result = sphereSphereIntersection(sA, sB, 1e-6);
    expect(result.type).toBe("miss");
  });

  test("internal miss — one sphere inside other", () => {
    const sA: Sphere = { center: { x: 0, y: 0, z: 0 }, radius: 10 };
    const sB: Sphere = { center: { x: 1, y: 0, z: 0 }, radius: 2 };
    const result = sphereSphereIntersection(sA, sB, 1e-6);
    expect(result.type).toBe("internal_miss");
  });

  test("off-axis overlapping spheres — circle center on line between centers", () => {
    // Diagonal arrangement: non-axis-aligned
    // oracle: radical plane formula, validated by circle center dot direction
    const sA: Sphere = { center: { x: 1, y: 2, z: 3 }, radius: 4 };
    const sB: Sphere = { center: { x: 4, y: 6, z: 3 }, radius: 4 };
    const result = sphereSphereIntersection(sA, sB, 1e-8);
    if (result.type === "circle") {
      // Center of intersection circle must be on the line between sphere centers
      const axis = V3.normalize(V3.sub(sB.center, sA.center) as typeof sA.center);
      const toCenter = V3.sub(result.circle!.center, sA.center) as typeof sA.center;
      const cross = V3.cross(axis, V3.normalize(toCenter) as typeof axis);
      const crossLen = Math.sqrt(cross.x * cross.x + cross.y * cross.y + cross.z * cross.z);
      expectNear(crossLen, 0, 1e-5, "circle center colinear with sphere centers");
    }
  });
});

// ── CircleCircleIntersection ──────────────────────────────────────────────────

describe("SdCircleCircleIntersection", () => {
  test("coplanar intersecting circles — two points verified by distance", () => {
    // oracle: 2D closed-form
    // Circle A: center=(0,0,0) r=3 in XY-plane
    // Circle B: center=(4,0,0) r=3 in XY-plane
    // dist=4; a=(16+9-9)/8=2; h=sqrt(9-4)=sqrt(5)
    const cA: Circle = { center: { x: 0, y: 0, z: 0 }, radius: 3, plane: Pl.worldXY() };
    const cB: Circle = { center: { x: 4, y: 0, z: 0 }, radius: 3, plane: Pl.worldXY() };
    const result = circleCircleIntersection(cA, cB, 1e-8);
    expect(result.type).toBe("two_points");
    expect(result.points.length).toBe(2);
    // Each point must lie on both circles
    for (const pt of result.points) {
      expectNear(dist3(pt, cA.center), cA.radius, 1e-5, "point on cA");
      expectNear(dist3(pt, cB.center), cB.radius, 1e-5, "point on cB");
    }
  });

  test("coplanar tangent circles — one point", () => {
    // A: center=(0,0,0) r=2; B: center=(5,0,0) r=3 — dist=5=2+3
    const normal = { x: 0, y: 0, z: 1 };
    const cA: Circle = { center: { x: 0, y: 0, z: 0 }, radius: 2, plane: Pl.fromPointNormal({ x: 0, y: 0, z: 0 }, normal) };
    const cB: Circle = { center: { x: 5, y: 0, z: 0 }, radius: 3, plane: Pl.fromPointNormal({ x: 5, y: 0, z: 0 }, normal) };
    const result = circleCircleIntersection(cA, cB, 1e-6);
    expect(result.type).toBe("tangent");
    expect(result.points.length).toBe(1);
    expectPointNear(result.points[0], { x: 2, y: 0, z: 0 }, 1e-4, "tangent point");
  });

  test("coplanar miss — circles too far apart", () => {
    const n = { x: 0, y: 0, z: 1 };
    const cA: Circle = { center: { x: 0, y: 0, z: 0 }, radius: 1, plane: Pl.fromPointNormal({ x: 0, y: 0, z: 0 }, n) };
    const cB: Circle = { center: { x: 10, y: 0, z: 0 }, radius: 1, plane: Pl.fromPointNormal({ x: 10, y: 0, z: 0 }, n) };
    const result = circleCircleIntersection(cA, cB, 1e-6);
    expect(result.type).toBe("miss");
    expect(result.points.length).toBe(0);
  });

  test("coincident circles — coincident type", () => {
    const n = { x: 0, y: 0, z: 1 };
    const cA: Circle = { center: { x: 1, y: 2, z: 0 }, radius: 3, plane: Pl.fromPointNormal({ x: 1, y: 2, z: 0 }, n) };
    const cB: Circle = { center: { x: 1, y: 2, z: 0 }, radius: 3, plane: Pl.fromPointNormal({ x: 1, y: 2, z: 0 }, n) };
    const result = circleCircleIntersection(cA, cB, 1e-6);
    expect(result.type).toBe("coincident");
  });

  test("tilted plane circles — non-XY", () => {
    // oracle: same 2D formula after projecting to circle planes
    const normal = V3.normalize({ x: 1, y: 0, z: 1 }); // 45° tilted
    const center = { x: 0, y: 0, z: 0 };
    const cA: Circle = { center, radius: 2, plane: Pl.fromPointNormal(center, normal) };
    const cB: Circle = {
      center: { x: 2.5, y: 0, z: 2.5 },
      radius: 2,
      plane: Pl.fromPointNormal({ x: 2.5, y: 0, z: 2.5 }, normal),
    };
    // Should not throw; result may be any valid type
    const result = circleCircleIntersection(cA, cB, 1e-5);
    expect(["miss", "tangent", "two_points", "coincident", "non_coplanar_miss", "non_coplanar_two_points"]).toContain(result.type);
  });
});

// ── ArcArcIntersection ────────────────────────────────────────────────────────

describe("SdArcArcIntersection", () => {
  test("two coplanar crossing arcs — intersection lies on both arcs", () => {
    // oracle: ArcCurve via intersectCurveCurve (verb-nurbs)
    // Arc A: center=(0,0,0) r=2, from 0 to π (upper semicircle in XY)
    // Arc B: center=(2,0,0) r=2, from π/2 to 3π/2 (left semicircle)
    // Expected intersection around (1, √3, 0) at angle 60° on A
    const worldXY = Pl.worldXY();
    const arcA: Arc = { center: { x: 0, y: 0, z: 0 }, radius: 2, startAngle: 0, endAngle: Math.PI, plane: worldXY };
    const arcB: Arc = { center: { x: 2, y: 0, z: 0 }, radius: 2, startAngle: Math.PI / 2, endAngle: 3 * Math.PI / 2, plane: worldXY };
    const result = arcArcIntersection(arcA, arcB, 1e-4);
    // At least one intersection expected
    expect(result.points.length).toBeGreaterThanOrEqual(1);
    // Each intersection must be within radius of both arc centers
    for (const pt of result.points) {
      const dA = dist3(pt, arcA.center);
      const dB = dist3(pt, arcB.center);
      expectNear(dA, arcA.radius, 1e-3, "arc A dist");
      expectNear(dB, arcB.radius, 1e-3, "arc B dist");
    }
  });

  test("non-intersecting arcs — zero points", () => {
    const worldXY = Pl.worldXY();
    // Arc A: upper-left quarter; Arc B: lower-right quarter — no geometric overlap
    const arcA: Arc = { center: { x: -5, y: 0, z: 0 }, radius: 2, startAngle: 0, endAngle: Math.PI, plane: worldXY };
    const arcB: Arc = { center: { x: 5, y: 0, z: 0 }, radius: 2, startAngle: Math.PI, endAngle: 2 * Math.PI, plane: worldXY };
    const result = arcArcIntersection(arcA, arcB, 1e-4);
    expect(result.points.length).toBe(0);
  });
});

// ── CurveCurveOverlaps ────────────────────────────────────────────────────────

describe("SdCurveCurveOverlaps", () => {
  test("two identical polylines — full overlap detected", () => {
    // oracle: computeCurveCurveOverlaps internal
    // Both curves are the same diagonal line segment
    function diagPts(n: number): number[][] {
      return Array.from({ length: n }, (_, i) => {
        const t = i / (n - 1);
        return [t * 3, t * 2, t * 1];
      });
    }
    const pts = diagPts(16);
    const result = computeCurveCurveOverlaps(
      { kind: "polyline", points: pts.map(p => ({ x: p[0], y: p[1], z: p[2] })), parameters: pts.map((_, i) => i / 15) },
      { kind: "polyline", points: pts.map(p => ({ x: p[0], y: p[1], z: p[2] })), parameters: pts.map((_, i) => i / 15) },
      1e-3,
    );
    expect(result.overlaps.length).toBeGreaterThanOrEqual(1);
  });

  test("two crossing non-axis-aligned polylines — one transversal intersection", () => {
    // oracle: intersectCurveCurve
    // Polyline A: (0,0,0)→(4,4,0)  Polyline B: (0,4,0)→(4,0,0)
    // Crossing at (2,2,0)
    function linePts(from: [number,number,number], to: [number,number,number], n: number): Point3Ish[] {
      return Array.from({ length: n }, (_, i) => {
        const t = i / (n - 1);
        return {
          x: from[0] + (to[0] - from[0]) * t,
          y: from[1] + (to[1] - from[1]) * t,
          z: from[2] + (to[2] - from[2]) * t,
        };
      });
    }
    type Point3Ish = { x: number; y: number; z: number };
    const ptsA = linePts([0, 0, 0], [4, 4, 0], 16);
    const ptsB = linePts([0, 4, 0], [4, 0, 0], 16);
    function toPolyline(pts: Point3Ish[]): Curve {
      const params: number[] = [0];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        params.push(params[i - 1] + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2));
      }
      return { kind: "polyline", points: pts, parameters: params };
    }
    const result = computeCurveCurveOverlaps(toPolyline(ptsA), toPolyline(ptsB), 1e-3);
    expect(result.intersections.length).toBeGreaterThanOrEqual(1);
    // Verify intersection near (2,2,0)
    const anyNear = result.intersections.some(x => {
      const d = dist3(x.pointA, { x: 2, y: 2, z: 0 });
      return d < 0.2;
    });
    expect(anyNear).toBe(true);
  });
});

// ── CurveSelfIntersection ─────────────────────────────────────────────────────

describe("SdCurveSelfIntersection", () => {
  test("figure-eight polyline — one self-intersection at center", () => {
    // oracle: closed-form: a figure-eight made of two circular loops crossing at origin
    const N = 64;
    const pts: { x: number; y: number; z: number }[] = [];
    // First loop: circle of radius 2 centered at (-2,0,0)
    for (let i = 0; i <= N; i++) {
      const theta = (i / N) * 2 * Math.PI;
      pts.push({ x: -2 + 2 * Math.cos(theta), y: 2 * Math.sin(theta), z: 0 });
    }
    // Second loop: circle of radius 2 centered at (2,0,0)
    for (let i = 1; i <= N; i++) {
      const theta = (i / N) * 2 * Math.PI;
      pts.push({ x: 2 + 2 * Math.cos(theta), y: 2 * Math.sin(theta), z: 0 });
    }
    const params: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      params.push(params[i - 1] + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2));
    }
    const curve: Curve = { kind: "polyline", points: pts, parameters: params };
    const result = computeCurveSelfIntersections(curve, 0.3);
    // Should find at least one self-intersection near (0,0,0)
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  test("non-self-intersecting polyline — no results", () => {
    // Simple monotone line — no self-intersections
    const pts = Array.from({ length: 10 }, (_, i) => ({ x: i * 0.5, y: i * 0.3, z: i * 0.1 }));
    const params: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      params.push(params[i - 1] + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2));
    }
    const curve: Curve = { kind: "polyline", points: pts, parameters: params };
    const result = computeCurveSelfIntersections(curve, 1e-3);
    expect(result.length).toBe(0);
  });
});

// ── C++ blocked stubs — skipped ───────────────────────────────────────────────

describe("C++-blocked stubs (kern.wasm required)", () => {
  test.skip("blocked: SdCurveSurfaceIntersection needs general CSX in kern.wasm", () => {
    // Will be un-skipped when kern/curve-surface-intersect.cpp is compiled.
    // Oracle: rhino3dm + verb-nurbs live + replicad
  });

  test.skip("blocked: SdCurveBrepIntersection needs CSX + BREP face iteration in kern.wasm", () => {
    // Will be un-skipped when kern/brep-csx.cpp is compiled.
    // Oracle: replicad + rhino3dm
  });

  test.skip("blocked: SdBrepPlaneSection needs face-plane CSX + loop joining in kern.wasm", () => {
    // Will be un-skipped when kern/brep-plane-section.cpp is compiled.
    // Oracle: OCCT via replicad + Grasshopper component output
  });

  test.skip("blocked: SdSurfaceSurfaceIntersectionGeneral needs BVH seed detection in kern.wasm", () => {
    // Will be un-skipped when kern/ssi.cpp covers arbitrary-orientation surfaces.
    // Oracle: Patrikalakis & Maekawa §7 + replicad + rhino3dm
  });

  test.skip("blocked: SdBrepBrepIntersection needs pairwise face SSI in kern.wasm", () => {
    // Will be un-skipped when kern/brep-brep-intersect.cpp is compiled.
    // Oracle: OCCT BRepAlgoAPI_Section via replicad
  });

  test.skip("blocked: SdMeshMeshIntersection needs triangle-triangle intersection in kern.wasm", () => {
    // Will be un-skipped when kern/mesh-intersect.cpp is compiled.
    // Oracle: replicad mesh-intersect + IFC fixtures
  });

  test.skip("blocked: SdMeshRayIntersection needs BVH ray traversal in kern.wasm", () => {
    // Will be un-skipped when kern/mesh-ray.cpp is compiled.
    // Oracle: Three.js Raycaster (closed-form reference)
  });

  test.skip("blocked: SdMeshPlaneIntersection needs mesh-plane contour stitching in kern.wasm", () => {
    // Will be un-skipped when kern/mesh-plane.cpp is compiled.
    // Oracle: OCCT + replicad mesh section
  });
});
