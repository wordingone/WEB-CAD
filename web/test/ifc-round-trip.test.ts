// IFC export round-trip — certified 2-storey house (#372 IFC leg, #400 kernel completeness).
//
// AC (Leo #13340): export house geometry to IFC, re-import, assert geometry
// parity (vertex/face count + bbox within tolerance) with ZERO silent geometry loss.
//
// Strategy: pure STEP-21 text parse (no web-ifc WASM needed in Bun).
//   IFCPOLYLOOP count  = triangle count  (1 per triangle in emitMeshBrep)
//   IFCCARTESIANPOINT count = vertex count + 1  (1 header world-origin)
//   Extract all IFCCARTESIANPOINT coords → compute bbox → compare to source bbox.
//
// House: 14 elements, 2 levels — matches native-house-replay.json structure.
//   GF (level/0): 1 slab + 4 walls + 1 door + 1 window  = 7 elements
//   UF (level/1): 1 slab + 4 walls + 2 windows           = 7 elements

import { describe, test, expect } from "bun:test";
import { buildIfcScene, type IfcSceneElement, type IfcLevel } from "../src/ifc/ifc-build.js";

// ── Box mesh factory ──────────────────────────────────────────────────────────
// 8 world-space vertices, 12 triangles (2 per face × 6 faces), 36 indices.

function makeBoxMesh(
  cx: number, cy: number, z0: number,
  w: number, d: number, h: number,
): { vertices: Float32Array; indices: Uint32Array } {
  const hw = w / 2, hd = d / 2;
  const x0 = cx - hw, x1 = cx + hw;
  const y0 = cy - hd, y1 = cy + hd;
  const z1 = z0 + h;
  const vertices = new Float32Array([
    x0, y0, z0,  x1, y0, z0,  x1, y1, z0,  x0, y1, z0,   // bottom (z=z0)
    x0, y0, z1,  x1, y0, z1,  x1, y1, z1,  x0, y1, z1,   // top    (z=z1)
  ]);
  const indices = new Uint32Array([
    0, 1, 2,  0, 2, 3,  // bottom face
    4, 6, 5,  4, 7, 6,  // top face
    0, 4, 5,  0, 5, 1,  // south face (y0)
    2, 6, 7,  2, 7, 3,  // north face (y1)
    0, 3, 7,  0, 7, 4,  // west face  (x0)
    1, 5, 6,  1, 6, 2,  // east face  (x1)
  ]);
  return { vertices, indices };
}

// ── STEP-21 geometry parser ───────────────────────────────────────────────────

function parseStepGeometry(text: string): {
  polyloopCount: number;
  cartPtCoords: [number, number, number][];
} {
  const polyloopCount = (text.match(/=IFCPOLYLOOP\(/g) ?? []).length;
  const cartPtCoords: [number, number, number][] = [];
  // Matches IFCCARTESIANPOINT((x,y,z)) — stepFloat uses no spaces inside the triple.
  const re = /=IFCCARTESIANPOINT\(\(([-\d.eE+]+),([-\d.eE+]+),([-\d.eE+]+)\)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    cartPtCoords.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
  }
  return { polyloopCount, cartPtCoords };
}

function bboxOf(coords: [number, number, number][]): {
  min: [number, number, number]; max: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of coords) {
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }
  return { min, max };
}

function sourceBbox(elements: IfcSceneElement[]): {
  min: [number, number, number]; max: [number, number, number];
} {
  const coords: [number, number, number][] = [];
  for (const el of elements) {
    const v = el.mesh.vertices;
    for (let i = 0; i < v.length; i += 3) coords.push([v[i]!, v[i + 1]!, v[i + 2]!]);
  }
  return bboxOf(coords);
}

// ── Certified house geometry ──────────────────────────────────────────────────
// Matches native-house-replay.json: 11×8.5m footprint, GF=2.8m, UF=2.6m, T=0.25m.

const GF_H = 2.8, UF_H = 2.6, T = 0.25, SLAB_T = 0.2;
const FP_W = 11, FP_D = 8.5;
const GF = "level/0", UF = "level/1";

