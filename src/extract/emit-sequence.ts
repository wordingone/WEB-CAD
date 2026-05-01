/**
 * Translate an extracted IFC representation into a replicad fluent-JS
 * source string.
 *
 * Output is the canonical training-target format for Spike A LoRA:
 * fluent JS source against the Tier 1 surface. See
 * docs/training-pair-format.md.
 */

import type { ExtractedRepresentation, PlacementChain } from "./walk-representation.js";

export function emitReplicadSequence(
  varName: string,
  repr: ExtractedRepresentation
): string {
  const placementSuffix = emitPlacement(repr.placement);

  switch (repr.kind) {
    case "extruded_rectangle":
      return `const ${varName} = drawRectangle(${num(repr.width)}, ${num(repr.height)}).sketchOnPlane("XY").extrude(${num(repr.depth)})${placementSuffix};`;

    case "extruded_circle":
      return `const ${varName} = drawCircle(${num(repr.radius)}).sketchOnPlane("XY").extrude(${num(repr.depth)})${placementSuffix};`;

    case "extruded_polyline": {
      const pts = repr.points
        .map(([x, y]) => `[${num(x)}, ${num(y)}]`)
        .join(", ");
      return `const ${varName} = drawPolyline([${pts}]).close().sketchOnPlane("XY").extrude(${num(repr.depth)})${placementSuffix};`;
    }
  }
}

function emitPlacement(p: PlacementChain): string {
  let s = "";
  const [tx, ty, tz] = p.translation;
  if (tx !== 0 || ty !== 0 || tz !== 0) {
    s += `.translate([${num(tx)}, ${num(ty)}, ${num(tz)}])`;
  }
  if (p.rotation) {
    const [ax, ay, az] = p.rotation.axis;
    s += `.rotate(${num(p.rotation.angle)}, [${num(ax)}, ${num(ay)}, ${num(az)}])`;
  }
  return s;
}

function num(n: number): string {
  // Strip trailing zeros: 5.000 → 5; preserve precision for fractional.
  const rounded = Math.round(n * 1e4) / 1e4;
  return rounded.toString();
}
