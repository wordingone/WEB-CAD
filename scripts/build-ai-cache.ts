// Build the bundled AI demo cache from eval corpora.
//
// Output: web/public/ai-cache.json — array of { prompt, js, source } rows.
// Sourced from:
//   outputs/cad-lora-v2-4b-it-eval.jsonl  (40 rows, 100% round-trip)
//   outputs/cad-lora-v2-4b-it-schultz-eval.jsonl  (1 row, gold field — pred is structurally broken)
//
// The web frontend fetches this JSON on first prompt and does fuzzy match
// against `prompt` to pick a JS construction sequence — no live model call.
// This is the demo path for #176; live LoRA inference is a follow-up swap-in.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..");

type CacheRow = {
  prompt: string;
  js: string;
  source: "lora-v2-4b-it-eval" | "lora-v2-4b-it-schultz-gold" | "demo-prompts";
  notes?: string;
};

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  const trimmed = text.trim();
  if (!trimmed) return [];
  // schultz-eval is pretty-printed JSON, not JSONL — fall back to JSON.parse.
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    return [JSON.parse(trimmed)];
  }
  return trimmed.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const out: CacheRow[] = [];

// 4b-it eval — 40 rows, only those that parse + api_clean + runtime_pass.
const evalRows = (await readJsonl(resolve(REPO, "outputs/cad-lora-v2-4b-it-eval.jsonl"))) as Array<{
  prompt: string;
  pred: string;
  parse_ok: boolean;
  api_clean: boolean;
  runtime_pass: boolean;
}>;

let kept = 0;
let dropped = 0;
for (const row of evalRows) {
  if (row.parse_ok && row.api_clean && row.runtime_pass) {
    out.push({ prompt: row.prompt, js: row.pred, source: "lora-v2-4b-it-eval" });
    kept++;
  } else {
    dropped++;
  }
}

// Schultz Residence — use gold (pred is structurally broken on E2B; 4b-it
// outputs untranslated walls and undersized cuts per session 2026-05-02 audit).
const schultzRows = (await readJsonl(resolve(REPO, "outputs/cad-lora-v2-4b-it-schultz-eval.jsonl"))) as Array<{
  prompt: string;
  gold: string;
  pred: string;
}>;
for (const row of schultzRows) {
  out.push({
    prompt: row.prompt,
    js: row.gold,
    source: "lora-v2-4b-it-schultz-gold",
    notes: "Using gold; 4b-it pred has translate/cut bugs.",
  });
}

const outPath = resolve(REPO, "web/public/ai-cache.json");
await writeFile(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log(`wrote ${outPath}`);
console.log(`  ${kept} kept from 4b-it eval, ${dropped} dropped (round-trip fail)`);
console.log(`  ${schultzRows.length} from Schultz gold`);
console.log(`  ${out.length} total rows`);
