// step-build.test.ts — unit tests for buildStepScene (AP214 STEP export).
//
// Verifies AC (Leo #13386):
//   AC1. Output starts with ISO-10303-21 header and ends with END-ISO-10303-21
//   AC2. AP214 schema identifier present in FILE_SCHEMA
//   AC3. PRODUCT count == EXTRUDED_AREA_SOLID count == scene element count
//   AC4. Degenerate elements (zero-volume) are skipped
//   AC5. AABB base placement coords match input mesh vertices

import { describe, test, expect } from "bun:test";
import { buildStepScene } from "../src/ifc/step-build.js";
import type { IfcSceneElement } from "../src/ifc/ifc-build.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBoxMesh(
  cx: number, cy: number, z0: number,
  w: number, d: number, h: number,
): { vertices: Float32Array; indices: Uint32Array } {
  const hw = w / 2, hd = d / 2;
  const x0 = cx - hw, x1 = cx + hw;
  const y0 = cy - hd, y1 = cy + hd;
  const z1 = z0 + h;
  const vertices = new Float32Array([
    x0, y0, z0,  x1, y0, z0,  x1, y1, z0,  x0, y1, z0,
    x0, y0, z1,  x1, y0, z1,  x1, y1, z1,  x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2,  0, 2, 3,  4, 6, 5,  4, 7, 6,
    0, 4, 5,  0, 5, 1,  2, 6, 7,  2, 7, 3,
    0, 3, 7,  0, 7, 4,  1, 5, 6,  1, 6, 2,
  ]);
  return { vertices, indices };
}

function countEntity(text: string, entity: string): number {
  return (text.match(new RegExp(`=${entity}\\(`, "g")) ?? []).length;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildStepScene — AP214 STEP from scene elements (Leo #13386)", () => {

  const elements: IfcSceneElement[] = [
    { mesh: makeBoxMesh(5.5, 0, 0, 11, 0.25, 2.8), creator: "IfcWall",  label: "GF south wall" },
    { mesh: makeBoxMesh(5.5, 4.25, 0, 11, 8.5, 0.2), creator: "IfcSlab", label: "GF slab"       },
  ];

  const bytes = buildStepScene(elements);
  const text  = new TextDecoder().decode(bytes);

  // AC1 — well-formed STEP-21 framing
  test("AC1: output starts with ISO-10303-21", () => {
    expect(text.trimStart().startsWith("ISO-10303-21;")).toBe(true);
  });

  test("AC1: output ends with END-ISO-10303-21", () => {
    expect(text.trimEnd().endsWith("END-ISO-10303-21;")).toBe(true);
  });

  test("AC1: DATA section present and closed", () => {
    expect(text).toContain("DATA;");
    expect(text).toContain("ENDSEC;");
  });

  // AC2 — AP214 schema
  test("AC2: FILE_SCHEMA contains AUTOMOTIVE_DESIGN (AP214)", () => {
    expect(text).toMatch(/FILE_SCHEMA\(\('AUTOMOTIVE_DESIGN/);
  });

  // AC3 — entity counts
  test("AC3: PRODUCT count == element count (2)", () => {
    expect(countEntity(text, "PRODUCT")).toBe(2);
  });

  test("AC3: EXTRUDED_AREA_SOLID count == element count (2)", () => {
    expect(countEntity(text, "EXTRUDED_AREA_SOLID")).toBe(2);
  });

  test("AC3: RECTANGLE_PROFILE_DEF count == element count (2)", () => {
    expect(countEntity(text, "RECTANGLE_PROFILE_DEF")).toBe(2);
  });

  test("AC3: SHAPE_DEFINITION_REPRESENTATION count == element count (2)", () => {
    expect(countEntity(text, "SHAPE_DEFINITION_REPRESENTATION")).toBe(2);
  });

  // AC4 — degenerate element skipped
  test("AC4: degenerate element (zero-height) is skipped", () => {
    const flatMesh = makeBoxMesh(0, 0, 0, 1, 1, 0); // h=0 → degenerate
    const elems: IfcSceneElement[] = [
      { mesh: makeBoxMesh(0, 0, 0, 2, 2, 2), creator: "IfcWall", label: "box" },
      { mesh: flatMesh,                       creator: "IfcSlab", label: "flat" },
    ];
    const out = new TextDecoder().decode(buildStepScene(elems));
    expect(countEntity(out, "EXTRUDED_AREA_SOLID")).toBe(1);
  });

  // AC5 — AABB placement: base center coords appear in CARTESIAN_POINT
  test("AC5: GF south wall base center (5.5, 0.0, 0.0) in CARTESIAN_POINT", () => {
    // Wall cx=5.5, cy=0., zMin=0.
    expect(text).toMatch(/CARTESIAN_POINT\(''.*5\.5.*0\./);
  });

  test("AC5: GF slab base Z = 0.0 present in output", () => {
    expect(text).toMatch(/CARTESIAN_POINT\(''.*0\.,0\.\)/);
  });

  // Geometry parity — house-scale test
  test("14-element house scene: PRODUCT count == 14", () => {
    const GF_H = 2.8, UF_H = 2.6, T = 0.25, FP_W = 11, FP_D = 8.5;
    const house: IfcSceneElement[] = [
      { mesh: makeBoxMesh(FP_W/2, FP_D/2, 0, FP_W, FP_D, 0.2), creator: "IfcSlab" },
      { mesh: makeBoxMesh(FP_W/2, 0, 0, FP_W, T, GF_H),        creator: "IfcWall" },
      { mesh: makeBoxMesh(FP_W/2, FP_D, 0, FP_W, T, GF_H),     creator: "IfcWall" },
      { mesh: makeBoxMesh(0, FP_D/2, 0, T, FP_D, GF_H),        creator: "IfcWall" },
      { mesh: makeBoxMesh(FP_W, FP_D/2, 0, T, FP_D, GF_H),     creator: "IfcWall" },
      { mesh: makeBoxMesh(4.925, 0, 0, 1.01, T, 2.01),          creator: "IfcDoor" },
      { mesh: makeBoxMesh(1.9, 0, 0.8, 2.0, T, 1.2),            creator: "IfcWindow" },
      { mesh: makeBoxMesh(FP_W/2, FP_D/2, GF_H, FP_W, FP_D, 0.2), creator: "IfcSlab" },
      { mesh: makeBoxMesh(FP_W/2, 0, GF_H, FP_W, T, UF_H),     creator: "IfcWall" },
      { mesh: makeBoxMesh(FP_W/2, FP_D, GF_H, FP_W, T, UF_H),  creator: "IfcWall" },
      { mesh: makeBoxMesh(0, FP_D/2, GF_H, T, FP_D, UF_H),     creator: "IfcWall" },
      { mesh: makeBoxMesh(FP_W, FP_D/2, GF_H, T, FP_D, UF_H),  creator: "IfcWall" },
      { mesh: makeBoxMesh(3.5, 0, GF_H + 0.8, 1.0, T, 1.0),    creator: "IfcWindow" },
      { mesh: makeBoxMesh(7.5, 0, GF_H + 0.8, 1.0, T, 1.0),    creator: "IfcWindow" },
    ];
    const out = new TextDecoder().decode(buildStepScene(house));
    expect(countEntity(out, "PRODUCT")).toBe(14);
    expect(countEntity(out, "EXTRUDED_AREA_SOLID")).toBe(14);
  });
});
