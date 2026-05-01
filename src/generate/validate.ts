/**
 * Lightweight client-side validation of a generated (NL, JS) pair before it
 * goes into the dataset. Mirrors src/train/inference_eval.py:score_output.
 *
 * - parse_ok: JS contains at least one Tier 1 primitive call
 * - api_clean: every called identifier is in TIER1_OPS (excl. lang keywords + var assignments)
 * - parsable: passes JS parse via `new Function(js)`
 */

export const TIER1_OPS = new Set<string>([
  "makeBox",
  "makeCylinder",
  "drawRectangle",
  "drawCircle",
  "drawLine",
  "drawPolyline",
  "sketchOnPlane",
  "extrude",
  "revolve",
  "fuse",
  "cut",
  "translate",
  "rotate",
  "close",
]);

const LANG_KEYWORDS = new Set<string>([
  "const", "let", "var", "function", "if", "for", "while", "return",
  "true", "false", "null", "undefined", "new", "this",
]);

export type ValidationResult = {
  parse_ok: boolean;
  api_clean: boolean;
  parsable: boolean;
  unknown_calls: string[];
  has_extrude: boolean;
};

export function validate(js: string): ValidationResult {
  const has_extrude = /\.extrude\(/.test(js);
  const calledRaw = Array.from(js.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)).map(m => m[1]);
  const called = new Set(calledRaw.filter(c => !LANG_KEYWORDS.has(c)));
  const unknown_calls = Array.from(called).filter(c => !TIER1_OPS.has(c));
  const api_clean = unknown_calls.length === 0;
  const parse_ok = /\b(drawRectangle|drawCircle|drawPolyline|makeBox|makeCylinder)\b/.test(js);

  let parsable = true;
  try {
    // Wrap in a no-op stub environment so any identifier reference parses.
    // We don't EXECUTE the JS; we just want SyntaxError on malformed source.
    new Function(js);
  } catch (e) {
    parsable = false;
  }

  return { parse_ok, api_clean, parsable, unknown_calls, has_extrude };
}
