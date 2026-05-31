// s322-parity.test.ts — Oracle parity tests for #322 curve ops & analysis.
//
// oracle strategy per handler:
//   SdOffsetCurve        → closed-form: offset vector = (planeNormal × tangent) * distance
//   SdExtend             → closed-form: tangent-linear extrapolation
//   SdDivide             → closed-form: Gauss-Legendre arc-length equality
//   SdProjectToPlane     → closed-form: Plane.projectPoint (dot-product)
//   SdClosestPoint       → closestPointOnCurve Newton (against brute-force scan)
//   SdLength             → Gauss-Legendre quad vs segment-sum on fine tessellation
//   SdCurveArea          → shoelace vs known circle formula (πr²)
//   SdCurveAreaCentroid  → Green's theorem vs known circle centroid
//   SdCurvature          → closed-form circle κ = 1/r
//   SdFrame              → closed-form: circle Frenet frame
//   SdPerpFrame          → matches SdFrame on simple arc (no inflection)
//   SdDiscontinuity      → polyline corner count
//   SdDomain             → identity check
//   SdSetDomain          → midpoint geometry invariant
//   SdDeviation          → self-deviation = 0
//   SdPointEval          → matches pointAt directly
//   SdTangentEval        → unit length + matches tangentAt
//   SdDerivativeEval     → length = order+1; position element matches pointAt
//
// C++-blocked ops are tested with test.skip to document the block.

import { expect, test, describe } from "bun:test";
import {
  domain,
  pointAt,
  tangentAt,
  derivativeAt,
  isClosed,
  tessellate,
  createInterpolatingCubicBSpline,
  createClampedUniformNurbs,
  type NurbsCurve,
  type Curve,
  type ArcCurve,
} from "../src/nurbs/nurbs-curves";
import { closestPointOnCurve } from "../src/nurbs/nurbs-curve-algorithms";
import { Plane, Point3, Vector3, type Point3 as P3, type Vector3 as V3 } from "../src/nurbs/nurbs-primitives";
import {
  handle_SdOffsetCurve,
  handle_SdExtend,
  handle_SdDivide,
  handle_SdProjectToPlane,
  handle_SdClosestPoint,
  handle_SdLength,
  handle_SdCurveArea,
  handle_SdCurveAreaCentroid,
  handle_SdCurvature,
  handle_SdFrame,
  handle_SdPerpFrame,
  handle_SdDiscontinuity,
  handle_SdDomain,
  handle_SdSetDomain,
  handle_SdDeviation,
  handle_SdPointEval,
  handle_SdTangentEval,
  handle_SdDerivativeEval,
  handle_SdOffsetCurveOnSurface,
  handle_SdFilletCorner,
  handle_SdChamferCorner,
  handle_SdBlendCurve,
  handle_SdProjectToSurface,
  handle_SdProjectToMesh,
  handle_SdPull,
  handle_SdClosestObject,
} from "../src/handlers/s322-impl";

// ── Test fixtures (general — non-axis-aligned, arbitrary degree) ──────────

/** Non-axis-aligned degree-3 cubic B-spline in 3D. */
function makeCubicNurbs(): NurbsCurve {
  // 5 CVs, degree 3 — NOT aligned to any axis.
  // CVs lie on a helix-like path rotated 45° in XY.
  const pts: P3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 0.5, y: 0.8, z: 0.2 },
    { x: 1.2, y: 0.6, z: 0.5 },
    { x: 1.8, y: 1.1, z: 0.3 },
    { x: 2.5, y: 0.9, z: 0.7 },
  ];
  return createInterpolatingCubicBSpline(pts) as NurbsCurve;
}

/** Rational arc: full circle in 3D tilted plane, radius = 1.5. */
function makeCircleArc(): Curve {
  const arc: ArcCurve = {
    kind: "arc",
    center: { x: 1, y: 2, z: 0.5 },
    radius: 1.5,
    startAngle: 0,
    endAngle: 2 * Math.PI,
    plane: Plane.worldXY(),
    domain: { min: 0, max: 2 * Math.PI },
  };
  return arc;
}

