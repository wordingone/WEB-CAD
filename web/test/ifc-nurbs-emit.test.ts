// Regression net for #30 G9: emitNurbsAdvancedBrep emits valid IFC4 STEP-21 NURBS entities.
//
// Tests emitNurbsAdvancedBrep directly (not through buildIfcScene pipeline).
// Verifies that the generated lines contain the expected entity names and that
// the control-point coordinates and knot structure are correct.
import { describe, test, expect } from "bun:test";
import { emitNurbsAdvancedBrep } from "../src/ifc/ifc-build";
import type { NurbsSurface as KernelNurbsSurface } from "../src/nurbs/nurbs-kernel";

// Bilinear patch: 4 control points, degree 1,1.
// Represents the front face of a wall: 0,0,0 → 4m wide, 3m tall.
function makeBilinearPatch(): KernelNurbsSurface {
  return {
    degreeU: 1, degreeV: 1,
    countU: 2, countV: 2,
    controlPoints: [
      [0, 0, 0], [4, 0, 0],   // row 0
      [0, 0, 3], [4, 0, 3],   // row 1
    ],
    weights: [1, 1, 1, 1],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

// Simple quadratic arc-like surface: degree 2,1 with rational weights.
function makeRationalPatch(): KernelNurbsSurface {
  return {
    degreeU: 2, degreeV: 1,
    countU: 3, countV: 2,
    controlPoints: [
      [0,0,0],[1,0,0],
      [1,1,0],[2,1,0],
      [2,0,0],[3,0,0],
    ],
    weights: [1, 1, 0.707, 0.707, 1, 1],
    knotsU: [0, 0, 0, 1, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

describe("G9 — emitNurbsAdvancedBrep non-rational (bilinear)", () => {
  test("emits IFCBSPLINESURFACEWITHKNOTS for unit-weight surface", () => {
    const surface = makeBilinearPatch();
    const lines: string[] = [];
    let id = 0;
    const next = () => `#${++id}`;
    const brepRef = emitNurbsAdvancedBrep(surface, lines, next, 1.0);
    expect(brepRef).toMatch(/^#\d+$/);
    const joined = lines.join("\n");
    expect(joined).toContain("IFCBSPLINESURFACEWITHKNOTS");
    expect(joined).not.toContain("IFCRATIONALBSPLINESURFACEWITHKNOTS");
  });

  test("emits correct degree (1,1)", () => {
    const surface = makeBilinearPatch();
    const lines: string[] = [];
    let id = 0;
    emitNurbsAdvancedBrep(surface, lines, () => `#${++id}`, 1.0);
    const surfLine = lines.find(l => l.includes("IFCBSPLINESURFACEWITHKNOTS"));
    expect(surfLine).toBeDefined();
    // First two numeric args after the entity name are degreeU, degreeV = 1,1
    expect(surfLine).toContain("IFCBSPLINESURFACEWITHKNOTS(1,1,");
  });

  test("emits 4 control-point refs (IFCCARTESIANPOINT)", () => {
    const surface = makeBilinearPatch();
    const lines: string[] = [];
    let id = 0;
    emitNurbsAdvancedBrep(surface, lines, () => `#${++id}`, 1.0);
    const cpLines = lines.filter(l => l.includes("IFCCARTESIANPOINT"));
    expect(cpLines).toHaveLength(4);
  });

  test("scale factor applied to control-point coordinates", () => {
    const surface = makeBilinearPatch();
    const lines: string[] = [];
    let id = 0;
    emitNurbsAdvancedBrep(surface, lines, () => `#${++id}`, 2.0);  // scale=2
    const cpLines = lines.filter(l => l.includes("IFCCARTESIANPOINT"));
    // First CP was (0,0,0) → (0,0,0); second was (4,0,0) → (8,0,0)
    const has8 = cpLines.some(l => l.includes("8."));
    expect(has8).toBe(true);
  });

  test("emits IFCSHELLBASEDSURFACEMODEL as brep wrapper", () => {
    const surface = makeBilinearPatch();
    const lines: string[] = [];
    let id = 0;
    emitNurbsAdvancedBrep(surface, lines, () => `#${++id}`, 1.0);
    const joined = lines.join("\n");
    expect(joined).toContain("IFCSHELLBASEDSURFACEMODEL");
  });
});

describe("G9 — emitNurbsAdvancedBrep rational", () => {
  test("emits IFCRATIONALBSPLINESURFACEWITHKNOTS for non-unit weights", () => {
    const surface = makeRationalPatch();
    const lines: string[] = [];
    let id = 0;
    emitNurbsAdvancedBrep(surface, lines, () => `#${++id}`, 1.0);
    const joined = lines.join("\n");
    expect(joined).toContain("IFCRATIONALBSPLINESURFACEWITHKNOTS");
  });

  test("emits correct degree (2,1)", () => {
    const surface = makeRationalPatch();
    const lines: string[] = [];
    let id = 0;
    emitNurbsAdvancedBrep(surface, lines, () => `#${++id}`, 1.0);
    const surfLine = lines.find(l => l.includes("IFCRATIONALBSPLINESURFACEWITHKNOTS"));
    expect(surfLine).toContain("IFCRATIONALBSPLINESURFACEWITHKNOTS(2,1,");
  });
});

describe("G9 — flatKnotsToIfc via emitNurbsAdvancedBrep output", () => {
  test("clamped degree-1 knots become (2,2) multiplicities", () => {
    // knotsU = [0,0,1,1] → distinct [0,1] mult [2,2]
    const surface = makeBilinearPatch();
    const lines: string[] = [];
    let id = 0;
    emitNurbsAdvancedBrep(surface, lines, () => `#${++id}`, 1.0);
    const surfLine = lines.find(l => l.includes("IFCBSPLINESURFACEWITHKNOTS"))!;
    // Multiplicities (2,2),(2,2) should appear
    expect(surfLine).toContain("(2,2),(2,2)");
  });
});