const levels: IfcLevel[] = [
  { levelId: GF, name: "Ground Floor", elevation: 0 },
  { levelId: UF, name: "Upper Floor",  elevation: GF_H },
];

const elements: IfcSceneElement[] = [
  // ── Ground floor (level/0) ──────────────────────────────────────
  { mesh: makeBoxMesh(FP_W / 2, FP_D / 2, 0,    FP_W, FP_D, SLAB_T), creator: "IfcSlab",   levelId: GF },
  // 4 perimeter walls — centered on footprint edges, half-thickness inward/outward
  { mesh: makeBoxMesh(FP_W / 2, 0,         0,    FP_W, T,    GF_H  ), creator: "IfcWall",   levelId: GF },
  { mesh: makeBoxMesh(FP_W / 2, FP_D,      0,    FP_W, T,    GF_H  ), creator: "IfcWall",   levelId: GF },
  { mesh: makeBoxMesh(0,        FP_D / 2,  0,    T,    FP_D, GF_H  ), creator: "IfcWall",   levelId: GF },
  { mesh: makeBoxMesh(FP_W,     FP_D / 2,  0,    T,    FP_D, GF_H  ), creator: "IfcWall",   levelId: GF },
  // GF door: 1.01 × 0.25 × 2.01 at front face x≈4.925
  { mesh: makeBoxMesh(4.925,    0,          0,    1.01, T,    2.01  ), creator: "IfcDoor",   levelId: GF },
  // GF window: 2.0 × 0.25 × 1.2 at sill 0.8m
  { mesh: makeBoxMesh(1.9,      0,          0.8,  2.0,  T,    1.2   ), creator: "IfcWindow", levelId: GF },
  // ── Upper floor (level/1) ───────────────────────────────────────
  { mesh: makeBoxMesh(FP_W / 2, FP_D / 2, GF_H, FP_W, FP_D, SLAB_T), creator: "IfcSlab",   levelId: UF },
  // 4 perimeter walls at GF_H elevation
  { mesh: makeBoxMesh(FP_W / 2, 0,        GF_H, FP_W, T,    UF_H  ), creator: "IfcWall",   levelId: UF },
  { mesh: makeBoxMesh(FP_W / 2, FP_D,     GF_H, FP_W, T,    UF_H  ), creator: "IfcWall",   levelId: UF },
  { mesh: makeBoxMesh(0,        FP_D / 2, GF_H, T,    FP_D, UF_H  ), creator: "IfcWall",   levelId: UF },
  { mesh: makeBoxMesh(FP_W,     FP_D / 2, GF_H, T,    FP_D, UF_H  ), creator: "IfcWall",   levelId: UF },
  // UF windows (2): 1.0 × 0.25 × 1.0 at sill 0.9m above UF floor
  { mesh: makeBoxMesh(5.5,      0,        GF_H + 0.9, 1.0, T, 1.0 ), creator: "IfcWindow", levelId: UF },
  { mesh: makeBoxMesh(5.5,      0,        GF_H + 0.9, 1.0, T, 1.0 ), creator: "IfcWindow", levelId: UF },
];

// ── Source stats (before export) ──────────────────────────────────────────────
const SOURCE_VERTEX_COUNT   = elements.reduce((s, el) => s + el.mesh.vertices.length / 3, 0);
const SOURCE_TRIANGLE_COUNT = elements.reduce((s, el) => s + el.mesh.indices.length  / 3, 0);
const srcBbox = sourceBbox(elements);

// ── Export ────────────────────────────────────────────────────────────────────
const ifcBytes = buildIfcScene(elements, levels);
const ifcText  = new TextDecoder().decode(ifcBytes);

