/**
 * Run the D2 static + runtime gate against any fixtures/*.jsonl file.
 * Same checks as generate-v2.ts (parse_ok + api_clean + parsable + execute),
 * different input source. D3 acceptance for Tier 1 extra: all 50 rows pass
 * parse_ok + api_clean + execute against the Tier 1 surface.
 *
 * Usage: bun scripts/validate-fixtures.ts <path-to-jsonl> [<path-to-jsonl> ...]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validate } from "../src/generate/validate.js";
import { execute } from "../src/generate/execute.js";

interface Row {
  id: string;
  prompt: string;
  sequence: string;
  element?: string;
  ops?: string[];
}

async function validateFile(path: string): Promise<{ total: number; failed: number; failures: { id: string; reasons: string[] }[] }> {
  const abs = resolve(path);
  const lines = readFileSync(abs, "utf8").split("\n").filter(l => l.trim().length > 0);
  const rows: Row[] = lines.map(l => JSON.parse(l));

  const failures: { id: string; reasons: string[] }[] = [];
  for (const row of rows) {
    const reasons: string[] = [];
    const v = validate(row.sequence);
    if (!v.parse_ok) reasons.push("parse_ok=false");
    if (!v.api_clean) reasons.push(`api_clean=false unknown=[${v.unknown_calls.join(",")}]`);
    if (!v.parsable) reasons.push("parsable=false");
    if (v.parse_ok && v.api_clean && v.parsable) {
      const e = await execute(row.sequence);
      if (!e.ok) reasons.push(`execute=false ${e.error}`);
    }
    if (reasons.length) failures.push({ id: row.id, reasons });
  }

  console.log(`\n[${path}]  total=${rows.length}  failed=${failures.length}`);
  for (const f of failures.slice(0, 20)) {
    console.log(`  [${f.id}] ${f.reasons.join("; ")}`);
  }
  if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);

  return { total: rows.length, failed: failures.length, failures };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: bun scripts/validate-fixtures.ts <path-to-jsonl> [more...]");
    process.exit(2);
  }
  let totalFailed = 0;
  for (const path of args) {
    const r = await validateFile(path);
    totalFailed += r.failed;
  }
  if (totalFailed > 0) {
    console.error(`\nFAIL: ${totalFailed} total failures`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
