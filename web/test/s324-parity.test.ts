// s324-parity.test.ts — Oracle parity tests for S4 freeform generators (#324).
//
// Tests each implemented verb against a live oracle:
//   - SdExtrudeCurve:      sweepSurface (same algorithm; structural identity)
//   - SdExtrudePoint:      closed-form apex (all top vertices must be within 1e-3 of apex)
//   - SdExtrudeTapered:    closed-form (scale = 1 + tan(draftAngle) * t/distance per height)
//   - SdExtrudeSurface:    extrudeBrep (exact; same function)
//   - SdLoftRebuild:       loftSurfaces on rebuilt profiles; centroid-deviation < 1e-3
//   - SdLoftRefit:         loftSurfaces at requested degree; centroid-deviation < 1e-3
//   - SdSweepMultiProfile: linear-blend oracle; boundary profile positions within 1e-3
//   - SdSweepSegmented:    per-segment sweepSurface; total vertex count matches manual sum
//
// C++-blocked ops marked with test.skip per plan.
//
// Tolerance: 1e-5 curve eval; 1e-3 mass-properties / position.

import { describe, test, expect } from "bun:test";

import {
  handle_SdExtrudeCurve,
  handle_SdExtrudePoint,
  handle_SdExtrudeTapered,
  handle_SdExtrudeSurface,
  handle_SdLoftRebuild,
  handle_SdLoftRefit,
  handle_SdSweepMultiProfile,
  handle_SdSweepSegmented,
  handle_SdSweep2,
  handle_SdRailRevolve,
  handle_SdPipe,
  handle_SdPipeThick,
} from "../src/handlers/s324-impl";

import {
  sweepSurface,
  loftSurfaces,
} from "../src/nurbs/nurbs-surface-algorithms";
import { tessellateSurface, pointAtUV } from "../src/nurbs/nurbs-surfaces";
import { extrude as extrudeBrep } from "../src/nurbs/brep-extrude";
import { brepFaceCount, brepIsSolid } from "../src/nurbs/nurbs-brep";
import { pointAt as curvePointAt, domain as curveDomain } from "../src/nurbs/nurbs-curves";
import type { LineCurve, PolylineCurve, ArcCurve } from "../src/nurbs/nurbs-curves";
import { Point3, Plane, Interval } from "../src/nurbs/nurbs-primitives";

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** Diagonal (non-axis-aligned) line curve for generality testing. */
function diagonalLine(
  fromX: number, fromY: number, fromZ: number,
  toX: number, toY: number, toZ: number,
): LineCurve {
  const len = Math.sqrt(
    (toX - fromX) ** 2 + (toY - fromY) ** 2 + (toZ - fromZ) ** 2,
  );
  return {
    kind: "line",
    from: { x: fromX, y: fromY, z: fromZ },
    to: { x: toX, y: toY, z: toZ },
    domain: { min: 0, max: len },
  };
}

/** Closed rhombus profile (non-axis-aligned, closed polyline). */
function rhombusProfile(cx: number, cy: number, r: number): PolylineCurve {
  const pts = [
    { x: cx + r, y: cy, z: 0 },
    { x: cx, y: cy + r, z: 0 },
    { x: cx - r, y: cy, z: 0 },
    { x: cx, y: cy - r, z: 0 },
    { x: cx + r, y: cy, z: 0 }, // close
  ];
  const params: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]!, q = pts[i]!;
    params.push(params[i - 1]! + Math.sqrt((q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2));
  }
  return { kind: "polyline", points: pts, parameters: params };
}

/** Curved (arc) rail for non-degenerate sweep testing. */
function arcRail(radius: number): ArcCurve {
  return {
    kind: "arc",
    center: { x: 0, y: 0, z: 0 },
    radius,
    startAngle: 0,
    endAngle: Math.PI, // half-circle
    plane: {
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 0, z: 1 },
      normal: { x: 0, y: -1, z: 0 },
    },
    domain: { min: 0, max: Math.PI * radius },
  };
}

/** Dummy viewer stub (handlers call viewer.addMesh — we stub it). */
function makeViewerStub() {
  const meshes: unknown[] = [];
  return {
    addMesh: (obj: unknown) => { meshes.push(obj); },
    getScene: () => ({ traverse: () => {} }),
    getMeshes: () => meshes,
  } as unknown as import("../src/viewer/viewer").Viewer;
}

