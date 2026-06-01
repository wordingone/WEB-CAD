// conversion-registry.ts — #370 PR2
//
// Brep-centric conversion registry. All format conversions route through Brep
// as the intermediate representation: X → Brep → Y.
//
// Usage:
//   register("brep", "mesh", brepToMesh);
//   const mesh = await convert("brep", "mesh", brep);
//   canConvert("canonical", "mesh");  // true if canonical→brep + brep→mesh both registered

import type { Brep } from "../nurbs/nurbs-brep.js";
import type { CanonicalGeometry } from "./canonical-geometry.js";

// ── Public types ──────────────────────────────────────────────────────────────

export type GeomFormat = "brep" | "mesh" | "canonical" | "ifc" | "step" | "3dm" | "obj" | "stl";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Converter<In = any, Out = any> = (data: In) => Out | Promise<Out>;

// ── Internal registry ─────────────────────────────────────────────────────────

type ConversionKey = `${GeomFormat}->${GeomFormat}`;
const _registry = new Map<ConversionKey, Converter>();

function _key(from: GeomFormat, to: GeomFormat): ConversionKey {
  return `${from}->${to}`;
}

// ── register ──────────────────────────────────────────────────────────────────

export function register<In, Out>(
  from: GeomFormat,
  to: GeomFormat,
  fn: Converter<In, Out>,
): void {
  _registry.set(_key(from, to), fn as Converter);
}

// ── canConvert ────────────────────────────────────────────────────────────────

export function canConvert(from: GeomFormat, to: GeomFormat): boolean {
  if (_registry.has(_key(from, to))) return true;
  if (from !== "brep" && to !== "brep") {
    return _registry.has(_key(from, "brep")) && _registry.has(_key("brep", to));
  }
  return false;
}

// ── convert ───────────────────────────────────────────────────────────────────

export async function convert(from: GeomFormat, to: GeomFormat, data: unknown): Promise<unknown> {
  const direct = _registry.get(_key(from, to));
  if (direct) return direct(data);

  if (from !== "brep" && to !== "brep") {
    const toBrep = _registry.get(_key(from, "brep"));
    const fromBrep = _registry.get(_key("brep", to));
    if (toBrep && fromBrep) {
      const brep = await toBrep(data);
      return fromBrep(brep);
    }
  }

  throw new Error(`ConversionRegistry: no path from "${from}" to "${to}"`);
}

// ── Built-in: canonical → brep ────────────────────────────────────────────────
// Extracts the Brep from a CanonicalBrepGeometry.
// Throws for non-brep canonical records — callers must check kind before converting.

register<CanonicalGeometry, Brep>("canonical", "brep", (geo) => {
  if (geo.kind !== "brep") {
    throw new Error(
      `ConversionRegistry: canonical→brep requires kind="brep", got "${geo.kind}"`,
    );
  }
  return geo.brep;
});
