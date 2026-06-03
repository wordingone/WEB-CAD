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
 *   bay_centers_mm=[1016,3048,5080], bay_dividers_mm=[2032,4064].
 * GF: bay0 window cx=1016 w=880 h=915 sill=730; bay1 door cx=3048 w=900 h=2100;
 *     bay2 window cx=5080 w=880 h=915 sill=730.
 * UF: all 3 bays window cx=1016/3048/5080 w=880 h=915 sill=730 (sill_cy=3168mm).
 *   position[2]=2.438 sets floor-elevation override per #485.
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
    // GF fenestration — bay_centers_mm=[1016,3048,5080] from frozen DWG parse
    {
      id: "win_gf_left",
      type: "SdWindow",
      params: {
        position:   { value: [1.016, 0, 0] },
        windowType: { value: "og" },
        width:      { value: 0.880 },
        height:     { value: 0.915 },
        sill:       { value: 0.730 },
      },
    },
    {
      id: "door_gf",
      type: "SdDoor",
      params: {
        position: { value: [3.048, 0, 0] },
        doorType: { value: "front" },
        width:    { value: 0.900 },
        height:   { value: 2.100 },
      },
    },
    {
      id: "win_gf_right",
      type: "SdWindow",
      params: {
        position:   { value: [5.080, 0, 0] },
        windowType: { value: "og" },
        width:      { value: 0.880 },
        height:     { value: 0.915 },
        sill:       { value: 0.730 },
      },
    },
    // UF fenestration — all 3 bays, position[2]=2.438 floor-elevation override (#485)
    {
      id: "win_uf_left",
      type: "SdWindow",
      params: {
        position:   { value: [1.016, 0, 2.438] },
        windowType: { value: "og" },
        width:      { value: 0.880 },
        height:     { value: 0.915 },
        sill:       { value: 0.730 },
      },
    },
    {
      id: "win_uf_ctr",
      type: "SdWindow",
      params: {
        position:   { value: [3.048, 0, 2.438] },
        windowType: { value: "og" },
        width:      { value: 0.880 },
        height:     { value: 0.915 },
        sill:       { value: 0.730 },
      },
    },
    {
      id: "win_uf_right",
      type: "SdWindow",
      params: {
        position:   { value: [5.080, 0, 2.438] },
        windowType: { value: "og" },
        width:      { value: 0.880 },
        height:     { value: 0.915 },
        sill:       { value: 0.730 },
      },
    },
  ],
};

/** All built-in sample defs, keyed by inlineGraphId for easy lookup. */
export const SAMPLE_DEFS: Record<string, GhDefSpec> = {
  [BOX_SAMPLE_DEF.inlineGraphId!]: BOX_SAMPLE_DEF,
  [VILLA_VERDE_DEF.inlineGraphId!]: VILLA_VERDE_DEF,
};