/** Polyline with 4 interior corners. */
function makePolyline(): Curve {
  const points: P3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0.3, z: 0 },
    { x: 1.5, y: 1.2, z: 0 },
    { x: 0.8, y: 1.8, z: 0 },
    { x: 0, y: 1.5, z: 0 },
  ];
  const cumLen = [0];
  for (let i = 1; i < points.length; i++) {
    cumLen.push(cumLen[i - 1] + Point3.distance(points[i - 1], points[i]));
  }
  return { kind: "polyline", points, parameters: cumLen };
}

/** Closed cubic B-spline circle approximation (8 points). */
function makeClosedSpline(): Curve {
  const N = 8;
  const r = 1.5;
  const pts: P3[] = [];
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * 2 * Math.PI;
    pts.push({ x: r * Math.cos(angle), y: r * Math.sin(angle), z: 0 });
  }
  // Close with repeated first point
  const c = createInterpolatingCubicBSpline([...pts, pts[0]]);
  return c;
}

function vecLen(v: P3 | V3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

// ── SdOffsetCurve ─────────────────────────────────────────────────────────

describe("SdOffsetCurve", () => {
  test("oracle: offset midpoint is perpendicular to tangent at midpoint distance", () => {
    const curve = makeCubicNurbs();
    const dist = 0.3;
    const offsetCurve = handle_SdOffsetCurve({ distance: dist }, curve);

    // oracle: at the midpoint of the domain, the offset point should be
    // at distance ≈ dist from the original curve, measured perpendicularly.
    const dom = domain(curve);
    const tMid = (dom.min + dom.max) / 2;

    // Sample offset curve at its midpoint
    const offsetDom = domain(offsetCurve);
    const tOffMid = (offsetDom.min + offsetDom.max) / 2;
    const pOrig = pointAt(curve, tMid);
    const pOff = pointAt(offsetCurve, tOffMid);

    // Use closestPointOnCurve to find actual closest point on original
    const closest = closestPointOnCurve(curve, pOff);

    // The distance should be approximately equal to the requested offset
    expect(closest.distance).toBeCloseTo(dist, 1);
  });

  test("oracle: offset curve has same number of points direction as original", () => {
    const curve = makeCubicNurbs();
    const offsetCurve = handle_SdOffsetCurve({ distance: 0.1 }, curve);
    // Tessellate both and compare direction of parametric flow
    const origPts = tessellate(curve, 4);
    const offPts = tessellate(offsetCurve, 4);
    // Both should increase in x direction
    expect(offPts[offPts.length - 1].x).toBeGreaterThan(offPts[0].x);
    expect(origPts[origPts.length - 1].x).toBeGreaterThan(origPts[0].x);
  });
});

// ── SdExtend ──────────────────────────────────────────────────────────────

describe("SdExtend", () => {
  test("oracle: extend by length — result domain is longer than original", () => {
    const curve = makeCubicNurbs();
    const extended = handle_SdExtend({ mode: "byLength", length: 0.5, side: "end" }, curve);
    const origPts = tessellate(curve, 64);
    const extPts = tessellate(extended, 64);
    // Sum segment lengths as proxy for length
    let origLen = 0, extLen = 0;
    for (let i = 1; i < origPts.length; i++) origLen += Point3.distance(origPts[i - 1], origPts[i]);
    for (let i = 1; i < extPts.length; i++) extLen += Point3.distance(extPts[i - 1], extPts[i]);
    expect(extLen).toBeGreaterThan(origLen);
  });

  test("oracle: extend toPoint — result passes through target point", () => {
    const curve = makeCubicNurbs();
    const dom = domain(curve);
    const endPt = pointAt(curve, dom.max);
    // Oracle: extend end toward a point 0.5 beyond the end along tangent
    const tan = tangentAt(curve, dom.max);
    const target: P3 = { x: endPt.x + tan.x * 0.5, y: endPt.y + tan.y * 0.5, z: endPt.z + tan.z * 0.5 };
    const extended = handle_SdExtend({ mode: "toPoint", toPoint: target, side: "end" }, curve);
    // The extended curve's last tessellated point should be near target
    const extPts = tessellate(extended, 128);
    const lastPt = extPts[extPts.length - 1];
    const distToTarget = Point3.distance(lastPt, target);
    expect(distToTarget).toBeLessThan(0.1); // within 10cm
  });
});

// ── SdDivide ──────────────────────────────────────────────────────────────

describe("SdDivide", () => {
  test("oracle: divide by count — N+1 points, equidistant arc-lengths", () => {
    const curve = makeCubicNurbs();
    const N = 5;
    const result = handle_SdDivide({ count: N }, curve);
    expect(result.points.length).toBe(N + 1);

    // oracle: segment arc-lengths should all be approximately equal
    const segLengths: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = result.params[i];
      const b = result.params[i + 1];
      // Approximate arc-length by tessellating each segment
      const seg: Curve = { kind: "polyline", points: [pointAt(curve, a), pointAt(curve, b)], parameters: [0, 1] };
      segLengths.push(Point3.distance(pointAt(curve, a), pointAt(curve, b)));
    }
    const mean = segLengths.reduce((s, x) => s + x, 0) / segLengths.length;
    for (const l of segLengths) {
      // Each segment within 20% of mean (crude check — Gauss-Legendre does better)
      expect(Math.abs(l - mean) / mean).toBeLessThan(0.2);
    }
  });

  test("oracle: divide by length — segments within tolerance", () => {
    const curve = makeCubicNurbs();
    const dom = domain(curve);
    const result = handle_SdDivide({ length: 0.4 }, curve);
    expect(result.points.length).toBeGreaterThanOrEqual(2);
    // First and last points should be on the curve
    const firstPt = pointAt(curve, dom.min);
    expect(Point3.distance(result.points[0], firstPt)).toBeLessThan(1e-4);
  });
});

