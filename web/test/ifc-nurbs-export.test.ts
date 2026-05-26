// ifc-nurbs-export.test.ts — G9: IfcAdvancedBrep emit when nurbsSurface present (#125).
import { describe, it, expect } from "bun:test";
import { buildIfcScene, buildIfc } from "../src/ifc/ifc-build.js";
import type { IfcSceneElement } from "../src/ifc/ifc-build.js";
import type { NurbsSurface } from "../src/nurbs/nurbs-surfaces.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function minimalMesh() {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

// Flat bilinear patch (degree 1 in both directions, 2×2 control points).
// Represents the unit square [0,1]×[0,1] in XY plane.
// OpenNURBS knots for degree=1, n=2: [0, 1] (length = n+order-2 = 2+2-2 = 2).
function bilinearPatch(): NurbsSurface {
  const cvs = [
    // (u=0,v=0) (u=0,v=1)
    0, 0, 0,   1, 0, 0,
    // (u=1,v=0) (u=1,v=1)
    0, 1, 0,   1, 1, 0,
  ];
  return {
    kind: "nurbs",
    dim: 3,
    isRational: false,
    order: [2, 2],            // degree 1 × 1
    cvCount: [2, 2],
    knots: [[0, 1], [0, 1]], // OpenNURBS: length = 2+2-2 = 2 per axis
    cvs,
    cvStride: [6, 3],        // [nV*dim, dim] = [2*3, 3]
  };
}

// Cubic patch (degree 3, 4×4 CVs).
// OpenNURBS clamped knots for degree=3, n=4: [0,0,0,1,1,1] (length = 4+4-2 = 6).
function cubicPatch(): NurbsSurface {
  const n = 4;
  const cvs: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      cvs.push(i / (n - 1), j / (n - 1), 0);
    }
  }
  const kU = [0, 0, 0, 1, 1, 1]; // degree-3 clamped, n=4
  return {
    kind: "nurbs",
    dim: 3,
    isRational: false,
    order: [4, 4],            // degree 3 × 3
    cvCount: [n, n],
    knots: [kU, kU],
    cvs,
    cvStride: [n * 3, 3],
  };
}

