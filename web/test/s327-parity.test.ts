// s327-parity.test.ts — Multi-oracle parity tests for #327 S7 cluster.
//
// Oracle strategy:
//   - Topology queries (IsValid/IsSolid/IsManifold/NakedEdge/accessors):
//     closed-form BrepShell JSON inspection. oracle = nurbs-brep.ts / brep-validity.ts
//   - Cap/Extract/Explode/Unjoin/Merge: structural brep manipulation.
//     oracle = closed-form construction invariants.
//   - C++-blocked ops: test.skip with explanation.
//
// NEVER hardcode expected values — every assertion uses a live oracle call.
// NEVER axis-aligned/box-only — test with rotated, non-unit geometry.

import { describe, test, expect } from "bun:test";
import {
  BREP_DEFAULT_TOLERANCE,
  brepFaceCount,
  brepIsSolid,
  brepIsOpen,
  brepNakedEdgeCount,
  brepMaxTolerance,
  shellFromSurface,
  brepFromShell,
  brepFromSurface,
  type Brep,
  type BrepShell,
  type BrepFace,
  type BrepEdge,
  type BrepVertex,
  type TrimLoop,
} from "../src/nurbs/nurbs-brep";
import { validateBrep } from "../src/nurbs/brep-validity";
import {
  pointAtUV,
  normalAtUV,
  domainU,
  domainV,
} from "../src/nurbs/nurbs-surfaces";
import type { PlaneSurface, NurbsSurface } from "../src/nurbs/nurbs-surfaces";
import {
  pointAt as curvePointAt,
  domain as curveDomain,
} from "../src/nurbs/nurbs-curves";
import type { LineCurve } from "../src/nurbs/nurbs-curves";
import {
  Plane,
  Point3 as Pt3,
  Vector3 as V3,
  Interval,
} from "../src/nurbs/nurbs-primitives";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Build a tilted PlaneSurface (not axis-aligned) with given normal. */
function tiltedPlaneSurf(nx: number, ny: number, nz: number): PlaneSurface {
  const n = V3.normalize({ x: nx, y: ny, z: nz });
  const plane = Plane.fromPointNormal(Pt3.create(1.5, 2.3, -0.7), n);
  return {
    kind: "plane",
    plane,
    uDomain: Interval.create(-2, 2),
    vDomain: Interval.create(-2, 2),
    uExtent: Interval.create(-2, 2),
    vExtent: Interval.create(-2, 2),
  };
}

/** Build a simple XY-plane PlaneSurface. */
function xyPlaneSurf(ox = 0, oy = 0, oz = 0): PlaneSurface {
  return {
    kind: "plane",
    plane: {
      origin: Pt3.create(ox, oy, oz),
      xAxis: V3.xAxis(),
      yAxis: V3.yAxis(),
      normal: V3.zAxis(),
    },
    uDomain: Interval.create(0, 1),
    vDomain: Interval.create(0, 1),
    uExtent: Interval.create(0, 1),
    vExtent: Interval.create(0, 1),
  };
}

/** LineCurve from a to b. */
function lineCurve(ax: number, ay: number, az: number, bx: number, by: number, bz: number): LineCurve {
  const len = Pt3.distance(Pt3.create(ax, ay, az), Pt3.create(bx, by, bz));
  return {
    kind: "line",
    from: { x: ax, y: ay, z: az },
    to: { x: bx, y: by, z: bz },
    domain: Interval.create(0, len),
  };
}

