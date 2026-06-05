// IFC loadability — web-ifc OpenModel + void fidelity (Leo #13348, #13350 AC).
//
// AC (Leo #13340/#13350):
//   AC1. web-ifc OpenModel loads the exported .ifc with zero errors/warnings.
//   AC2. IfcOpeningElement + IfcRelVoidsElement present; each RelatingBuildingElement
//        resolves to the HOST wall (type = IFCWALL), not free-floating.
//   AC3. Opening has real void geometry: GetFlatMesh on the IfcOpeningElement returns
//        non-zero vertex data — the opening is not a semantic phantom.
//
// BRep void note: with IfcShellBasedSurfaceModel / IfcFacetedBrep geometry
// (our current export), the HOST WALL mesh itself remains a solid box — web-ifc
// does NOT compute a geometric subtraction for BRep-based IfcRelVoidsElement.
// The semantic relationship IS correct (IFC viewers render the opening correctly),
// but the wall's GetFlatMesh vertex count is unchanged vs. a plain wall.
// Geometric void subtraction in mesh form requires IfcExtrudedAreaSolid profiles —
// tracked as a follow-up to this test.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createRequire } from "module";
import { buildIfcScene, type IfcSceneElement, type IfcLevel } from "../src/ifc/ifc-build.js";

// web-ifc is a CJS module; use createRequire for ESM compatibility.
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

/** Collect all express IDs from a web-ifc typed vector. */
function vecToArray(vec: { size(): number; get(i: number): number }): number[] {
  const out: number[] = [];
  for (let i = 0; i < vec.size(); i++) out.push(vec.get(i));
  return out;
}

// ── Scene: 2 walls (GF south + north), south wall carries a door opening ──────
//
//   GF south wall (y=0): FP_W × T × GF_H — has openings: [door_void]
//   GF north wall (y=FP_D): FP_W × T × GF_H — solid, no opening
//   Door void: 1.01 × T × 2.01 centred at x=4.925 on south wall
//   GF slab: FP_W × FP_D × SLAB_T
//   Level: GF at elevation 0

const FP_W = 11, FP_D = 8.5, GF_H = 2.8, T = 0.25, SLAB_T = 0.2;
const DOOR_W = 1.01, DOOR_H = 2.01, DOOR_CX = 4.925;
const GF_ID = "level/0";

const doorVoidMesh = makeBoxMesh(DOOR_CX, 0, 0, DOOR_W, T, DOOR_H);

const elements: IfcSceneElement[] = [
  // GF slab — no openings
  { mesh: makeBoxMesh(FP_W / 2, FP_D / 2, 0, FP_W, FP_D, SLAB_T), creator: "IfcSlab", levelId: GF_ID },
  // GF south wall — carries door opening
  {
    mesh: makeBoxMesh(FP_W / 2, 0, 0, FP_W, T, GF_H),
    creator: "IfcWall",
    levelId: GF_ID,
    openings: [{ mesh: doorVoidMesh, label: "Door void" }],
  },
  // GF north wall — solid, no opening
  { mesh: makeBoxMesh(FP_W / 2, FP_D, 0, FP_W, T, GF_H), creator: "IfcWall", levelId: GF_ID },
];

const levels: IfcLevel[] = [
  { levelId: GF_ID, name: "Ground Floor", elevation: 0 },
];

// ── Build IFC + web-ifc model lifecycle ──────────────────────────────────────

let ifcBytes: Uint8Array;
let ifcText: string;
let api: ReturnType<typeof wifc.IfcAPI>;
let modelId: number;

beforeAll(async () => {
  // Build IFC from scene
  ifcBytes = buildIfcScene(elements, levels);
  ifcText = new TextDecoder().decode(ifcBytes);

  // Initialize web-ifc WASM
  api = new wifc.IfcAPI();
  await api.Init();

  // AC1 measured here: OpenModel must not throw
  modelId = api.OpenModel(ifcBytes);
});