// Rational bilinear patch (isRational=true, cvStride=4 for xyzw).
function rationalPatch(): NurbsSurface {
  const cvs = [
    // x, y, z, w
    0, 0, 0, 1,   1, 0, 0, 1,
    0, 1, 0, 1,   1, 1, 0, 1,
  ];
  return {
    kind: "nurbs",
    dim: 3,
    isRational: true,
    order: [2, 2],
    cvCount: [2, 2],
    knots: [[0, 1], [0, 1]],
    cvs,
    cvStride: [8, 4],        // [nV*4, 4]
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("G9 — fallback: no nurbsSurface → IfcFacetedBrep", () => {
  it("element without nurbsSurface emits IFCFACETEDBREP", () => {
    const elements: IfcSceneElement[] = [{ mesh: minimalMesh(), creator: "IfcWall" }];
    const text = new TextDecoder().decode(buildIfcScene(elements));
    expect(text).toContain("IFCFACETEDBREP");
    expect(text).not.toContain("IFCADVANCEDBREP");
    expect(text).not.toContain("IFCADVANCEDFACE");
  });

  it("shape rep type is 'Brep' for mesh-only element", () => {
    const text = new TextDecoder().decode(
      buildIfcScene([{ mesh: minimalMesh(), creator: "IfcWall" }]),
    );
    expect(text).toContain("'Brep'");
    expect(text).not.toContain("'AdvancedBrep'");
  });
});

describe("G9 — nurbsSurface present → IfcAdvancedBrep", () => {
  it("AC#1 — IFCADVANCEDBREP present (not IFCFACETEDBREP)", () => {
    const el: IfcSceneElement = {
      mesh: minimalMesh(),
      creator: "IfcWall",
      nurbsSurface: bilinearPatch(),
    };
    const text = new TextDecoder().decode(buildIfcScene([el]));
    expect(text).toContain("IFCADVANCEDBREP");
    expect(text).not.toContain("IFCFACETEDBREP");
  });

  it("AC#2 — IFCADVANCEDFACE present", () => {
    const text = new TextDecoder().decode(
      buildIfcScene([{ mesh: minimalMesh(), creator: "IfcWall", nurbsSurface: bilinearPatch() }]),
    );
    expect(text).toContain("IFCADVANCEDFACE");
  });

  it("AC#3 — shape rep type is 'AdvancedBrep'", () => {
    const text = new TextDecoder().decode(
      buildIfcScene([{ mesh: minimalMesh(), creator: "IfcWall", nurbsSurface: bilinearPatch() }]),
    );
    expect(text).toContain("'AdvancedBrep'");
    expect(text).not.toContain("'Brep'");
  });

  it("AC#4 — IFCEDGELOOP present (AdvancedFace requires EdgeLoop, not PolyLoop)", () => {
    const text = new TextDecoder().decode(
      buildIfcScene([{ mesh: minimalMesh(), creator: "IfcWall", nurbsSurface: bilinearPatch() }]),
    );
    expect(text).toContain("IFCEDGELOOP");
    expect(text).not.toContain("IFCPOLYLOOP");
  });
});

describe("G9 — non-rational surface → IFCBSPLINESURFACEWITHKNOTS", () => {
  it("non-rational patch emits IFCBSPLINESURFACEWITHKNOTS (not rational variant)", () => {
    const text = new TextDecoder().decode(
      buildIfcScene([{ mesh: minimalMesh(), creator: "IfcWall", nurbsSurface: bilinearPatch() }]),
    );
    expect(text).toContain("IFCBSPLINESURFACEWITHKNOTS");
    expect(text).not.toContain("IFCRATIONALBSPLINESURFACEWITHKNOTS");
  });
});

describe("G9 — rational surface → IFCRATIONALBSPLINESURFACEWITHKNOTS", () => {
  it("rational patch emits IFCRATIONALBSPLINESURFACEWITHKNOTS", () => {
    const text = new TextDecoder().decode(
      buildIfcScene([{ mesh: minimalMesh(), creator: "IfcWall", nurbsSurface: rationalPatch() }]),
    );
    expect(text).toContain("IFCRATIONALBSPLINESURFACEWITHKNOTS");
  });
});

describe("G9 — knot multiplicity constraint (IFC4: sum = cvCount + degree + 1)", () => {
  it("bilinear patch (degree=1, n=2): IFC mults sum = 2+1+1 = 4 per axis", () => {
    const text = new TextDecoder().decode(
      buildIfcScene([{ mesh: minimalMesh(), creator: "IfcWall", nurbsSurface: bilinearPatch() }]),
    );
    // OpenNURBS [0,1] → compress → {knots:[0,1], mults:[1,1]} → +1 first/last → [2,2] → sum=4
    // The STEP line contains mults like (2,2) for each axis
    expect(text).toMatch(/IFCBSPLINESURFACEWITHKNOTS\(1,1,.*\(2,2\),\(2,2\)/);
  });

  it("cubic patch (degree=3, n=4): IFC mults sum = 4+3+1 = 8 per axis", () => {
    const text = new TextDecoder().decode(
      buildIfcScene([{ mesh: minimalMesh(), creator: "IfcWall", nurbsSurface: cubicPatch() }]),
    );
    // OpenNURBS [0,0,0,1,1,1] → {knots:[0,1], mults:[3,3]} → +1 each → [4,4] → sum=8 ✓
    expect(text).toMatch(/IFCBSPLINESURFACEWITHKNOTS\(3,3,.*\(4,4\),\(4,4\)/);
  });
});

describe("G9 — control point count in STEP output", () => {
  it("bilinear 2×2 patch emits 4 control-point IFCCARTESIANPOINT entries (plus corner pts)", () => {
    const text = new TextDecoder().decode(
      buildIfcScene([{ mesh: minimalMesh(), creator: "IfcWall", nurbsSurface: bilinearPatch() }]),
    );
    // 4 CVs + 4 corner points for edge loop = 8 total IFCCARTESIANPOINT
    // At minimum 4 (just the CVs — but corners might reuse them)
    const matches = text.match(/IFCCARTESIANPOINT/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4); // at least 4 for 2×2 CVs
  });
});

describe("G9 — buildIfc (legacy single-element) with nurbsSurface", () => {
  it("buildIfc with nurbsSurface emits IFCADVANCEDBREP", () => {
    const text = new TextDecoder().decode(
      buildIfc(minimalMesh(), "TestElement", { nurbsSurface: bilinearPatch() }),
    );
    expect(text).toContain("IFCADVANCEDBREP");
    expect(text).not.toContain("IFCFACETEDBREP");
    expect(text).toContain("IFCBSPLINESURFACEWITHKNOTS");
    expect(text).toContain("'AdvancedBrep'");
  });

  it("buildIfc without nurbsSurface still emits IFCFACETEDBREP (regression guard)", () => {
    const text = new TextDecoder().decode(buildIfc(minimalMesh(), "TestElement"));
    expect(text).toContain("IFCFACETEDBREP");
    expect(text).not.toContain("IFCADVANCEDBREP");
  });
});

describe("G9 — NURBS element alongside mesh element", () => {
  it("mixed scene: one mesh element + one nurbs element both present", () => {
    const elements: IfcSceneElement[] = [
      { mesh: minimalMesh(), creator: "IfcWall" },
      { mesh: minimalMesh(), creator: "IfcSlab", nurbsSurface: bilinearPatch() },
    ];
    const text = new TextDecoder().decode(buildIfcScene(elements));
    expect(text).toContain("IFCFACETEDBREP");
    expect(text).toContain("IFCADVANCEDBREP");
    expect(text).toContain("'Brep'");
    expect(text).toContain("'AdvancedBrep'");
  });
});
