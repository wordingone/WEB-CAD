// Regression net for #30 G10: parseIfcNurbsStep21 + expandKnots + round-trip
// with emitNurbsAdvancedBrep.
import { describe, test, expect } from "bun:test";
import { parseIfcNurbsStep21, expandKnots, ifcAdvancedBrepToNurbs } from "../src/ifc/ifc-nurbs";
import { emitNurbsAdvancedBrep } from "../src/ifc/ifc-build";
import type { NurbsSurface as KernelNurbsSurface } from "../src/nurbs/nurbs-kernel";

const TOL = 1e-6;
function close(a: number, b: number) { return Math.abs(a - b) < TOL; }

// Bilinear patch emitted by G9, parsed by G10.
function makeBilinearPatch(): KernelNurbsSurface {
  return {
    degreeU: 1, degreeV: 1,
    countU: 2, countV: 2,
    controlPoints: [[0,0,0],[4,0,0],[0,0,3],[4,0,3]],
    weights: [1,1,1,1],
    knotsU: [0,0,1,1],
    knotsV: [0,0,1,1],
  };
}

function makeRationalPatch(): KernelNurbsSurface {
  return {
    degreeU: 2, degreeV: 1,
    countU: 3, countV: 2,
    controlPoints: [[0,0,0],[1,0,0],[1,1,0],[2,1,0],[2,0,0],[3,0,0]],
    weights: [1,1,0.707,0.707,1,1],
    knotsU: [0,0,0,1,1,1],
    knotsV: [0,0,1,1],
  };
}

function emitToStep(surface: KernelNurbsSurface, scale = 1.0): string {
  const lines: string[] = [];
  let id = 0;
  emitNurbsAdvancedBrep(surface, lines, () => `#${++id}`, scale);
  return lines.join("\n");
}

describe("G10 — expandKnots", () => {
  test("clamped degree-1 [0,0,1,1] from knots [0,1] + mults [2,2]", () => {
    expect(expandKnots([0, 1], [2, 2])).toEqual([0, 0, 1, 1]);
  });

  test("uniform knots", () => {
    expect(expandKnots([0, 1, 2, 3], [1, 1, 1, 1])).toEqual([0, 1, 2, 3]);
  });

  test("throws when lengths mismatch", () => {
    expect(() => expandKnots([0, 1], [2])).toThrow();
  });
});

describe("G10 — parseIfcNurbsStep21: non-rational bilinear patch", () => {
  test("round-trips degreeU and degreeV", () => {
    const step = emitToStep(makeBilinearPatch());
    const surfaces = parseIfcNurbsStep21(step);
    expect(surfaces.length).toBeGreaterThanOrEqual(1);
    const s = surfaces[0];
    expect(s.degreeU).toBe(1);
    expect(s.degreeV).toBe(1);
  });

  test("round-trips countU and countV", () => {
    const step = emitToStep(makeBilinearPatch());
    const s = parseIfcNurbsStep21(step)[0];
    expect(s.countU).toBe(2);
    expect(s.countV).toBe(2);
  });

  test("round-trips control points (4 points)", () => {
    const orig = makeBilinearPatch();
    const step = emitToStep(orig);
    const s = parseIfcNurbsStep21(step)[0];
    expect(s.controlPoints.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(close(s.controlPoints[i][0], orig.controlPoints[i][0])).toBe(true);
      expect(close(s.controlPoints[i][1], orig.controlPoints[i][1])).toBe(true);
      expect(close(s.controlPoints[i][2], orig.controlPoints[i][2])).toBe(true);
    }
  });

  test("round-trips knotsU (expanded)", () => {
    const step = emitToStep(makeBilinearPatch());
    const s = parseIfcNurbsStep21(step)[0];
    expect(s.knotsU).toEqual([0, 0, 1, 1]);
  });

  test("round-trips knotsV (expanded)", () => {
    const step = emitToStep(makeBilinearPatch());
    const s = parseIfcNurbsStep21(step)[0];
    expect(s.knotsV).toEqual([0, 0, 1, 1]);
  });

  test("weights default to all-1 for non-rational", () => {
    const step = emitToStep(makeBilinearPatch());
    const s = parseIfcNurbsStep21(step)[0];
    expect(s.weights.every(w => close(w, 1))).toBe(true);
  });

  test("scale factor applied — CP x=4 emitted as x=8 with scale=2", () => {
    const step = emitToStep(makeBilinearPatch(), 2.0);
    const s = parseIfcNurbsStep21(step)[0];
    expect(close(s.controlPoints[1][0], 8)).toBe(true);
  });
});

describe("G10 — parseIfcNurbsStep21: rational patch", () => {
  test("round-trips as rational (non-unit weights preserved)", () => {
    const orig = makeRationalPatch();
    const step = emitToStep(orig);
    const s = parseIfcNurbsStep21(step)[0];
    // Weight at index 2 is 0.707
    expect(close(s.weights[2], 0.707)).toBe(true);
  });

  test("round-trips degreeU=2, degreeV=1", () => {
    const step = emitToStep(makeRationalPatch());
    const s = parseIfcNurbsStep21(step)[0];
    expect(s.degreeU).toBe(2);
    expect(s.degreeV).toBe(1);
  });

  test("round-trips knotsU for degree-2 clamped", () => {
    const step = emitToStep(makeRationalPatch());
    const s = parseIfcNurbsStep21(step)[0];
    expect(s.knotsU).toEqual([0,0,0,1,1,1]);
  });
});

describe("G10 — ifcAdvancedBrepToNurbs (bytes)", () => {
  test("async wrapper decodes bytes and returns surfaces", async () => {
    const step = emitToStep(makeBilinearPatch());
    const bytes = new TextEncoder().encode(step);
    const surfaces = await ifcAdvancedBrepToNurbs(bytes);
    expect(surfaces.length).toBeGreaterThanOrEqual(1);
    expect(surfaces[0].degreeU).toBe(1);
  });
});

describe("G10 — empty / no-NURBS text", () => {
  test("returns empty array when no NURBS entities present", () => {
    const step = "ISO-10303-21;\nDATA;\n#1=IFCCARTESIANPOINT((0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;";
    expect(parseIfcNurbsStep21(step)).toHaveLength(0);
  });
});
