// IFC export-pipeline openings — populateOpenings() integration test.
//
// Verify AC (Leo #13354): export the actual 2-storey house with production-style
// lowercase creator strings (as sceneElementsForExport() produces from the builders),
// apply populateOpenings(), export to IFC, load with web-ifc, and assert:
//   - IfcRelVoidsElement count = total door+window elements (4 for this house)
//   - Each RelatingBuildingElement resolves to IFCWALL (not free-floating)
//   - Each RelatedOpeningElement resolves to IFCOPENINGELEMENT
//   - Zero orphaned IfcOpeningElements
//
// Also verifies that creator normalisation works: "wall" → "IfcWall" etc.
// so no IFCBUILDINGELEMENTPROXY appears for standard structural elements.
//
// House: 11×8.5m footprint, GF 2.8m / UF 2.6m — native-house-replay.json geometry.
// 14 scene elements: 8 walls + 2 slabs + 1 door + 3 windows across 2 levels.
// Void assignment after populateOpenings():
//   GF south wall (y=0): door-void + GF-window-void (2 IfcRelVoidsElement)
//   UF south wall (y=0, z=GF_H): UF-window-1-void + UF-window-2-void (2 IfcRelVoidsElement)
//   All other walls: no openings
// Total expected: 4 IfcRelVoidsElement.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createRequire } from "module";
import { buildIfcScene, populateOpenings, CREATOR_IFC_CLASS, type IfcSceneElement, type IfcLevel } from "../src/ifc/ifc-build.js";

const _require = createRequire(import.meta.url);
const wifc = _require("../../node_modules/web-ifc/web-ifc-api-node.js");

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

function vecToArray(vec: { size(): number; get(i: number): number }): number[] {
  const out: number[] = [];
  for (let i = 0; i < vec.size(); i++) out.push(vec.get(i));
  return out;
}

// ── House scene — LOWERCASE creators (production sceneElementsForExport() output) ──
// Builders in structural.ts / openings.ts set userData.creator = "wall", "door", etc.

const GF_H = 2.8, UF_H = 2.6, T = 0.25, SLAB_T = 0.2;
const FP_W = 11, FP_D = 8.5;
const GF = "level/0", UF = "level/1";

// Raw elements as sceneElementsForExport() would return them (lowercase creators).
const rawElements: IfcSceneElement[] = [
  // Ground floor
  { mesh: makeBoxMesh(FP_W / 2, FP_D / 2, 0, FP_W, FP_D, SLAB_T), creator: "slab",   levelId: GF },
  { mesh: makeBoxMesh(FP_W / 2, 0,         0, FP_W, T,    GF_H  ), creator: "wall",   levelId: GF }, // south
  { mesh: makeBoxMesh(FP_W / 2, FP_D,      0, FP_W, T,    GF_H  ), creator: "wall",   levelId: GF }, // north
  { mesh: makeBoxMesh(0,        FP_D / 2,  0, T,    FP_D, GF_H  ), creator: "wall",   levelId: GF }, // west
  { mesh: makeBoxMesh(FP_W,     FP_D / 2,  0, T,    FP_D, GF_H  ), creator: "wall",   levelId: GF }, // east
  { mesh: makeBoxMesh(4.925,    0,          0, 1.01, T,    2.01  ), creator: "door",   levelId: GF }, // GF door
  { mesh: makeBoxMesh(1.9,      0,          0.8, 2.0, T,    1.2  ), creator: "window", levelId: GF }, // GF window
  // Upper floor
  { mesh: makeBoxMesh(FP_W / 2, FP_D / 2, GF_H, FP_W, FP_D, SLAB_T), creator: "slab",   levelId: UF },
  { mesh: makeBoxMesh(FP_W / 2, 0,        GF_H, FP_W, T,    UF_H  ), creator: "wall",   levelId: UF }, // UF south
  { mesh: makeBoxMesh(FP_W / 2, FP_D,     GF_H, FP_W, T,    UF_H  ), creator: "wall",   levelId: UF }, // UF north
  { mesh: makeBoxMesh(0,        FP_D / 2, GF_H, T,    FP_D, UF_H  ), creator: "wall",   levelId: UF }, // UF west
  { mesh: makeBoxMesh(FP_W,     FP_D / 2, GF_H, T,    FP_D, UF_H  ), creator: "wall",   levelId: UF }, // UF east
  { mesh: makeBoxMesh(5.5,      0,        GF_H + 0.9, 1.0, T, 1.0 ), creator: "window", levelId: UF }, // UF window 1
  { mesh: makeBoxMesh(5.5,      0,        GF_H + 0.9, 1.0, T, 1.0 ), creator: "window", levelId: UF }, // UF window 2
];

