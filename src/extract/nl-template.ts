/**
 * NL description templating — produce variation across templates so the
 * model doesn't overfit to a single phrasing.
 *
 * Spike A: 3 template variants per IFC element, randomized at sample
 * generation time. Inputs are the IFC entity attributes + extracted
 * representation.
 */

import type { ExtractedRepresentation } from "./walk-representation.js";

export interface NLContext {
  elementType: string;       // e.g. "IfcWallStandardCase"
  predefinedType?: string;   // e.g. "STANDARD"
  name?: string;             // IFC Name attribute
  storey?: string;           // resolved storey name
  loadBearing?: boolean;     // Pset_WallCommon.LoadBearing
  fireRating?: string;       // Pset_WallCommon.FireRating
  isExternal?: boolean;
  material?: string;
  representation: ExtractedRepresentation;
}

export function renderNL(ctx: NLContext, seed: number = 0): string {
  const templates = templatesFor(ctx);
  return templates[seed % templates.length];
}

export function renderAllVariants(ctx: NLContext): string[] {
  return templatesFor(ctx);
}

function templatesFor(ctx: NLContext): string[] {
  const r = ctx.representation;

  if (ctx.elementType.includes("Wall")) {
    if (r.kind === "extruded_rectangle") {
      const len = r.width;
      const thk = r.height;
      const hgt = r.depth;
      const loadBearing = ctx.loadBearing
        ? "load-bearing"
        : ctx.loadBearing === false
          ? "non-load-bearing"
          : "";
      const storey = ctx.storey ? ` on ${ctx.storey}` : "";
      const lbPart = loadBearing ? `${loadBearing} ` : "";

      return [
        `Build a ${lbPart}wall, ${num(len)}m long, ${num(thk)}m thick, ${num(hgt)}m tall${storey}.`,
        `Create a ${num(hgt)}m tall ${lbPart}wall with length ${num(len)}m and thickness ${num(thk)}m${storey}.`,
        `Add a wall: ${num(len)} × ${num(thk)} × ${num(hgt)} meters${ctx.loadBearing ? ", load-bearing" : ""}${storey}.`,
      ];
    }
  }

  if (ctx.elementType.includes("Column")) {
    if (r.kind === "extruded_circle") {
      const radius = r.radius;
      const height = r.depth;
      const storey = ctx.storey ? ` on ${ctx.storey}` : "";
      return [
        `Place a circular column, ${num(radius)}m radius, ${num(height)}m tall${storey}.`,
        `Add a cylindrical column ${num(height)}m high with radius ${num(radius)}m${storey}.`,
        `Build a column: cylinder, radius ${num(radius)}m, height ${num(height)}m${storey}.`,
      ];
    }
    if (r.kind === "extruded_rectangle") {
      const w = r.width, d = r.height, h = r.depth;
      return [
        `Place a rectangular column, ${num(w)}m × ${num(d)}m × ${num(h)}m tall.`,
        `Add a column with a ${num(w)} by ${num(d)} meter footprint and ${num(h)}m height.`,
        `Build a column: ${num(w)} × ${num(d)} × ${num(h)} meters.`,
      ];
    }
  }

  if (ctx.elementType.includes("Slab")) {
    if (r.kind === "extruded_rectangle") {
      const w = r.width, l = r.height, t = r.depth;
      return [
        `Add a flat slab, ${num(w)}m by ${num(l)}m, ${num(t)}m thick.`,
        `Build a floor slab ${num(w)} × ${num(l)} meters and ${num(t)}m thick.`,
        `Place a slab: ${num(w)}m wide, ${num(l)}m long, ${num(t)}m thick.`,
      ];
    }
  }

  // Fallback generic.
  return [
    `Build a ${ctx.elementType.replace("Ifc", "").replace("StandardCase", "")} element.`,
  ];
}

function num(n: number): string {
  const rounded = Math.round(n * 1e2) / 1e2;
  return rounded.toString();
}
