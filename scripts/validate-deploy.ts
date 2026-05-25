#!/usr/bin/env bun
// Validate the deployed WEB-CAD page against submission/demo-script.md.
//
// Pre-submission regression check: hits the live URL + ai-cache.json,
// asserts shape + rows + presence of the prompts demo-script.md cuts depend on.
//
// Run:
//   bun scripts/validate-deploy.ts
//   bun scripts/validate-deploy.ts --url https://staging.example/   # override target
//
// Exits 0 on full pass, 1 on any assertion failure. Prints a summary table.

export {};

const argv = process.argv.slice(2);
const flagIdx = argv.indexOf("--url");
const url =
  flagIdx >= 0
    ? argv[flagIdx + 1]
    : "https://wordingone.github.io/WEB-CAD/";

const targetUrl = url.endsWith("/") ? url : url + "/";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  ${tag}  ${name.padEnd(32)} ${detail}`);
}

console.log(`WEB-CAD deploy validator — ${targetUrl}\n`);

// 1. Page HTTP 200
const pageRes = await fetch(targetUrl);
record(
  "page-http-200",
  pageRes.status === 200,
  `HTTP ${pageRes.status} ${pageRes.statusText}`,
);

// 2. Page HTML carries the expected title
const pageHtml = await pageRes.text();
const titleMatch = pageHtml.match(/<title>([^<]+)<\/title>/);
const titleOk =
  titleMatch !== null && /gemma.*architect/i.test(titleMatch[1] ?? "");
record(
  "page-title",
  titleOk,
  titleOk ? `title="${titleMatch![1]}"` : `no <title> match for /gemma.*architect/i`,
);

// 3. ai-cache.json HTTP 200
const cacheRes = await fetch(`${targetUrl}ai-cache.json`);
record(
  "ai-cache-http-200",
  cacheRes.status === 200,
  `HTTP ${cacheRes.status} ${cacheRes.statusText}`,
);

if (cacheRes.status !== 200) {
  printSummary();
  process.exit(1);
}

// 4. ai-cache.json shape: array of {prompt, js, source}
const cacheText = await cacheRes.text();
let cache: Array<{ prompt: string; js: string; source?: string }>;
try {
  cache = JSON.parse(cacheText);
} catch (e) {
  record("ai-cache-parses", false, `JSON.parse threw: ${(e as Error).message}`);
  printSummary();
  process.exit(1);
}
record("ai-cache-parses", true, `${cacheText.length} bytes parsed`);

const isArray = Array.isArray(cache);
record(
  "ai-cache-array",
  isArray,
  isArray ? `${cache.length} entries` : `not an array, got ${typeof cache}`,
);

if (!isArray) {
  printSummary();
  process.exit(1);
}

// 5. ai-cache.json has at least 60 rows (writeup claim: 40 eval + 19 DSL + 1 schultz gold)
record(
  "ai-cache-rows-gte-60",
  cache.length >= 60,
  `${cache.length} rows (expected >= 60)`,
);

// 6. Every entry has prompt + js
const malformed = cache.filter(
  (r) => typeof r.prompt !== "string" || typeof r.js !== "string",
);
record(
  "ai-cache-shape",
  malformed.length === 0,
  malformed.length === 0
    ? "all rows have prompt + js"
    : `${malformed.length} malformed rows`,
);

// 7. demo-script.md cut 2 dependency: column-square-3m row
const demoCut2Prompt = "Build a square column 0.3m by 0.3m, 3m tall.";
const demoCut2Hit = cache.find((r) => r.prompt === demoCut2Prompt);
record(
  "demo-cut2-cache-row",
  demoCut2Hit !== undefined,
  demoCut2Hit
    ? `found "${demoCut2Hit.prompt.slice(0, 50)}..."`
    : `MISSING: "${demoCut2Prompt}" — demo-script.md cut 2 will fall through to live LoRA`,
);

// 8. demo-script.md cut 1 dependency: wall demo prompt
const demoCut1Prompt = "Build a wall, 5.5m long, 0.2m thick, 2.8m tall.";
const demoCut1Hit = cache.find((r) => r.prompt === demoCut1Prompt);
record(
  "demo-cut1-cache-row",
  demoCut1Hit !== undefined,
  demoCut1Hit
    ? `found "${demoCut1Hit.prompt.slice(0, 50)}..."`
    : `MISSING: "${demoCut1Prompt}"`,
);

// 9. Schultz Residence prompt present (cut 3 / hero demo)
const schultzHit = cache.find(
  (r) =>
    /single-story residence/i.test(r.prompt) ||
    /Schultz/i.test(r.prompt) ||
    /12.{1,4}8m.{0,20}residence/i.test(r.prompt),
);
record(
  "schultz-cache-row",
  schultzHit !== undefined,
  schultzHit
    ? `found "${schultzHit.prompt.slice(0, 60)}..."`
    : `MISSING: Schultz hero demo prompt`,
);

// 10. JS is non-empty for every row
const emptyJs = cache.filter((r) => !r.js || r.js.trim().length === 0);
record(
  "ai-cache-js-nonempty",
  emptyJs.length === 0,
  emptyJs.length === 0
    ? "every row has non-empty js"
    : `${emptyJs.length} rows with empty js`,
);

printSummary();

function printSummary(): void {
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).length;
  console.log(``);
  console.log(`${passed}/${checks.length} checks passed`);
  if (failed > 0) {
    console.log(`\nFailed checks:`);
    for (const c of checks.filter((c) => !c.ok)) {
      console.log(`  - ${c.name}: ${c.detail}`);
    }
    process.exit(1);
  }
}
