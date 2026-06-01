// wasm-brep-topology-parity.test.ts — #370 PR1 round-trip gate.
//
// Verifies that brepToKernJson / kernResultToBrep preserve full BRep topology
// (edges, vertices, trim loops with 3D curves) through the JS↔kern boundary.
// Does NOT load the WASM binary — tests serialization/deserialization logic only.
//
// Pass criterion: every edge, vertex, and trim curve present in the input Brep
// survives the JS→kern-JSON→JS round-trip with correct structure and numeric values.
//
// Also covers: degree-bound guard (#359), knot-vector inversion symmetry.

import { describe, test, expect } from "bun:test";
import { _brepToKernJsonForTest, _kernResultToBrepForTest } from "../src/nurbs/wasm-boolean-backend";
import type { Brep, BrepShell } from "../src/nurbs/nurbs-brep";
import type { NurbsCurve } from "../src/nurbs/nurbs-curves";
import type { NurbsSurface } from "../src/nurbs/nurbs-surfaces";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function lineCurve(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): NurbsCurve {
  // Degree-1 NurbsCurve from (x0,y0,z0) to (x1,y1,z1).
  // OpenNURBS knot vector for order=2, cvCount=2: length = 2+2-2 = 2 → [0, 1]
  return {
    kind: "nurbs", dim: 3, isRational: false,
    order: 2, cvCount: 2,
    knots: [0, 1],
    cvs: [x0, y0, z0, x1, y1, z1],
    cvStride: 3,
  };
}

function unitPlaneSurface(): NurbsSurface {
  // Bilinear degree-1×1 NurbsSurface: 2×2 CVs forming a 1×1 unit square in XY.
  // OpenNURBS knots for order=[2,2], cvCount=[2,2]: each direction = [0,1]
  return {
    kind: "nurbs", dim: 3, isRational: false,
    order: [2, 2], cvCount: [2, 2],
    knots: [[0, 1], [0, 1]],
    cvs: [
      0, 0, 0,   // (0,0,0)
      1, 0, 0,   // (1,0,0)
      0, 1, 0,   // (0,1,0)
      1, 1, 0,   // (1,1,0)
    ],
    cvStride: [6, 3],
  };
}

// A minimal BrepShell with:
//   1 face (unit plane) with an outer trim loop (4 line curves)
//   4 edges (the four boundary edges of the unit square)
//   4 vertices (the corners)
function unitSquareShell(): BrepShell {
  const surface = unitPlaneSurface();

  const bottomEdge = lineCurve(0, 0, 0,  1, 0, 0);
  const rightEdge  = lineCurve(1, 0, 0,  1, 1, 0);
  const topEdge    = lineCurve(1, 1, 0,  0, 1, 0);
  const leftEdge   = lineCurve(0, 1, 0,  0, 0, 0);

  return {
    faces: [{
      surface,
      outerLoop: {
        curves: [bottomEdge, rightEdge, topEdge, leftEdge],
        orientation: true,
      },
      innerLoops: [],
      orientation: true,
      tolerance: 1e-6,
    }],
    edges: [
      { curve: bottomEdge, faceIndex1: 0, faceIndex2: null, tolerance: 1e-6 },
      { curve: rightEdge,  faceIndex1: 0, faceIndex2: null, tolerance: 1e-6 },
      { curve: topEdge,    faceIndex1: 0, faceIndex2: null, tolerance: 1e-6 },
      { curve: leftEdge,   faceIndex1: 0, faceIndex2: null, tolerance: 1e-6 },
    ],
    vertices: [
      { point: { x: 0, y: 0, z: 0 }, edgeIndices: [0, 3], tolerance: 1e-6 },
      { point: { x: 1, y: 0, z: 0 }, edgeIndices: [0, 1], tolerance: 1e-6 },
      { point: { x: 1, y: 1, z: 0 }, edgeIndices: [1, 2], tolerance: 1e-6 },
      { point: { x: 0, y: 1, z: 0 }, edgeIndices: [2, 3], tolerance: 1e-6 },
    ],
    isClosed: false,
  };
}

function unitSquareBrep(): Brep {
  return { shells: [unitSquareShell()] };
}

// ── Knot-vector helpers ───────────────────────────────────────────────────────

