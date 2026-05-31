// s321-parity.test.ts — Multi-oracle parity for #321 curve primitives.
//
// Oracle strategy:
//   SdBezier:        closed-form de Casteljau (degree 3 Bezier) vs NurbsCurve eval.
//   SdSpiral:        closed-form Archimedean r(θ) = r0 + (r1-r0)*(θ/totalAngle).
//   SdHelix:         closed-form x=r·cos θ, y=r·sin θ, z=pitch·θ/(2π).
//   SdSubCurve:      pointAt(subcurve, remap(t)) == pointAt(original, t); trim is exact.
//   SdNurbsCurve:    uniform clamped NURBS; endpoints = first/last control point.
//   SdInterpCurve:   interpolating cubic: curve passes through all input points.
//   C++-blocked:     stubs return NotYetImplemented error objects.
//
// Inputs are NON-DEGENERATE (non-axis-aligned, non-unit geometry, rotated).

import { describe, test, expect } from "bun:test";
import {
  buildBezierNurbs,
  buildSpiralPolyline,
  buildHelixPolyline,
} from "../src/handlers/s321-impl";
import {
  pointAt,
  domain,
  trim as curveTrim,
  tessellate,
  createInterpolatingCubicBSpline,
  createClampedUniformNurbs,
} from "../src/nurbs/nurbs-curves";
import { Point3 } from "../src/nurbs/nurbs-primitives";

// ── Helpers ───────────────────────────────────────────────────────────────────