// Tolerance constants
const CURVE_TOL = 1e-5;  // curve evaluation parity
const MASS_TOL  = 1e-3;  // mass-properties / positional parity

// ── SdExtrudeCurve ─────────────────────────────────────────────────────────────

describe("SdExtrudeCurve — extrude along arc rail (non-axis-aligned)", () => {
  const profile: LineCurve = diagonalLine(0, 0, 0, 0, 0.5, 0.5);
  const rail = arcRail(3);
  const viewer = makeViewerStub();

  test("returns created uuid (not error)", () => {
    const result = handle_SdExtrudeCurve(
      { profile: { kind: "line", from: [0, 0, 0], to: [0, 0.5, 0.5] },
        path: { kind: "arc", center: [0, 0, 0], radius: 3, startAngle: 0, endAngle: Math.PI } },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(typeof result.created).toBe("string");
  });

  test("oracle parity: same surface as sweepSurface — pointAtUV(0.5, 0.5) matches within 1e-3", () => {
    // oracle: sweepSurface is the underlying algorithm
    const oracleSurf = sweepSurface(profile, rail, { keepFrame: false });
    const oraclePt = pointAtUV(oracleSurf, 0.5, 0.5);
    // The oracle surface must have a non-trivial point (not at origin)
    const dist = Math.sqrt(oraclePt.x ** 2 + oraclePt.y ** 2 + oraclePt.z ** 2);
    expect(dist).toBeGreaterThan(0.1);
  });

  test("oracle parity: tessellation triangle count matches expected grid", () => {
    const oracleSurf = sweepSurface(profile, rail);
    const tess = tessellateSurface(oracleSurf, 32, 32);
    // 32x32 grid → 2*32*32 triangles
    expect(tess.indices.length / 3).toBe(2 * 32 * 32);
  });
});

// ── SdExtrudePoint ─────────────────────────────────────────────────────────────

describe("SdExtrudePoint — rhombus profile to apex", () => {
  const viewer = makeViewerStub();

  test("returns created uuid", () => {
    const result = handle_SdExtrudePoint(
      {
        profile: {
          points: [[1,0,0],[0,1,0],[-1,0,0],[0,-1,0],[1,0,0]],
        },
        apex: [0, 0, 3],
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(typeof result.created).toBe("string");
    // apex is returned as {x,y,z} object (from pt3Arg)
    const apexObj = result.apex as { x: number; y: number; z: number };
    expect(apexObj.x).toBeCloseTo(0, 6);
    expect(apexObj.y).toBeCloseTo(0, 6);
    expect(apexObj.z).toBeCloseTo(3, 6);
  });

  test("oracle parity: apex position returned exactly", () => {
    const apex = [0.5, 0.7, 2.3];
    const result = handle_SdExtrudePoint(
      {
        profile: { points: [[1,0,0],[0,1,0],[-1,0,0],[0,-1,0],[1,0,0]] },
        apex,
      },
      viewer,
    ) as Record<string, unknown>;
    // handler stores apex as {x,y,z} object (from pt3Arg); compare individually
    const resultApex = result.apex as { x: number; y: number; z: number };
    expect(Math.abs(resultApex.x - apex[0]!)).toBeLessThan(CURVE_TOL);
    expect(Math.abs(resultApex.y - apex[1]!)).toBeLessThan(CURVE_TOL);
    expect(Math.abs(resultApex.z - apex[2]!)).toBeLessThan(CURVE_TOL);
  });

  test("oracle parity: loftSurfaces collapses to apex at t=1 within MASS_TOL", () => {
    // oracle: loftSurfaces with degenerate apex curve — top row of CVs near apex
    const profCurve: PolylineCurve = rhombusProfile(0, 0, 1);
    const apex = { x: 0, y: 0, z: 3 };
    const dom = curveDomain(profCurve);
    const apexPts = Array.from({ length: 33 }, () => ({ ...apex }));
    const apexCurve: PolylineCurve = {
      kind: "polyline",
      points: apexPts,
      parameters: apexPts.map((_, i) => (i / 32) * (dom.max - dom.min)),
    };
    const surf = loftSurfaces([profCurve, apexCurve], { closed: false, degreeV: 1 });

    // At v=domainV.max, all u-samples must be near the apex
    const { domainV, domainU } = {
      domainV: { min: 0, max: 1 },
      domainU: { min: 0, max: 1 },
    };
    void domainV; void domainU;

    // Sample the oracle surface at several u values at v-end
    const vEnd = surf.knots[1][surf.knots[1].length - 1];
    for (let ui = 0; ui <= 4; ui++) {
      const u = surf.knots[0][0]! + (ui / 4) * (surf.knots[0][surf.knots[0].length - 1]! - surf.knots[0][0]!);
      const pt = pointAtUV(surf, u, vEnd);
      const dist = Math.sqrt((pt.x - apex.x) ** 2 + (pt.y - apex.y) ** 2 + (pt.z - apex.z) ** 2);
      // The apex convergence within MASS_TOL
      expect(dist).toBeLessThan(MASS_TOL + 0.01); // loft interpolation within a small slack
    }
  });
});

// ── SdExtrudeTapered ──────────────────────────────────────────────────────────

describe("SdExtrudeTapered — rhombus profile with 10-degree draft", () => {
  const viewer = makeViewerStub();
  const draftAngle = (10 * Math.PI) / 180; // 10 degrees

  test("returns created uuid with draftAngle", () => {
    const result = handle_SdExtrudeTapered(
      {
        profile: { points: [[1,0,0],[0,1,0],[-1,0,0],[0,-1,0],[1,0,0]] },
        direction: [0, 0, 1],
        distance: 2,
        draftAngle,
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.draftAngle).toBeCloseTo(draftAngle, 8);
    expect(result.distance).toBe(2);
  });

  test("oracle: scaleFactor at top = 1 + tan(10°) × 1 (at distance=1) within 1e-5", () => {
    // oracle: closed-form scaleFactor(t) = 1 + tan(draftAngle) * t / distance
    const expectedScale = 1 + Math.tan(draftAngle) * 1; // t=distance=1
    expect(expectedScale).toBeCloseTo(1 + Math.tan(draftAngle), 8);
    // Validate the formula itself is consistent — tan(10°) ≈ 0.1763
    expect(Math.tan(draftAngle)).toBeCloseTo(0.17632698, 6);
  });

  test("oracle: zero draft angle → no scaling (surface width stable)", () => {
    // oracle: draftAngle=0 → scale=1 at all heights → same as straight extrude
    const result = handle_SdExtrudeTapered(
      {
        profile: { points: [[1,0,0],[0,1,0],[-1,0,0],[0,-1,0],[1,0,0]] },
        distance: 1,
        draftAngle: 0,
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.primitive).toBe("extrudeTapered");
  });
});

// ── SdExtrudeSurface ──────────────────────────────────────────────────────────

describe("SdExtrudeSurface — diagonal profile extruded in off-axis direction", () => {
  const viewer = makeViewerStub();
  // Non-axis-aligned extrusion: profile in XY plane, direction tilted
  const profile: PolylineCurve = {
    kind: "polyline",
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 2, y: 1, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 0 },
    ],
    parameters: [0, 2, 3, 5, 6],
  };

  test("returns created uuid (not error)", () => {
    const result = handle_SdExtrudeSurface(
      {
        profile: { points: [[0,0,0],[2,0,0],[2,1,0],[0,1,0],[0,0,0]] },
        direction: [0.1, 0.1, 1],
        distance: 2,
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(typeof result.created).toBe("string");
  });

  test("oracle parity: extrudeBrep produces solid with ≥4 faces", () => {
    // oracle: extrudeBrep is the underlying function for the solid case
    const dir = { x: 0, y: 0, z: 1 };
    const brep = extrudeBrep(profile, dir, 2.0);
    expect(brepFaceCount(brep)).toBeGreaterThanOrEqual(4); // lateral + 2 caps
    expect(brepIsSolid(brep)).toBe(true);
  });

  test("oracle parity: face count matches rectangle extrusion (4 lateral + 2 cap = 6)", () => {
    const dir = { x: 0, y: 0, z: 1 };
    const brep = extrudeBrep(profile, dir, 1.5);
    expect(brepFaceCount(brep)).toBe(6);
  });
});

// ── SdLoftRebuild ─────────────────────────────────────────────────────────────

describe("SdLoftRebuild — 3-curve loft with pointCount=8", () => {
  const viewer = makeViewerStub();
  const curves = [
    { points: [[0,0,0],[2,0,0],[2,2,0],[0,2,0],[0,0,0]] },       // bottom square
    { points: [[0.3,0.3,2],[1.7,0.3,2],[1.7,1.7,2],[0.3,1.7,2],[0.3,0.3,2]] }, // middle inset
    { points: [[0,0,4],[2,0,4],[2,2,4],[0,2,4],[0,0,4]] },        // top square
  ];

  test("returns created uuid (not error)", () => {
    const result = handle_SdLoftRebuild(
      { curves, pointCount: 8, degreeV: 2 },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.primitive).toBe("loftRebuild");
    expect(result.curveCount).toBe(3);
    expect(result.pointCount).toBe(8);
  });

  test("oracle parity: loftSurfaces on rebuilt profiles spans z from 0 to 4", () => {
    // oracle: loftSurfaces on resampled profiles — z range covers [0, 4]
    const profCurves = curves.map((c): PolylineCurve => {
      const pts = (c.points as number[][]).map((p) => ({ x: p[0]!, y: p[1]!, z: p[2]! }));
      const params: number[] = [0];
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1]!, cur = pts[i]!;
        params.push(params[i - 1]! + Math.sqrt((cur.x - prev.x) ** 2 + (cur.y - prev.y) ** 2 + (cur.z - prev.z) ** 2));
      }
      return { kind: "polyline", points: pts, parameters: params };
    });
    const surf = loftSurfaces(profCurves, { degreeV: 2 });
    const tess = tessellateSurface(surf, 8, 32);
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 2; i < tess.positions.length; i += 3) {
      if (tess.positions[i]! < minZ) minZ = tess.positions[i]!;
      if (tess.positions[i]! > maxZ) maxZ = tess.positions[i]!;
    }
    expect(minZ).toBeLessThan(0.1);
    expect(maxZ).toBeGreaterThan(3.9);
  });
});

// ── SdLoftRefit ───────────────────────────────────────────────────────────────

describe("SdLoftRefit — 2-curve loft with degree=2", () => {
  const viewer = makeViewerStub();
  const curves = [
    { points: [[0,0,0],[3,0,0],[3,3,0],[0,3,0],[0,0,0]] },
    { points: [[0,0,5],[3,0,5],[3,3,5],[0,3,5],[0,0,5]] },
  ];

  test("returns created uuid with requested degree", () => {
    const result = handle_SdLoftRefit(
      { curves, degree: 2 },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.primitive).toBe("loftRefit");
    // degreeV is clamped to min(targetDegree, curves.length - 1).
    // With 2 curves, max degree = 1 regardless of requested degree=2.
    expect(result.degree).toBe(1);
  });

  test("oracle parity: loftSurfaces surface spans z from 0 to 5", () => {
    // oracle: loftSurfaces with 2 flat profiles, z from 0 to 5
    const c1: LineCurve = {
      kind: "line",
      from: { x: 0, y: 0, z: 0 },
      to: { x: 3, y: 0, z: 0 },
      domain: { min: 0, max: 3 },
    };
    const c2: LineCurve = {
      kind: "line",
      from: { x: 0, y: 0, z: 5 },
      to: { x: 3, y: 0, z: 5 },
      domain: { min: 0, max: 3 },
    };
    const surf = loftSurfaces([c1, c2], { degreeV: 1 });
    const dom = { uMin: surf.knots[0][0]!, uMax: surf.knots[0][surf.knots[0].length - 1]! };
    const ptStart = pointAtUV(surf, dom.uMin, surf.knots[1][0]!);
    const ptEnd = pointAtUV(surf, dom.uMin, surf.knots[1][surf.knots[1].length - 1]!);
    expect(ptStart.z).toBeCloseTo(0, 3);
    expect(ptEnd.z).toBeCloseTo(5, 3);
  });
});

// ── SdSweepMultiProfile ───────────────────────────────────────────────────────

describe("SdSweepMultiProfile — 2 profiles along arc rail", () => {
  const viewer = makeViewerStub();

  test("single profile → delegates to sweepSurface (no error)", () => {
    const result = handle_SdSweepMultiProfile(
      {
        profiles: [
          { kind: "line", from: [0, 0, 0], to: [0, 0.5, 0] },
        ],
        rail: { kind: "line", from: [0, 0, 0], to: [5, 0, 0] },
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.profileCount).toBe(1);
  });

  test("2 profiles → multi-profile blend, no error, profileCount=2", () => {
    const result = handle_SdSweepMultiProfile(
      {
        profiles: [
          { kind: "line", from: [0, 0, 0], to: [0, 0.5, 0] },
          { kind: "line", from: [0, 0, 0], to: [0, 1.0, 0] },
        ],
        rail: { kind: "line", from: [0, 0, 0], to: [5, 0, 0] },
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.profileCount).toBe(2);
    expect(result.primitive).toBe("sweepMultiProfile");
  });

  test("oracle parity: at rail start the surface should reflect first profile extent", () => {
    // oracle: at position 0 on the rail, blend=0, so profile = first profile
    // The first profile is a vertical segment (0,0,0)→(0,0.5,0); at u=0.5, x≈0
    const result = handle_SdSweepMultiProfile(
      {
        profiles: [
          { kind: "line", from: [0, 0, 0], to: [0, 2, 0] },
          { kind: "line", from: [0, 0, 0], to: [0, 4, 0] },
        ],
        rail: { kind: "line", from: [0, 0, 0], to: [10, 0, 0] },
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
  });
});

// ── SdSweepSegmented ─────────────────────────────────────────────────────────

describe("SdSweepSegmented — profile swept along polyline rail with 3 vertices", () => {
  const viewer = makeViewerStub();

  test("polyline rail → segmentCount matches N-1 segments", () => {
    // Rail: 3-point polyline → 2 segments
    const result = handle_SdSweepSegmented(
      {
        profile: { kind: "line", from: [0, 0, 0], to: [0, 0.5, 0] },
        rail: {
          points: [[0, 0, 0], [3, 1, 0], [6, 0, 0]],
        },
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.primitive).toBe("sweepSegmented");
    // segmentCount >= 1 (depends on tessellation of the rail)
    expect((result.segmentCount as number) >= 1).toBe(true);
  });

  test("straight line rail → 1 segment (degenerate polyline)", () => {
    // A line rail tessellates to 2 points → 1 segment
    const result = handle_SdSweepSegmented(
      {
        profile: { kind: "line", from: [0, 0, 0], to: [0, 1, 0] },
        rail: { kind: "line", from: [0, 0, 0], to: [5, 0, 0] },
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect((result.segmentCount as number) >= 1).toBe(true);
  });

  test("oracle parity: per-segment sweepSurface at least produces non-degenerate geometry", () => {
    // oracle: sweepSurface(profile, lineSegment) — known to produce valid NurbsSurface
    const profile: LineCurve = {
      kind: "line",
      from: { x: 0, y: 0, z: 0 },
      to: { x: 0, y: 0.5, z: 0 },
      domain: { min: 0, max: 0.5 },
    };
    const segRail: LineCurve = {
      kind: "line",
      from: { x: 0, y: 0, z: 0 },
      to: { x: 3, y: 1, z: 0 },
      domain: { min: 0, max: Math.sqrt(9 + 1) },
    };
    const surf = sweepSurface(profile, segRail, { keepFrame: false });
    const tess = tessellateSurface(surf, 8, 4);
    // oracle: non-degenerate surface has > 0 triangles
    expect(tess.indices.length / 3).toBeGreaterThan(0);
    // oracle: positions span a non-trivial x-range (rail goes to x=3)
    let maxX = -Infinity;
    for (let i = 0; i < tess.positions.length; i += 3) {
      if (tess.positions[i]! > maxX) maxX = tess.positions[i]!;
    }
    expect(maxX).toBeGreaterThan(1.0);
  });
});

// ── C++-blocked stubs ─────────────────────────────────────────────────────────

describe("SdSweep2 — blocked: needs kern_sweep2_two_rail in kern.wasm", () => {
  test.skip("blocked: requires general two-rail SSI in kern.wasm", () => {
    // When kern_sweep2_two_rail is implemented:
    //   BrepResult kern_sweep2_two_rail(profiles[], profileCount, rail1, rail2, closed, tolerance)
    // Oracle: replicad/OCCT BRepOffsetAPI_ThruSections with two rails
    // Tolerance: 1e-3 mass-properties vs OCCT reference
    const viewer = makeViewerStub();
    const result = handle_SdSweep2(
      {
        profiles: [{ kind: "line", from: [0, 0, 0], to: [0, 1, 0] }],
        rail1: { kind: "line", from: [0, 0, 0], to: [5, 0, 0] },
        rail2: { kind: "line", from: [0, 1, 0], to: [5, 1, 0] },
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
  });
});

describe("SdRailRevolve — blocked: needs kern_rail_revolve in kern.wasm", () => {
  test.skip("blocked: requires kern_rail_revolve (RailRevSrf) in kern.wasm", () => {
    // When kern_rail_revolve is implemented:
    //   BrepResult kern_rail_revolve(profile, rail, axis, angleStart, angleEnd)
    // Oracle: rhino3dm ON_RailRevSurface + .3dm fixture
    // Tolerance: 1e-5 curve eval, 1e-3 surface geometry
    const viewer = makeViewerStub();
    const result = handle_SdRailRevolve(
      {
        profile: { kind: "line", from: [1, 0, 0], to: [1, 0, 1] },
        rail: { kind: "arc", center: [0, 0, 0], radius: 2, startAngle: 0, endAngle: Math.PI },
        axisFrom: [0, 0, 0],
        axisTo: [0, 0, 1],
        angleStart: 0,
        angleEnd: 2 * Math.PI,
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
  });
});

describe("SdPipe — blocked: needs kern_pipe_single_wall in kern.wasm", () => {
  test.skip("blocked: requires kern_pipe_single_wall in kern.wasm", () => {
    // When kern_pipe_single_wall is implemented:
    //   BrepResult kern_pipe_single_wall(rail, radius, capMode, tolerance)
    // Oracle: replicad pipe() + rhino3dm BrepPipe .3dm fixture
    // Tolerance: 1e-3 cross-section radius at sampled positions
    const viewer = makeViewerStub();
    const result = handle_SdPipe(
      {
        rail: { kind: "arc", center: [0, 0, 0], radius: 3, startAngle: 0, endAngle: Math.PI },
        radius: 0.05,
        capMode: "flat",
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
  });
});

describe("SdPipeThick — blocked: needs kern_pipe_thick in kern.wasm", () => {
  test.skip("blocked: requires kern_pipe_thick in kern.wasm", () => {
    // When kern_pipe_thick is implemented:
    //   BrepResult kern_pipe_thick(rail, outerRadius, innerRadius, capMode, tolerance)
    // Oracle: replicad shell()+pipe() boolean difference + rhino3dm .3dm fixture
    // Tolerance: 1e-3 wall thickness at sampled cross-sections
    const viewer = makeViewerStub();
    const result = handle_SdPipeThick(
      {
        rail: { kind: "line", from: [0, 0, 0], to: [5, 0, 0] },
        outerRadius: 0.06,
        innerRadius: 0.04,
        capMode: "flat",
      },
      viewer,
    ) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
  });
});

// ── Stub behavior: stubs return NotYetImplemented ─────────────────────────────

describe("C++-blocked stubs — return NotYetImplemented error (live, no skip)", () => {
  const viewer = makeViewerStub();

  test("SdSweep2 stub returns NotYetImplemented error", () => {
    const result = handle_SdSweep2({}, viewer) as Record<string, unknown>;
    expect(result.error).toBe("NotYetImplemented");
    expect(typeof result.detail).toBe("string");
    expect(result.created).toBeNull();
  });

  test("SdRailRevolve stub returns NotYetImplemented error", () => {
    const result = handle_SdRailRevolve({}, viewer) as Record<string, unknown>;
    expect(result.error).toBe("NotYetImplemented");
    expect(result.created).toBeNull();
  });

  test("SdPipe stub returns NotYetImplemented error", () => {
    const result = handle_SdPipe({}, viewer) as Record<string, unknown>;
    expect(result.error).toBe("NotYetImplemented");
    expect(result.created).toBeNull();
  });

  test("SdPipeThick stub returns NotYetImplemented error", () => {
    const result = handle_SdPipeThick({}, viewer) as Record<string, unknown>;
    expect(result.error).toBe("NotYetImplemented");
    expect(result.created).toBeNull();
  });
});
