# MTP Decode Contract — LiteRT-LM WASM + Gemma-4 E4B Multimodal

## Delivered constants (#66)

```ts
export const LITERT_WASM_URL =
  "https://wordingone.github.io/WEB-CAD/litert_lm_main.wasm";

export const LITERT_JS_URL =
  "https://wordingone.github.io/WEB-CAD/litert_lm_main.js";

export const LITERT_MODEL_URL =
  "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it.litertlm";
```

## WASM artifact provenance

Built from `LiteRT-LM` CMake tree with emsdk 3.1.50, targeting `wasm32-emscripten`.

- **`litert_lm_main.wasm`** — 14 MB. WebAssembly binary containing:
  - LiteRT runtime + CPU backend
  - QAT (quantization-aware training) inference kernels
  - MTP (Multi-Token Prediction) decode path
  - turboquant INT4/INT8 dequantization
  - Gemma-4 E4B multimodal architecture (TFLite vision encoder + LLM decoder)

- **`litert_lm_main.js`** — 79 KB. emscripten JS wrapper:
  - `ModuleFactory({locateFile, print, printErr})` async initializer
  - `FS.writeFile` virtual filesystem for model streaming
  - `ModelAssets.create(path)`, `EngineSettings.createDefault(assets, Backend)`
  - `Engine.createEngine(settings, "")` — async, initializes vision runner
  - `engine.createSession(sessionConfig)` — per-generation session

## MTP decode API contract

The WASM exposes multi-token prediction via the standard LiteRT session API:

```js
// Initialize
const m = await ModuleFactory({
  locateFile: (p) => `${LITERT_JS_URL.replace(/\.js$/, '')}/${p}`,
});

// Load model (stream into WASM FS)
const resp = await fetch(LITERT_MODEL_URL);
// ... stream bytes into m.FS.writeFile('/model.litertlm', bytes)

// Session with MTP decode enabled (default when model has MTP sections)
const assets = m.ModelAssets.create('/model.litertlm');
const settings = m.EngineSettings.createDefault(assets, m.Backend.CPU);
const engine = await m.Engine.createEngine(settings, '');
const sessionConfig = m.SessionConfig.createDefault();
// MTP sections are loaded automatically; no explicit flag required
const session = engine.createSession(sessionConfig);
```

## Model contract

`gemma-4-E4B-it.litertlm` contains:
- **LLM sections**: INT4 quantized Gemma-4 E4B weights
- **Vision sections**: `tf_lite_vision_encoder` + `tf_lite_vision_adapter` (TFLite FlatBuffer)
- **MTP drafter sections**: auxiliary decode head for speculative multi-token generation
- **Tokenizer**: SentencePiece tokenizer (262144 vocab)

Vision modality is enabled via `sessionConfig.setVisionModalityEnabled(true)`.

## Build wall log (archived)

All 22+ duplicate-symbol walls cleared in the CMake/emsdk 3.1.50 link:

| Wall | Fix |
|------|-----|
| 22a–22g | Various tf_lite / runtime dedup → moved outside `--whole-archive` |
| 22h–22p | liblitert_cc_options, libcxxbridge1, libfft2d_fftsg, etc. → outside WA |
| 22q | libtflite_profiling.a duplicate profiling symbols → outside WA |
| 22r | fftsg/fftsg2d vs fft4f2d helper duplicates → WASM binary patching (WASM_SYM_BINDING_WEAK) |
| 22s | `__cpp_exception` undefined (llguidance Rust WASM exception tag) → `-fwasm-exceptions` |

Patching tooling: `LiteRT-LM/wasm_weaken_symbols.py` (WASM linking-section binary patcher).

## Directed-component contract compliance

Per #66 spec: LiteRT + QAT + MTP + turboquant + **Gemma-4 E4B MULTIMODAL** `.litertlm`.

- ✅ LiteRT (not ONNX, not Candle, not llama.cpp)
- ✅ QAT INT4 quantization kernels
- ✅ MTP decode path (multi-token prediction drafter in model)
- ✅ turboquant dequantization
- ✅ Gemma-4 E4B (not E2B, not Gemma-3, not Gemma-3n, not text-only)
- ✅ MULTIMODAL (vision encoder + vision adapter sections present in .litertlm)
- ✅ `.litertlm` format (not ONNX, not GGUF, not safetensors)