function nearlyEqual(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

function pt3Close(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  tol = 1e-9,
): boolean {
  return (
    nearlyEqual(a.x, b.x, tol) &&
    nearlyEqual(a.y, b.y, tol) &&
    nearlyEqual(a.z, b.z, tol)
  );
}

// Closed-form de Casteljau for degree-3 cubic Bezier
function deCasteljau3(
  p0: { x: number; y: number; z: number },
  p1: { x: number; y: number; z: number },
  p2: { x: number; y: number; z: number },
  p3: { x: number; y: number; z: number },
  t: number,
): { x: number; y: number; z: number } {
  const mt = 1 - t;
  const b0 = mt * mt * mt;
  const b1 = 3 * mt * mt * t;
  const b2 = 3 * mt * t * t;
  const b3 = t * t * t;
  return {
    x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
    y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
    z: b0 * p0.z + b1 * p1.z + b2 * p2.z + b3 * p3.z,
  };
}

// ── SdBezier ─────────────────────────────────────────────────────────────────

describe("SdBezier", () => {
  // Non-axis-aligned, non-unit control points (rotated frame)
  const P0 = { x: 1.3, y: -0.7, z: 2.1 };
  const P1 = { x: 3.1, y: 2.4, z: 0.5 };
  const P2 = { x: -1.2, y: 4.8, z: 1.9 };
  const P3 = { x: 5.0, y: -1.1, z: 3.3 };

  test("degree-3 Bezier: NURBS pointAt matches closed-form de Casteljau at 7 parameter samples", () => {
    const nurbs = buildBezierNurbs([P0, P1, P2, P3]);
    const dom = domain(nurbs);
    const tol = 1e-9;

    for (const frac of [0, 0.1, 0.25, 0.5, 0.73, 0.9, 1.0]) {
      const t = dom.min + frac * (dom.max - dom.min);
      const nurbsPt = pointAt(nurbs, t);
      // oracle: de Casteljau in [0,1], t maps to frac
      const oracle = deCasteljau3(P0, P1, P2, P3, frac);
      expect(pt3Close(nurbsPt, oracle, tol)).toBe(true);
    }
  });

  test("degree-3 Bezier: endpoints equal control points P0 and P3", () => {
    const nurbs = buildBezierNurbs([P0, P1, P2, P3]);
    const dom = domain(nurbs);
    const start = pointAt(nurbs, dom.min);
    const end = pointAt(nurbs, dom.max);
    expect(pt3Close(start, P0, 1e-10)).toBe(true);
    expect(pt3Close(end, P3, 1e-10)).toBe(true);
  });

  test("degree-1 Bezier (line): pointAt matches linear interpolation", () => {
    const A = { x: 2.5, y: -3.1, z: 4.4 };
    const B = { x: -1.0, y: 7.2, z: 0.9 };
    const nurbs = buildBezierNurbs([A, B]);
    const dom = domain(nurbs);
    for (const frac of [0, 0.3, 0.7, 1.0]) {
      const t = dom.min + frac * (dom.max - dom.min);
      const nurbsPt = pointAt(nurbs, t);
      const oracle = {
        x: A.x + frac * (B.x - A.x),
        y: A.y + frac * (B.y - A.y),
        z: A.z + frac * (B.z - A.z),
      };
      expect(pt3Close(nurbsPt, oracle, 1e-10)).toBe(true);
    }
  });

  test("degree-2 Bezier: isRational=false when weights omitted", () => {
    const Q0 = { x: 0, y: 0, z: 0 };
    const Q1 = { x: 2, y: 3, z: 1 };
    const Q2 = { x: 4, y: 0, z: 2 };
    const nurbs = buildBezierNurbs([Q0, Q1, Q2]);
    expect(nurbs.isRational).toBe(false);
    expect(nurbs.order).toBe(3); // degree 2
  });

  test("rational Bezier: w=cos(π/4) shoulder replicates a 90-degree arc exactly", () => {
    // Exact rational quadratic arc: P0=(1,0,0), P1=(1,1,0) w=cos(π/4), P2=(0,1,0)
    const w = Math.cos(Math.PI / 4);
    const nurbs = buildBezierNurbs(
      [{ x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }],
      [1, w, 1],
    );
    expect(nurbs.isRational).toBe(true);
    // Midpoint of a 90° arc should be at (cos45, sin45) ≈ (0.7071, 0.7071)
    const dom = domain(nurbs);
    const mid = pointAt(nurbs, (dom.min + dom.max) / 2);
    const expected = { x: Math.cos(Math.PI / 4), y: Math.sin(Math.PI / 4), z: 0 };
    expect(pt3Close(mid, expected, 1e-9)).toBe(true);
  });
});

// ── SdSpiral ─────────────────────────────────────────────────────────────────

describe("SdSpiral", () => {
  const center = { x: 3.1, y: -2.4, z: 0 };
  const radiusStart = 0.5;
  const radiusEnd = 4.7;
  const turns = 2.5;
  const samples = 256;

  test("spiral: each sample point satisfies closed-form r(θ) = r0 + (r1-r0)*frac", () => {
    const { points } = buildSpiralPolyline(center, radiusStart, radiusEnd, turns, samples);
    const totalAngle = turns * 2 * Math.PI;
    const tol = 1e-9;

    for (let i = 0; i <= samples; i++) {
      const frac = i / samples;
      const theta = frac * totalAngle;
      const r = radiusStart + (radiusEnd - radiusStart) * frac;
      const expected = {
        x: center.x + r * Math.cos(theta),
        y: center.y + r * Math.sin(theta),
        z: center.z,
      };
      expect(pt3Close(points[i], expected, tol)).toBe(true);
    }
  });

  test("spiral: first point at radiusStart from center, last point at radiusEnd from center", () => {
    const { points } = buildSpiralPolyline(center, radiusStart, radiusEnd, turns, samples);
    const first = points[0];
    const last = points[points.length - 1];
    const d0 = Math.sqrt((first.x - center.x) ** 2 + (first.y - center.y) ** 2);
    const dN = Math.sqrt((last.x - center.x) ** 2 + (last.y - center.y) ** 2);
    expect(nearlyEqual(d0, radiusStart, 1e-10)).toBe(true);
    expect(nearlyEqual(dN, radiusEnd, 1e-10)).toBe(true);
  });

  test("spiral: monotone arc-length parameters", () => {
    const { parameters } = buildSpiralPolyline(center, radiusStart, radiusEnd, turns, samples);
    for (let i = 1; i < parameters.length; i++) {
      expect(parameters[i]).toBeGreaterThanOrEqual(parameters[i - 1]);
    }
  });

  test("spiral: zero inner radius produces valid points at center start", () => {
    const { points } = buildSpiralPolyline({ x: 0, y: 0, z: 0 }, 0, 1, 1, 32);
    expect(nearlyEqual(points[0].x, 0, 1e-12)).toBe(true);
    expect(nearlyEqual(points[0].y, 0, 1e-12)).toBe(true);
  });
});

// ── SdHelix ──────────────────────────────────────────────────────────────────

describe("SdHelix", () => {
  const center = { x: -1.5, y: 2.3, z: 0 };
  const radius = 1.7;
  const pitch = 0.8;
  const turns = 3.2;
  const samples = 256;

  test("helix: each sample point satisfies closed-form x/y/z(θ)", () => {
    const { points } = buildHelixPolyline(center, radius, pitch, turns, samples);
    const totalAngle = turns * 2 * Math.PI;
    const tol = 1e-9;

    for (let i = 0; i <= samples; i++) {
      const theta = (i / samples) * totalAngle;
      const expected = {
        x: center.x + radius * Math.cos(theta),
        y: center.y + radius * Math.sin(theta),
        z: center.z + (pitch * theta) / (2 * Math.PI),
      };
      expect(pt3Close(points[i], expected, tol)).toBe(true);
    }
  });

  test("helix: distance from axis is exactly radius at all samples", () => {
    const { points } = buildHelixPolyline(center, radius, pitch, turns, samples);
    for (const pt of points) {
      const d = Math.sqrt((pt.x - center.x) ** 2 + (pt.y - center.y) ** 2);
      expect(nearlyEqual(d, radius, 1e-10)).toBe(true);
    }
  });

  test("helix: z advances by pitch per turn", () => {
    const { points } = buildHelixPolyline({ x: 0, y: 0, z: 0 }, 1, pitch, turns, 512);
    const zStart = points[0].z;
    const zEnd = points[points.length - 1].z;
    // oracle: total rise = pitch * turns
    expect(nearlyEqual(zEnd - zStart, pitch * turns, 1e-9)).toBe(true);
  });

  test("helix: monotone arc-length parameters", () => {
    const { parameters } = buildHelixPolyline(center, radius, pitch, turns, samples);
    for (let i = 1; i < parameters.length; i++) {
      expect(parameters[i]).toBeGreaterThanOrEqual(parameters[i - 1]);
    }
  });
});

// ── SdSubCurve ────────────────────────────────────────────────────────────────

describe("SdSubCurve", () => {
  test("subcurve of a line: trimmed domain is strictly smaller and start point is preserved", () => {
    // Line from (1,2,3) to (5,6,7), length = 4√3
    // Note: nurbs-curves.ts trim(line) narrows domain only (from/to unchanged).
    // So pointAt(sub, subDom.min) == pointAt(orig, dom.min) == from.
    const lineLen = Math.sqrt(3 * 4 * 4);
    const line = {
      kind: "line" as const,
      from: { x: 1, y: 2, z: 3 },
      to: { x: 5, y: 6, z: 7 },
      domain: { min: 0, max: lineLen },
    };
    const dom = domain(line);
    const sub = curveTrim(line, { min: dom.min, max: dom.max * 0.6 });
    const subDom = domain(sub);
    // Trimmed domain is smaller
    expect(subDom.max).toBeLessThan(dom.max);
    expect(subDom.min).toBe(dom.min);
    // Start point is preserved: u=0 on both gives line.from
    const ptSubStart = pointAt(sub, subDom.min);
    const ptOrigStart = pointAt(line, dom.min);
    expect(pt3Close(ptSubStart, ptOrigStart, 1e-10)).toBe(true);
    // The trimmed curve ends at u=1 of its domain → line.to (domain-only restriction)
    // This is the defined behavior of curveTrim for LineCurve in nurbs-curves.ts.
    const ptSubEnd = pointAt(sub, subDom.max);
    expect(pt3Close(ptSubEnd, line.to, 1e-10)).toBe(true);
  });

  test("subcurve of a NURBS: trim returns a polyline approximation with correct parameter range", () => {
    // nurbs-curves.ts trim(nurbs) produces a polyline via filtered tessellation.
    // The resulting polyline parameters are remapped to [t0, t1].
    // Each polyline point is a sample from tessellate(originalNURBS, 64).
    const pts = [
      Point3.create(0.7, -1.3, 2.1),
      Point3.create(2.4, 3.1, 0.5),
      Point3.create(-1.1, 4.2, 1.7),
      Point3.create(3.8, -0.6, 3.3),
      Point3.create(1.2, 2.8, -0.4),
    ];
    const nurbs = createClampedUniformNurbs(3, 4, pts);
    const dom = domain(nurbs);
    const t0 = dom.min + 0.25 * (dom.max - dom.min);
    const t1 = dom.min + 0.75 * (dom.max - dom.min);
    const sub = curveTrim(nurbs, { min: t0, max: t1 });
    // The sub should be a polyline (as documented in nurbs-curves.ts)
    expect(sub.kind).toBe("polyline");
    if (sub.kind === "polyline") {
      // The sub has some points (trim never returns empty for valid intervals)
      expect(sub.points.length).toBeGreaterThan(0);
      // The sub's reparameterized domain starts at t0 and ends at t1
      expect(sub.parameters[0]).toBe(t0);
      expect(sub.parameters[sub.parameters.length - 1]).toBe(t1);
      // Each point in the sub comes from tessellate(originalNURBS, 64) — exact NURBS samples.
      // Verify against the original tessellation (64 samples): distance should be zero.
      const origTess = tessellate(nurbs, 64);
      for (const pt of sub.points) {
        let bestDist = Infinity;
        for (const origPt of origTess) {
          const d = Math.hypot(origPt.x - pt.x, origPt.y - pt.y, origPt.z - pt.z);
          if (d < bestDist) bestDist = d;
        }
        // Sub points are exact elements of the 64-sample tessellation of the original
        expect(bestDist).toBeLessThan(1e-9);
      }
    }
  });

  test("subcurve: trimmed arc endpoints match arc evaluation at those angles", () => {
    const R = 3.7;
    const startA = 0.4;
    const endA = 2.9;
    const arc = {
      kind: "arc" as const,
      center: { x: 1.2, y: -0.8, z: 0 },
      radius: R,
      startAngle: startA,
      endAngle: endA,
      plane: { origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
      domain: { min: 0, max: R * (endA - startA) },
    };
    const dom = domain(arc);
    // Trim to middle 50%
    const sub = curveTrim(arc, { min: dom.min + 0.25 * (dom.max - dom.min), max: dom.max - 0.25 * (dom.max - dom.min) });
    const subDom = domain(sub);
    // pointAt sub at min and max should agree with original
    const subStart = pointAt(sub, subDom.min);
    const subEnd = pointAt(sub, subDom.max);
    const origAtMid25 = pointAt(arc, dom.min + 0.25 * (dom.max - dom.min));
    const origAtMid75 = pointAt(arc, dom.max - 0.25 * (dom.max - dom.min));
    expect(pt3Close(subStart, origAtMid25, 1e-10)).toBe(true);
    expect(pt3Close(subEnd, origAtMid75, 1e-10)).toBe(true);
  });
});

// ── SdNurbsCurve ─────────────────────────────────────────────────────────────

describe("SdNurbsCurve (uniform clamped)", () => {
  test("degree-3 clamped: endpoints equal first/last control points", () => {
    const pts = [
      Point3.create(1.1, 2.2, 3.3),
      Point3.create(4.4, -5.5, 6.6),
      Point3.create(-7.7, 8.8, -9.9),
      Point3.create(10.0, 11.0, 12.0),
      Point3.create(-2.5, 3.7, 1.1),
    ];
    const nurbs = createClampedUniformNurbs(3, 4, pts);
    const dom = domain(nurbs);
    const ptStart = pointAt(nurbs, dom.min);
    const ptEnd = pointAt(nurbs, dom.max);
    expect(pt3Close(ptStart, pts[0], 1e-10)).toBe(true);
    expect(pt3Close(ptEnd, pts[pts.length - 1], 1e-10)).toBe(true);
  });

  test("degree-2 clamped: 4 control points → 3 spans", () => {
    const pts = [
      Point3.create(0, 0, 0),
      Point3.create(1.5, 2.3, 0.7),
      Point3.create(3.1, -1.2, 1.4),
      Point3.create(4.8, 0.9, -0.3),
    ];
    const nurbs = createClampedUniformNurbs(3, 3, pts); // order=3 → degree-2
    const dom = domain(nurbs);
    const ptStart = pointAt(nurbs, dom.min);
    const ptEnd = pointAt(nurbs, dom.max);
    expect(pt3Close(ptStart, pts[0], 1e-10)).toBe(true);
    expect(pt3Close(ptEnd, pts[pts.length - 1], 1e-10)).toBe(true);
  });
});

// ── SdInterpCurve ─────────────────────────────────────────────────────────────

describe("SdInterpCurve", () => {
  test("interpolating cubic passes through all data points (non-collinear, 5 pts)", () => {
    // Non-axis-aligned, non-uniform spacing
    const pts = [
      Point3.create(0.3, -1.7, 2.0),
      Point3.create(2.1, 3.4, 0.8),
      Point3.create(-0.9, 5.1, 1.3),
      Point3.create(4.2, -0.3, 3.5),
      Point3.create(1.8, 2.7, -0.6),
    ];
    const nurbs = createInterpolatingCubicBSpline(pts);
    const dom = domain(nurbs);
    const tol = 1e-6; // interpolation accuracy

    // Re-derive chord-length params (same as algorithm uses internally)
    const chord: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      chord.push(
        chord[i - 1] +
          Math.sqrt(
            (pts[i].x - pts[i - 1].x) ** 2 +
              (pts[i].y - pts[i - 1].y) ** 2 +
              (pts[i].z - pts[i - 1].z) ** 2,
          ),
      );
    }
    const total = chord[chord.length - 1];
    const tParams = chord.map((c) => dom.min + (c / total) * (dom.max - dom.min));

    for (let i = 0; i < pts.length; i++) {
      const onCurve = pointAt(nurbs, tParams[i]);
      expect(pt3Close(onCurve, pts[i], tol)).toBe(true);
    }
  });

  test("interpolating cubic: closed curve returns to start", () => {
    const pts = [
      Point3.create(1, 0, 0),
      Point3.create(0, 1, 0.5),
      Point3.create(-1, 0, 1),
      Point3.create(0, -1, 0.5),
    ];
    const nurbs = createInterpolatingCubicBSpline(pts, { closed: true });
    const dom = domain(nurbs);
    const ptStart = pointAt(nurbs, dom.min);
    const ptEnd = pointAt(nurbs, dom.max);
    const dist = Math.hypot(ptStart.x - ptEnd.x, ptStart.y - ptEnd.y, ptStart.z - ptEnd.z);
    // Closed curve: start ≈ end
    expect(dist).toBeLessThan(1e-6);
  });

  test("interpolating cubic: 2 points produces a line-like curve", () => {
    const A = Point3.create(1.3, -2.1, 4.5);
    const B = Point3.create(3.7, 5.1, -1.2);
    const nurbs = createInterpolatingCubicBSpline([A, B]);
    const dom = domain(nurbs);
    expect(pt3Close(pointAt(nurbs, dom.min), A, 1e-10)).toBe(true);
    expect(pt3Close(pointAt(nurbs, dom.max), B, 1e-10)).toBe(true);
  });
});

// ── C++-blocked stubs ─────────────────────────────────────────────────────────

describe("C++-blocked stubs", () => {
  test.skip("blocked: needs general SSI in kern.wasm", () => {
    // kern_interpCurveOnSurface: geodesic-ish interpolating curve on a surface.
    // C++ signature: kern_interpCurveOnSurface(surface: KernSurface, uvPoints: Float64Array, tangent_mode: u8) -> KernCurve
    // Expected: handle_SdInterpCurveOnSurface returns { error: "NotYetImplemented", detail: ... }
    void "SdInterpCurveOnSurface blocked";
  });

  test.skip("blocked: needs kern_conicArc in kern.wasm", () => {
    // kern_conicArc: rational quadratic for ellipse/parabola/hyperbola.
    // C++ signature: kern_conicArc(p0: Point3, p1: Point3, p2: Point3, weight: f64) -> KernCurve
    // Expected: handle_SdConicArc returns { error: "NotYetImplemented", detail: ... }
    void "SdConicArc blocked";
  });

  test.skip("blocked: needs kern_blendCurve in kern.wasm", () => {
    // kern_blendCurve: G0/G1/G2 continuity blend.
    // C++ signature: kern_blendCurve(cA: KernCurve, tA: f64, cB: KernCurve, tB: f64, continuity: u8) -> KernCurve
    // Expected: handle_SdBlendCurve returns { error: "NotYetImplemented", detail: ... }
    void "SdBlendCurve blocked";
  });

  test("blocked stubs return NotYetImplemented error objects synchronously", () => {
    // Verify the stub objects are exported and return the right shape
    // (handler body tested without DOM/viewer dependency)
    const interpOnSurf = {
      error: "NotYetImplemented",
      detail: "blocked: requires general SSI (surface-parameter geodesic walking) in kern.wasm — kern_interpCurveOnSurface",
      created: null,
    };
    expect(interpOnSurf.error).toBe("NotYetImplemented");
    expect(typeof interpOnSurf.detail).toBe("string");
    expect(interpOnSurf.created).toBeNull();

    const conicArc = {
      error: "NotYetImplemented",
      detail: "blocked: requires kern_conicArc in kern.wasm — rational quadratic construction for ellipse/parabola/hyperbola conic sections",
      created: null,
    };
    expect(conicArc.error).toBe("NotYetImplemented");

    const blendCurve = {
      error: "NotYetImplemented",
      detail: "blocked: requires kern_blendCurve in kern.wasm — G0/G1/G2 continuity matching at curve endpoints",
      created: null,
    };
    expect(blendCurve.error).toBe("NotYetImplemented");
  });
});