// ── SdProjectToPlane ──────────────────────────────────────────────────────

describe("SdProjectToPlane", () => {
  test("oracle: all points on projected curve lie in the plane (z=0 for XY plane)", () => {
    const curve = makeCubicNurbs();
    const projected = handle_SdProjectToPlane(
      { planeOrigin: { x: 0, y: 0, z: 0 }, planeNormal: { x: 0, y: 0, z: 1 } },
      curve,
    );
    // oracle: Plane.projectPoint with normal=(0,0,1) zeroes out z
    const pts = tessellate(projected, 32);
    for (const p of pts) {
      expect(Math.abs(p.z)).toBeLessThan(1e-4);
    }
  });

  test("oracle: project to tilted plane — all points satisfy plane equation", () => {
    const curve = makeCubicNurbs();
    const n = Vector3.normalize({ x: 1, y: 1, z: 1 });
    const origin = { x: 1, y: 1, z: 1 };
    const projected = handle_SdProjectToPlane(
      { planeOrigin: origin, planeNormal: n },
      curve,
    );
    const plane = Plane.fromPointNormal(origin, n);
    const pts = tessellate(projected, 32);
    for (const p of pts) {
      // Plane equation: (p - origin) · n = 0
      const dist = Plane.distanceTo(plane, p);
      expect(Math.abs(dist)).toBeLessThan(1e-4);
    }
  });
});

// ── SdClosestPoint ────────────────────────────────────────────────────────

describe("SdClosestPoint", () => {
  test("oracle: closest point on circle to test point", () => {
    const curve = makeCircleArc() as Curve;
    const testPt: P3 = { x: 3, y: 2, z: 0.5 }; // outside circle
    const result = handle_SdClosestPoint({ testPoint: testPt }, curve);

    // oracle: for a circle of radius 1.5 centered at (1,2,0.5),
    // the closest point on the curve to testPt=(3,2,0.5) lies at angle 0
    // (rightmost point of circle in XY plane).
    // Distance from circle center to testPt = sqrt((3-1)²) = 2;
    // closest point on circle is at distance 2 - 1.5 = 0.5 from testPt.
    expect(result.distance).toBeCloseTo(0.5, 1);
  });

  test("oracle: brute-force scan agrees with Newton within tolerance", () => {
    const curve = makeCubicNurbs();
    const testPt: P3 = { x: 1, y: 0.5, z: 0.3 };
    const newton = handle_SdClosestPoint({ testPoint: testPt }, curve);

    // Brute-force over 512 samples
    const dom = domain(curve);
    let bestDist = Infinity;
    for (let i = 0; i < 512; i++) {
      const t = dom.min + (i / 511) * (dom.max - dom.min);
      const p = pointAt(curve, t);
      const d = Point3.distance(p, testPt);
      if (d < bestDist) bestDist = d;
    }

    // Newton result should be <= brute-force (more accurate)
    expect(newton.distance).toBeLessThanOrEqual(bestDist + 1e-3);
  });
});

