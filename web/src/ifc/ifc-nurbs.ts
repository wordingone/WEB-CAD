// IFC ↔ NURBS interop bridge (T17 / #30 G10).
//
// IFC4 carries NURBS surfaces as IfcRationalBSplineSurfaceWithKnots /
// IfcBSplineSurfaceWithKnots inside IfcAdvancedBrep entities. This module
// provides a pure-JS STEP-21 parser for the subset emitted by ifc-build.ts
// (emitNurbsAdvancedBrep) — no web-ifc WASM dependency, fully testable
// in Bun.
//
// Round-trip chain (G9 → G10):
//   emitNurbsAdvancedBrep  →  STEP-21 text  →  parseIfcNurbsStep21  →  NurbsSurface[]
//
// References:
//   - IFC4 schema, Annex C.6 — B-spline surface entities.
//   - Piegl & Tiller, "The NURBS Book" §2.3 (knot multiplicity → flat knots).

import type { NurbsSurface as KernelNurbsSurface } from "../nurbs/nurbs-kernel.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public: expandKnots — already existed; kept as-is.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expand an IFC knot list (distinct knot values + multiplicities) into the
 * flat knot vector our evaluator expects.
 */
export function expandKnots(knots: number[], multiplicities: number[]): number[] {
  if (knots.length !== multiplicities.length) {
    throw new Error(
      `expandKnots: knots.length ${knots.length} != multiplicities.length ${multiplicities.length}`,
    );
  }
  const out: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    for (let m = 0; m < multiplicities[i]; m++) {
      out.push(knots[i]);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: minimal STEP-21 tokeniser
// ─────────────────────────────────────────────────────────────────────────────

/** Parsed representation of one STEP-21 line. */
interface StepLine {
  ref: string;   // e.g. "#12"
  entity: string; // e.g. "IFCCARTESIANPOINT"
  rawArgs: string; // everything inside the outer parentheses
}

/** Parse STEP-21 DATA section into a ref → StepLine map. */
function parseStep21(text: string): Map<string, StepLine> {
  const map = new Map<string, StepLine>();
  // Match lines of the form: #N=ENTITYNAME(...);
  const lineRe = /(#\d+)=([A-Z0-9]+)\(([\s\S]*?)\);/g;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text)) !== null) {
    map.set(m[1], { ref: m[1], entity: m[2], rawArgs: m[3] });
  }
  return map;
}

/** Split a STEP-21 argument list at top-level commas (not inside parens). */
function splitArgs(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "(" ) depth++;
    else if (raw[i] === ")") depth--;
    else if (raw[i] === "," && depth === 0) {
      parts.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(raw.slice(start).trim());
  return parts;
}

/** Parse a STEP-21 number list like "(0.,1.,2.)" into number[]. */
function parseNumberList(s: string): number[] {
  const inner = s.trim().replace(/^\(|\)$/g, "");
  return inner.split(",").map((v) => parseFloat(v.trim())).filter(Number.isFinite);
}

/** Parse a STEP-21 integer list like "(2,2)" into number[]. */
function parseIntList(s: string): number[] {
  const inner = s.trim().replace(/^\(|\)$/g, "");
  return inner.split(",").map((v) => parseInt(v.trim(), 10)).filter(Number.isInteger);
}

/** Resolve "#N" → [x, y, z] from IFCCARTESIANPOINT. Returns null if not found. */
function resolveCartesianPoint(ref: string, map: Map<string, StepLine>): [number, number, number] | null {
  const line = map.get(ref);
  if (!line || line.entity !== "IFCCARTESIANPOINT") return null;
  const coords = parseNumberList(line.rawArgs);
  return [coords[0] ?? 0, coords[1] ?? 0, coords[2] ?? 0];
}

/**
 * Parse a 2D STEP-21 control-point list "((#1,#2),(#3,#4),...)" into
 * a flat [Vec3] array, row-major. Returns [points, countU, countV] or null.
 */
function parseControlPointsList(
  s: string,
  map: Map<string, StepLine>,
): { points: [number,number,number][]; countU: number; countV: number } | null {
  // Strip outer parens
  const inner = s.trim().replace(/^\(|\)$/g, "");
  // Split into rows — each row is "(#a,#b,...)"
  const rowRe = /\(([^()]+)\)/g;
  const rows: string[][] = [];
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(inner)) !== null) {
    const refs = rm[1].split(",").map((r) => r.trim());
    rows.push(refs);
  }
  if (rows.length === 0) return null;
  const countU = rows.length;
  const countV = rows[0].length;
  const points: [number,number,number][] = [];
  for (const row of rows) {
    for (const ref of row) {
      const p = resolveCartesianPoint(ref, map);
      if (!p) return null;
      points.push(p);
    }
  }
  return { points, countU, countV };
}

