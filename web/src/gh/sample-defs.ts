// sample-defs.ts — Hand-authored sample GH definitions for testing and demos.
// These are the first end-to-end test cases for the client-side GH evaluator (#480).

import type { GhDefSpec } from "./gh-def-ingester";

/** Box parametrised by width, height, depth — the canonical #480 smoke-test def. */
export const BOX_SAMPLE_DEF: GhDefSpec = {
  inlineGraphId: "sample:box-from-params",
  label: "Box from W/H/D",
  inputPorts: [
    { name: "w", min: 0.1, max: 20, default: 5 },
    { name: "h", min: 0.1, max: 10, default: 3 },
    { name: "d", min: 0.1, max: 20, default: 5 },
  ],
  components: [
    {
      id: "box1",
      type: "SdBox",
      params: {
        width:  { portRef: "w" },
        height: { portRef: "h" },
        depth:  { portRef: "d" },
      },
    },
  ],
};

/**
 * Villa Verde Typologia 2 — ELEMENTAL / Alejandro Aravena, Constitución 2013.
 * Dims from frozen target_spec.json (rhino/exports/house_villa_verde/target_spec.json):
 *   w=6096mm, d=7315mm, floor_h=2438mm, wall_h=4876mm, pitch=24.2° (45% slope).
 *   window 940×915mm, sill 730mm, 3 bays @ 2032mm.
 * Four SdWall components let SdRoof auto-detect the 4.876m eave offset.
 * Floor-band SdBox at z=2.438m makes the storey split visible in elevation.
 * Fenestration: GF 2×SdWindow(og) + 1×SdDoor(front) at bay centres;
 *   UF 2×SdWindow(og) using position[2]=2.438 floor-elevation override (#485).
 */
export const VILLA_VERDE_DEF: GhDefSpec = {
  inlineGraphId: "sample:villa-verde-v1",
  label: "Villa Verde Typologia 2",
  inputPorts: [
    { name: "w",      min: 4.0,  max: 10.0, default: 6.096 },
    { name: "d",      min: 4.0,  max: 12.0, default: 7.315 },
    { name: "wall_h", min: 3.0,  max: 7.0,  default: 4.876 },
    { name: "pitch",  min: 10.0, max: 45.0, default: 24.2  },
  ],
  components: [
    // Perimeter walls — SdRoof infers eave height from these
    {
      id: "wall_front",
      type: "SdWall",
      params: {
        start:     { value: [0,     0,     0] },
        end:       { value: [6.096, 0,     0] },
        height:    { portRef: "wall_h" },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "wall_back",
      type: "SdWall",
      params: {
        start:     { value: [0,     7.315, 0] },
        end:       { value: [6.096, 7.315, 0] },
        height:    { portRef: "wall_h" },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "wall_left",
      type: "SdWall",
      params: {
        start:     { value: [0, 0,     0] },
        end:       { value: [0, 7.315, 0] },
        height:    { portRef: "wall_h" },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "wall_right",
      type: "SdWall",
      params: {
        start:     { value: [6.096, 0,     0] },
        end:       { value: [6.096, 7.315, 0] },
        height:    { portRef: "wall_h" },
        thickness: { value: 0.2 },
      },
    },
    // Thin slab at first-floor level — makes storey split visible in front elevation
    {
      id: "floor_band",
      type: "SdBox",
      params: {
        width:  { value: 6.5 },
        depth:  { value: 7.5 },
        height: { value: 0.15 },
        center: { value: [3.048, 3.6575, 2.438] },
      },
    },
    // Gable roof — SdRoof auto-positions at 4.876m eave via wall traversal
    {
      id: "roof",
      type: "SdRoof",
      params: {
        roofType:  { value: "pitched" },
        footprint: { value: [[0, 0], [6.096, 0], [6.096, 7.315], [0, 7.315]] },
        pitchDeg:  { portRef: "pitch" },
      },
    },
    // GF fenestration — 3-bay rhythm: bay1=window, bay2=door, bay3=window
    // Bay centres: 1.016m, 3.048m, 5.080m (3 × 2.032m = 6.096m)
    {
      id: "win_gf_left",
      type: "SdWindow",
      params: {
        position:   { value: [1.016, 0, 0] },
        windowType: { value: "og" },
      },
    },
    {
      id: "door_gf",
      type: "SdDoor",
      params: {
        position: { value: [3.048, 0, 0] },
        doorType: { value: "front" },
      },
    },
    {
      id: "win_gf_right",
      type: "SdWindow",
      params: {
        position:   { value: [5.080, 0, 0] },
        windowType: { value: "og" },
      },
    },
    // UF fenestration — position[2]=2.438 sets floor elevation override (#485)
    {
      id: "win_uf_left",
      type: "SdWindow",
      params: {
        position:   { value: [1.016, 0, 2.438] },
        windowType: { value: "og" },
      },
    },
    {
      id: "win_uf_right",
      type: "SdWindow",
      params: {
        position:   { value: [5.080, 0, 2.438] },
        windowType: { value: "og" },
      },
    },
  ],
};

/** All built-in sample defs, keyed by inlineGraphId for easy lookup. */
export const SAMPLE_DEFS: Record<string, GhDefSpec> = {
  [BOX_SAMPLE_DEF.inlineGraphId!]: BOX_SAMPLE_DEF,
  [VILLA_VERDE_DEF.inlineGraphId!]: VILLA_VERDE_DEF,
};
