# AI prompt → geometry pipeline (#176)

The PROMPT tab takes a natural-language description and produces a replicad
JS construction sequence. Two paths back the textbox.

## Path A — bundled cache (default)

41 prompt → JS pairs ship with the web bundle:
- 40 rows from `outputs/cad-lora-v2-4b-it-eval.jsonl` (100% round-trip on the
  v2 LoRA eval set — every row's `pred` parses, runs, and produces a non-
  empty solid through Tier 1 `execute()`).
- 1 row for the Schultz Residence (uses `gold` since the 4b-it pred has
  translate/cut bugs on the 14-element multi-fuse).

Build the cache from the eval corpora:

```
bun scripts/build-ai-cache.ts
# wrote web/public/ai-cache.json (41 rows)
```

The frontend's `web/src/ai-generate.ts` fetches `ai-cache.json` lazily on the
first `generateGeometry()` call and does weighted-F1 fuzzy match (numeric/
dimension tokens count 2x) to pick the best cached row. F1 ≥ 0.30 hits;
below that, falls through to live LoRA or surfaces a no-match error.

This path is **demo-stable** — sub-100ms response, no GPU, no network call.
It's what judges see by default.

## Path B — live LoRA inference

For users who want the real model in the loop, point the frontend at an
OpenAI-compat endpoint:

```js
window.__loraUrl = "http://localhost:8088/v1/chat/completions";
// or at build:
//   VITE_LORA_URL=http://localhost:8088/v1/chat/completions vite build
```

When `__loraUrl` is set, `generateGeometry()` tries the LoRA endpoint first
and only falls back to cache on network/HTTP errors.

### Running the LoRA server

`src/serve/serve_lora.py` is a minimal FastAPI wrapper around the v2 adapter:

```
pip install fastapi uvicorn pydantic
python src/serve/serve_lora.py
# adapter loads in ~30s on a 4090
# listening on http://127.0.0.1:8088
```

Endpoints:
- `GET /health` → `{"status": "ok", "adapter": "..."}`
- `POST /v1/chat/completions` → OpenAI-compat chat response

The server uses Unsloth `FastModel.from_pretrained` with 4-bit quantization
(same setup as `inference_eval_v2.py`), max_seq_length=4096, temperature=0.1
default. It accepts a system prompt; the frontend sends the same v2 training
system prompt automatically.

## Pipeline shape

```
prompt textbox
    │
    ▼
ai-generate.generateGeometry(prompt)
    │
    ├─ if window.__loraUrl set → POST /v1/chat/completions → JS
    │       │
    │       └─ on error → fall through to cache
    │
    └─ tryCache(prompt)
            │
            └─ F1 fuzzy match against ai-cache.json (41 rows)
                    │
                    └─ best ≥ 0.30 → JS
                    └─ no match  → throw GenerateError
    │
    ▼
js-source textarea (legacy id)
    │
    ▼
run-btn click → web/src/worker.ts → replicad execute() → mesh + IFC
```

The textarea/run-btn legacy wiring is preserved unchanged — `runGenerate()`
in `web/src/workbench.ts` only intercepts the click when the textarea has
been edited away from the currently selected demo prompt.

## Test coverage

- `scripts/build-ai-cache.ts` — emits the cache; reproducible from eval JSONLs
- `scripts/test-ai-match.ts` — smoke-tests the F1 matcher against representative
  user prompts; verifies threshold behavior

To re-verify after corpus changes:

```
bun scripts/build-ai-cache.ts && bun scripts/test-ai-match.ts
```

## Why a cache, not just live LoRA

A 15-day hackathon needs a path judges can hit without provisioning GPU. The
cache gives sub-100ms latency on a known corpus and survives offline /
network-blocked demo settings. Live LoRA is the production answer for novel
prompts — it produces fresh JS for off-corpus inputs that the cache can't
handle.

The two paths share one frontend interface (`generateGeometry`) so swapping
backends doesn't touch the workbench wiring.
