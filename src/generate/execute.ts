/**
 * Runtime execution gate for D2 generator output.
 *
 * Per dataset/v2-spec.md the round-trip flow is:
 *   1. Generator emits JS.
 *   2. Run JS through replicad → produces a model.
 *   3. Export to IFC4.
 *   4. Mine IFC back to (NL, JS).
 *   5. Compare.
 *
 * Step 2 alone catches the failure classes that matter for v2: unbound vars,
 * type errors, NaN params, boolean-op failures (cut(empty) / fuse(disjoint)).
 * Steps 3–5 only add value when validating IFC export quality, which is a
 * separate concern from generator correctness — and `web-ifc` is a parser,
 * not an emitter, so step 3 isn't free anyway.
 *
 * This file gates D2 output at step 2: every emitted JS must execute against
 * the Tier 1 surface and produce a defined replicad value (Solid, Drawing,
 * or Sketch — anything non-undefined that the chain returned).
 */

import { setOC } from "replicad";
import * as tier1 from "../tools/tier1.js";

let _ocReady: Promise<void> | null = null;

async function ensureOC(): Promise<void> {
  if (_ocReady) return _ocReady;
  _ocReady = (async () => {
    const ocModule: any = await import("replicad-opencascadejs/src/replicad_single.js");
    const init = ocModule.default ?? ocModule;
    const oc = await init();
    setOC(oc);
  })();
  return _ocReady;
}

export type ExecResult =
  | { ok: true; resultKind: string }
  | { ok: false; error: string };

/**
 * Execute one (NL, JS) pair's JS against the Tier 1 surface.
 *
 * The JS is wrapped in a function whose argument list spreads every Tier 1
 * binding into scope, then `result` is captured from the last `const` in the
 * sequence by appending a sniffer suffix. The sequences emitted by synth.ts
 * always end with a top-level `const <name> = ...;` — we collect the union
 * of all those names and return the last-defined one.
 */
export async function execute(js: string): Promise<ExecResult> {
  await ensureOC();

  const bindings = {
    drawRectangle: tier1.drawRectangle,
    drawCircle: tier1.drawCircle,
    drawLine: tier1.drawLine,
    drawPolyline: tier1.drawPolyline,
    makeBox: tier1.makeBox,
    makeCylinder: tier1.makeCylinder,
  };

  // Pull every top-level `const <name> = ...` so we can return the last one.
  const constNames = Array.from(js.matchAll(/^\s*const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/gm)).map(m => m[1]);
  if (constNames.length === 0) {
    return { ok: false, error: "no top-level const declarations" };
  }
  const lastName = constNames[constNames.length - 1];

  const wrapped = `${js}\nreturn ${lastName};`;
  let fn: Function;
  try {
    fn = new Function(...Object.keys(bindings), wrapped);
  } catch (e) {
    return { ok: false, error: `parse: ${(e as Error).message}` };
  }

  let result: unknown;
  try {
    result = fn(...Object.values(bindings));
  } catch (e) {
    return { ok: false, error: `runtime: ${(e as Error).message}` };
  }

  if (result === undefined || result === null) {
    return { ok: false, error: `${lastName} resolved to ${result === undefined ? "undefined" : "null"}` };
  }

  const ctorName = (result as object).constructor?.name ?? typeof result;
  return { ok: true, resultKind: ctorName };
}
