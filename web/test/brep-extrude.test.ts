// brep-extrude.test.ts — brep-extrude unit tests (#116 / #7c).
import { describe, test, expect } from "bun:test";
import { extrude } from "../src/nurbs/brep-extrude";
import type { PolylineCurve, ArcCurve, LineCurve } from "../src/nurbs/nurbs-curves";
import { Point3, Vector3, Plane, Interval } from "../src/nurbs/nurbs-primitives";
import { brepFaceCount, brepIsSolid } from "../src/nurbs/nurbs-brep";
import { pointAtUV } from "../src/nurbs/nurbs-surfaces";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Rectangle profile in XY plane: 4 corners, CCW, closed. */
function rectangleProfile(w: number, h: number): PolylineCurve {
  return {
    kind: "polyline",
    points: [
      { x: 0,  y: 0,  z: 0 },
      { x: w,  y: 0,  z: 0 },
      { x: w,  y: h,  z: 0 },
      { x: 0,  y: h,  z: 0 },
      { x: 0,  y: 0,  z: 0 }, // closed
    ],
    parameters: [0, w, w + h, 2 * w + h, 2 * (w + h)],
  };
}

/** Circle profile as ArcCurve (full 360°). */
function circleProfile(radius: number): ArcCurve {
  return {
    kind: "arc",
    center: { x: 0, y: 0, z: 0 },
    radius,
    startAngle: 0,
    endAngle: 2 * Math.PI,
    plane: Plane.worldXY(),
    domain: Interval.create(0, 2 * Math.PI * radius),
  };
}

/** Single line segment profile. */
function lineProfile(length: number): LineCurve {
  return {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to:   { x: length, y: 0, z: 0 },
    domain: Interval.create(0, length),
  };
}

const UP: Vector3 = { x: 0, y: 0, z: 1 };

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("extrude — rectangle profile", () => {
  test("rectangle extruded upward yields 6 faces", () => {
    const profile = rectangleProfile(4, 3);
    const brep = extrude(profile, UP, 3.0);

    // 4 lateral segments (sides) + 2 caps = 6
    expect(brepFaceCount(brep)).toBe(6);
  });

  test("shell is marked closed", () => {
    const brep = extrude(rectangleProfile(4, 3), UP, 3.0);
    expect(brepIsSolid(brep)).toBe(true);
  });

  test("lateral faces are SumSurface kind", () => {
    const brep = extrude(rectangleProfile(4, 3), UP, 3.0);
    const lateralFaces = brep.shells[0].faces.slice(0, 4);
    for (const f of lateralFaces) {
      expect(f.surface.kind).toBe("sum");
    }
  });

  test("cap faces are PlaneSurface kind", () => {
    const brep = extrude(rectangleProfile(4, 3), UP, 3.0);
    const faces = brep.shells[0].faces;
    const bottomCap = faces[faces.length - 2];
    const topCap    = faces[faces.length - 1];
    expect(bottomCap.surface.kind).toBe("plane");
    expect(topCap.surface.kind).toBe("plane");
  });

  test("cap faces carry footprint trim loops instead of whole-plane fallback bounds", () => {
    const brep = extrude(rectangleProfile(4, 3), UP, 3.0);
    const faces = brep.shells[0].faces;
    for (const cap of [faces[faces.length - 2], faces[faces.length - 1]]) {
      const trim = cap.outerLoop.curves[0];
      expect(trim?.kind).toBe("polyline");
      if (trim?.kind !== "polyline") throw new Error("expected polyline trim");
      expect(trim.points).toHaveLength(5);
      const world = trim.points.slice(0, -1).map((point) => pointAtUV(cap.surface, point.x, point.y));
      const xs = world.map((point) => point.x).sort((a, b) => a - b);
      const ys = world.map((point) => point.y).sort((a, b) => a - b);
      expect(xs[0]).toBeCloseTo(0);
      expect(xs[xs.length - 1]).toBeCloseTo(4);
      expect(ys[0]).toBeCloseTo(0);
      expect(ys[ys.length - 1]).toBeCloseTo(3);
    }
  });

  test("lateral surface evaluates at v=0 to profile start", () => {
    const brep = extrude(rectangleProfile(4, 3), UP, 3.0);
    const lateralFace = brep.shells[0].faces[0]; // first side = bottom edge
    const surf = lateralFace.surface;
    if (surf.kind !== "sum") throw new Error("expected sum surface");

    // At v=0, u=domainMin → should be close to profile start (0,0,0)
    const domU = surf.curveU.kind === "line"
      ? Interval.create(0, Point3.distance(surf.curveU.from, surf.curveU.to))
      : Interval.create(0, 1);
    const domV = Interval.create(0, 3.0);

    const pt = pointAtUV(surf, domU.min, domV.min);
    expect(Math.abs(pt.z)).toBeLessThan(0.01);  // bottom cap z ≈ 0
  });

  test("throws on distance <= 0", () => {
    expect(() => extrude(rectangleProfile(4, 3), UP, 0)).toThrow();
    expect(() => extrude(rectangleProfile(4, 3), UP, -1)).toThrow();
  });
});

describe("extrude — circle profile", () => {
  test("circle extruded upward yields 3 faces", () => {
    const profile = circleProfile(2.0);
    const brep = extrude(profile, UP, 2.0);
    // 1 lateral + 2 caps
    expect(brepFaceCount(brep)).toBe(3);
  });

  test("lateral face is SumSurface", () => {
    const brep = extrude(circleProfile(2.0), UP, 2.0);
    expect(brep.shells[0].faces[0].surface.kind).toBe("sum");
  });

  test("caps are PlaneSurface", () => {
    const brep = extrude(circleProfile(2.0), UP, 2.0);
    const faces = brep.shells[0].faces;
    expect(faces[faces.length - 2].surface.kind).toBe("plane");
    expect(faces[faces.length - 1].surface.kind).toBe("plane");
  });
});

describe("extrude — line profile", () => {
  test("line profile extruded gives 3 faces (1 lateral + 2 caps)", () => {
    const brep = extrude(lineProfile(5), UP, 2.0);
    expect(brepFaceCount(brep)).toBe(3);
  });
});