// ── Parse re-import stats ─────────────────────────────────────────────────────
const { polyloopCount, cartPtCoords } = parseStepGeometry(ifcText);
const reimportBbox = bboxOf(cartPtCoords);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("IFC export round-trip — certified house (#372/#400)", () => {
  test("IFC output is valid STEP-21 IFC4", () => {
    expect(ifcBytes.byteLength).toBeGreaterThan(10_000);
    expect(ifcText).toContain("ISO-10303-21;");
    expect(ifcText).toContain("FILE_SCHEMA(('IFC4'));");
    expect(ifcText).toContain("END-ISO-10303-21;");
  });

  test("triangle count round-trips without loss (IFCPOLYLOOP count === source triangles)", () => {
    // emitMeshBrep emits exactly 1 IFCPOLYLOOP per source triangle — no merging, no splitting.
    expect(polyloopCount).toBe(SOURCE_TRIANGLE_COUNT);
  });

  test("vertex count round-trips without loss (IFCCARTESIANPOINT = source vertices + 1 header origin)", () => {
    // buildIfcScene header emits exactly 1 IFCCARTESIANPOINT for the world origin (0,0,0).
    // Every mesh vertex is emitted as a separate IFCCARTESIANPOINT in emitMeshBrep.
    expect(cartPtCoords.length).toBe(SOURCE_VERTEX_COUNT + 1);
  });

  test("bounding box round-trips within 1e-4 tolerance", () => {
    // The header origin (0,0,0) lies at the building corner — within source bbox.
    // stepFloat precision: integers as "n.0", floats as toString() — 1e-4 is safe.
    expect(reimportBbox.min[0]).toBeCloseTo(srcBbox.min[0], 4);
    expect(reimportBbox.min[1]).toBeCloseTo(srcBbox.min[1], 4);
    expect(reimportBbox.min[2]).toBeCloseTo(srcBbox.min[2], 4);
    expect(reimportBbox.max[0]).toBeCloseTo(srcBbox.max[0], 4);
    expect(reimportBbox.max[1]).toBeCloseTo(srcBbox.max[1], 4);
    expect(reimportBbox.max[2]).toBeCloseTo(srcBbox.max[2], 4);
  });

  test("element type counts preserved — IfcWall/IfcSlab/IfcDoor/IfcWindow all present", () => {
    const wallCount   = (ifcText.match(/=IFCWALL\(/g)   ?? []).length;
    const slabCount   = (ifcText.match(/=IFCSLAB\(/g)   ?? []).length;
    const doorCount   = (ifcText.match(/=IFCDOOR\(/g)   ?? []).length;
    const windowCount = (ifcText.match(/=IFCWINDOW\(/g) ?? []).length;
    expect(wallCount).toBe(elements.filter(e => e.creator === "IfcWall").length);    // 8
    expect(slabCount).toBe(elements.filter(e => e.creator === "IfcSlab").length);    // 2
    expect(doorCount).toBe(elements.filter(e => e.creator === "IfcDoor").length);    // 1
    expect(windowCount).toBe(elements.filter(e => e.creator === "IfcWindow").length); // 3
  });

  test("multi-level: 2 occupied storeys emit separate IFCRELCONTAINEDINSPATIALSTRUCTURE", () => {
    // GF has 7 elements, UF has 7 elements → both occupied.
    // Unassigned storey has 0 elements → no containment relation for it.
    const containedCount = (ifcText.match(/=IFCRELCONTAINEDINSPATIALSTRUCTURE\(/g) ?? []).length;
    expect(containedCount).toBe(2);
  });

  test("ZERO silent geometry loss — no element falls through to IFCBUILDINGELEMENTPROXY", () => {
    // All creators (IfcWall/IfcSlab/IfcDoor/IfcWindow) map to named IFC4 entities.
    // Any unknown creator silently becomes IFCBUILDINGELEMENTPROXY — that's the class
    // of silent loss this test catches.
    const proxyCount = (ifcText.match(/=IFCBUILDINGELEMENTPROXY\(/g) ?? []).length;
    expect(proxyCount).toBe(0);
  });

  test("source stats sanity: 14 elements × 8 vertices × 12 triangles per box", () => {
    expect(SOURCE_VERTEX_COUNT).toBe(14 * 8);    // 112 vertices
    expect(SOURCE_TRIANGLE_COUNT).toBe(14 * 12); // 168 triangles
  });
});