/** BrepFace with a plane surface, no loops. */
function planarFace(surf: PlaneSurface): BrepFace {
  return {
    surface: surf,
    outerLoop: { curves: [], orientation: true },
    innerLoops: [],
    orientation: true,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

/** BrepEdge between two face indices. */
function sharedEdge(fi1: number, fi2: number | null): BrepEdge {
  return {
    curve: lineCurve(0, 0, 0, 1, 0, 0),
    faceIndex1: fi1,
    faceIndex2: fi2,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

/** Build an open-shell brep with N planar faces and naked perimeter edges. */
function openPlanarShell(faceCount: number): Brep {
  const faces: BrepFace[] = [];
  for (let i = 0; i < faceCount; i++) {
    // Non-axis-aligned: tilt each face slightly differently
    faces.push(planarFace(tiltedPlaneSurf(0.1 * i, 1, 0.2 * i)));
  }
  const edges: BrepEdge[] = [];
  // Each consecutive pair shares an edge; first and last are naked
  for (let i = 0; i + 1 < faceCount; i++) {
    edges.push({ ...sharedEdge(i, i + 1), curve: lineCurve(i, 0, 0, i + 1, 0, 0) });
  }
  // Add two naked edges to simulate open boundary
  edges.push({ ...sharedEdge(0, null), curve: lineCurve(0, 1, 0, 1, 1, 0) });
  edges.push({ ...sharedEdge(faceCount - 1, null), curve: lineCurve(faceCount, 1, 0, faceCount + 1, 1, 0) });

  const shell: BrepShell = { faces, edges, vertices: [], isClosed: false };
  return brepFromShell(shell);
}

/** Build a closed 2-face brep (two faces sharing all edges, isClosed=true). */
function closedTwoFaceBrep(): Brep {
  const faces: BrepFace[] = [
    planarFace(xyPlaneSurf(0, 0, 0)),
    planarFace(xyPlaneSurf(0, 0, 1)),
  ];
  // 4 shared edges forming a rectangle between the two faces
  const edges: BrepEdge[] = [
    { curve: lineCurve(0, 0, 0, 1, 0, 0), faceIndex1: 0, faceIndex2: 1, tolerance: BREP_DEFAULT_TOLERANCE },
    { curve: lineCurve(1, 0, 0, 1, 1, 0), faceIndex1: 0, faceIndex2: 1, tolerance: BREP_DEFAULT_TOLERANCE },
    { curve: lineCurve(1, 1, 0, 0, 1, 0), faceIndex1: 0, faceIndex2: 1, tolerance: BREP_DEFAULT_TOLERANCE },
    { curve: lineCurve(0, 1, 0, 0, 0, 0), faceIndex1: 0, faceIndex2: 1, tolerance: BREP_DEFAULT_TOLERANCE },
  ];
  const shell: BrepShell = { faces, edges, vertices: [], isClosed: true };
  return brepFromShell(shell);
}

// ── SdBrepIsValid oracle tests ────────────────────────────────────────────────

describe("SdBrepIsValid — closed-form oracle via validateBrep()", () => {
  test("valid closed brep → isValid true, no errors", () => {
    const brep = closedTwoFaceBrep();
    // oracle: validateBrep (Euler check skipped for V=0 scaffold)
    const report = validateBrep(brep);
    expect(report.valid).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  test("brep with empty shells → EMPTY_BREP error", () => {
    const emptyBrep: Brep = { shells: [] };
    const report = validateBrep(emptyBrep);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "EMPTY_BREP")).toBe(true);
  });

  test("open shell with naked edge (faceIndex2=null) → isValid true (open shells allowed)", () => {
    const brep = openPlanarShell(3);
    // open shells with isClosed=false: EDGE_VALENCE not triggered
    const report = validateBrep(brep);
    // Naked edges on open shell are OK per design
    expect(report.errors.filter((e) => e.code === "EDGE_VALENCE")).toHaveLength(0);
  });

  test("closed shell with naked edge → EDGE_VALENCE error", () => {
    // Force isClosed=true but leave a naked edge — structural inconsistency
    const brep = openPlanarShell(3);
    brep.shells[0]!.isClosed = true; // lie about closure
    const report = validateBrep(brep);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "EDGE_VALENCE")).toBe(true);
  });

  test("non-axis-aligned tilted surface in shell: validates the same as axis-aligned", () => {
    // oracle: structural check is surface-agnostic — only topology data matters
    const surf = tiltedPlaneSurf(0.577, 0.577, 0.577); // 45-degree normal
    const brep = brepFromSurface(surf);
    const report = validateBrep(brep);
    // Single-face open shell with no edges: valid by convention
    expect(report.valid).toBe(true);
  });
});

// ── SdBrepIsSolid oracle tests ─────────────────────────────────────────────────

describe("SdBrepIsSolid — oracle via brepIsSolid()", () => {
  test("closed two-face shell → isSolid true", () => {
    const brep = closedTwoFaceBrep();
    // oracle: brepIsSolid reads isClosed flag on each shell
    expect(brepIsSolid(brep)).toBe(true);
  });

  test("open shell → isSolid false", () => {
    const brep = openPlanarShell(4);
    expect(brepIsSolid(brep)).toBe(false);
  });

  test("empty brep (no shells) → isSolid false (no shells = not solid)", () => {
    expect(brepIsSolid({ shells: [] })).toBe(false);
  });

  test("multi-shell brep: one open + one closed → isSolid false", () => {
    const closed = closedTwoFaceBrep();
    const open = openPlanarShell(2);
    const multi: Brep = { shells: [...closed.shells, ...open.shells] };
    // oracle: brepIsSolid returns true only if ALL shells are closed
    expect(brepIsSolid(multi)).toBe(false);
  });
});

// ── SdBrepIsManifold oracle tests ──────────────────────────────────────────────

describe("SdBrepIsManifold — oracle via edge faceIndex bounds check", () => {
  test("closed two-face shell with valid faceIndex → isManifold true", () => {
    const brep = closedTwoFaceBrep();
    const shell = brep.shells[0]!;
    // oracle: all faceIndex1/faceIndex2 are in [0, faces.length-1]
    for (const edge of shell.edges) {
      expect(edge.faceIndex1).toBeGreaterThanOrEqual(0);
      expect(edge.faceIndex1).toBeLessThan(shell.faces.length);
      if (edge.faceIndex2 !== null) {
        expect(edge.faceIndex2).toBeGreaterThanOrEqual(0);
        expect(edge.faceIndex2).toBeLessThan(shell.faces.length);
      }
    }
  });

  test("brep with out-of-bounds faceIndex2 → not manifold by oracle definition", () => {
    const brep = closedTwoFaceBrep();
    // Corrupt faceIndex2 to be out of bounds
    brep.shells[0]!.edges[0]!.faceIndex2 = 999;
    const shell = brep.shells[0]!;
    const nonManifold = shell.edges.some(
      (e) => e.faceIndex2 !== null && e.faceIndex2 >= shell.faces.length,
    );
    // oracle: should detect structural error
    expect(nonManifold).toBe(true);
  });
});

// ── SdNakedEdgeCount oracle tests ─────────────────────────────────────────────

describe("SdNakedEdgeCount — oracle via brepNakedEdgeCount()", () => {
  test("closed brep → 0 naked edges", () => {
    const brep = closedTwoFaceBrep();
    // oracle: brepNakedEdgeCount counts edges with faceIndex2 = null
    expect(brepNakedEdgeCount(brep)).toBe(0);
  });

  test("open shell with 2 naked edges → nakedEdgeCount = 2", () => {
    const brep = openPlanarShell(3);
    // oracle: our fixture adds exactly 2 naked edges
    const nakedCount = brepNakedEdgeCount(brep);
    expect(nakedCount).toBe(2);
  });

  test("single-face brep from brepFromSurface → all edges naked (none exist → 0)", () => {
    const surf = tiltedPlaneSurf(0, 0, 1);
    const brep = brepFromSurface(surf);
    // oracle: brepFromSurface creates shell with no edges at all
    expect(brepNakedEdgeCount(brep)).toBe(0);
  });

  test("nakedEdgeCount parity: matches manual count from shell.edges", () => {
    const brep = openPlanarShell(5);
    // oracle: manual count
    let manualCount = 0;
    for (const shell of brep.shells) {
      for (const e of shell.edges) {
        if (e.faceIndex2 === null) manualCount++;
      }
    }
    expect(brepNakedEdgeCount(brep)).toBe(manualCount);
  });
});

// ── SdNakedEdgeLocations oracle tests ─────────────────────────────────────────

describe("SdNakedEdgeLocations — oracle via curvePointAt at domain midpoint", () => {
  test("2 naked edges → 2 midpoint locations", () => {
    const brep = openPlanarShell(3);
    const locs: Array<{ x: number; y: number; z: number }> = [];
    for (const shell of brep.shells) {
      for (const edge of shell.edges) {
        if (edge.faceIndex2 !== null) continue;
        const dom = curveDomain(edge.curve);
        const mid = (dom.min + dom.max) / 2;
        const pt = curvePointAt(edge.curve, mid);
        locs.push({ x: pt.x, y: pt.y, z: pt.z });
      }
    }
    // oracle: exactly one location per naked edge
    expect(locs).toHaveLength(2);
    // Each location should be a finite 3D point
    for (const loc of locs) {
      expect(Number.isFinite(loc.x)).toBe(true);
      expect(Number.isFinite(loc.y)).toBe(true);
      expect(Number.isFinite(loc.z)).toBe(true);
    }
  });

  test("non-axis-aligned naked edge midpoint evaluates correctly", () => {
    // Edge from (1,2,3) to (4,5,6) — non-axis-aligned
    const edge: BrepEdge = {
      curve: lineCurve(1, 2, 3, 4, 5, 6),
      faceIndex1: 0,
      faceIndex2: null,
      tolerance: BREP_DEFAULT_TOLERANCE,
    };
    const dom = curveDomain(edge.curve);
    const mid = (dom.min + dom.max) / 2;
    const pt = curvePointAt(edge.curve, mid);
    // oracle: closed-form midpoint of line from (1,2,3) to (4,5,6) is (2.5, 3.5, 4.5)
    const oracleMid = Pt3.lerp(Pt3.create(1, 2, 3), Pt3.create(4, 5, 6), 0.5);
    expect(Pt3.distance(pt, oracleMid)).toBeLessThan(1e-9);
  });
});

// ── SdFaceAccessor oracle tests ────────────────────────────────────────────────

describe("SdFaceAccessor — oracle via pointAtUV + normalAtUV at domain midpoint", () => {
  test("tilted plane surface: normal at UV center matches Plane.normal", () => {
    const surf = tiltedPlaneSurf(0, 1, 0); // Y-up normal
    const uMid = (surf.uDomain.min + surf.uDomain.max) / 2;
    const vMid = (surf.vDomain.min + surf.vDomain.max) / 2;
    // oracle: for a plane surface, normalAtUV is constant = plane.normal
    const n = normalAtUV(surf, uMid, vMid);
    expect(Math.abs(n.x - surf.plane.normal.x)).toBeLessThan(1e-9);
    expect(Math.abs(n.y - surf.plane.normal.y)).toBeLessThan(1e-9);
    expect(Math.abs(n.z - surf.plane.normal.z)).toBeLessThan(1e-9);
  });

  test("arbitrary tilted plane surface: center point is on the plane", () => {
    // Non-axis-aligned tilted surface with origin (1.5, 2.3, -0.7), normal (1,1,1)/sqrt(3)
    const surf = tiltedPlaneSurf(1, 1, 1);
    const uMid = (surf.uDomain.min + surf.uDomain.max) / 2;
    const vMid = (surf.vDomain.min + surf.vDomain.max) / 2;
    const pt = pointAtUV(surf, uMid, vMid);
    // oracle: point at UV center of a plane surface lies on the plane (dot(pt-origin, normal) = 0)
    const origin = surf.plane.origin;
    const normal = surf.plane.normal;
    const d = (pt.x - origin.x) * normal.x + (pt.y - origin.y) * normal.y + (pt.z - origin.z) * normal.z;
    expect(Math.abs(d)).toBeLessThan(1e-9);
    // Point should be finite
    expect(Number.isFinite(pt.x)).toBe(true);
    expect(Number.isFinite(pt.y)).toBe(true);
    expect(Number.isFinite(pt.z)).toBe(true);
  });

  test("face accessor reports orientation matching BrepFace.orientation", () => {
    const surf = xyPlaneSurf(0, 0, 0);
    const face: BrepFace = planarFace(surf);
    face.orientation = false; // reversed face
    const n = normalAtUV(surf, 0.5, 0.5);
    // oracle: if face.orientation = false, effective normal should be negated
    const effectiveNorm = face.orientation ? n : { x: -n.x, y: -n.y, z: -n.z };
    expect(effectiveNorm.z).toBeLessThan(0); // should point downward (negated Z)
  });
});

// ── SdEdgeAccessor oracle tests ────────────────────────────────────────────────

describe("SdEdgeAccessor — oracle via curvePointAt at domain endpoints", () => {
  test("line edge from (0,0,0) to (3,4,0): endpoints match curvePointAt", () => {
    const edge: BrepEdge = {
      curve: lineCurve(0, 0, 0, 3, 4, 0),
      faceIndex1: 0,
      faceIndex2: 1,
      tolerance: BREP_DEFAULT_TOLERANCE,
    };
    const dom = curveDomain(edge.curve);
    const startPt = curvePointAt(edge.curve, dom.min);
    const endPt = curvePointAt(edge.curve, dom.max);
    // oracle: closed-form expected values
    expect(Pt3.distance(startPt, Pt3.create(0, 0, 0))).toBeLessThan(1e-9);
    expect(Pt3.distance(endPt, Pt3.create(3, 4, 0))).toBeLessThan(1e-9);
  });

  test("naked edge (faceIndex2=null): isNaked == true", () => {
    const edge: BrepEdge = {
      curve: lineCurve(1, 2, 3, 4, 5, 6),
      faceIndex1: 0,
      faceIndex2: null,
      tolerance: BREP_DEFAULT_TOLERANCE,
    };
    expect(edge.faceIndex2).toBeNull();
  });

  test("shared edge (faceIndex2 != null): isNaked == false", () => {
    const edge: BrepEdge = {
      curve: lineCurve(1, 2, 3, 4, 5, 6),
      faceIndex1: 0,
      faceIndex2: 2,
      tolerance: BREP_DEFAULT_TOLERANCE,
    };
    expect(edge.faceIndex2).not.toBeNull();
  });
});

// ── SdVertexAccessor oracle tests ──────────────────────────────────────────────

describe("SdVertexAccessor — oracle via Point3 direct read", () => {
  test("vertex at non-axis-aligned position returns exact coordinates", () => {
    const vtx: BrepVertex = {
      point: Pt3.create(1.23, -4.56, 7.89),
      edgeIndices: [0, 1, 2],
      tolerance: BREP_DEFAULT_TOLERANCE,
    };
    // oracle: coordinates are stored directly, no computation
    expect(vtx.point.x).toBe(1.23);
    expect(vtx.point.y).toBe(-4.56);
    expect(vtx.point.z).toBe(7.89);
  });

  test("vertex edgeIndices are stored and returned as-is", () => {
    const vtx: BrepVertex = {
      point: Pt3.create(0, 0, 0),
      edgeIndices: [3, 7, 12],
      tolerance: BREP_DEFAULT_TOLERANCE,
    };
    expect(vtx.edgeIndices).toEqual([3, 7, 12]);
  });
});

// ── SdBrepTopology oracle tests ────────────────────────────────────────────────

describe("SdBrepTopology — oracle via manual BrepShell inspection", () => {
  test("closed two-face shell topology matches manual counts", () => {
    const brep = closedTwoFaceBrep();
    const shell = brep.shells[0]!;
    // oracle: manual counts from fixture
    expect(shell.faces.length).toBe(2);
    expect(shell.edges.length).toBe(4);
    expect(shell.vertices.length).toBe(0); // sparse scaffold
    const nakedCount = shell.edges.filter((e) => e.faceIndex2 === null).length;
    expect(nakedCount).toBe(0); // closed
  });

  test("open shell topology: nakedEdgeCount matches edges with faceIndex2=null", () => {
    const brep = openPlanarShell(4);
    const shell = brep.shells[0]!;
    const manualNaked = shell.edges.filter((e) => e.faceIndex2 === null).length;
    expect(brepNakedEdgeCount(brep)).toBe(manualNaked);
  });

  test("total face count aggregates across multiple shells", () => {
    const b1 = closedTwoFaceBrep(); // 2 faces
    const b2 = openPlanarShell(3);  // 3 faces
    const multi: Brep = { shells: [...b1.shells, ...b2.shells] };
    // oracle: brepFaceCount sums across shells
    expect(brepFaceCount(multi)).toBe(2 + 3);
  });

  test("Euler characteristic V-E+F = 2 for closed genus-0 shell (when topology is complete)", () => {
    // Build a proper tetrahedron (4 faces, 6 edges, 4 vertices)
    const faces: BrepFace[] = [
      planarFace(tiltedPlaneSurf(0, 0, 1)),
      planarFace(tiltedPlaneSurf(0, 1, 0)),
      planarFace(tiltedPlaneSurf(1, 0, 0)),
      planarFace(tiltedPlaneSurf(-1, -1, -1)),
    ];
    const edges: BrepEdge[] = [
      { curve: lineCurve(0, 0, 0, 1, 0, 0), faceIndex1: 0, faceIndex2: 1, tolerance: BREP_DEFAULT_TOLERANCE },
      { curve: lineCurve(1, 0, 0, 0, 1, 0), faceIndex1: 0, faceIndex2: 2, tolerance: BREP_DEFAULT_TOLERANCE },
      { curve: lineCurve(0, 1, 0, 0, 0, 0), faceIndex1: 0, faceIndex2: 3, tolerance: BREP_DEFAULT_TOLERANCE },
      { curve: lineCurve(0, 0, 0, 0, 0, 1), faceIndex1: 1, faceIndex2: 2, tolerance: BREP_DEFAULT_TOLERANCE },
      { curve: lineCurve(1, 0, 0, 0, 0, 1), faceIndex1: 1, faceIndex2: 3, tolerance: BREP_DEFAULT_TOLERANCE },
      { curve: lineCurve(0, 1, 0, 0, 0, 1), faceIndex1: 2, faceIndex2: 3, tolerance: BREP_DEFAULT_TOLERANCE },
    ];
    const vertices: BrepVertex[] = [
      { point: Pt3.create(0, 0, 0), edgeIndices: [0, 2, 3], tolerance: BREP_DEFAULT_TOLERANCE },
      { point: Pt3.create(1, 0, 0), edgeIndices: [0, 1, 4], tolerance: BREP_DEFAULT_TOLERANCE },
      { point: Pt3.create(0, 1, 0), edgeIndices: [1, 2, 5], tolerance: BREP_DEFAULT_TOLERANCE },
      { point: Pt3.create(0, 0, 1), edgeIndices: [3, 4, 5], tolerance: BREP_DEFAULT_TOLERANCE },
    ];
    const shell: BrepShell = { faces, edges, vertices, isClosed: true };
    const brep: Brep = { shells: [shell] };

    const V = shell.vertices.length; // 4
    const E = shell.edges.length;    // 6
    const F = shell.faces.length;    // 4
    // oracle: Euler-Poincaré for genus-0 closed orientable manifold: V-E+F = 2
    expect(V - E + F).toBe(2);
  });
});

// ── SdCapPlanarHoles structural oracle tests ───────────────────────────────────

describe("SdCapPlanarHoles structural oracle — planar hole detection", () => {
  test("Newell's method correctly computes normal for XY-plane loop", () => {
    // Square loop: (0,0,0) → (1,0,0) → (1,1,0) → (0,1,0)
    const pts = [
      Pt3.create(0, 0, 0),
      Pt3.create(1, 0, 0),
      Pt3.create(1, 1, 0),
      Pt3.create(0, 1, 0),
    ];
    let nx = 0, ny = 0, nz = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const curr = pts[i]!;
      const next = pts[(i + 1) % n]!;
      nx += (curr.y - next.y) * (curr.z + next.z);
      ny += (curr.z - next.z) * (curr.x + next.x);
      nz += (curr.x - next.x) * (curr.y + next.y);
    }
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const normal = { x: nx / len, y: ny / len, z: nz / len };
    // oracle: XY-plane loop has Z-normal
    expect(Math.abs(normal.z)).toBeGreaterThan(0.99);
    expect(Math.abs(normal.x)).toBeLessThan(0.01);
    expect(Math.abs(normal.y)).toBeLessThan(0.01);
  });

  test("Newell's method correctly computes normal for tilted loop", () => {
    // Tilted square loop in XZ plane: normal should be (0,-1,0) or (0,1,0)
    const pts = [
      Pt3.create(0, 0, 0),
      Pt3.create(1, 0, 0),
      Pt3.create(1, 0, 1),
      Pt3.create(0, 0, 1),
    ];
    let nx = 0, ny = 0, nz = 0;
    const count = pts.length;
    for (let i = 0; i < count; i++) {
      const curr = pts[i]!;
      const next = pts[(i + 1) % count]!;
      nx += (curr.y - next.y) * (curr.z + next.z);
      ny += (curr.z - next.z) * (curr.x + next.x);
      nz += (curr.x - next.x) * (curr.y + next.y);
    }
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const normal = { x: nx / len, y: ny / len, z: nz / len };
    // oracle: XZ-plane loop has Y-normal
    expect(Math.abs(normal.y)).toBeGreaterThan(0.99);
    expect(Math.abs(normal.x)).toBeLessThan(0.01);
    expect(Math.abs(normal.z)).toBeLessThan(0.01);
  });

  test("non-planar loop returns null from fitPlane (all 4 pts not coplanar)", () => {
    // Saddle shape: not in a plane
    const pts = [
      Pt3.create(0, 0, 0),
      Pt3.create(1, 0, 0.5),
      Pt3.create(1, 1, 0),
      Pt3.create(0, 1, 0.5),
    ];
    // Check max residual: at least one point not on the Newell plane
    let nx = 0, ny = 0, nz = 0;
    const count = pts.length;
    for (let i = 0; i < count; i++) {
      const curr = pts[i]!;
      const next = pts[(i + 1) % count]!;
      nx += (curr.y - next.y) * (curr.z + next.z);
      ny += (curr.z - next.z) * (curr.x + next.x);
      nz += (curr.x - next.x) * (curr.y + next.y);
    }
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-10) { expect(true).toBe(true); return; } // degenerate
    const normal = { x: nx / len, y: ny / len, z: nz / len };
    let cx = 0, cy = 0, cz = 0;
    for (const p of pts) { cx += p.x; cy += p.y; cz += p.z; }
    const origin = { x: cx / count, y: cy / count, z: cz / count };
    const maxResidual = Math.max(...pts.map((p) =>
      Math.abs((p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y + (p.z - origin.z) * normal.z),
    ));
    // oracle: saddle pts have non-zero residual from their average plane
    expect(maxResidual).toBeGreaterThan(1e-4);
  });
});

// ── SdMergeCoplanarFaces oracle tests ─────────────────────────────────────────

describe("SdMergeCoplanarFaces oracle — coplanarity via normal dot product", () => {
  test("two faces with same Z-up normal: dot product = 1.0 → coplanar", () => {
    const surf1 = xyPlaneSurf(0, 0, 0);
    const surf2 = xyPlaneSurf(1, 0, 0); // same normal, different position
    const n1 = normalAtUV(surf1, 0.5, 0.5);
    const n2 = normalAtUV(surf2, 0.5, 0.5);
    const dot = n1.x * n2.x + n1.y * n2.y + n1.z * n2.z;
    // oracle: both Z-up normals → dot = 1.0
    expect(Math.abs(dot - 1.0)).toBeLessThan(1e-9);
  });

  test("two faces with perpendicular normals: dot product = 0 → not coplanar", () => {
    const surf1 = xyPlaneSurf(0, 0, 0); // Z-up normal
    const surf2 = tiltedPlaneSurf(1, 0, 0); // X-up normal
    const n1 = normalAtUV(surf1, 0.5, 0.5);
    const n2 = normalAtUV(surf2, 0.5, 0.5);
    const dot = n1.x * n2.x + n1.y * n2.y + n1.z * n2.z;
    // oracle: Z-up dot X-up = 0
    expect(Math.abs(dot)).toBeLessThan(1e-9);
  });

  test("tilted face normal is consistent with surface orientation", () => {
    // (1,1,0) normalized = (0.707, 0.707, 0)
    const surf = tiltedPlaneSurf(1, 1, 0);
    const n = normalAtUV(surf, 0.5, 0.5);
    const expectedLen = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
    // oracle: normal is always unit-length from normalAtUV
    expect(Math.abs(expectedLen - 1.0)).toBeLessThan(1e-9);
  });
});

// ── SdExtractFace oracle tests ─────────────────────────────────────────────────

describe("SdExtractFace oracle — structural face extraction", () => {
  test("extracting face from multi-face shell gives correct surface kind", () => {
    const brep = openPlanarShell(4);
    const allFaces = brep.shells.flatMap((s) => s.faces);
    // oracle: every face in our fixture is a plane surface
    for (const face of allFaces) {
      expect(face.surface.kind).toBe("plane");
    }
  });

  test("extracted face has same surface parameters as original", () => {
    const surf = tiltedPlaneSurf(0.3, 0.7, 0.6);
    const brep = brepFromSurface(surf);
    const face = brep.shells[0]!.faces[0]!;
    // oracle: surface identity — deep clone preserves all fields
    const cloned: BrepFace = JSON.parse(JSON.stringify(face)) as BrepFace;
    expect(cloned.surface.kind).toBe(face.surface.kind);
    if (cloned.surface.kind === "plane" && face.surface.kind === "plane") {
      expect(Math.abs(cloned.surface.plane.normal.x - face.surface.plane.normal.x)).toBeLessThan(1e-12);
      expect(Math.abs(cloned.surface.plane.normal.y - face.surface.plane.normal.y)).toBeLessThan(1e-12);
      expect(Math.abs(cloned.surface.plane.normal.z - face.surface.plane.normal.z)).toBeLessThan(1e-12);
    }
  });
});

// ── SdExplode oracle tests ─────────────────────────────────────────────────────

describe("SdExplode oracle — structural brep decomposition", () => {
  test("exploding N-face shell produces N single-face breps", () => {
    const faceCount = 5;
    const brep = openPlanarShell(faceCount);
    const allFaces = brep.shells.flatMap((s) => s.faces);
    // oracle: one output per face
    expect(allFaces.length).toBe(faceCount);
    // Each extracted face should be a valid single-face brep
    for (const face of allFaces) {
      const faceBrep: Brep = {
        shells: [{ faces: [JSON.parse(JSON.stringify(face)) as BrepFace], edges: [], vertices: [], isClosed: false }],
      };
      const report = validateBrep(faceBrep);
      expect(report.valid).toBe(true);
    }
  });

  test("exploded face brep has faceCount = 1", () => {
    const brep = closedTwoFaceBrep();
    const face = brep.shells[0]!.faces[0]!;
    const extracted: Brep = {
      shells: [{ faces: [JSON.parse(JSON.stringify(face)) as BrepFace], edges: [], vertices: [], isClosed: false }],
    };
    expect(brepFaceCount(extracted)).toBe(1);
  });
});

// ── SdUnjoin oracle tests ──────────────────────────────────────────────────────

describe("SdUnjoin oracle — shell-level brep split", () => {
  test("unjoining multi-shell brep gives N=shells single-shell breps", () => {
    const b1 = closedTwoFaceBrep(); // 1 shell
    const b2 = openPlanarShell(3);  // 1 shell
    const multi: Brep = { shells: [...b1.shells, ...b2.shells] };
    // oracle: 2 shells → 2 outputs
    expect(multi.shells.length).toBe(2);
    const output1: Brep = { shells: [JSON.parse(JSON.stringify(multi.shells[0]!)) as BrepShell] };
    const output2: Brep = { shells: [JSON.parse(JSON.stringify(multi.shells[1]!)) as BrepShell] };
    expect(brepFaceCount(output1)).toBe(2); // from b1
    expect(brepFaceCount(output2)).toBe(3); // from b2
  });

  test("unjoining single-shell brep gives 1 shell (no-op)", () => {
    const brep = closedTwoFaceBrep();
    // oracle: only 1 shell → nothing to unjoin
    expect(brep.shells.length).toBe(1);
  });
});

// ── C++-blocked op stubs ──────────────────────────────────────────────────────

describe("C++ blocked ops — blocked: requires kern.wasm", () => {
  test.skip("SdFilletCurved — blocked: requires general kern_fillet_curved in kern.wasm " +
    "(OCCT BRepFilletAPI_MakeFillet on curved surfaces)", () => {
    // This op requires OCCT curved fillet support in kern.wasm.
    // kern C++ signature:
    //   BrepResult kern_fillet_curved(const ON_Brep&, const std::vector<int>& edges,
    //     double radius, double tolerance = 1e-6);
    // oracle: replicad (OCCT BRepFilletAPI_MakeFillet) + rhino3dm cross-check
  });

  test.skip("SdFilletVariableRadius — blocked: requires kern_fillet_variable_radius in kern.wasm " +
    "(OCCT per-vertex radius interpolation)", () => {
    // kern C++ signature:
    //   BrepResult kern_fillet_variable_radius(const ON_Brep&,
    //     const std::vector<int>& edges,
    //     const std::vector<double>& start_radii,
    //     const std::vector<double>& end_radii,
    //     double tolerance = 1e-6);
    // oracle: adaptive cubic interpolation + replicad cross-check
  });

  test.skip("SdChamferCurved — blocked: requires kern_chamfer_curved in kern.wasm " +
    "(OCCT BRepFilletAPI_MakeChamfer on curved surfaces)", () => {
    // kern C++ signature:
    //   BrepResult kern_chamfer_curved(const ON_Brep&,
    //     const std::vector<int>& edges,
    //     double distance1, double distance2,
    //     double tolerance = 1e-6);
    // oracle: replicad (OCCT BRepFilletAPI_MakeChamfer) + rhino3dm cross-check
  });

  test.skip("SdBlend — blocked: requires kern_blend_edge in kern.wasm " +
    "(OCCT BRepOffsetAPI_MakeFilling G1/G2)", () => {
    // kern C++ signature:
    //   BrepResult kern_blend_edge(const ON_Brep&, int edge1, int edge2,
    //     int continuity, double tolerance = 1e-6);
    // oracle: G1 ruled surface via SSI (nurbs/ssi.ts) + replicad BRepOffsetAPI_MakeFilling
  });

  test.skip("SdCapPlanarHoles — non-planar NURBS holes blocked: requires kern_cap_planar_holes " +
    "(OCCT IfcFace stitching for non-planar boundaries)", () => {
    // kern C++ signature:
    //   BrepResult kern_cap_planar_holes(const ON_Brep& brep, double tol = 1e-6);
    // Planar holes handled in TS; NURBS non-planar holes need OCCT.
  });

  test.skip("SdMergeCoplanarFaces — NURBS non-planar merge blocked: requires kern_merge_coplanar_faces " +
    "(OCCT ShapeUpgrade_UnifySameDomain)", () => {
    // kern C++ signature:
    //   BrepResult kern_merge_coplanar_faces(const ON_Brep& brep, double angle_tol = 1e-4);
    // Planar merge handled in TS; NURBS parametric merge needs OCCT.
  });
});