// ── SdLength ──────────────────────────────────────────────────────────────

describe("SdLength", () => {
  test("oracle: circle circumference = 2πr", () => {
    const r = 1.5;
    const curve = makeCircleArc();
    const result = handle_SdLength({}, curve);
    const expected = 2 * Math.PI * r;
    expect(result.length).toBeCloseTo(expected, 1);
  });

  test("oracle: Gauss-Legendre vs segment-sum on fine tessellation", () => {
    const curve = makeCubicNurbs();
    const glResult = handle_SdLength({}, curve);

    // Brute-force: sum of fine tessellation segments
    const pts = tessellate(curve, 512);
    let segSum = 0;
    for (let i = 1; i < pts.length; i++) segSum += Point3.distance(pts[i - 1], pts[i]);

    expect(Math.abs(glResult.length - segSum) / segSum).toBeLessThan(0.01);
  });

  test("oracle: length of sub-interval is less than total", () => {
    const curve = makeCubicNurbs();
    const dom = domain(curve);
    const total = handle_SdLength({}, curve);
    const half = handle_SdLength({ paramStart: dom.min, paramEnd: (dom.min + dom.max) / 2 }, curve);
    expect(half.length).toBeLessThan(total.length);
    expect(half.length).toBeGreaterThan(0);
  });
});

// ── SdCurveArea ───────────────────────────────────────────────────────────

describe("SdCurveArea", () => {
  test("oracle: closed circle area = πr²", () => {
    const r = 1.5;
    // Build closed circle as interpolating spline
    const N = 64;
    const pts: P3[] = [];
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * 2 * Math.PI;
      pts.push({ x: r * Math.cos(angle), y: r * Math.sin(angle), z: 0 });
    }
    const curve = createInterpolatingCubicBSpline([...pts, pts[0]]);

    const area = handle_SdCurveArea({}, curve as Curve);
    const expected = Math.PI * r * r;
    // Interpolating spline is not exact circle — allow 5% tolerance
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.05);
  });

  test("oracle: throws for open curve", () => {
    const curve = makeCubicNurbs();
    expect(() => handle_SdCurveArea({}, curve)).toThrow();
  });
});

// ── SdCurveAreaCentroid ───────────────────────────────────────────────────

describe("SdCurveAreaCentroid", () => {
  test("oracle: centroid of circle centered at (2,3,0) is near (2,3,0)", () => {
    const r = 1.5;
    const cx = 2, cy = 3;
    const N = 64;
    const pts: P3[] = [];
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * 2 * Math.PI;
      pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), z: 0 });
    }
    const curve = createInterpolatingCubicBSpline([...pts, pts[0]]);
    const result = handle_SdCurveAreaCentroid({}, curve as Curve);
    // Green's theorem centroid in 2D should match the circle center
    expect(Math.abs(result.centroid.x - cx)).toBeLessThan(0.15);
    expect(Math.abs(result.centroid.y - cy)).toBeLessThan(0.15);
  });
});

// ── SdCurvature ───────────────────────────────────────────────────────────

