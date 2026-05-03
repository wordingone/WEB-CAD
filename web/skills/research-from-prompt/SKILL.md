---
name: research-from-prompt
version: 0.1.0
description: Query the gemma-architect research corpus (TF-IDF over markdown fixtures) and produce ranked snippets with citations. Use when an architectural design conversation needs grounded references — wall thickness, IFC4 schema, gable roofs, daylight calculations, building codes — before the model emits geometry.
keywords:
  - research
  - corpus
  - rag
  - citations
  - architecture
  - building-codes
  - ifc4
  - gable-roof
  - wall-thickness
  - daylight
examples:
  - "What's the minimum thickness for a partition wall?"
  - "How do I emit a gable roof in tier-1 DSL?"
  - "What's the SHGC limit for north-facing glazing in climate zone 4A?"
  - "Are there code restrictions on bedroom egress windows I should account for?"
eval_id: research-from-prompt-v0
---

# research-from-prompt

When the user prompt names a design constraint, code reference, or
architectural convention that the model isn't certain about, query
the in-memory research index BEFORE emitting geometry. The agent
should ground every numeric value (thickness, height, SHGC, setback,
etc.) in a citation rather than hallucinating defaults.

This skill operates against the index built by
`web/src/research-index.ts` and the citation tracker in the same
module. The corpus lives at `web/research-corpus/*.md` and is
bundled into the page; no network call is required.

## When this skill fires

Trigger when the user prompt includes any of:

- A code reference ("ASHRAE", "IBC", "IECC", "Article 32", "egress").
- A numeric building-element constraint that has a real-world default
  ("how thick should the wall be", "what's the rise of a stair").
- An IFC schema question ("how does this round-trip", "what entity").
- A convention ("are gable roofs typically", "what's the standard
  setback").

Skip the skill when the prompt is purely geometric (e.g. "make a 5×3m
box") — there's no factual claim to ground.

## Index API

```ts
import {
  buildResearchIndex,
  queryResearch,
  createCitationTracker,
} from "../../src/research-index";
import { defaultCorpus } from "../../src/research-corpus-loader";

const idx = await buildResearchIndex(defaultCorpus());
const tracker = createCitationTracker();
```

### `queryResearch(idx, query, options?)`

Returns the top-N ranked `QueryResult[]` with fields:

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Doc identifier (filename without `.md`). |
| `title` | string | Display title (first H1 in the doc). |
| `kind` | `"local" \| "web"` | Source classification — drives the LOCAL/WEB filter pills. |
| `score` | number | Cosine similarity in `[0, 1]`. Higher is better. |
| `snippet` | string | ~240-char extract surrounding the first matched term. |
| `line` | number | 1-indexed line in the source doc where the snippet starts. |
| `matchedTerms` | string[] | Lowercase query terms that hit this doc (drives `<mark>` highlights). |

`options`:
- `source: "local" | "web" | "all"` — restrict to a single source kind.
- `limit: number` — max results (default 10).
- `restrictTo: Set<string>` — only score docs whose `name` is in the set
  (used for the CITE filter — see below).

### `tracker.cite({ source, line, claim })`

Append a citation triple to the session-scoped log. `source` should be
the doc's `name`, `line` the 1-indexed line number returned by
`queryResearch`, `claim` the snippet being cited.

`tracker.list()` returns a copy of the citation array.
`tracker.citedSources()` returns a `Set<string>` of cited doc names —
pass this as `restrictTo` to `queryResearch` to implement the CITE
pill filter.

`tracker.exportJSON()` returns a pretty-printed JSON array suitable
for a download button (the UI wires this to "export").

## Recommended workflow for an LLM agent

```
1. Identify factual claims in the user's design prompt.
2. For each claim, formulate 2-4 keyword query strings.
3. queryResearch(idx, query, { limit: 5 }) → keep results with score > 0.05.
4. If top result is unambiguous (score gap > 0.5 vs runner-up), tracker.cite() it.
5. Surface the cited snippet to the user inline with the geometry response:
       "Wall thickness defaults to 0.2m (ref: wall-thickness.md line 12)."
6. Before emitting numeric defaults, check tracker.list() — if a relevant
   citation exists, use the value FROM the citation rather than a guess.
```

## Filter semantics

- **LOCAL** — only docs under `web/research-corpus/` (kind = `"local"`).
- **WEB** — currently a placeholder; returns the small set of fixture
  URLs in `defaultCorpus()`. A real web-search adapter would slot in
  here, indexing search results as `CorpusEntry[]` with `kind: "web"`.
  Future work; not blocking T16.
- **CITE** — only docs whose name appears in
  `tracker.citedSources()`. Use this as a post-research focus pass:
  the user picks 2-3 high-confidence sources, then queries within
  them.

## Eval criteria (`research-from-prompt-v0`)

For a hand-curated 10-prompt eval set, the agent passes if:

1. `queryResearch` is called for every prompt that names a numeric
   architectural constraint.
2. The top result for "wall thickness conventions" is
   `wall-thickness.md`.
3. The top result for "gable roof in DSL" is `gable-roof.md`.
4. The top result for "ASHRAE envelope" or "SHGC" filters cleanly into
   the daylight or codes docs.
5. At least 80% of factual claims in the agent's response are
   accompanied by a `tracker.cite(...)` call referencing a real
   `(source, line)` pair from the corpus.

The eval set lives at `web/skills/research-from-prompt/eval.jsonl`
(future work — placeholder until T11 lands the eval harness).

## Future expansions

- **Web-search adapter** — replace the placeholder WEB entries in
  `defaultCorpus()` with a real search API. The adapter must produce
  `CorpusEntry[]` with `kind: "web"` and a stable `name` so the CITE
  filter works across sessions.
- **Per-paragraph indexing** — current granularity is per-doc. For
  long sources we should split on `\n\n` and index each paragraph
  separately, surfacing the paragraph (not the doc) as the citation
  unit.
- **Stemming + stopword pruning** — the 5-doc corpus doesn't need
  either, but past 50 docs the precision floor will drop without them.
- **Embedding-based recall** — TF-IDF misses semantic matches
  ("partition" vs "interior wall"). A pre-computed embedding index
  (e.g. via sentence-transformers offline) would compose with TF-IDF
  for a hybrid score.

## Cross-refs

- `web/src/research-index.ts` — the scoring math + tracker.
- `web/src/research-corpus-loader.ts` — the bundled corpus.
- `web/src/research-md.ts` — the markdown renderer + `<mark>` highlighter.
- `web/src/modes.ts` — the UI that calls all three.
- `web/test/research.test.ts` — acceptance tests.
- `docs/tier1-conventions.md` — the canonical empirical reference for
  the geometric defaults the corpus documents.
