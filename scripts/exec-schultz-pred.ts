/**
 * One-shot: verify the trained 4b-it LoRA's Schultz prediction
 * actually executes through the Tier 1 surface.
 *
 * Reads outputs/cad-lora-v2-4b-it-schultz-eval.jsonl, pulls .pred,
 * runs it via src/generate/execute.ts, reports ok/error + resultKind.
 *
 * Why: the eval scored static metrics (parse_ok, api_clean, has_extrude)
 * but never confirmed the chain runs end-to-end. If this passes, the
 * demo can show 4b-it doing Schultz-scale construction (12 of 14 consts;
 * door/window are floating boxes instead of cuts — known geometry bug).
 */

import { readFile } from "node:fs/promises";
import { execute } from "../src/generate/execute.js";

const path = "outputs/cad-lora-v2-4b-it-schultz-eval.jsonl";
const text = await readFile(path, "utf8");
// File is pretty-printed JSON, not JSONL despite the suffix.
const row = JSON.parse(text);
const js = row.pred as string;

console.log(`pred chars: ${js.length}`);
console.log(`pred const_count: ${row.pred_const_count}/${row.gold_const_count}`);
console.log(`api_clean=${row.api_clean} has_extrude=${row.has_extrude} has_fuse=${row.has_fuse} has_cut=${row.has_cut}`);
console.log("--- exec ---");

const r = await execute(js);
if (r.ok) {
  console.log(`OK  resultKind=${r.resultKind}`);
} else {
  console.log(`FAIL  ${r.error}`);
  process.exit(1);
}
