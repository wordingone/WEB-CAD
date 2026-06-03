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
 * Four SdWall components let SdRoof auto-detect the 4.876m eave offset.
 * Floor-band SdBox at z=2.438m makes the storey split visible in elevation.
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
  ],
};

/** All built-in sample defs, keyed by inlineGraphId for easy lookup. */
export const SAMPLE_DEFS: Record<string, GhDefSpec> = {
  [BOX_SAMPLE_DEF.inlineGraphId!]: BOX_SAMPLE_DEF,
  [VILLA_VERDE_DEF.inlineGraphId!]: VILLA_VERDE_DEF,
};
