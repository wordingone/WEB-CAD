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
 * GhDefSpec v0.3 — certified multi-view converged 2026-06-03.
 * W=6.096m, D=7.315m, H_WALL=4.876m, RISE=1.369m, H_TOTAL=6.245m.
 * 12-component graph: SdWall×4, SdBox, SdRoof, SdWindow×5, SdDoor.
 */
export const VILLA_VERDE_DEF: GhDefSpec = {
  inlineGraphId: "villa-verde-typologia-2-v3",
  label: "Villa Verde Typologia 2",
  inputPorts: [
    { name: "unit_width_m",   default: 6.096, min: 4.0,  max: 9.0  },
    { name: "unit_depth_m",   default: 7.315, min: 5.0,  max: 12.0 },
    { name: "floor_height_m", default: 2.438, min: 2.0,  max: 3.2  },
    { name: "n_floors",       default: 2,     min: 1,    max: 3    },
    { name: "roof_rise_m",    default: 1.369, min: 0.5,  max: 3.0  },
    { name: "n_bays",         default: 3,     min: 2,    max: 5    },
    { name: "window_w_m",     default: 0.880, min: 0.4,  max: 1.8  },
    { name: "window_h_m",     default: 0.915, min: 0.4,  max: 1.8  },
    { name: "door_w_m",       default: 0.900, min: 0.7,  max: 1.2  },
  ],
  components: [
    {
      id: "wall_front",
      type: "SdWall",
      params: {
        start:     { value: [0, 0, 0] },
        end:       { value: [6.096, 0, 0] },
        height:    { value: 4.876 },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "wall_back",
      type: "SdWall",
      params: {
        start:     { value: [0, 7.315, 0] },
        end:       { value: [6.096, 7.315, 0] },
        height:    { value: 4.876 },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "wall_left",
      type: "SdWall",
      params: {
        start:     { value: [0, 0, 0] },
        end:       { value: [0, 7.315, 0] },
        height:    { value: 4.876 },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "wall_right",
      type: "SdWall",
      params: {
        start:     { value: [6.096, 0, 0] },
        end:       { value: [6.096, 7.315, 0] },
        height:    { value: 4.876 },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "floor_band",
      type: "SdBox",
      params: {
        width:  { value: 6.096 },
        depth:  { value: 7.315 },
        height: { value: 0.12 },
        center: { value: [3.048, 3.6575, 2.438] },
      },
    },
    {
      id: "roof",
      type: "SdRoof",
      params: {
        roofType:  { value: "pitched" },
        footprint: { value: [[0,0],[6.096,0],[6.096,7.315],[0,7.315]] },
        rise:      { portRef: "roof_rise_m" },
      },
    },
    {
      id: "win_gf_left",
      type: "SdWindow",
      params: {
        position:   { value: [1.016, 0, 0] },
        windowType: { value: "og" },
        width:      { portRef: "window_w_m" },
        height:     { portRef: "window_h_m" },
        sill:       { value: 0.730 },
      },
    },
    {
      id: "door_gf",
      type: "SdDoor",
      params: {
        position: { value: [3.048, 0, 0] },
        doorType: { value: "front" },
        width:    { portRef: "door_w_m" },
        height:   { value: 2.100 },
      },
    },
    {
      id: "win_gf_right",
      type: "SdWindow",
      params: {
        position:   { value: [5.080, 0, 0] },
        windowType: { value: "og" },
        width:      { portRef: "window_w_m" },
        height:     { portRef: "window_h_m" },
        sill:       { value: 0.730 },
      },
    },
    {
      id: "win_uf_left",
      type: "SdWindow",
      params: {
        position:   { value: [1.016, 0, 2.438] },
        windowType: { value: "og" },
        width:      { portRef: "window_w_m" },
        height:     { portRef: "window_h_m" },
        sill:       { value: 0.730 },
      },
    },
    {
      id: "win_uf_ctr",
      type: "SdWindow",
      params: {
        position:   { value: [3.048, 0, 2.438] },
        windowType: { value: "og" },
        width:      { portRef: "window_w_m" },
        height:     { portRef: "window_h_m" },
        sill:       { value: 0.730 },
      },
    },
    {
      id: "win_uf_right",
      type: "SdWindow",
      params: {
        position:   { value: [5.080, 0, 2.438] },
        windowType: { value: "og" },
        width:      { portRef: "window_w_m" },
        height:     { portRef: "window_h_m" },
        sill:       { value: 0.730 },
      },
    },
  ],
};

/**
 * WikiHouse Skylark 250 M — 1-storey, 42° gable roof.
 * GhDefSpec v0.3 — certified multi-view converged 2026-06-03.
 * W=5.436m, D=7.200m, H_WALL=2.400m, RISE=2.161m, H_TOTAL=4.561m.
 * 8-component graph: SdWall×4, SdRoof, SdWindow×2, SdDoor.
 */
export const WIKIHOUSE_SKYLARK_DEF: GhDefSpec = {
  inlineGraphId: "wikihouse-skylark-250-m-v3",
  label: "WikiHouse Skylark 250 M",
  inputPorts: [
    { name: "external_width_m", default: 5.436, min: 4.8,  max: 7.2  },
    { name: "wall_height_m",    default: 2.400, min: 1.8,  max: 3.0  },
    { name: "gable_rise_m",     default: 2.161, min: 1.5,  max: 3.0  },
    { name: "depth_m",          default: 7.200, min: 3.6,  max: 14.4 },
    { name: "door_cx_m",        default: 2.718, min: 0.918, max: 4.518 },
    { name: "door_w_m",         default: 1.200, min: 0.6,  max: 2.4  },
    { name: "win_cx_left_m",    default: 1.518, min: 0.918, max: 2.718 },
    { name: "win_cx_right_m",   default: 3.918, min: 2.718, max: 4.518 },
    { name: "win_size_m",       default: 1.200, min: 0.6,  max: 1.8  },
    { name: "win_sill_m",       default: 0.900, min: 0.6,  max: 1.2  },
  ],
  components: [
    {
      id: "wall_front",
      type: "SdWall",
      params: {
        start:     { value: [0, 0, 0] },
        end:       { value: [5.436, 0, 0] },
        height:    { value: 2.400 },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "wall_back",
      type: "SdWall",
      params: {
        start:     { value: [0, 7.200, 0] },
        end:       { value: [5.436, 7.200, 0] },
        height:    { value: 2.400 },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "wall_left",
      type: "SdWall",
      params: {
        start:     { value: [0, 0, 0] },
        end:       { value: [0, 7.200, 0] },
        height:    { value: 2.400 },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "wall_right",
      type: "SdWall",
      params: {
        start:     { value: [5.436, 0, 0] },
        end:       { value: [5.436, 7.200, 0] },
        height:    { value: 2.400 },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "roof",
      type: "SdRoof",
      params: {
        roofType:  { value: "pitched" },
        footprint: { value: [[0,0],[5.436,0],[5.436,7.200],[0,7.200]] },
        rise:      { portRef: "gable_rise_m" },
      },
    },
    {
      id: "win_left",
      type: "SdWindow",
      params: {
        position:   { value: [1.518, 0, 0] },
        windowType: { value: "og" },
        width:      { portRef: "win_size_m" },
        height:     { portRef: "win_size_m" },
        sill:       { portRef: "win_sill_m" },
      },
    },
    {
      id: "door_gf",
      type: "SdDoor",
      params: {
        position: { value: [2.718, 0, 0] },
        doorType: { value: "front" },
        width:    { portRef: "door_w_m" },
        height:   { value: 2.100 },
      },
    },
    {
      id: "win_right",
      type: "SdWindow",
      params: {
        position:   { value: [3.918, 0, 0] },
        windowType: { value: "og" },
        width:      { portRef: "win_size_m" },
        height:     { portRef: "win_size_m" },
        sill:       { portRef: "win_sill_m" },
      },
    },
  ],
};

/**
 * Quinta Monroy Housing — ELEMENTAL (Aravena), Iquique Chile 2004.
 * GhDefSpec v0.3 — certified multi-view converged 2026-06-03.
 * W=6.0m, D=6.048m, H_WALL=7.28m, PARAPET=0.18m, H_TOTAL=7.46m. Flat roof.
 * 11-component graph: SdWall×4, SdBox×3, SdRoof, SdDoor, SdWindow×2.
 */
export const QUINTA_MONROY_DEF: GhDefSpec = {
  inlineGraphId: "quinta-monroy-v3",
  label: "Quinta Monroy",
  inputPorts: [
    { name: "unit_width_m",     default: 6.000,  min: 4.0,  max: 9.0  },
    { name: "unit_depth_m",     default: 6.048,  min: 4.0,  max: 10.0 },
    { name: "floor_1_height_m", default: 2.340,  min: 2.0,  max: 3.2  },
    { name: "floor_2_height_m", default: 2.340,  min: 2.0,  max: 3.2  },
    { name: "floor_3_height_m", default: 2.600,  min: 2.0,  max: 3.5  },
    { name: "parapet_height_m", default: 0.180,  min: 0.1,  max: 0.5  },
    { name: "window_w_m",       default: 0.660,  min: 0.4,  max: 1.2  },
    { name: "window_h_m",       default: 1.400,  min: 0.6,  max: 2.0  },
    { name: "door_w_m",         default: 0.900,  min: 0.7,  max: 1.2  },
  ],
  components: [
    {
      id: "wall_front",
      type: "SdWall",
      params: {
        start:     { value: [0, 0, 0] },
        end:       { value: [6.0, 0, 0] },
        height:    { value: 7.28 },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "wall_back",
      type: "SdWall",
      params: {
        start:     { value: [0, 6.048, 0] },
        end:       { value: [6.0, 6.048, 0] },
        height:    { value: 7.28 },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "wall_left",
      type: "SdWall",
      params: {
        start:     { value: [0, 0, 0] },
        end:       { value: [0, 6.048, 0] },
        height:    { value: 7.28 },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "wall_right",
      type: "SdWall",
      params: {
        start:     { value: [6.0, 0, 0] },
        end:       { value: [6.0, 6.048, 0] },
        height:    { value: 7.28 },
        thickness: { value: 0.2 },
      },
    },
    {
      id: "parapet",
      type: "SdBox",
      params: {
        width:  { value: 6.0 },
        depth:  { value: 6.048 },
        height: { value: 0.18 },
        center: { value: [3.0, 3.024, 7.37] },
      },
    },
    {
      id: "roof",
      type: "SdRoof",
      params: {
        roofType:  { value: "flat" },
        footprint: { value: [[0,0],[6.0,0],[6.0,6.048],[0,6.048]] },
        rise:      { value: 0 },
      },
    },
    {
      id: "floor_band_f2",
      type: "SdBox",
      params: {
        width:  { value: 6.0 },
        depth:  { value: 6.048 },
        height: { value: 0.12 },
        center: { value: [3.0, 3.024, 2.34] },
      },
    },
    {
      id: "floor_band_f3",
      type: "SdBox",
      params: {
        width:  { value: 6.0 },
        depth:  { value: 6.048 },
        height: { value: 0.12 },
        center: { value: [3.0, 3.024, 4.68] },
      },
    },
    {
      id: "door_gf",
      type: "SdDoor",
      params: {
        position: { value: [1.5, 0, 0] },
        doorType: { value: "P2" },
        width:    { portRef: "door_w_m" },
        height:   { value: 2.10 },
      },
    },
    {
      id: "win_gf_v1",
      type: "SdWindow",
      params: {
        position:   { value: [4.5, 0, 0] },
        windowType: { value: "V1" },
        width:      { portRef: "window_w_m" },
        height:     { portRef: "window_h_m" },
        sill:       { value: 0.60 },
      },
    },
    {
      id: "win_f2_v1",
      type: "SdWindow",
      params: {
        position:   { value: [3.0, 0, 2.34] },
        windowType: { value: "V1" },
        width:      { portRef: "window_w_m" },
        height:     { portRef: "window_h_m" },
        sill:       { value: 0.60 },
      },
    },
    {
      id: "win_f3_v1",
      type: "SdWindow",
      params: {
        position:   { value: [3.0, 0, 4.68] },
        windowType: { value: "V1" },
        width:      { portRef: "window_w_m" },
        height:     { portRef: "window_h_m" },
        sill:       { value: 0.60 },
      },
    },
  ],
};

/** All built-in sample defs, keyed by inlineGraphId for easy lookup. */
export const SAMPLE_DEFS: Record<string, GhDefSpec> = {
  [BOX_SAMPLE_DEF.inlineGraphId!]: BOX_SAMPLE_DEF,
  [VILLA_VERDE_DEF.inlineGraphId!]: VILLA_VERDE_DEF,
  [WIKIHOUSE_SKYLARK_DEF.inlineGraphId!]: WIKIHOUSE_SKYLARK_DEF,
  [QUINTA_MONROY_DEF.inlineGraphId!]: QUINTA_MONROY_DEF,
};

/** Certified v0.3 building defs — appear in the Skills tab "Buildings" section. */
export const BUILDING_DEFS: GhDefSpec[] = [
  VILLA_VERDE_DEF,
  WIKIHOUSE_SKYLARK_DEF,
  QUINTA_MONROY_DEF,
];