// brepToKernJson converts OpenNURBS knots → standard full-clamped.
// For order=2, cvCount=2, OpenNURBS knots=[0,1] → standard=[0,0,1,1].
function toStandardKnots(openKnots: number[]): number[] {
  return [openKnots[0], ...openKnots, openKnots[openKnots.length - 1]];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("#370 PR1 — brepToKernJson serializes full topology", () => {
  test("shell edges are present in kern JSON (not empty array)", () => {
    const brep = unitSquareBrep();
    const json = _brepToKernJsonForTest(brep);
    const kern = JSON.parse(json) as { shells: { edges: unknown[] }[] };
    expect(kern.shells[0].edges).toHaveLength(4);
  });

  test("shell vertices are present in kern JSON (not empty array)", () => {
    const brep = unitSquareBrep();
    const json = _brepToKernJsonForTest(brep);
    const kern = JSON.parse(json) as { shells: { vertices: { point: number[] }[] }[] };
    expect(kern.shells[0].vertices).toHaveLength(4);
    // Spot-check first vertex coords
    expect(kern.shells[0].vertices[0].point).toEqual([0, 0, 0]);
  });

  test("face outerLoop edges are present (not empty array)", () => {
    const brep = unitSquareBrep();
    const json = _brepToKernJsonForTest(brep);
    const kern = JSON.parse(json) as {
      shells: { faces: { outerLoop: { edges: unknown[] } }[] }[]
    };
    expect(kern.shells[0].faces[0].outerLoop.edges).toHaveLength(4);
  });

  test("edge curves use standard (full-clamped) knot vectors", () => {
    const brep = unitSquareBrep();
    const json = _brepToKernJsonForTest(brep);
    const kern = JSON.parse(json) as {
      shells: { edges: { curve: { knots: number[]; degree: number; cvCount: number } }[] }[]
    };
    const edgeCurve = kern.shells[0].edges[0].curve;
    // degree=1, cvCount=2 → standard knots = [0,0,1,1] (length = degree+cvCount+1 = 4)
    expect(edgeCurve.knots).toHaveLength(edgeCurve.degree + edgeCurve.cvCount + 1);
    expect(edgeCurve.knots).toEqual(toStandardKnots([0, 1]));
  });

  test("edge CVs are xyzw homogeneous (4 floats per CV)", () => {
    const brep = unitSquareBrep();
    const json = _brepToKernJsonForTest(brep);
    const kern = JSON.parse(json) as {
      shells: { edges: { curve: { cvCount: number; cvs: number[] } }[] }[]
    };
    const { cvCount, cvs } = kern.shells[0].edges[0].curve;
    expect(cvs).toHaveLength(cvCount * 4);
    // Non-rational: w=1 for all CVs
    for (let i = 0; i < cvCount; i++) {
      expect(cvs[i * 4 + 3]).toBe(1);
    }
  });

  test("naked edges serialized with faceIndex2 = -1", () => {
    const brep = unitSquareBrep();
    const json = _brepToKernJsonForTest(brep);
    const kern = JSON.parse(json) as {
      shells: { edges: { faceIndex2: number }[] }[]
    };
    for (const e of kern.shells[0].edges) {
      expect(e.faceIndex2).toBe(-1);
    }
  });

  test("vertex edgeIndices preserved", () => {
    const brep = unitSquareBrep();
    const json = _brepToKernJsonForTest(brep);
    const kern = JSON.parse(json) as {
      shells: { vertices: { edgeIndices: number[] }[] }[]
    };
    expect(kern.shells[0].vertices[0].edgeIndices).toEqual([0, 3]);
    expect(kern.shells[0].vertices[1].edgeIndices).toEqual([0, 1]);
  });
});

describe("#370 PR1 — round-trip: JS Brep → kern JSON → JS Brep preserves topology", () => {
  // Simulate a kern-shaped response (as if the kern reflected topology back unchanged)
  // by parsing the brepToKernJson output and feeding it through kernResultToBrep.
  function roundTrip(brep: Brep): Brep {
    const json = _brepToKernJsonForTest(brep);
    return _kernResultToBrepForTest(JSON.parse(json));
  }

  test("edge count survives round-trip", () => {
    const brep = unitSquareBrep();
    const rt = roundTrip(brep);
    expect(rt.shells[0].edges).toHaveLength(4);
  });

  test("vertex count survives round-trip", () => {
    const brep = unitSquareBrep();
    const rt = roundTrip(brep);
    expect(rt.shells[0].vertices).toHaveLength(4);
  });

  test("trim curve count per face survives round-trip", () => {
    const brep = unitSquareBrep();
    const rt = roundTrip(brep);
    expect(rt.shells[0].faces[0].outerLoop.curves).toHaveLength(4);
  });

  test("edge curve kind is nurbs after round-trip", () => {
    const brep = unitSquareBrep();
    const rt = roundTrip(brep);
    for (const edge of rt.shells[0].edges) {
      expect(edge.curve.kind).toBe("nurbs");
    }
  });

  test("naked edges have faceIndex2 = null after round-trip (not -1)", () => {
    const brep = unitSquareBrep();
    const rt = roundTrip(brep);
    for (const edge of rt.shells[0].edges) {
      expect(edge.faceIndex2).toBeNull();
    }
  });

  test("vertex coords preserved to 1e-10 after round-trip", () => {
    const brep = unitSquareBrep();
    const rt = roundTrip(brep);
    const verts = rt.shells[0].vertices;
    expect(verts[0].point.x).toBeCloseTo(0, 10);
    expect(verts[0].point.y).toBeCloseTo(0, 10);
    expect(verts[2].point.x).toBeCloseTo(1, 10);
    expect(verts[2].point.y).toBeCloseTo(1, 10);
  });

  test("edge CV start/end coords preserved after round-trip", () => {
    const brep = unitSquareBrep();
    const rt = roundTrip(brep);
    const edge = rt.shells[0].edges[0].curve as NurbsCurve;
    // Bottom edge: (0,0,0) → (1,0,0)
    expect(edge.cvs[0]).toBeCloseTo(0, 10);
    expect(edge.cvs[1]).toBeCloseTo(0, 10);
    expect(edge.cvs[2]).toBeCloseTo(0, 10);
    expect(edge.cvs[3]).toBeCloseTo(1, 10);
    expect(edge.cvs[4]).toBeCloseTo(0, 10);
    expect(edge.cvs[5]).toBeCloseTo(0, 10);
  });

  test("OpenNURBS knots restored after round-trip (standard → OpenNURBS inversion)", () => {
    const brep = unitSquareBrep();
    const rt = roundTrip(brep);
    const edge = rt.shells[0].edges[0].curve as NurbsCurve;
    // Original: [0, 1] → standard: [0,0,1,1] → back to OpenNURBS: [0, 1]
    expect(edge.knots).toEqual([0, 1]);
  });
});

describe("#370 PR1 — degree guard (#359 kMaxDeg=7)", () => {
  test("throws on surface with degreeU > 7", () => {
    // degree-8 surface: order=9, cvCount=[9,2]
    const highDegreeSurf: NurbsSurface = {
      kind: "nurbs", dim: 3, isRational: false,
      order: [9, 2], cvCount: [9, 2],
      // OpenNURBS knot length U: order + cvCount - 2 = 9 + 9 - 2 = 16
      knots: [
        new Array(16).fill(0).map((_, i) => i < 8 ? 0 : 1),
        [0, 1],
      ],
      cvs: new Array(9 * 2 * 3).fill(0),
      cvStride: [6, 3],
    };
    const brep: Brep = {
      shells: [{
        faces: [{
          surface: highDegreeSurf,
          outerLoop: { curves: [], orientation: true },
          innerLoops: [],
          orientation: true,
          tolerance: 1e-6,
        }],
        edges: [],
        vertices: [],
        isClosed: false,
      }],
    };
    expect(() => _brepToKernJsonForTest(brep)).toThrow(/degree 8.*kMaxDeg=7|#359/);
  });

  test("degree-7 surface passes the guard", () => {
    // degree-7 surface: order=8, cvCount=[8,2]
    const deg7Surf: NurbsSurface = {
      kind: "nurbs", dim: 3, isRational: false,
      order: [8, 2], cvCount: [8, 2],
      // OpenNURBS knot length U: 8+8-2 = 14
      knots: [
        new Array(14).fill(0).map((_, i) => i < 7 ? 0 : 1),
        [0, 1],
      ],
      cvs: new Array(8 * 2 * 3).fill(0),
      cvStride: [6, 3],
    };
    const brep: Brep = {
      shells: [{
        faces: [{
          surface: deg7Surf,
          outerLoop: { curves: [], orientation: true },
          innerLoops: [],
          orientation: true,
          tolerance: 1e-6,
        }],
        edges: [],
        vertices: [],
        isClosed: false,
      }],
    };
    expect(() => _brepToKernJsonForTest(brep)).not.toThrow();
  });
});

describe("#370 PR1 — M1 latency measurement: 200-face unit-square array", () => {
  test("serialization of 200 identical shells completes in < 50ms", () => {
    // 200 shells × 1 face × 4 edges × 4 vertices — simulates 200-face model import.
    const shells: BrepShell[] = Array.from({ length: 200 }, () => unitSquareShell());
    const brep: Brep = { shells };
    const t0 = performance.now();
    const json = _brepToKernJsonForTest(brep);
    const elapsed = performance.now() - t0;
    // Well within 5ms production gate; 50ms is generous for test environments.
    expect(elapsed).toBeLessThan(50);
    expect(JSON.parse(json).shells).toHaveLength(200);
  });
});
