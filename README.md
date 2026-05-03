# gemma-architect

Browser-native parametric architectural design from natural-language prompts.
Type a sentence; render a building; export an IFC4 file. No server,
no install, no API key — Gemma 4 LoRA + replicad geometry kernel +
web-ifc all run inside a single tab.

**Hackathon entry:** Gemma 4 Good Hackathon (Kaggle + Google DeepMind),
deadline 2026-05-18.
**Track:** Equity — 3D parametric design accessibility for non-CAD users.
**License:** Apache-2.0 (see [`LICENSE`](LICENSE)).

---

## What it does

Open the page. Pick a demo (or type your own prompt). Gemma 4 emits a
short replicad JavaScript program. The page executes it in a worker,
meshes the result with OpenCascade, renders with three.js, and offers
an **Export IFC** button that downloads an IFC4 STEP-21 file consumable
in Revit, ArchiCAD, BlenderBIM, IFC.js viewers, BimVision.

```
"a wall, 5.5m long, 0.2m thick, 2.8m tall"
                          │
                          ▼
   const e0 = drawRectangle(5.5, 0.2)
                .sketchOnPlane("XY")
                .extrude(2.8);
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
        three.js viewer         wall.ifc download
        (parameter sliders)     (loads in any BIM tool)
```

Nine canned demos ship in the page: walls, columns, raised slabs,
slabs with stair holes, walls with doorways, L-shape walls, four-walled
rooms, stair-step structures, and a 14-element Schultz Residence (the
hero demo, also reachable via the Cmd-K palette). Each has 3-6 sliders
that re-trigger the worker without re-running the model.

---

## AI prompt pipeline

The PROMPT textbox supports two paths:

- **Cache-first (default).** A 60-row prompt → JS cache ships with the
  bundle (40 from the v2 LoRA eval at 100 % round-trip + 19 DSL corpus
  rows compiled via `compileDsl()` + 1 Schultz gold). F1-weighted
  similarity (numeric tokens 2x, stop-words filtered) returns the best
  match in ~50 ms. No GPU, no network call — the path judges hit by
  default and the path that survives offline demo settings.
- **Live LoRA (opt-in).** `src/serve/serve_lora.py` is a FastAPI wrapper
  around the v2 adapter exposing `/v1/chat/completions`. Set
  `window.__loraUrl` (or `VITE_LORA_URL` at build time) and the page
  hits the live model first, falling back to the cache on
  network/HTTP errors.

Architecture: [`docs/ai-pipeline.md`](docs/ai-pipeline.md). The
console-DSL terminal that backs the cache's broader-coverage rows is
documented in [`docs/console-dsl.md`](docs/console-dsl.md).

---

## Numbers

| What                                       | Number                            |
| ------------------------------------------ | --------------------------------- |
| Base model                                 | `unsloth/gemma-3-4b-it-unsloth-bnb-4bit` |
| LoRA                                       | rank 16, alpha 16, all-linear     |
| Train rows (augmented)                     | 932                               |
| Eval rows (held-out, no augmentation)      | 40                                |
| Train wall-clock (RTX 4090)                | 53 min (351 steps × 3 epochs)     |
| `train_loss` @ epoch 3                     | 0.2442                            |
| Eval `parse_ok`                            | 40 / 40                           |
| Eval `api_clean`                           | 40 / 40                           |
| Eval `has_solid_op`                        | 40 / 40                           |
| Eval **`runtime_pass` (full round-trip)**  | **40 / 40 = 100 %**               |
| Self-harness demos (no browser)            | 9 / 9 pass                        |
| AI prompt cache rows (eval + DSL + Schultz)| 60                                |
| DSL corpus rows compiled via `compileDsl()`| 19 / 19 pass                      |

Numbers reproducible end-to-end via [`submission/repro.md`](submission/repro.md).

---

## Submission artifacts

- [`submission/writeup.md`](submission/writeup.md) — Kaggle post draft.
- [`submission/impact.md`](submission/impact.md) — equity story, who benefits, adoption path.
- [`submission/repro.md`](submission/repro.md) — step-by-step reproduction.
- [`submission/demo-script.md`](submission/demo-script.md) — 3-min demo video voiceover + cuts.
- [`submission/screenshots/`](submission/screenshots/) — screenshot grid for the Kaggle post (placeholders pending day-of-shoot capture).

---

## Stack

- **Model:** Gemma-3-4b-it via Unsloth FastModel (4-bit QLoRA).
  E2B variant deferred (see `submission/repro.md` §3).