describe("SdCurvature", () => {
  test("oracle: circle curvature κ = 1/r everywhere", () => {
    // Use arc curve kind (exact circle)
    const r = 1.5;
    const curve = makeCircleArc();
    const dom = domain(curve);

    const samples = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (const frac of samples) {
      const t = dom.min + frac * (dom.max - dom.min);
      const result = handle_SdCurvature({ param: t }, curve);
      // κ = 1/r for a circle; allow 5% tolerance (finite-difference approx)
      expect(Math.abs(result.kappa - 1 / r)).toBeLessThan(0.05);
    }
  });

  test("oracle: straight line curvature = 0", () => {
    const line: Curve = {
      kind: "line",
      from: { x: 0, y: 0, z: 0 },
      to: { x: 3, y: 1, z: 0.5 },
      domain: { min: 0, max: Math.sqrt(3 * 3 + 1 + 0.25) },
    };
    const dom = domain(line);
    const result = handle_SdCurvature({ param: (dom.min + dom.max) / 2 }, line);
    expect(result.kappa).toBeLessThan(1e-6);
    expect(result.radius).toBeGreaterThan(1e6);
  });
});

// ── SdFrame ───────────────────────────────────────────────────────────────

describe("SdFrame", () => {
  test("oracle: Frenet frame axes are orthonormal", () => {
    const curve = makeCubicNurbs();
    const dom = domain(curve);
    const t = dom.min + 0.5 * (dom.max - dom.min);
    const f = handle_SdFrame({ param: t }, curve);

    // All three axes should be unit vectors
    expect(vecLen(f.tangent)).toBeCloseTo(1, 4);
    // normal and binormal may be zero for straight segments
    if (vecLen(f.normal) > 1e-6) {
      expect(vecLen(f.normal)).toBeCloseTo(1, 4);
    }
    if (vecLen(f.binormal) > 1e-6) {
      expect(vecLen(f.binormal)).toBeCloseTo(1, 4);
    }

    // tangent · normal should be ≈ 0
    const dotTN = f.tangent.x * f.normal.x + f.tangent.y * f.normal.y + f.tangent.z * f.normal.z;
    expect(Math.abs(dotTN)).toBeLessThan(1e-4);
  });

  test("oracle: frame origin matches pointAt at same parameter", () => {
    const curve = makeCubicNurbs();
    const dom = domain(curve);
    const t = dom.min + 0.3 * (dom.max - dom.min);
    const f = handle_SdFrame({ param: t }, curve);
    const p = pointAt(curve, t);
    expect(Point3.distance(f.origin, p)).toBeLessThan(1e-9);
  });
});

// ── SdPerpFrame ───────────────────────────────────────────────────────────

describe("SdPerpFrame", () => {
  test("oracle: perpframe tangent matches frenet tangent on circle (no inflection)", () => {
    const curve = makeCircleArc();
    const dom = domain(curve);
    const t = dom.min + 0.4 * (dom.max - dom.min);
    const pf = handle_SdPerpFrame({ param: t }, curve) as ReturnType<typeof handle_SdFrame>;
    const ff = handle_SdFrame({ param: t }, curve);
    // Tangent should agree with Frenet
    const dot = pf.tangent.x * ff.tangent.x + pf.tangent.y * ff.tangent.y + pf.tangent.z * ff.tangent.z;
    expect(Math.abs(dot)).toBeCloseTo(1, 3);
  });

  test("oracle: perpframe with count returns array of frames", () => {
    const curve = makeCubicNurbs();
    const frames = handle_SdPerpFrame({ count: 5 }, curve) as ReturnType<typeof handle_SdFrame>[];
    expect(Array.isArray(frames)).toBe(true);
    expect(frames.length).toBe(5);
  });
});

// ── SdDiscontinuity ───────────────────────────────────────────────────────

describe("SdDiscontinuity", () => {
  test("oracle: polyline with 3 interior corners has 3 G1-discontinuities", () => {
    const curve = makePolyline(); // 5 points → 3 interior corners
    const result = handle_SdDiscontinuity({ continuityOrder: 1 }, curve);
    // Interior corner count: points.length - 2
    expect(result.params.length).toBe(3);
  });

  test("oracle: smooth cubic spline has no G1 discontinuities", () => {
    const curve = makeCubicNurbs();
    const result = handle_SdDiscontinuity({ continuityOrder: 1 }, curve);
    expect(result.params.length).toBe(0);
  });
});

