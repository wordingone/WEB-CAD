#!/usr/bin/env bun
/**
 * run.mjs — Phase 1 corpus mining orchestrator.
 *
 * Fetches seed URLs (sources.mjs), extracts WEB-CAD scenarios (extract.mjs),
 * deduplicates, and writes state/corpus/scenarios-phase1.jsonl.
 *
 * Usage:
 *   bun scripts/corpus-mine/run.mjs [--dry-run] [--source rhino-docs] [--limit N]
 *
 *   --dry-run         Fetch + extract but don't write output file
 *   --source <name>   Only process seeds from this source category
 *   --limit <N>       Stop after N seeds (for quick sanity checks)
 *
 * Resource-serialize note: this script does NOT overlap with browser passes.
 * If a browser collection run is live, wait for it to finish first.
 * Prints MEM-HEAVY START/END only if video/ASR ops are added in Phase 2.
 */

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { SEEDS } from "./sources.mjs";
import { fetchDoc } from "./fetch.mjs";
import { extractScenarios, templateScenario, deduplicateScenarios } from "./extract.mjs";
import { coveredVerbs } from "./translate.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const SOURCE_FILTER = process.argv.find((_, i, a) => a[i - 1] === "--source");
const LIMIT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--limit") ?? "9999");

const OUT_DIR = "state/corpus";
const OUT_FILE = `${OUT_DIR}/scenarios-phase1.jsonl`;

mkdirSync(OUT_DIR, { recursive: true });

const seeds = SEEDS
  .filter(s => !SOURCE_FILTER || s.source === SOURCE_FILTER)
  .slice(0, LIMIT);

console.log(`[corpus-mine] Phase 1 — ${seeds.length} seeds`);
console.log(`[corpus-mine] WEB-CAD verbs in map: ${[...coveredVerbs()].join(", ")}`);
if (DRY_RUN) console.log("[corpus-mine] DRY RUN — no output file");

/** @type {object[]} */
const allScenarios = [];
const state = { startSeq: 0 };

let fetchOk = 0, fetchFail = 0, extracted = 0;

for (const seed of seeds) {
  process.stdout.write(`  [${seed.source}] ${seed.title.slice(0, 60)}… `);
  const doc = await fetchDoc(seed.url, seed.source, seed.title);
  if (!doc) { console.log("SKIP (fetch fail)"); fetchFail++; continue; }

  fetchOk++;
  const scenarios = extractScenarios(
    doc.contentText,
    doc.url,
    doc.source,
    doc.fetchedAt,
    doc.title,
    seed.source,
    state,
  );
  // For command-reference pages with few/no numbered steps: add template scenario
  const tmpl = templateScenario(seed.title, doc.url, doc.source, doc.fetchedAt, seed.source, state);
  if (tmpl && !scenarios.find(s => s.expected_state.verb === tmpl.expected_state.verb)) {
    scenarios.unshift(tmpl);
  }
  console.log(`${scenarios.length} scenarios (${doc.rawHtmlBytes} bytes raw)`);
  extracted += scenarios.length;
  allScenarios.push(...scenarios);
}

const deduped = deduplicateScenarios(allScenarios);

// Coverage report
const verbCoverage = {};
for (const s of deduped) {
  const v = s.expected_state.verb;
  verbCoverage[v] = (verbCoverage[v] ?? 0) + 1;
}

console.log(`\n[corpus-mine] fetch: ${fetchOk} OK / ${fetchFail} failed`);
console.log(`[corpus-mine] scenarios: ${allScenarios.length} raw → ${deduped.length} after dedup`);
console.log(`[corpus-mine] verb coverage (${Object.keys(verbCoverage).length} verbs):`);
for (const [verb, count] of Object.entries(verbCoverage).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${verb}: ${count}`);
}

// Geometry class distribution
const classCoverage = {};
for (const s of deduped) {
  const c = s.expected_state.geometry_class;
  classCoverage[c] = (classCoverage[c] ?? 0) + 1;
}
console.log(`[corpus-mine] geometry class distribution: ${JSON.stringify(classCoverage)}`);

if (!DRY_RUN && deduped.length > 0) {
  const lines = deduped.map(s => JSON.stringify(s)).join("\n");
  writeFileSync(OUT_FILE, lines + "\n");
  console.log(`\n[corpus-mine] written → ${OUT_FILE} (${deduped.length} scenarios)`);
} else if (DRY_RUN) {
  console.log("\n[corpus-mine] dry-run complete — no file written");
} else {
  console.log("\n[corpus-mine] 0 scenarios extracted — nothing written");
}
