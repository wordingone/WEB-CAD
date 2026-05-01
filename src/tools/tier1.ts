/**
 * Tier 1 tool surface — 12 ops, Spike A LoRA target vocabulary.
 *
 * Covers ~85% of IfcWallStandardCase, IfcSlab, IfcColumn, IfcBeam,
 * IfcStair (extrude family) and basic openings (cut). See
 * docs/tool-taxonomy.md for the full mapping.
 *
 * Ops are exposed as fluent-style replicad re-exports; the model emits
 * JS source against this surface, NOT against raw replicad.
 */

import {
  drawRectangle,
  drawCircle,
  drawLine,
  drawPolyline,
  makeBox,
  makeCylinder,
  Drawing,
  Sketch,
  Solid,
} from "replicad";

export {
  // primitives
  makeBox,
  makeCylinder,

  // 2D drawing
  drawRectangle,
  drawCircle,
  drawLine,
  drawPolyline,

  // types
  Drawing,
  Sketch,
  Solid,
};

/**
 * Tier 1 op names — used by the syntax-validator to whitelist which
 * symbols the model can reference. ReferenceError on anything outside
 * this list = "unknown_api" reason code in Spike A error classification.
 */
export const TIER1_OPS = [
  // primitives
  "makeBox",
  "makeCylinder",
  // 2D drawing
  "drawRectangle",
  "drawCircle",
  "drawLine",
  "drawPolyline",
  // sketch transitions
  "sketchOnPlane",
  // surface ops
  "extrude",
  "revolve",
  // Boolean
  "fuse",
  "cut",
  // transforms
  "translate",
  "rotate",
] as const;

export type Tier1Op = typeof TIER1_OPS[number];
