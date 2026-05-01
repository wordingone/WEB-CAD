/**
 * Entry script for D2 of docs/plan-18-day.md.
 *
 * Generates 200 synthetic (NL, JS) pairs by calling src/generate/synth.ts,
 * static-validates each via src/generate/validate.ts (parse_ok + api_clean +
 * parsable), runtime-validates via src/generate/execute.ts (executes JS against
 * the Tier 1 surface and asserts a defined replicad value), and writes the
 * passing rows to data/v2-synthetic.jsonl in the same chat-message format as
 * data/train.jsonl.
 *
 * Acceptance gate per dataset/v2-spec.md: every emitted row must pass all four
 * checks. If any subcategory has > 10% failure rate (any reason), the generator
 * is broken and must be fixed before the file is shipped.
 *
 * Usage: bun scripts/generate-v2.ts [--seed=42] [--out=data/v2-synthetic.jsonl]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { emit200 } from "../src/generate/synth.js";
import { validate } from "../src/generate/validate.js";
import { execute } from "../src/generate/execute.js";

const SYSTEM_PROMPT = "You are a parametric CAD assistant. Given a natural-language description of an architectural element or assembly, emit a JavaScript construction sequence using the replicad fluent API (drawRectangle, drawCircle, drawPolyline, sketchOnPlane, extrude, translate, rotate, fuse, cut). Output only the JS code, no commentary.";

function parseArgs(argv: string[]): { seed: number; out: string } {
  let seed = 42;
  let out = "data/v2-synthetic.jsonl";
  for (const a of argv.slice(2)) {
    if (a.startsWith("--seed=")) seed = parseInt(a.slice("--seed=".length), 10);
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
  }
  return { seed, out };
}

async function main() {
  const { seed, out } = parseArgs(process.argv);
  const rows = emit200(seed);

  // Per-row validation: static checks (parse_ok / api_clean / parsable) gate the
  // runtime check. v2-spec.md D2 acceptance: every row must additionally execute
  // against the Tier 1 surface and produce a defined replicad value. Per-subcat
  // failure rate must be ≤ 10% for ANY reason class — generator bug otherwise.
  const failures: { id: string; subcategory: string; reasons: string[]; sequence: string }[] = [];
  const perCat = new Map<string, { total: number; failed: number }>();
  const passing: typeof rows = [];
  for (const row of rows) {
    const v = validate(row.sequence);
    const reasons: string[] = [];
    if (!v.parse_ok) reasons.push("parse_ok=false");
    if (!v.api_clean) reasons.push(`api_clean=false unknown=[${v.unknown_calls.join(",")}]`);
    if (!v.parsable) reasons.push("parsable=false");

    if (v.parse_ok && v.api_clean && v.parsable) {
      const e = await execute(row.sequence);
      if (!e.ok) reasons.push(`execute=false ${e.error}`);
    }

    const stat = perCat.get(row.subcategory) ?? { total: 0, failed: 0 };
    stat.total++;
    if (reasons.length) stat.failed++;
    perCat.set(row.subcategory, stat);

    if (reasons.length) {
      failures.push({ id: row.id, subcategory: row.subcategory, reasons, sequence: row.sequence });
    } else {
      passing.push(row);
    }
  }

  console.log(`Generated ${rows.length} rows from seed=${seed}`);
  console.log("Per-subcategory breakdown:");
  const cats = Array.from(perCat.entries()).sort();
  for (const [cat, stat] of cats) {
    const failRate = stat.total === 0 ? 0 : (stat.failed / stat.total) * 100;
    console.log(`  ${cat.padEnd(22)} total=${stat.total.toString().padStart(3)} failed=${stat.failed.toString().padStart(3)} (${failRate.toFixed(1)}%)`);
  }

  if (failures.length) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const f of failures.slice(0, 20)) {
      console.log(`  [${f.id}] ${f.subcategory}: ${f.reasons.join("; ")}`);
      console.log(`    seq: ${f.sequence.replace(/\n/g, " | ").slice(0, 120)}`);
    }
    if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);
  }

  // Per-spec acceptance: every subcategory must have <= 10% failure rate.
  const overLimit = cats.filter(([, s]) => s.total > 0 && s.failed / s.total > 0.1);
  if (overLimit.length > 0) {
    console.error(`\nACCEPTANCE FAIL: ${overLimit.length} subcategories exceed 10% failure rate:`);
    for (const [cat, s] of overLimit) {
      console.error(`  ${cat}: ${s.failed}/${s.total} (${((s.failed / s.total) * 100).toFixed(1)}%)`);
    }
    process.exit(1);
  }

  // Write JSONL in chat-message format (same as data/train.jsonl).
  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  const lines = passing.map(row => JSON.stringify({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: row.prompt },
      { role: "assistant", content: row.sequence },
    ],
    meta: {
      id: row.id,
      subcategory: row.subcategory,
      ops: row.ops,
      params: row.params,
    },
  }));
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`\nWrote ${passing.length} rows to ${outPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