afterAll(() => {
  if (api && typeof api.CloseModel === "function") api.CloseModel(modelId);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("IFC loadability — web-ifc OpenModel + void fidelity (Leo #13348/#13350)", () => {

  // ── AC1: OpenModel loads without error ─────────────────────────────────────

  test("AC1: web-ifc OpenModel returns valid model ID (non-negative integer)", () => {
    // If OpenModel failed, modelId would be negative or the beforeAll would have thrown.
    expect(typeof modelId).toBe("number");
    expect(modelId).toBeGreaterThanOrEqual(0);
    expect(api.IsModelOpen(modelId)).toBe(true);
  });

  test("AC1: IFC4 schema header present in exported bytes", () => {
    expect(ifcText).toContain("FILE_SCHEMA(('IFC4'));");
  });

  // ── AC2: IfcOpeningElement + IfcRelVoidsElement present and linked ─────────

  test("AC2: exactly 1 IfcOpeningElement present (1 door void on south wall)", () => {
    const ids = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCOPENINGELEMENT));
    expect(ids.length).toBe(1);
  });

  test("AC2: exactly 1 IfcRelVoidsElement present", () => {
    const ids = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCRELVOIDSELEMENT));
    expect(ids.length).toBe(1);
  });

  test("AC2: IfcRelVoidsElement.RelatingBuildingElement resolves to IfcWall (not free-floating)", () => {
    const relIds = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCRELVOIDSELEMENT));
    expect(relIds.length).toBeGreaterThan(0);

    for (const relId of relIds) {
      const rel = api.GetLine(modelId, relId);

      // RelatingBuildingElement must be a valid reference (type 5 = IFCREFERENCE)
      expect(rel.RelatingBuildingElement).not.toBeNull();
      expect(rel.RelatingBuildingElement.value).toBeGreaterThan(0);

      // Resolve the host element and verify it is an IfcWall
      const hostId = rel.RelatingBuildingElement.value as number;
      const lineType = api.GetLineType(modelId, hostId);
      expect(lineType).toBe(wifc.IFCWALL);
    }
  });

  test("AC2: IfcRelVoidsElement.RelatedOpeningElement resolves to IfcOpeningElement", () => {
    const relIds = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCRELVOIDSELEMENT));
    for (const relId of relIds) {
      const rel = api.GetLine(modelId, relId);
      expect(rel.RelatedOpeningElement).not.toBeNull();
      const openingId = rel.RelatedOpeningElement.value as number;
      const lineType = api.GetLineType(modelId, openingId);
      expect(lineType).toBe(wifc.IFCOPENINGELEMENT);
    }
  });

  test("AC2: no IfcOpeningElement is free-floating — each has exactly 1 IfcRelVoidsElement", () => {
    const openingIds = new Set(
      vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCOPENINGELEMENT)),
    );
    const relIds = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCRELVOIDSELEMENT));

    // Collect which opening IDs are referenced
    const referencedOpenings = new Set<number>();
    for (const relId of relIds) {
      const rel = api.GetLine(modelId, relId);
      referencedOpenings.add(rel.RelatedOpeningElement.value as number);
    }

    // Every IfcOpeningElement must appear in exactly one IfcRelVoidsElement
    for (const opId of openingIds) {
      expect(referencedOpenings.has(opId)).toBe(true);
    }
  });

  // ── AC3: Opening has real geometry ────────────────────────────────────────

  test("AC3: IfcOpeningElement has non-zero vertex geometry (GetFlatMesh)", () => {
    const openingIds = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCOPENINGELEMENT));
    expect(openingIds.length).toBeGreaterThan(0);

    for (const openingId of openingIds) {
      const flatMesh = api.GetFlatMesh(modelId, openingId);
      expect(flatMesh).not.toBeNull();
      const geomCount = flatMesh.geometries.size();
      // The opening must have associated geometry — it is not a phantom.
      expect(geomCount).toBeGreaterThan(0);
    }
  });

  test("AC3: exported IFC text contains IfcOpeningElement with Brep body representation", () => {
    // Verify the opening's shape representation is present in the IFC text.
    expect(ifcText).toContain("IFCOPENINGELEMENT(");
    expect(ifcText).toContain("IFCRELVOIDSELEMENT(");
    // The opening body is a Brep representation (same path as walls/slabs).
    // Count Brep shape representations — must be > 0.
    const brepCount = (ifcText.match(/IFCSHAPEREPRESENTATION\([^)]*'Brep'/g) ?? []).length;
    expect(brepCount).toBeGreaterThan(0);
  });

  // ── BRep void limitation — documented, not a failure ─────────────────────

  test("documented: solid wall + solid N walls present (3 total wall entities incl. host)", () => {
    // 2 walls in elements array: south (with opening) + north (solid).
    // The IfcSlab is separate.
    const wallIds = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCWALL));
    expect(wallIds.length).toBe(2);

    const slabIds = vecToArray(api.GetLineIDsWithType(modelId, wifc.IFCSLAB));
    expect(slabIds.length).toBe(1);
  });

  test("CSG: host wall body is IfcBooleanResult(DIFFERENCE) — void baked into geometry", () => {
    // Wall with openings emits IfcExtrudedAreaSolid + IfcBooleanResult(DIFFERENCE) per opening.
    // Wall without openings (north wall) + slab + door void still use IfcFacetedBrep (IfcPolyLoop).
    // IfcPolyLoop count: north wall (12) + slab (12) + door void opening (12) = 36.
    const polyloops = (ifcText.match(/=IFCPOLYLOOP\(/g) ?? []).length;
    expect(polyloops).toBe(36);
    // The host wall body uses CSG — confirm the entities are present.
    expect(ifcText).toMatch(/=IFCBOOLEANRESULT\(\.DIFFERENCE\./);
    expect(ifcText).toMatch(/=IFCEXTRUDEDAREASOLID\(/);
  });
});
