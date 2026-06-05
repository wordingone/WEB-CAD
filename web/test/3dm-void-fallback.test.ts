// 3dm-void-fallback.test.ts — unit tests for #493: AABB opening reconstruction
// after .3dm round-trip.
//
// Verifies AC (Leo #13409/#13422):
//   AC1. populateOpenings detects wall/window AABB overlap → wall.openings populated
//   AC2. Non-overlapping window does NOT pollute wall.openings
//   AC3. creator strings written by export3dm (e.g. "wall","window") survive
//        CREATOR_IFC_CLASS normalisation inside populateOpenings

import { describe, test, expect } from "bun:test";
import { populateOpenings } from "../src/ifc/ifc-build.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function boxMesh(
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("3dm void fallback — AABB opening reconstruction (Leo #13409/#13422)", () => {

  // GF south wall: 11m × 0.25m × 2.8m at y=0
  const wallMesh = boxMesh(5.5, 0, 0, 11, 0.25, 2.8);
  // Window: 2.0m × 0.25m × 1.2m sill=0.8m, overlapping the same wall face
  const winMesh = boxMesh(1.9, 0, 0.8, 2.0, 0.25, 1.2);
  // Far window: same size but at y=10 (no overlap with wall at y=0)
  const farWinMesh = boxMesh(1.9, 10, 0.8, 2.0, 0.25, 1.2);

  // AC1: overlapping window → wall gets openings[]
  test("AC1: window AABB overlapping wall — wall.openings populated", () => {
    const elements = [
      { mesh: wallMesh, creator: "wall" },
      { mesh: winMesh,  creator: "window" },
    ];
    const enriched = populateOpenings(elements);
    const wallEl = enriched.find(e => e.creator === "IfcWall");
    expect(wallEl).toBeDefined();
    expect(wallEl?.openings).toBeDefined();
    expect(wallEl!.openings!.length).toBeGreaterThan(0);
  });

  // AC2: non-overlapping window → wall has no openings
  test("AC2: window AABB not overlapping wall — wall.openings absent", () => {
    const elements = [
      { mesh: wallMesh,    creator: "wall" },
      { mesh: farWinMesh,  creator: "window" },
    ];
    const enriched = populateOpenings(elements);
    const wallEl = enriched.find(e => e.creator === "IfcWall");
    expect(wallEl).toBeDefined();
    expect(wallEl?.openings ?? []).toHaveLength(0);
  });

  // AC3: creator normalisation — lowercase "wall"/"window" → IfcWall/IfcWindow
  test("AC3: creator strings normalised to IfcWall / IfcWindow", () => {
    const elements = [
      { mesh: wallMesh, creator: "wall" },
      { mesh: winMesh,  creator: "window" },
    ];
    const enriched = populateOpenings(elements);
    expect(enriched.map(e => e.creator)).toContain("IfcWall");
    expect(enriched.map(e => e.creator)).toContain("IfcWindow");
  });

  // AC1-extended: two windows, both overlapping → both registered on wall
  test("AC1-ext: two overlapping windows → wall.openings.length === 2", () => {
    const winMesh2 = boxMesh(5.5, 0, 0.8, 2.0, 0.25, 1.2);
    const elements = [
      { mesh: wallMesh, creator: "wall" },
      { mesh: winMesh,  creator: "window" },
      { mesh: winMesh2, creator: "window" },
    ];
    const enriched = populateOpenings(elements);
    const wallEl = enriched.find(e => e.creator === "IfcWall");
    expect(wallEl!.openings!.length).toBe(2);
  });
});