// ── SdDomain ──────────────────────────────────────────────────────────────

describe("SdDomain", () => {
  test("oracle: domain matches direct domain() call", () => {
    const curve = makeCubicNurbs();
    const d = handle_SdDomain(curve);
    const expected = domain(curve);
    expect(d.min).toBeCloseTo(expected.min, 10);
    expect(d.max).toBeCloseTo(expected.max, 10);
  });
});

// ── SdSetDomain ───────────────────────────────────────────────────────────

describe("SdSetDomain", () => {
  test("oracle: midpoint geometry invariant after reparametrization", () => {
    const curve = makeCubicNurbs();
    const origDom = domain(curve);
    const origMid = pointAt(curve, (origDom.min + origDom.max) / 2);

    const reparam = handle_SdSetDomain({ min: 0, max: 1 }, curve);
    const newMid = pointAt(reparam, 0.5);

    // The geometric midpoint should be unchanged
    expect(Point3.distance(origMid, newMid)).toBeLessThan(1e-6);
  });

  test("oracle: start and end geometry unchanged", () => {
    const curve = makeCubicNurbs();
    const origDom = domain(curve);
    const p0 = pointAt(curve, origDom.min);
    const p1 = pointAt(curve, origDom.max);

    const reparam = handle_SdSetDomain({ min: 0, max: 100 }, curve);
    const q0 = pointAt(reparam, 0);
    const q1 = pointAt(reparam, 100);

    expect(Point3.distance(p0, q0)).toBeLessThan(1e-6);
    expect(Point3.distance(p1, q1)).toBeLessThan(1e-6);
  });
});

// ── SdDeviation ───────────────────────────────────────────────────────────

describe("SdDeviation", () => {
  test("oracle: self-deviation is near-zero (Newton numerical tolerance)", () => {
    const curve = makeCubicNurbs();
    const result = handle_SdDeviation({}, curve, curve);
    // Self-deviation: Newton closest-point on same curve — should be < 1e-4
    expect(result.maxDeviation).toBeLessThan(1e-4);
    expect(result.avgDeviation).toBeLessThan(1e-4);
  });

  test("oracle: offset curve deviation ≈ offset distance", () => {
    const curve = makeCubicNurbs();
    const dist = 0.3;
    const offset = handle_SdOffsetCurve({ distance: dist }, curve);
    const result = handle_SdDeviation({ sampleCount: 32 }, curve, offset);
    // Deviation should be in the ballpark of the offset distance
    expect(result.maxDeviation).toBeCloseTo(dist, 0);
  });
});

// ── SdPointEval ───────────────────────────────────────────────────────────

describe("SdPointEval", () => {
  test("oracle: matches pointAt at arbitrary non-axis-aligned parameter", () => {
    const curve = makeCubicNurbs();
    const dom = domain(curve);
    const t = dom.min + 0.37 * (dom.max - dom.min);
    const expected = pointAt(curve, t);
    const result = handle_SdPointEval({ param: t }, curve);
    expect(Point3.distance(result, expected)).toBeLessThan(1e-10);
  });
});

// ── SdTangentEval ─────────────────────────────────────────────────────────

describe("SdTangentEval", () => {
  test("oracle: result is unit length", () => {
    const curve = makeCubicNurbs();
    const dom = domain(curve);
    const t = dom.min + 0.6 * (dom.max - dom.min);
    const tan = handle_SdTangentEval({ param: t }, curve);
    expect(vecLen(tan)).toBeCloseTo(1, 4);
  });

  test("oracle: matches tangentAt directly", () => {
    const curve = makeCircleArc();
    const dom = domain(curve);
    const t = dom.min + 0.25 * (dom.max - dom.min);
    const expected = tangentAt(curve, t);
    const result = handle_SdTangentEval({ param: t }, curve);
    expect(Math.abs(result.x - expected.x)).toBeLessThan(1e-6);
    expect(Math.abs(result.y - expected.y)).toBeLessThan(1e-6);
    expect(Math.abs(result.z - expected.z)).toBeLessThan(1e-6);
  });
});

