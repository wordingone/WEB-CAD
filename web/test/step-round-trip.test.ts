// STEP export round-trip — NURBS surface geometry parity (#372 STEP leg).
//
// AC (Leo #13340): completes IFC+.3dm+OBJ+STL+STEP first-class round-trip set.
// AC extension (Leo #13348): opening-fidelity note required.
//
// Testable path in Bun: exportNurbsToStep (SdStepWrite Path C — pure TS,
// AP214 B_SPLINE_SURFACE_WITH_KNOTS). SdStepWrite Paths A/B (replicad/OCCT
// worker) are browser-only and not exercised here.
//
// Opening-fidelity note (Leo #13348): exportNurbsToStep is a single-surface
// geometry exporter. It carries NO wall/opening/void semantics. Void fidelity
// (IfcOpeningElement / OCCT boolean subtraction) belongs to:
//   (a) IFC loadability follow-up — web-ifc WASM, assert IfcOpeningElement present
//   (b) deployed cert for SdStepWrite Paths A/B (replicad+OCCT, browser cert)
//
// Parity invariants for Path C (what this file verifies):
//   CARTESIAN_POINT count === countU × countV  (one per control point, row-major)
//   B_SPLINE_SURFACE_WITH_KNOTS present (non-rational) or RATIONAL_B_SPLINE_SURFACE (rational)
//   Degree U/V preserved exactly
//   Knot multiplicity sums: sum(mults_U) == countU+degreeU+1; sum(mults_V) == countV+degreeV+1
//   SHAPE_DEFINITION_REPRESENTATION present (OCCT AP214 root anchor)
//   Control-point bbox round-trips within 1e-7 (stepReal precision)
//   AP214 AUTOMOTIVE_DESIGN schema header

import { describe, test, expect } from "bun:test";
import {
  exportNurbsToStep,
  nurbsSurfaceFromGrid,
  buildSampleNurbsSurface,
  type NurbsSurface,
} from "../src/nurbs/nurbs-kernel.js";

// ── STEP-21 text parsers ──────────────────────────────────────────────────────

function parseCartesianPoints(text: string): [number, number, number][] {
  // nurbs-kernel emits: #N=CARTESIAN_POINT('',(x,y,z));
  const re = /=CARTESIAN_POINT\('',\(([-\d.eE+]+),([-\d.eE+]+),([-\d.eE+]+)\)\);/g;
  const coords: [number, number, number][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    coords.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
  }
  return coords;
}

function parseBSplineDegrees(text: string): [number, number] | null {
  // Non-rational: #N=B_SPLINE_SURFACE_WITH_KNOTS('avir-nurbs-surface',dU,dV,...);
  let m = text.match(/=B_SPLINE_SURFACE_WITH_KNOTS\('avir-nurbs-surface',(\d+),(\d+),/);
  if (m) return [parseInt(m[1]), parseInt(m[2])];
  // Rational complex entity: ...B_SPLINE_SURFACE(dU,dV,...);
  m = text.match(/B_SPLINE_SURFACE\((\d+),(\d+),/);
  if (m) return [parseInt(m[1]), parseInt(m[2])];
  return null;
}

function parseKnotMultiplicitySums(text: string): [number, number] | null {
  // B_SPLINE_SURFACE_WITH_KNOTS (non-rational): last param before .UNSPECIFIED.
  // is (...knotsLiteral...,.UNSPECIFIED.);
  // Mult lists appear as: (m1,m2,...),(m3,m4,...)
  // The surface entity line contains exactly 2 mult-list params before the knot lists.
  // Extract from the entity line: after degree params.
  const entityLine = text.match(
    /=B_SPLINE_SURFACE_WITH_KNOTS\([^;]*\);|B_SPLINE_SURFACE_WITH_KNOTS\([^)]*\)/,
  );
  if (!entityLine) return null;
  const line = entityLine[0];
  // Find all parenthesized integer lists: (d,d,d,...)
  const intLists = Array.from(line.matchAll(/\((\d+(?:,\d+)*)\)/g), (m) =>
    m[1].split(",").map(Number),
  );
  // First two int-lists are U multiplicities and V multiplicities.
  if (intLists.length < 2) return null;
  const sumU = intLists[0].reduce((s, v) => s + v, 0);
  const sumV = intLists[1].reduce((s, v) => s + v, 0);
  return [sumU, sumV];
}

function bboxOf(pts: [number, number, number][]): {
  min: [number, number, number];
  max: [number, number, number];
} {
  let [xMin, yMin, zMin] = [Infinity, Infinity, Infinity];
  let [xMax, yMax, zMax] = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of pts) {
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    if (z < zMin) zMin = z; if (z > zMax) zMax = z;
  }
  return { min: [xMin, yMin, zMin], max: [xMax, yMax, zMax] };
}

function sourceBbox(surface: NurbsSurface): {
  min: [number, number, number];
  max: [number, number, number];
} {
  return bboxOf(surface.controlPoints as [number, number, number][]);
}

