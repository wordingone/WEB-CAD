// brep-validity.test.ts — brep-validity unit tests (#117 / #7d).
import { describe, test, expect } from "bun:test";
import { validateBrep } from "../src/nurbs/brep-validity";
import type { Brep, BrepShell, BrepFace, BrepEdge, BrepVertex, TrimLoop } from "../src/nurbs/nurbs-brep";
import { BREP_DEFAULT_TOLERANCE } from "../src/nurbs/nurbs-brep";
import type { LineCurve } from "../src/nurbs/nurbs-curves";
import type { PlaneSurface } from "../src/nurbs/nurbs-surfaces";
import { Plane, Interval } from "../src/nurbs/nurbs-primitives";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function planeSurf(): PlaneSurface {
  return {
    kind: "plane",
    plane: Plane.worldXY(),
    uDomain: Interval.create(0, 1),
    vDomain: Interval.create(0, 1),
    uExtent: Interval.create(-1, 1),
    vExtent: Interval.create(-1, 1),
  };
}

function makeFace(loops: TrimLoop[] = []): BrepFace {
  const [outerLoop = { curves: [], orientation: true }, ...innerLoops] = loops;
  return {
    surface: planeSurf(),
    outerLoop,
    innerLoops,
    orientation: true,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

function lineCurve(fromX: number, toX: number): LineCurve {
  return {
    kind: "line",
    from: { x: fromX, y: 0, z: 0 },
    to:   { x: toX,   y: 0, z: 0 },
    domain: Interval.create(0, Math.abs(toX - fromX)),
  };
}

function makeEdge(fi1: number, fi2: number | null, len = 1.0): BrepEdge {
  return {
    curve: lineCurve(0, len),
    faceIndex1: fi1,
    faceIndex2: fi2,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

function makeVertex(x: number, edgeIndices: number[] = [0]): BrepVertex {
  return {
    point: { x, y: 0, z: 0 },
    edgeIndices,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

/**
 * Minimal valid closed box: 6 faces, 12 edges (all interior), 8 vertices.
 * V(8) - E(12) + F(6) = 2. All edges have faceIndex2 set.
 */
function validBoxShell(): BrepShell {
  const faces = Array.from({ length: 6 }, () => makeFace());

  // 12 edges for a box — pair each with two distinct face indices
  const edgePairs: [number, number][] = [
    [0, 1], [0, 2], [0, 3], [0, 4],
    [1, 2], [1, 3], [1, 5], [2, 4],
    [2, 5], [3, 4], [3, 5], [4, 5],
  ];
  const edges = edgePairs.map(([f1, f2]) => makeEdge(f1, f2));

  // 8 vertices
  const vertices = Array.from({ length: 8 }, (_, i) => makeVertex(i));

  return { faces, edges, vertices, isClosed: true };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("validateBrep — valid inputs", () => {
  test("AC#1 — valid closed box yields valid:true, errors:[]", () => {
    const brep: Brep = { shells: [validBoxShell()] };
    const report = validateBrep(brep);
    expect(report.valid).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  test("open shell with naked edges is valid (isClosed=false permits naked edges)", () => {
    const shell: BrepShell = {
      faces: [makeFace()],
      edges: [makeEdge(0, null)],
      vertices: [],
      isClosed: false,
    };
    const brep: Brep = { shells: [shell] };
    const report = validateBrep(brep);
    expect(report.valid).toBe(true);
  });

  test("face with empty TrimLoop is valid (trivially closed)", () => {
    const face = makeFace([{ curves: [], orientation: true }]);
    const brep: Brep = { shells: [{ faces: [face], edges: [], vertices: [], isClosed: false }] };
    const report = validateBrep(brep);
    expect(report.valid).toBe(true);
  });
});

describe("validateBrep — EDGE_VALENCE", () => {
  test("AC#2 — dangling edge in closed shell → EDGE_VALENCE error", () => {
    const shell = validBoxShell();
    // Replace edge[0] with a naked edge (faceIndex2 = null)
    shell.edges[0] = makeEdge(0, null);
    const report = validateBrep({ shells: [shell] });
    expect(report.valid).toBe(false);
    const ev = report.errors.find(e => e.code === "EDGE_VALENCE");
    expect(ev).toBeDefined();
  });

  test("multiple dangling edges — one error per naked edge", () => {
    const shell = validBoxShell();
    shell.edges[0] = makeEdge(0, null);
    shell.edges[1] = makeEdge(0, null);
    const report = validateBrep({ shells: [shell] });
    const count = report.errors.filter(e => e.code === "EDGE_VALENCE").length;
    expect(count).toBe(2);
  });
});

describe("validateBrep — LOOP_OPEN", () => {
  test("AC#3 — TrimLoop with non-closing curves → LOOP_OPEN error", () => {
    // Two line curves that don't connect: c1 ends at x=1, c2 starts at x=2
    const c1 = lineCurve(0, 1);
    const c2 = lineCurve(2, 3); // gap between c1's end and c2's start
    const loop: TrimLoop = { curves: [c1, c2], orientation: true };
    const face = makeFace([loop]);
    const brep: Brep = { shells: [{ faces: [face], edges: [], vertices: [], isClosed: false }] };
    const report = validateBrep(brep);
    expect(report.valid).toBe(false);
    const lo = report.errors.find(e => e.code === "LOOP_OPEN");
    expect(lo).toBeDefined();
  });

  test("TrimLoop with connecting curves is valid", () => {
    // c1 ends at x=1, c2 starts at x=1 — closes
    const c1 = lineCurve(0, 1);
    const c2: LineCurve = {
      kind: "line",
      from: { x: 1, y: 0, z: 0 },
      to:   { x: 0, y: 0, z: 0 },
      domain: Interval.create(0, 1),
    };
    const loop: TrimLoop = { curves: [c1, c2], orientation: true };
    const face = makeFace([loop]);
    const brep: Brep = { shells: [{ faces: [face], edges: [], vertices: [], isClosed: false }] };
    const report = validateBrep(brep);
    expect(report.valid).toBe(true);
  });
});

describe("validateBrep — EDGE_TOO_SHORT", () => {
  test("degenerate zero-length edge → EDGE_TOO_SHORT", () => {
    const zeroEdge: BrepEdge = {
      curve: lineCurve(0, 0), // from === to
      faceIndex1: 0,
      faceIndex2: 1,
      tolerance: BREP_DEFAULT_TOLERANCE,
    };
    const shell = validBoxShell();
    shell.edges[0] = zeroEdge;
    const report = validateBrep({ shells: [shell] });
    const err = report.errors.find(e => e.code === "EDGE_TOO_SHORT");
    expect(err).toBeDefined();
  });
});

describe("validateBrep — EULER", () => {
  test("closed shell with wrong Euler number → EULER error", () => {
    // V=5, E=9, F=6 → 5-9+6=2 ✓ — adjust: V=5, E=10, F=6 → 5-10+6=1 ≠ 2
    // Heuristic passes: V(5)>0 AND E(10)>=F(6)
    const faces = Array.from({ length: 6 }, () => makeFace());
    const edges = Array.from({ length: 10 }, (_, i) => makeEdge(i % 6, (i + 1) % 6));
    const vertices = Array.from({ length: 5 }, (_, i) => makeVertex(i));
    const shell: BrepShell = { faces, edges, vertices, isClosed: true };
    const report = validateBrep({ shells: [shell] });
    const err = report.errors.find(e => e.code === "EULER");
    expect(err).toBeDefined();
  });

  test("sparse scaffold (V=0) skips Euler check", () => {
    // Scaffold from extrude has V=4 but E < F (4 < 6) → Euler skip
    const faces = Array.from({ length: 6 }, () => makeFace());
    const edges = Array.from({ length: 4 }, (_, i) => makeEdge(i, i + 1));
    const vertices: BrepVertex[] = []; // V=0 → skip
    const shell: BrepShell = { faces, edges, vertices, isClosed: true };
    const report = validateBrep({ shells: [shell] });
    const eulerError = report.errors.find(e => e.code === "EULER");
    expect(eulerError).toBeUndefined();
  });
});

describe("validateBrep — EMPTY_BREP", () => {
  test("empty brep → EMPTY_BREP error", () => {
    const report = validateBrep({ shells: [] });
    expect(report.valid).toBe(false);
    expect(report.errors[0].code).toBe("EMPTY_BREP");
  });
});