/**
 * Parse a 2D STEP-21 weight list "((1.,1.),(1.,1.),...)" into a flat number[].
 */
function parseWeightsList(s: string): number[] {
  const inner = s.trim().replace(/^\(|\)$/g, "");
  const rowRe = /\(([^()]+)\)/g;
  const out: number[] = [];
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(inner)) !== null) {
    const ws = rm[1].split(",").map((v) => parseFloat(v.trim()));
    out.push(...ws);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: parseIfcNurbsStep21
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse all NURBS surfaces from a STEP-21 IFC4 text string.
 *
 * Handles IFCBSPLINESURFACEWITHKNOTS and IFCRATIONALBSPLINESURFACEWITHKNOTS
 * as emitted by ifc-build.ts emitNurbsAdvancedBrep.
 *
 * Returns an array of KernelNurbsSurface — one entry per surface entity found.
 * Throws on parse failure of an individual entity (skips unknown entities).
 */
export function parseIfcNurbsStep21(text: string): KernelNurbsSurface[] {
  const map = parseStep21(text);
  const surfaces: KernelNurbsSurface[] = [];

  for (const line of map.values()) {
    const isRational = line.entity === "IFCRATIONALBSPLINESURFACEWITHKNOTS";
    const isNonRational = line.entity === "IFCBSPLINESURFACEWITHKNOTS";
    if (!isRational && !isNonRational) continue;

    const args = splitArgs(line.rawArgs);
    // Non-rational:  (degU, degV, cpList, form, uClosed, vClosed, selfInt, uMults, vMults, uKnots, vKnots, knotSpec)
    // Rational:      same + (weightsList) at the end
    if (args.length < 12) continue;

    const degreeU = parseInt(args[0], 10);
    const degreeV = parseInt(args[1], 10);
    if (!Number.isFinite(degreeU) || !Number.isFinite(degreeV)) continue;

    const cpResult = parseControlPointsList(args[2], map);
    if (!cpResult) continue;
    const { points: controlPoints, countU, countV } = cpResult;

    const uMults = parseIntList(args[7]);
    const vMults = parseIntList(args[8]);
    const uKnotVals = parseNumberList(args[9]);
    const vKnotVals = parseNumberList(args[10]);

    const knotsU = expandKnots(uKnotVals, uMults);
    const knotsV = expandKnots(vKnotVals, vMults);

    let weights: number[];
    if (isRational && args.length >= 13) {
      weights = parseWeightsList(args[12]);
    } else {
      weights = new Array(controlPoints.length).fill(1);
    }

    surfaces.push({ degreeU, degreeV, countU, countV, controlPoints, weights, knotsU, knotsV });
  }

  return surfaces;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: ifcAdvancedBrepToNurbs — updated signature (G10)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an IFC4 file (raw bytes) to a list of KernelNurbsSurface.
 *
 * Decodes as UTF-8 and calls parseIfcNurbsStep21. Works in browser and Bun.
 * For web-ifc model-ID-based access, use parseIfcNurbsStep21 directly on the
 * STEP-21 text obtained from the model's file buffer.
 */
export async function ifcAdvancedBrepToNurbs(bytes: Uint8Array): Promise<KernelNurbsSurface[]> {
  const text = new TextDecoder().decode(bytes);
  return parseIfcNurbsStep21(text);
}
