# #558 LiteRT/MediaPipe-Web Feasibility Map

**Issue:** #558  
**Date:** 2026-06-05  
**Author:** Archie  
**Scope:** Survey-only. No code change. Leo-gateable before any runtime swap.

---

## A — Prior State Recovery

**Finding: no prior LiteRT investigation exists in this codebase.**

- Zero LiteRT/MediaPipe references in source (`git grep -i litert mediapipe`: 0 hits).
- Zero commits matching `litert|mediapipe` in full git history.
- The MTP audit doc (`docs/engine-audit-mtp.md`, Eli, 2026-05-11, issue #403) investigated upstream transformers.js speculative-decode support — found blocked: no `assistant_model` port, no `Gemma4AssistantForCausalLM` ONNX checkpoint. Recommended re-audit at next transformers.js release.
- Since that audit, custom 3-session MTP spec-decode was implemented independently in `webgpu-mtp-backend.ts` (issue #751) — does not depend on transformers.js's speculative-decode API. Currently **disabled** (`_effectiveDrafterUrl = null` in `model-worker.ts:682`) while +60s OOM investigation is in progress.
- The LiteRT track (`CC#19`) was user-directed 2026-06-05 — this document is the first artifact.

**Why it stalled:** It never started. This is a fresh investigation.

---

## B — Current Stack Baseline (Regression Yardstick)

### Runtime

| Component | Value |
|---|---|
| JS library | `@huggingface/transformers@4.2.0` (transformers.js) |
| ORT-web version | `onnxruntime-web@1.26.0-dev.20260416-b7804b056c` (drafter sessions) |
| Execution provider | WebGPU primary; WASM (CPU) for iGPU/software adapters |
| Model (default) | `onnx-community/gemma-4-E4B-it-ONNX` (q4f16, WebGPU) |
| Model (fallback) | `onnx-community/gemma-4-E2B-it-ONNX` (via `?gemma_model=e2b`) |
| Drafter | E4B drafter, fp32 ONNX ~302MB (WASM EP) — **currently disabled** |
| Context window | 16,384 tokens (WEBGPU_CONTEXT_LIMIT) |
| Multimodal | Image (`RawImage.fromURL`) + Video (`RawImage[]` per frame) via `AutoProcessor` — **working** |
| Model cache | OPFS custom cache (persistent); falls back to Cache API → in-memory |
| Estimated cold-cache download | 5.5 GB (ONNX shards + embeddings + tokenizer + drafter) |

### Existing ONNX optimizations

| Optimization | Impl. location | Notes |
|---|---|---|
| Static KV cache | transformers.js config | Enabled at load; eliminates dynamic KV allocation per step |
| freeDimensionOverrides | removed in #441 | Was causing ORT errors — removed, not portable |
| OPFS custom cache | `model-worker.ts:332–410` | Persistent, eviction-resistant; first-visit downloads to OPFS |
| iGPU/software adapter fallback | `model-worker.ts:511–514` | Forces WASM EP when integrated or software GPU detected |
| Pre-acquired WebGPU device | `model-worker.ts:420–505` | ORT gets our device reference before from_pretrained; eliminates device-null window |
| Cold/warm-cache warmup step count | `model-worker.ts:645` | 64 steps cold-cache, 8 steps warm-cache — pre-allocates buffer pool |
| Post-drafter GPU flush | `model-worker.ts:765–799` | Drains ORT GPU queue after drafter init before first real inference |
| WASM drafter EP | `model-worker.ts:722–726` | Prevents drafter GPU session from competing with main model VRAM |
| Conversation trimming | `model-worker.ts:112–139` | 4096 token ceiling; drops oldest pairs to prevent OOM on long sessions |
| 3-retry buffer_manager recovery | `model-worker.ts:1098–1150` | Retry with flush on `buffer_manager|unaligned accesses` errors |

**turboquant:** Not present and not applicable. turboquant is the avir-cli GGUF quantization pipeline. WEB-CAD's inference path is ONNX-only; turboquant is not in scope.

### Current cold-cache performance (deployer note)

No deployed-Pages cold-cache benchmark has been captured yet under the current stack. A baseline measurement is required before any comparison claim can be made. The existing telemetry ring (`window.__telemetry`) captures `prefill_ms`, `decode_ms`, `tokens_out`, `tg_tps` per turn — running the 5 benchmark prompts from `docs/engine-audit-e2b-vs-e4b.md` against deployed Pages would give the E4B cold/warm baseline.

**Current multimodal status:** Working. Image dispatch: `RawImage.fromURL` + `AutoProcessor` for image content blocks. Video dispatch: `RawImage[]` per frame, `proc(chatText, null, [videoFrames])`. Confirmed wired in `model-worker.ts:914–968`.

---

## C — Feasibility Per Piece

### C1 — LiteRT/MediaPipe-Web (`@mediapipe/tasks-genai`)

**What it is:** Google's LiteRT-LM runtime exposed via `@mediapipe/tasks-genai` npm package. Uses `.litertlm` or `.task` model format (not ONNX). Backend is WebGPU + WASM (native Google ML stack).

**Available Gemma4 web models:**
- `litert-community/gemma-4-E2B-it-litert-lm` → `gemma-4-E2B-it-web.litertlm`
- `litert-community/gemma-4-E4B-it-litert-lm` → `gemma-4-E4B-it-web.litertlm` (2.97 GB)

**Claimed performance (E4B, M4 Max):** Prefill 1,590 tok/s, decode 44 tok/s — measured on top-tier hardware (MacBook Pro 2024, Apple M4 Max, 48 GB, 40 GPU cores). Not representative of the median WEB-CAD user's machine.

**Multimodal status: BLOCKED.**
- `gemma-4-E4B-it-web.litertlm` is **text-only on web** (confirmed in model card).
- LiteRT-LM issue [#2150](https://github.com/google-ai-edge/LiteRT-LM/issues/2150): Gemma4 multimodal throws `INVALID_ARGUMENT: LlmVisionInferenceCalculator` — no workaround, requires engineering fix by Google.
- MediaPipe issue [#6270](https://github.com/google-ai-edge/mediapipe/issues/6270): `RuntimeError: memory access out of bounds` on Chrome 146 loading Gemma4 web.task — separate stability bug.
- Gemma-3n multimodal on web DOES work (separate issue #6024) — this is Gemma4-specific regression.

**API surface:** `LlmInference.createFromOptions()` → `generateResponse()`. Completely different from transformers.js (`from_pretrained` / `generate`). Would require full API rewrite in `model-worker.ts`.

**MTP in tasks-genai web API:** Not exposed. The LiteRT-LM runtime claims "up to 2.2x speedup via native MTP" but this is internal to the C++ runtime — no JS API knob. The 3-session custom MTP in `webgpu-mtp-backend.ts` cannot be wired to LiteRT.

**Model format migration:** `.litertlm` is not ONNX. Existing `onnx-community` models are not reusable. A full separate model download on CDN is required (2.97 GB for E4B web). Two CDN assets per model variant, new caching strategy required (OPFS custom cache would need rewrite for `.litertlm` fetch pattern).

**Portability of existing ONNX optimizations to LiteRT:**

| Optimization | Portable? | Notes |
|---|---|---|
| Static KV cache | No — ONNX-specific | LiteRT uses its own KV management |
| OPFS cache | Partial | Fetch + OPFS write pattern is portable, but `.litertlm` is a single large blob vs ONNX shards |
| iGPU gate | Portable | Adapter fingerprinting + WebGPU query is independent of runtime |
| Pre-acquired device | No | LiteRT manages its own WebGPU device; no external injection API |
| Warmup step control | No | No `generate()` step-count API in tasks-genai |
| WASM drafter | Not applicable | LiteRT's MTP is internal; no WASM drafter to inject |
| Buffer_manager retry | Not applicable | LiteRT error surface is different |
| Conversation trimming | Portable | Logic is model-agnostic; LiteRT has same context-window constraints |

**Summary:** LiteRT/MediaPipe-Web Gemma4 is viable for **text-only** use cases with ~full rewrite. **Not viable today for multimodal** — blocked by upstream issue #2150 with no ETA.

---

### C2 — MTP (Multi-Token Prediction)

**Current state:** Custom 3-session spec-decode implemented, currently disabled.

- `webgpu-mtp-backend.ts`: embed_tokens + decoder_model_merged (from transformers.js ONNX sessions) + E4B drafter (fp32 ONNX, WASM EP, ~302 MB)
- Disabled: `_effectiveDrafterUrl = null` in `model-worker.ts:682` (diagnostic isolation for +60s OOM)
- When enabled: fires on `useMtp && inputLength < 900` — conservative threshold to avoid drafter KV mismatch on long prompts
- Acceptance: real greedy token comparison (`MTP_VERIFICATION_WIRED = true`), not accept-all

**LiteRT MTP path:** Internal to C++ runtime, not exposed via `@mediapipe/tasks-genai` JS API. If LiteRT swap happened, custom MTP would be lost.

**Re-enable path (ORT-only):** Unrelated to LiteRT. Once +60s OOM investigation (#281-scope) confirms stability, re-enable by restoring `_effectiveDrafterUrl = DRAFTER_ONNX_URL`.

**Feasibility for LiteRT:** N/A. LiteRT's internal MTP is opaque to the caller.

---

### C3 — turboquant

**Not applicable.** turboquant is avir-cli's GGUF quantization track for llama.cpp/llama-server. WEB-CAD uses ONNX q4f16 — the quantization is done upstream by `onnx-community` at export time. There is no turboquant-equivalent in WEB-CAD's path.

---

### C4 — ONNX optimizations (existing, within current stack)

The existing ONNX optimization set is already deep (see B above). The meaningful remaining levers within the ORT-web path:

| Potential opt | Status | Notes |
|---|---|---|
| Re-enable MTP drafter | Blocked on OOM investigation | ~1.5–2x decode speedup on short prompts when it was active |
| E4B → larger model | Already using E4B | E2B available via URL param |
| onnxruntime-web upgrade | Currently on dev build (1.26.0-dev) | Stable release upgrade could improve perf/stability |
| Prefill chunking | Not implemented | Splits long prefills to prevent timeout; not urgent |
| KV cache quantization | Upstream-only | Would require re-export at onnx-community |

---

## D — Recommended Stack + Zero-Regression Plan

### Recommendation: Do not swap to LiteRT now.

**Blocking reason: 100% multimodal regression risk.** LiteRT-LM web Gemma4 is text-only (confirmed model card + issue #2150). WEB-CAD's image and video input paths are working today on the ONNX/ORT stack. A LiteRT swap would zero out both surfaces with no recovery path until Google ships Gemma4 multimodal support for the web runtime.

**Secondary reasons:**
- Complete API rewrite required (not an in-place optimization).
- Existing 17+ OOM fixes and stability hardening (40+ PRs) would need re-validation against LiteRT's error surface.
- No deployed-Pages cold-cache baseline yet — can't quantify the "win" without a measurement.
- Two separate 2.97 GB CDN assets required (one per model variant).

### When to revisit

Trigger: LiteRT-LM issue [#2150](https://github.com/google-ai-edge/LiteRT-LM/issues/2150) closes with Gemma4 multimodal support confirmed on web. Then:

1. **Text-only A/B behind `?engine=litert` URL param.** No rip-out. Both stacks alive.
2. **Cold-cache ORT baseline first.** Run the 5-prompt bench from `engine-audit-e2b-vs-e4b.md` on deployed Pages, capture `prefill_ms`/`decode_ms`/`tokens_out`/`tg_tps`.
3. **LiteRT text-only bench on same hardware.** Compare decode tok/s and prefill time.
4. **If text-only LiteRT win ≥20%:** proceed to multimodal gate.
5. **Multimodal gate:** image input and video input must both pass on LiteRT before any switchover.
6. **ORT stack remains as fallback** for iGPU/software adapters until LiteRT's classification path is validated.

### Zero-regression test plan (for future LiteRT gate)

| Surface | Test | Current status |
|---|---|---|
| Cold-cache text boot | Full load to `boot-complete`, no error | ✓ Working (ORT) |
| Warm-cache text boot | OPFS → `opfs-warm-start` signal | ✓ Working |
| Single dispatch | `draw a wall from (0,0) to (5,0)` → 1 tool call | ✓ Working |
| Multi-dispatch | `create a room: 4 walls...` → 5 tool calls | ✓ Working |
| Long session trim | 5+ turn session, no OOM | ✓ Working (conv trim) |
| Image input | Image URL in last user message → vision encode | ✓ Working (ORT); ✗ Blocked (LiteRT #2150) |
| Video input | Frame URLs → video content block | ✓ Working (ORT); ✗ Blocked (LiteRT #2150) |
| IFC export | Export scene after dispatch → valid IFC | ✓ Working |
| MTP spec-decode | Short prompt → drafter spec-decode → accepted tokens | ⚠ Disabled (OOM investigation) |
| iGPU fallback | WASM EP on classification-triggered path | ✓ Working (ORT) |

All surfaces must pass on deployed Pages cold-cache before Leo gates any LiteRT merge.

---

## References

- [LiteRT-LM issue #2150 — Gemma4 multimodal blocked on web](https://github.com/google-ai-edge/LiteRT-LM/issues/2150)
- [MediaPipe issue #6270 — memory OOB on Chrome 146 with Gemma4 web.task](https://github.com/google-ai-edge/mediapipe/issues/6270)
- [litert-community/gemma-4-E4B-it-litert-lm model card](https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm)
- [MediaPipe LLM Inference web guide](https://developers.google.com/edge/mediapipe/solutions/genai/llm_inference/web_js)
- [LiteRT-LM announcement — blazing fast on-device GenAI](https://developers.googleblog.com/blazing-fast-on-device-genai-with-litert-lm/)
- WEB-CAD docs: `docs/engine-audit-mtp.md`, `docs/engine-audit-e2b-vs-e4b.md`
- WEB-CAD source: `web/src/agent/model-worker.ts`, `web/src/agent/webgpu-mtp-backend.ts`