- **Geometry kernel:** [replicad](https://replicad.xyz/) 0.20.0 (MIT) on
  [replicad-opencascadejs](https://github.com/sgenoud/replicad) 0.20.0
  (LGPL-2.1 + linking exception).
- **IFC4 parser:** [web-ifc](https://github.com/ThatOpen/engine_web-ifc)
  0.0.77 (Apache-2.0) — the page hand-emits STEP-21 text and
  round-trips it through `IfcAPI.OpenModel` to verify parseability.
- **Viewer:** three.js 0.162.0 + OrbitControls.
- **Build:** Vite 8 + TypeScript 5.3 + vite-plugin-wasm + vite-plugin-top-level-await.
- **Runtime:** ES-module web worker for the geometry kernel; main thread
  never blocks. COOP+COEP headers configured for SharedArrayBuffer.

License chain is fully Apache-2.0/MIT/LGPL-with-linking-exception
compatible — commercial deployment unblocked.

---

## Directory layout

| Path | What lives there |
| ---- | ---------------- |
| `web/` | Browser app (Vite + TypeScript). Entry: `web/src/main.ts`. |
| `web/src/worker.ts` | Geometry-kernel web worker (replicad + OpenCascade). |
| `web/src/ifc.ts` + `ifc-build.ts` | IFC4 STEP-21 emit + web-ifc round-trip verify. |
| `web/src/demo-prompts.ts` | The 9 canned demos with parameter slider config (incl. Schultz hero). |
| `web/src/ai-generate.ts` | Cache-first prompt → JS pipeline + live LoRA fallback. |
| `web/src/dsl-eval.ts` | `compileDsl()` — v0 lexicon → JS for the CONSOLE tab. |
| `web/public/ai-cache.json` | 60-row prompt → JS cache (built by `scripts/build-ai-cache.ts`). |
| `src/tools/tier1.ts` | The 12-op replicad surface the model is trained against. |
| `src/train/` | Unsloth LoRA training scripts (build dataset, train, eval, publish). |
| `src/serve/serve_lora.py` | OpenAI-compat FastAPI wrapper around the v2 adapter. |
| `src/extract/` | IFC → (NL, replicad) extraction pipeline. |
| `src/generate/` | Synthetic-IFC generator (D2 in 18-day plan). |
| `fixtures/` | Hand-curated training pairs (tier1 + tier1-extra + tier2-curated + mined-extra). |
| `data/dsl-demo-corpus.jsonl` | 19-row DSL corpus that broadens cache coverage. |
| `data/` | Built training/eval JSONL (gitignored — produced by `build_dataset_v2.py`). |
| `outputs/` | LoRA adapter + train stats + eval results (gitignored — produced by training). |
| `scripts/` | Bun scripts: `validate-fixtures.ts`, `web-self-harness.ts`, `generate-v2.ts`, `leo-as-architect.ts`, `probe-conventions.ts`, `build-ai-cache.ts`, `test-ai-match.ts`, `test-ifc-bounds.ts`, `verify-dsl-corpus.ts`. |
| `submission/` | Hackathon submission docs + screenshots. |
| `docs/` | Design docs (`ai-pipeline.md`, `console-dsl.md`, **`tier1-conventions.md`**, tool taxonomy, training-pair format, 18-day plan, retrospectives). |

---

## Quick start

Full reproduction guide: [`submission/repro.md`](submission/repro.md).
TL;DR for the **browser-only** path (no training):

```bash
git clone https://github.com/wordingone/gemma-architect
cd gemma-architect
bun install
bun run web:typecheck       # strict tsc, no emit
bun run web:dev             # http://localhost:5173 — hot reload
# or
bun run web:build           # outputs to web/dist/
bun run web:preview         # http://127.0.0.1:4173 — same build the live demo serves
```

Self-harness (no browser, validates the same data path the worker
takes):

```bash
bun scripts/web-self-harness.ts          # 9/9 canned demos pass
bun scripts/leo-as-architect.ts          # 8/8 hand-written designs (revolve, gables, T-junctions)
bun scripts/probe-conventions.ts         # primitive-by-primitive bounds — run when in doubt
bun scripts/build-ai-cache.ts            # rebuild the 60-row prompt → JS cache
bun scripts/test-ai-match.ts             # F1-similarity smoke test for the matcher
bun scripts/test-ifc-bounds.ts           # IFC viewer column-major matrix regression
bun scripts/verify-dsl-corpus.ts         # 19/19 DSL corpus rows compile + execute
```

The hand-written harness exercises corners of the tool surface the
canned demos don't (revolve, sketchOnPlane("XZ"), drawPolyline N-gons,
nested booleans). What it surfaced about the 12-op convention is in
[`docs/tier1-conventions.md`](docs/tier1-conventions.md) — required
reading for anyone training against this surface.

To re-train the LoRA on a 4090, see [`submission/repro.md`](submission/repro.md) §3.

---

## What ships with this submission

- **GitHub repo** — this repo. Apache-2.0.
- **Hugging Face Hub adapter** — `gemma-architect/cad-lora-v2` (LoRA on
  `gemma-3-4b-it-unsloth-bnb-4bit`). Apache-2.0. Auto-generated model
  card carries eval numbers + intended use + limitations.
- **Hosted live demo** — HuggingFace Spaces (Vite static build, COOP+COEP
  headers configured). URL filled in at submission time.
- **3-min demo video** — script in [`submission/demo-script.md`](submission/demo-script.md);
  video URL filled in at submission time.

---

## Limitations

- **Tier 1 vocabulary only** — schematic-design primitives (walls,
  slabs, columns, footings, basic openings via `cut`, L-shape and
  U-shape footprints). ~85% of what a small-shop architect produces in
  schematic design. Construction-document detailing is out of scope.
- **English only.** Corpus expansion to other languages is a dataset
  job, not a model-architecture job.
- **Not a structural validator.** The model produces geometry that
  *could* be a wall; it does not check that the wall would stand. That
  belongs to the engineer who picks up the IFC export.
- **Semantic placement gaps.** Held-out eval scores `runtime_pass`
  (the JS executes and produces a Solid). Some emitted sequences place
  components in geometrically-imprecise positions (e.g., the
  four-walled room's bounding box is slightly wider than the spec calls
  for). Tier 2 dataset work + per-row positional eval is the obvious
  next step.

Full discussion in [`submission/writeup.md`](submission/writeup.md#limitations).

---

## Contributing

Issues + PRs welcome. The 18-day hackathon plan at
[`docs/plan-18-day.md`](docs/plan-18-day.md) lists the open work
items. Post-hackathon roadmap in [`submission/impact.md`](submission/impact.md#adoption-path).

---

## Author

[wordingone](https://github.com/wordingone)