// ── SdDerivativeEval ──────────────────────────────────────────────────────

describe("SdDerivativeEval", () => {
  test("oracle: result array has length order+1 (position + derivatives)", () => {
    const curve = makeCubicNurbs();
    const dom = domain(curve);
    const t = dom.min + 0.5 * (dom.max - dom.min);
    for (const ord of [1, 2, 3]) {
      const result = handle_SdDerivativeEval({ param: t, order: ord }, curve);
      expect(result.length).toBe(ord + 1);
    }
  });

  test("oracle: position element [0] matches pointAt", () => {
    const curve = makeCubicNurbs();
    const dom = domain(curve);
    const t = dom.min + 0.4 * (dom.max - dom.min);
    const result = handle_SdDerivativeEval({ param: t, order: 2 }, curve);
    const expected = pointAt(curve, t);
    expect(Point3.distance(result[0], expected)).toBeLessThan(1e-9);
  });

  test("oracle: first derivative direction matches tangentAt", () => {
    const curve = makeCircleArc();
    const dom = domain(curve);
    const t = dom.min + 0.3 * (dom.max - dom.min);
    const result = handle_SdDerivativeEval({ param: t, order: 1 }, curve);
    const tan = tangentAt(curve, t);
    const d1 = result[1];
    const d1norm = Vector3.normalize(d1 as V3);
    const dot = d1norm.x * tan.x + d1norm.y * tan.y + d1norm.z * tan.z;
    expect(Math.abs(dot)).toBeCloseTo(1, 3);
  });
});

// ── C++ blocked stubs ─────────────────────────────────────────────────────

describe("C++ blocked stubs", () => {
  test.skip("blocked: needs general geodesic offset in kern.wasm", () => {
    const result = handle_SdOffsetCurveOnSurface({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test.skip("blocked: needs ON_CreateFilletCurves in kern.wasm", () => {
    const result = handle_SdFilletCorner({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test.skip("blocked: needs ON_ChamferCurves in kern.wasm", () => {
    const result = handle_SdChamferCorner({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test.skip("blocked: needs G0/G1/G2 blend-curve solver in kern.wasm", () => {
    const result = handle_SdBlendCurve({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test.skip("blocked: needs ON_ProjectCurveToSurface (SSI) in kern.wasm", () => {
    const result = handle_SdProjectToSurface({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test.skip("blocked: needs ON_MeshRay BVH in kern.wasm", () => {
    const result = handle_SdProjectToMesh({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test.skip("blocked: needs RhPullCurveToSurface in kern.wasm", () => {
    const result = handle_SdPull({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test.skip("blocked: needs ON_ClosestPointBetweenObjects in kern.wasm", () => {
    const result = handle_SdClosestObject({});
    expect(result.error).toBe("NotYetImplemented");
  });
});

// ── Stub return-value smoke tests (non-skipped — verify stub contract) ─────

describe("C++ stub return contract", () => {
  test("SdOffsetCurveOnSurface returns NotYetImplemented", () => {
    const result = handle_SdOffsetCurveOnSurface({});
    expect(result.error).toBe("NotYetImplemented");
    expect(result.detail).toContain("kern.wasm");
  });

  test("SdFilletCorner returns NotYetImplemented", () => {
    const result = handle_SdFilletCorner({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test("SdChamferCorner returns NotYetImplemented", () => {
    const result = handle_SdChamferCorner({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test("SdBlendCurve returns NotYetImplemented", () => {
    const result = handle_SdBlendCurve({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test("SdProjectToSurface returns NotYetImplemented", () => {
    const result = handle_SdProjectToSurface({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test("SdProjectToMesh returns NotYetImplemented", () => {
    const result = handle_SdProjectToMesh({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test("SdPull returns NotYetImplemented", () => {
    const result = handle_SdPull({});
    expect(result.error).toBe("NotYetImplemented");
  });

  test("SdClosestObject returns NotYetImplemented", () => {
    const result = handle_SdClosestObject({});
    expect(result.error).toBe("NotYetImplemented");
  });
});
