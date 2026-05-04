// Quick smoke test for the cache matching logic at scripts time (no DOM).
// Validates the similarity function picks reasonable matches against the
// bundled cache for representative user prompts. Path resolves relative to
// THIS script so it works in worktrees and the main repo identically.

import { readFile } from "node:fs/promises";

type CacheRow = { prompt: string; js: string; source: string };

const cache: CacheRow[] = JSON.parse(
  await readFile(new URL("../web/public/ai-cache.json", import.meta.url), "utf8"),
);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\w.\-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const STOP = new Set([
  "a", "an", "the", "of", "to", "for", "by", "with", "and", "or", "in", "on",
  "at", "is", "be", "are", "from", "into", "onto", "as", "this", "that",
  "make", "create", "build", "draw", "place", "add", "put", "i", "need",
]);

// F1 over content tokens, weighted so numeric/dimension tokens count more.
// F1 penalizes both poor recall (user content not covered) AND poor precision
// (cached prompt has lots of tokens the user didn't ask for) — without it,
// long cached prompts (Schultz) win every short query.
function similarity(user: string, cached: string): number {
  const U = tokens(user).filter((t) => !STOP.has(t));
  const C = tokens(cached).filter((t) => !STOP.has(t));
  if (U.length === 0 || C.length === 0) return 0;
  const cset = new Set(C);
  const uset = new Set(U);
  const weight = (t: string) => (/\d/.test(t) ? 2 : 1);
  let interW = 0;
  let userW = 0;
  let cacheW = 0;
  for (const t of uset) {
    userW += weight(t);
    if (cset.has(t)) interW += weight(t);
  }
  for (const t of cset) cacheW += weight(t);
  if (userW === 0 || cacheW === 0) return 0;
  const recall = interW / userW;
  const precision = interW / cacheW;
  if (recall === 0 || precision === 0) return 0;
  return (2 * recall * precision) / (recall + precision);
}

function topMatch(query: string): { row: CacheRow; score: number } | null {
  let best: CacheRow | null = null;
  let bestScore = 0;
  for (const r of cache) {
    const s = similarity(query, r.prompt);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  return best ? { row: best, score: bestScore } : null;
}

const queries = [
  "build a single-story residence with a doorway and window",
  "make a 12 by 8 rectangular floor slab",
  "create a column 0.3m square 3m tall",
  "wall from origin to (5, 0) 3m tall",
  "L-shaped walls 6m and 4m long",
  "completely unrelated query about vegetables",
  "footings 10m long",
  // queries targeting the new DSL-corpus rows in the cache:
  "U-shape with three walls 8m and two 6m sides",
  "closed 6 by 6 room with 0.3m thick walls 3m tall",
  "2x2 column grid at 5m bay corners",
  "wall 5m long with a window opening centered",
  "concrete slab on grade with perimeter footing",
];

console.log(`cache: ${cache.length} rows\n`);
for (const q of queries) {
  const m = topMatch(q);
  if (!m) {
    console.log(`[NO MATCH] ${q}`);
    continue;
  }
  const ok = m.score >= 0.4 ? "OK   " : "WEAK ";
  const matched = m.row.prompt.slice(0, 70);
  console.log(`${ok} ${m.score.toFixed(2)}  q: ${q.slice(0, 60)}\n         m: ${matched}\n`);
}
