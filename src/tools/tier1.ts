/**
 * Tier 1 tool surface — 12 ops, Spike A LoRA target vocabulary.
 *
 * Covers ~85% of IfcWallStandardCase, IfcSlab, IfcColumn, IfcBeam,
 * IfcStair (extrude family) and basic openings (cut). See
 * docs/tool-taxonomy.md for the full mapping.
 *
 * The model emits JS source against this surface (free functions named here +
 * fluent methods inherited from replicad's Drawing/Sketch/Solid). Two of the
 * six free functions are NOT direct replicad exports and are composed here:
 *
 *   - `makeBox(w, d, h)` → replicad's `makeBaseBox` (dimension form). Replicad's
 *     own `makeBox` takes two corner points; the dataset uses dimension form.
 *   - `drawLine(p1, p2)` → `draw(p1).lineTo(p2)` (returns a DrawingPen, must
 *     be `.close()`d to produce a Drawing — same shape as `draw().lineTo()`).
 *   - `drawPolyline(pts)` → `draw(pts[0]).lineTo(pts[1])...` chain.
 */

import {
  drawRectangle,
  drawCircle,
  makeBaseBox,
  makeCylinder,
  draw,
  Drawing,
  Sketch,
  Solid,
} from "replicad";

type Pt = [number, number];

// makeBox in the Tier 1 surface = dimension form (width, depth, height).
// Replicad's native `makeBox` takes (corner1, corner2); we want the simpler
// form for a model emitting `makeBox(2, 2, 2)`-style output.
const makeBox: (width: number, depth: number, height: number) => Solid = makeBaseBox;

function drawLine(p1: Pt, p2: Pt) {
  return draw(p1).lineTo(p2);
}

function drawPolyline(points: Pt[]) {
  if (points.length < 2) {
    throw new Error("drawPolyline requires at least 2 points");
  }
  let pen = draw(points[0]);
  for (let i = 1; i < points.length; i++) {
    pen = pen.lineTo(points[i]);
  }
  // Polyline as Tier 1 op = closed profile (extrudable / revolvable). Open pens
  // have no sketchOnPlane; auto-close so drawPolyline output behaves like a
  // primitive shape (same as drawRectangle / drawCircle).
  return pen.close();
}

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