const levels: IfcLevel[] = [
  { levelId: GF, name: "Ground Floor", elevation: 0 },
  { levelId: UF, name: "Upper Floor",  elevation: GF_H },
];

// Apply production fix: normalise creators + populate openings.
const enrichedElements = populateOpenings(rawElements);

// Build IFC from enriched elements.
const ifcBytes = buildIfcScene(enrichedElements, levels);
const ifcText  = new TextDecoder().decode(ifcBytes);

// ── web-ifc lifecycle ─────────────────────────────────────────────────────────

let api: ReturnType<typeof wifc.IfcAPI>;
let modelId: number;

beforeAll(async () => {
  api = new wifc.IfcAPI();
  await api.Init();
  modelId = api.OpenModel(ifcBytes);
});

afterAll(() => {
  if (api && typeof api.CloseModel === "function") api.CloseModel(modelId);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("IFC export-pipeline openings — populateOpenings() integration (Leo #13354)", () => {

  // ── CREATOR_IFC_CLASS normalization ──────────────────────────────────────

  test("CREATOR_IFC_CLASS covers all builder creator strings used in the house", () => {
    expect(CREATOR_IFC_CLASS.wall).toBe("IfcWall");
    expect(CREATOR_IFC_CLASS.slab).toBe("IfcSlab");
    expect(CREATOR_IFC_CLASS.door).toBe("IfcDoor");
    expect(CREATOR_IFC_CLASS.window).toBe("IfcWindow");
  });

  test("populateOpenings normalises creator strings: raw 'wall' → 'IfcWall' in enriched elements", () => {
    const rawWallCreators = rawElements.filter(e => e.creator === "wall").length;
    const enrichedWallCreators = enrichedElements.filter(e => e.creator === "IfcWall").length;
    expect(rawWallCreators).toBeGreaterThan(0);
    expect(enrichedWallCreators).toBe(rawWallCreators);
  });

  test("no IFCBUILDINGELEMENTPROXY — all standard elements map to named IFC4 types", () => {
    const proxyCount = (ifcText.match(/=IFCBUILDINGELEMENTPROXY\(/g) ?? []).length;
    expect(proxyCount).toBe(0);
  });

  // ── Void assignment ───────────────────────────────────────────────────────

  test("GF south wall carries 2 openings: door + window", () => {
    // After populateOpenings, rawElements[1] (GF south wall, y=0) should have 2 openings.
    const gfSouthWall = enrichedElements[1];
    expect(gfSouthWall.creator).toBe("IfcWall");
    expect(gfSouthWall.openings?.length).toBe(2); // door + window
  });

  test("UF south wall carries 2 openings: UF window 1 + UF window 2", () => {
    const ufSouthWall = enrichedElements[8];
    expect(ufSouthWall.creator).toBe("IfcWall");
    expect(ufSouthWall.openings?.length).toBe(2); // 2 UF windows
  });

  test("non-south walls carry no openings", () => {
    // GF north, west, east walls (indices 2, 3, 4)
    for (const idx of [2, 3, 4]) {
      expect(enrichedElements[idx].openings ?? []).toHaveLength(0);
    }
    // UF north, west, east walls (indices 9, 10, 11)
    for (const idx of [9, 10, 11]) {
      expect(enrichedElements[idx].openings ?? []).toHaveLength(0);
    }
  });

  // ── web-ifc: verify AC (Leo #13354) ──────────────────────────────────────

  test("web-ifc OpenModel: valid model ID, zero-error load", () => {
    expect(typeof modelId).toBe("number");
    expect(modelId).toBeGreaterThanOrEqual(0);
    expect(api.IsModelOpen(modelId)).toBe(true);
  });

  test("IfcRelVoidsElement count = 4 (1 door + 1 GF-window + 2 UF-windows)", () => {
    const relIds = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCRELVOIDSELEMENT));
    expect(relIds.length).toBe(4);
  });

  test("every IfcRelVoidsElement.RelatingBuildingElement resolves to IFCWALL", () => {
    const relIds = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCRELVOIDSELEMENT));
    for (const relId of relIds) {
      const rel = api.GetLine(modelId, relId);
      const hostType = api.GetLineType(modelId, rel.RelatingBuildingElement.value as number);
      expect(hostType).toBe(wifc.IFCWALL);
    }
  });

  test("every IfcRelVoidsElement.RelatedOpeningElement resolves to IFCOPENINGELEMENT", () => {
    const relIds = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCRELVOIDSELEMENT));
    for (const relId of relIds) {
      const rel = api.GetLine(modelId, relId);
      const opType = api.GetLineType(modelId, rel.RelatedOpeningElement.value as number);
      expect(opType).toBe(wifc.IFCOPENINGELEMENT);
    }
  });

  test("zero orphaned IfcOpeningElements — every opening referenced by exactly one IfcRelVoidsElement", () => {
    const openingIds = new Set(vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCOPENINGELEMENT)));
    const relIds = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCRELVOIDSELEMENT));
    const referenced = new Set(relIds.map((rid) => {
      const rel = api.GetLine(modelId, rid);
      return rel.RelatedOpeningElement.value as number;
    }));
    // Every IfcOpeningElement must appear in exactly one IfcRelVoidsElement.
    for (const opId of openingIds) {
      expect(referenced.has(opId)).toBe(true);
    }
    expect(openingIds.size).toBe(referenced.size);
  });

  test("4 IfcOpeningElements present (1 per door/window element)", () => {
    const count = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCOPENINGELEMENT)).length;
    expect(count).toBe(4);
  });

  test("8 IfcWall + 2 IfcSlab + 1 IfcDoor + 3 IfcWindow (ZERO proxies)", () => {
    const walls   = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCWALL)).length;
    const slabs   = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCSLAB)).length;
    const doors   = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCDOOR)).length;
    const windows = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCWINDOW)).length;
    const proxies = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCBUILDINGELEMENTPROXY)).length;
    expect(walls).toBe(8);
    expect(slabs).toBe(2);
    expect(doors).toBe(1);
    expect(windows).toBe(3);
    expect(proxies).toBe(0);
  });

  test("CSG bake: GF south wall GetFlatMesh has more triangles than a plain box (void subtracted)", () => {
    // GF south wall (enrichedElements[1]) has 2 openings → IfcBooleanResult bakes the void into geometry.
    // A plain box has 12 triangles. After subtracting 2 openings the mesh must have substantially more.
    const wallIds = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCWALL));
    // Find the GF south wall by iterating GetFlatMesh; south wall is the largest by index count.
    let maxTris = 0;
    for (const wid of wallIds) {
      const flatMesh = api.GetFlatMesh(modelId, wid);
      let tris = 0;
      for (let gi = 0; gi < flatMesh.geometries.size(); gi++) {
        const geomEntry = flatMesh.geometries.get(gi);
        const geom = api.GetGeometry(modelId, geomEntry.geometryExpressID);
        const idxBuf = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        tris += idxBuf.length / 3;
        geom.delete();
      }
      if (tris > maxTris) maxTris = tris;
    }
    // The wall with 2 openings must have significantly more triangles than a plain box (12).
    expect(maxTris).toBeGreaterThan(24);
  });
});