// ── Test surfaces ─────────────────────────────────────────────────────────────

// Surface A: bilinear patch (degree 1×1, 2×2 CPs, all weights=1, non-rational)
const bilinear: NurbsSurface = nurbsSurfaceFromGrid(
  [
    [[0, 0, 0], [0, 5, 0]],
    [[8, 0, 0], [8, 5, 0]],
  ],
  undefined,
  undefined,
  undefined,
  1,
  1,
);

// Surface B: bicubic flat patch (degree 3×3, 4×4 CPs, non-rational)
const bicubic: NurbsSurface = nurbsSurfaceFromGrid(
  [
    [[0, 0, 0],   [0, 2, 0.5],   [0, 4, 0.5],   [0, 6, 0]],
    [[3, 0, 0.5], [3, 2, 2.0],   [3, 4, 2.0],   [3, 6, 0.5]],
    [[6, 0, 0.5], [6, 2, 2.0],   [6, 4, 2.0],   [6, 6, 0.5]],
    [[9, 0, 0],   [9, 2, 0.5],   [9, 4, 0.5],   [9, 6, 0]],
  ],
  undefined,
  undefined,
  undefined,
  3,
  3,
);

// Surface C: canonical rational sample from nurbs-kernel (3×3 CPs, degree 2×2, rational)
const rational = buildSampleNurbsSurface(); // quarter-cylinder arc

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("STEP export round-trip — NURBS geometry parity (#372/#400 STEP leg)", () => {
  // ── Header/schema ──────────────────────────────────────────────────────────

  test("STEP output is valid AP214 ISO-10303-21 (bilinear)", () => {
    const bytes = exportNurbsToStep(bilinear);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("ISO-10303-21;");
    expect(text).toContain("END-ISO-10303-21;");
    // AP214 AUTOMOTIVE_DESIGN schema
    expect(text).toContain("AUTOMOTIVE_DESIGN");
    expect(text).toContain("FILE_SCHEMA");
    // Must have a DATA section
    expect(text).toContain("DATA;");
    expect(text).toContain("ENDSEC;");
  });

  // ── Control-point count parity ────────────────────────────────────────────

  test("CARTESIAN_POINT count = countU × countV for bilinear (2×2 = 4)", () => {
    const text = new TextDecoder().decode(exportNurbsToStep(bilinear));
    const pts = parseCartesianPoints(text);
    expect(pts.length).toBe(bilinear.countU * bilinear.countV);
    expect(pts.length).toBe(4);
  });

  test("CARTESIAN_POINT count = countU × countV for bicubic (4×4 = 16)", () => {
    const text = new TextDecoder().decode(exportNurbsToStep(bicubic));
    const pts = parseCartesianPoints(text);
    expect(pts.length).toBe(bicubic.countU * bicubic.countV);
    expect(pts.length).toBe(16);
  });

  test("CARTESIAN_POINT count = countU × countV for rational sample (3×3 = 9)", () => {
    const text = new TextDecoder().decode(exportNurbsToStep(rational));
    const pts = parseCartesianPoints(text);
    expect(pts.length).toBe(rational.countU * rational.countV);
    expect(pts.length).toBe(9);
  });

  // ── Degree preservation ───────────────────────────────────────────────────

  test("degree U/V preserved exactly: bilinear degree 1×1", () => {
    const text = new TextDecoder().decode(exportNurbsToStep(bilinear));
    const degrees = parseBSplineDegrees(text);
    expect(degrees).not.toBeNull();
    expect(degrees![0]).toBe(1); // degreeU
    expect(degrees![1]).toBe(1); // degreeV
  });

  test("degree U/V preserved exactly: bicubic degree 3×3", () => {
    const text = new TextDecoder().decode(exportNurbsToStep(bicubic));
    const degrees = parseBSplineDegrees(text);
    expect(degrees).not.toBeNull();
    expect(degrees![0]).toBe(3);
    expect(degrees![1]).toBe(3);
  });

  test("degree U/V preserved exactly: rational sample degree 2×2", () => {
    const text = new TextDecoder().decode(exportNurbsToStep(rational));
    const degrees = parseBSplineDegrees(text);
    expect(degrees).not.toBeNull();
    expect(degrees![0]).toBe(2);
    expect(degrees![1]).toBe(2);
  });

  // ── Non-rational vs rational entity format ────────────────────────────────

  test("non-rational surface emits B_SPLINE_SURFACE_WITH_KNOTS (not RATIONAL)", () => {
    const text = new TextDecoder().decode(exportNurbsToStep(bilinear));
    expect(text).toContain("B_SPLINE_SURFACE_WITH_KNOTS");
    // Must NOT use the complex rational entity form
    expect(text).not.toContain("RATIONAL_B_SPLINE_SURFACE");
  });

  test("rational surface emits complex entity with RATIONAL_B_SPLINE_SURFACE", () => {
    const text = new TextDecoder().decode(exportNurbsToStep(rational));
    expect(text).toContain("RATIONAL_B_SPLINE_SURFACE");
    // Must contain the bounded/geometric wrappers required by AP214 complex form
    expect(text).toContain("BOUNDED_SURFACE()");
    expect(text).toContain("GEOMETRIC_REPRESENTATION_ITEM()");
  });

  // ── OCCT root anchor ──────────────────────────────────────────────────────

  test("SHAPE_DEFINITION_REPRESENTATION present (OCCT AP214 root anchor)", () => {
    for (const surface of [bilinear, bicubic, rational]) {
      const text = new TextDecoder().decode(exportNurbsToStep(surface));
      expect(text).toContain("SHAPE_DEFINITION_REPRESENTATION");
      expect(text).toContain("ADVANCED_FACE");
      expect(text).toContain("OPEN_SHELL");
      expect(text).toContain("SHAPE_REPRESENTATION");
    }
  });

  // ── Knot multiplicity sum invariant ──────────────────────────────────────

  test("knot multiplicity sums = countU+degreeU+1 and countV+degreeV+1 (bilinear)", () => {
    const text = new TextDecoder().decode(exportNurbsToStep(bilinear));
    const sums = parseKnotMultiplicitySums(text);
    expect(sums).not.toBeNull();
    const [sumU, sumV] = sums!;
    // knotsU.length = countU + degreeU + 1 = 2 + 1 + 1 = 4
    expect(sumU).toBe(bilinear.countU + bilinear.degreeU + 1);
    // knotsV.length = countV + degreeV + 1 = 2 + 1 + 1 = 4
    expect(sumV).toBe(bilinear.countV + bilinear.degreeV + 1);
  });

  test("knot multiplicity sums = countU+degreeU+1 and countV+degreeV+1 (bicubic)", () => {
    const text = new TextDecoder().decode(exportNurbsToStep(bicubic));
    const sums = parseKnotMultiplicitySums(text);
    expect(sums).not.toBeNull();
    const [sumU, sumV] = sums!;
    // knotsU.length = 4 + 3 + 1 = 8
    expect(sumU).toBe(bicubic.countU + bicubic.degreeU + 1);
    // knotsV.length = 4 + 3 + 1 = 8
    expect(sumV).toBe(bicubic.countV + bicubic.degreeV + 1);
  });

  // ── Bounding box parity ───────────────────────────────────────────────────

  test("control-point bbox round-trips within 1e-7 for bilinear", () => {
    const text = new TextDecoder().decode(exportNurbsToStep(bilinear));
    const pts = parseCartesianPoints(text);
    const got = bboxOf(pts);
    const src = sourceBbox(bilinear);
    expect(got.min[0]).toBeCloseTo(src.min[0], 7);
    expect(got.min[1]).toBeCloseTo(src.min[1], 7);
    expect(got.min[2]).toBeCloseTo(src.min[2], 7);
    expect(got.max[0]).toBeCloseTo(src.max[0], 7);
    expect(got.max[1]).toBeCloseTo(src.max[1], 7);
    expect(got.max[2]).toBeCloseTo(src.max[2], 7);
  });

  test("control-point bbox round-trips within 1e-7 for rational sample", () => {
    const text = new TextDecoder().decode(exportNurbsToStep(rational));
    const pts = parseCartesianPoints(text);
    const got = bboxOf(pts);
    const src = sourceBbox(rational);
    expect(got.min[0]).toBeCloseTo(src.min[0], 7);
    expect(got.min[1]).toBeCloseTo(src.min[1], 7);
    expect(got.min[2]).toBeCloseTo(src.min[2], 7);
    expect(got.max[0]).toBeCloseTo(src.max[0], 7);
    expect(got.max[1]).toBeCloseTo(src.max[1], 7);
    expect(got.max[2]).toBeCloseTo(src.max[2], 7);
  });

  // ── Source stats sanity ───────────────────────────────────────────────────

  test("surface source stats: bilinear 2×2 CPs, bicubic 4×4 CPs, rational 3×3 CPs", () => {
    expect(bilinear.countU).toBe(2);
    expect(bilinear.countV).toBe(2);
    expect(bilinear.controlPoints.length).toBe(4);
    expect(bilinear.degreeU).toBe(1);
    expect(bilinear.degreeV).toBe(1);

    expect(bicubic.countU).toBe(4);
    expect(bicubic.countV).toBe(4);
    expect(bicubic.controlPoints.length).toBe(16);
    expect(bicubic.degreeU).toBe(3);
    expect(bicubic.degreeV).toBe(3);

    expect(rational.countU).toBe(3);
    expect(rational.countV).toBe(3);
    expect(rational.controlPoints.length).toBe(9);
    expect(rational.degreeU).toBe(2);
    expect(rational.degreeV).toBe(2);
    // rational.weights contains non-unit values (√0.5 ≈ 0.707)
    const hasNonUnit = rational.weights.some((w) => Math.abs(w - 1) > 1e-10);
    expect(hasNonUnit).toBe(true);
  });
});
