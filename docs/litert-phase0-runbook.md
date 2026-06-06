# LiteRT Phase 0 — Toolchain Runbook

WSL2 setup, model conversion, quantization, .task bundling, and browser load verification.
Proven on 2026-06-06 against `litert-torch==0.9.1` + `litert_lm_builder==0.13.0`.

---

## Environment

**Host:** Windows 11, CUDA GPU available in WSL2
**WSL2 distro:** Ubuntu 22.04 (or 24.04), Python 3.12 system install (PEP 668 — venv required)
**Venv:** `/home/jun/litert-venv`

---

## 1. WSL2 venv creation

```bash
python3 -m venv /home/jun/litert-venv
source /home/jun/litert-venv/bin/activate
pip install --upgrade pip
```

---

## 2. Package installation

```bash
# PyTorch (CUDA 13.0 / cu130)
pip install torch --index-url https://download.pytorch.org/whl/cu130

# LiteRT toolchain
pip install litert-torch==0.9.1
pip install litert-lm-builder==0.13.0

# Tokenizer
pip install sentencepiece==0.2.1

# Required for multimodal export (AutoImageProcessor)
pip install torchvision --index-url https://download.pytorch.org/whl/cu130
```

**Import names:**
- `litert_torch` (not `ai_edge_torch` — that's the deprecated shim)
- `litert_lm_builder`

---

## 3. tensorflow.lite.python shim (required)

`litert_torch.generative.layers.lora` imports from `tensorflow.lite.python.schema_py_generated`,
but `tensorflow` is NOT installed. Fix: create a shim pointing to `ai_edge_litert`.

```bash
VENV=/home/jun/litert-venv
SITE=$VENV/lib/python3.12/site-packages

mkdir -p $SITE/tensorflow/lite/python
touch $SITE/tensorflow/__init__.py
touch $SITE/tensorflow/lite/__init__.py
touch $SITE/tensorflow/lite/python/__init__.py

cat > $SITE/tensorflow/lite/python/schema_py_generated.py <<'EOF'
from ai_edge_litert.schema_py_generated import *
from ai_edge_litert.schema_py_generated import (
    ModelT, SubGraphT, TensorT, OperatorT, BufferT,
    BuiltinOperator, BuiltinOptions, Padding, ActivationFunctionType,
    QuantizationParametersT, DimensionMetadataT,
)
EOF
```

---

## 4. Model conversion (INT8 dynamic quantization)

Key API facts:
- `litert_torch.convert(module, sample_args, quant_config=None)` → `LiteRTModel`
- `LiteRTModel.export(path)` writes `.tflite`
- `quant_recipes.full_dynamic_recipe(mcfg=model_config)` → INT8 `QuantConfig`
- `KVCache.from_model_config(kv_cache_max, config)` — `kv_cache_max` is first positional
- `DecoderOnlyModel(config, mask_cache_size=N)` — `mask_cache_size > 0` required

Minimal working example (micro Gemma-compat, vocab=64, dim=64, 1 layer):

```python
import litert_torch as lt
from litert_torch.generative.layers import model_config as cfg, kv_cache as kv_utils
from litert_torch.generative.utilities import model_builder
from litert_torch.generative.quantize import quant_recipes

attn = cfg.AttentionConfig(num_heads=4, head_dim=16, num_query_groups=1,
    rotary_base=10000, rotary_percentage=1.0, enable_kv_cache=True)
ff = cfg.FeedForwardConfig(type=cfg.FeedForwardType.GATED,
    activation=cfg.ActivationConfig(cfg.ActivationType.SILU), intermediate_size=64)
norm = cfg.NormalizationConfig(type=cfg.NormalizationType.RMS_NORM, epsilon=1e-6)
block = cfg.TransformerBlockConfig(attn_config=attn, ff_config=ff,
    pre_attention_norm_config=norm, post_attention_norm_config=norm)
mc = cfg.ModelConfig(vocab_size=64, num_layers=1, max_seq_len=32, embedding_dim=64,
    block_configs=block, final_norm_config=norm,
    lm_head_share_weight_with_embedding=True, enable_hlfb=True)

SEQ_LEN = 8
model = model_builder.DecoderOnlyModel(mc, mask_cache_size=SEQ_LEN).eval()
kv    = kv_utils.KVCache.from_model_config(kv_cache_max=SEQ_LEN, config=mc)

tokens    = torch.full((1, SEQ_LEN), 0, dtype=torch.int)
input_pos = torch.arange(0, SEQ_LEN, dtype=torch.int)

qcfg = quant_recipes.full_dynamic_recipe(mcfg=mc)
litert_model = lt.convert(model, (tokens, input_pos, kv), quant_config=qcfg)
litert_model.export("/tmp/model_int8.tflite")
```

**Constraint:** `embedding_dim = num_heads × head_dim` (e.g., 64 = 4 × 16).

---

## 5. .task bundling

```python
import litert_lm_builder as llb
from litert_lm_builder import litertlm_core
import sentencepiece as spm, io

# Train a minimal SentencePiece tokenizer (BPE, vocab must match model)
spm.SentencePieceTrainer.train(
    input="corpus.txt", model_prefix="tokenizer",
    vocab_size=64, character_coverage=1.0, model_type="bpe",
    pad_id=0, unk_id=1, bos_id=2, eos_id=3)

# Bundle
builder = llb.LitertLmFileBuilder()
builder.add_tflite_model("model_int8.tflite", llb.TfLiteModelType.PREFILL_DECODE)
builder.add_sentencepiece_tokenizer("tokenizer.model")
builder.add_system_metadata(llb.Metadata(key="version", value="v1", dtype=llb.DType.STRING))

with litertlm_core.open_file("model.task", "wb") as f:
    builder.build(f)

# Inspect
peek_out = io.StringIO()
llb.peek_litertlm_file("model.task", dump_files_dir=None, output_stream=peek_out)
print(peek_out.getvalue())
```

Output format: LiteRT-LM v1.5.0 (2 sections: `PREFILL_DECODE` + `SP_Tokenizer`).

---

## 6. Browser load verification

**Runtime:** `@litert-lm/core@0.13.1` (CDN: `https://cdn.jsdelivr.net/npm/@litert-lm/core@0.13.1/+esm`)
**API:**
```js
import { Engine, Backend } from '@litert-lm/core';
const engine = await Engine.create({ model: readable_stream, backend: Backend.CPU });
const chat   = await engine.createConversation();
const reply  = await chat.sendMessage('hello');
```
`Backend.CPU` (value=3) works without WebGPU. `Backend.GPU_ARTISAN` (default) requires WebGPU.

**Path fix:** On GitHub Pages at `…/WEB-CAD/page.html`, use **relative** fetch paths
(`fetch('test/model.task')`) not absolute paths (`fetch('/test/model.task')`) — the absolute
path drops the `/WEB-CAD/` subdir prefix.

**CDP test script** (`scripts/phase0-browser-test.mjs`, Bun runtime):
```bash
cd B:/M/WEB-CAD && bun scripts/phase0-browser-test.mjs
```
Uses Bun's built-in `WebSocket` (no `ws` npm package needed). Navigates to deployed Pages,
clicks "Run test", polls `window.__phase0Result`, reports PASS/FAIL with engine output.

---

## Common errors and fixes

| Error | Fix |
|---|---|
| `ModuleNotFoundError: No module named 'tensorflow'` | Create the `tensorflow.lite.python.schema_py_generated` shim (§3) |
| `TypeError: KVCache.from_model_config() missing 1 required positional argument: 'config'` | Signature is `(kv_cache_max, config, ...)` — pass `kv_cache_max` first |
| `AssertionError: Mask cache must be built` | `DecoderOnlyModel(config)` defaults `mask_cache_size=0`. Pass `mask_cache_size=SEQ_LEN` |
| `AttributeError: 'FeedForwardType' has no attribute 'GATED_LINEAR_UNIT'` | Use `cfg.FeedForwardType.GATED` (not `GATED_LINEAR_UNIT`) |
| `TypeError: peek_litertlm_file() missing 2 required positional arguments` | Signature: `(path, dump_files_dir, output_stream)`. Pass all 3. |
| HTTP 404 on `.task` file in Pages | Use relative fetch path, not absolute (`/test/...` → `test/...`) |
| `SIGTERM at MLIR lowering (exit 15)` | MLIR lowering peaks at 40-60GB RAM on E4B. Add `experimental_lightweight_conversion=True` to `lt_export.export()` — reduces peak RAM by streaming MLIR conversion. Clean up leftover `tmp*/` dirs from the killed run first. |

---

## Phase 1 — E4B multimodal full export

**Target:** `google/gemma-4-E4B-it` (~8B total / 4.5B effective, integrated vision encoder ~150M params)

litert-torch 0.9.1 has native Gemma-4 support at `litert_torch/generative/export_hf/model_ext/gemma4/`.

### Export command (Python API)

```python
from litert_torch.generative.export_hf import export as lt_export

lt_export.export(
    model='google/gemma-4-E4B-it',
    output_dir='/home/jun/e4b_export',
    task='image_text_to_text',             # multimodal (decoder + vision)
    quantization_recipe='weight_only_wi4_afp32',
    export_vision_encoder=True,
    vision_encoder_quantization_recipe='weight_only_wi4_afp32',
    bundle_litert_lm=True,
    prefill_lengths=[512],
    cache_length=1024,
    experimental_lightweight_conversion=True,  # required: prevents OOM at MLIR lowering
)
```

Or CLI:
```bash
source /home/jun/litert-venv/bin/activate
HF_HOME=/home/jun/hf_models python3 -m litert_torch.generative.export_hf \
  google/gemma-4-E4B-it /home/jun/e4b_export \
  --task=image_text_to_text \
  --quantization_recipe=weight_only_wi4_afp32 \
  --export_vision_encoder=True \
  --vision_encoder_quantization_recipe=weight_only_wi4_afp32 \
  --bundle_litert_lm=True \
  --prefill_lengths=[512] \
  --cache_length=1024
```

### Available quantization recipes (ai_edge_quantizer)

| Recipe | Description |
|---|---|
| `weight_only_wi4_afp32` | Weight-only INT4, activation fp32 (**use this for memory reduction**) |
| `weight_only_wi8_afp32` | Weight-only INT8, activation fp32 |
| `dynamic_wi4_afp32` | Dynamic INT4 w + fp32 activation |
| `dynamic_wi8_afp32` | Dynamic INT8 w + fp32 activation (litert-torch default) |
| `static_wi8_ai8` | Static INT8 w + INT8 activation |

### Actual output sizes (E4B, verified 2026-06-05)

| Artifact | Size |
|---|---|
| Decoder INT4 (`model_quantized.tflite`) | 2.5 GB |
| Embedder INT4 (`embedder_quantized.tflite`) | 338.7 MB |
| Per-layer embedder INT4 (`per_layer_embedder_quantized.tflite`) | 1412.4 MB |
| Vision encoder INT4 (`vision_encoder_quantized.tflite`) | 142.7 MB |
| Vision adapter INT4 (`vision_adapter_quantized.tflite`) | 1.0 MB |
| Tokenizer (`tokenizer.json`) | 32.2 MB |
| **Bundle .litertlm** | **4.353 GB** |

Bundle is ~4.4 GB (not ~2.6 GB) because Gemma-4 uses Per-Layer Embeddings (PLE):
`externalize_embedder=True` + `single_token_embedder=True` exports a per_layer_embedder
that is 1.4 GB — much larger than a shared embedder. This is expected architecture overhead.

### System requirements

- WSL2 RAM: ≥32GB (model loads ~16GB BF16; conversion needs ~32-48GB virtual)
- Download: 16GB safetensors (`model.safetensors`)
- HF_HOME: set to writable path (e.g. `/home/jun/hf_models`) — `/home/jun/.cache/huggingface/hub` may have permission issues
- Auto-enabled by litert-torch: `externalize_embedder=True`, `single_token_embedder=True` (required for Gemma-4 Per-Layer-Embeddings)

### Browser load

Use `weight_only_wi4_afp32` for both decoder and vision encoder.
Browser target: GPU backend (`Backend.GPU_ARTISAN`) for real perf measurement.
Image tiling: E4B has native visual-token-budget knob (70/140/280/560/1120 tokens) —
start low (`vision_soft_tokens_per_image=70`) to bound peak activation memory.

### Three upstream bugs in litert-torch 0.9.1 — required patches

The `export_hf.export()` path has three bugs on 32 GB machines. All must be patched for a successful E4B export. See `C:/WINDOWS/TEMP/phase1-recovery-v3.py` for the full recovery script.

#### Bug 1 — Decoder MLIR OOM (fixed by export flag)

`export_text_prefill_decode_model` peaks at 40-60 GB during MLIR lowering unless `experimental_lightweight_conversion=True` is passed to `lt_export.export()`. This is documented but easy to miss. **Fix:** always pass `experimental_lightweight_conversion=True`.

#### Bug 2 — per_layer_embedder MLIR OOM (`export_additional_models_impl`)

`export_additional_models_impl` calls `converter.convert(strict_export=False)` **without** `lightweight_conversion`. MLIR lowering of the per_layer_embedder OOMs on 32 GB machines. **Fix:** monkey-patch the function:

```python
from litert_torch.generative.export_hf.core import export_lib
from litert_torch._convert import interface as converter_utils
import dataclasses, gc

def _patched_additional_models_impl(
    name, exportable_module_cls, source_model_artifacts, export_config, exported_model_artifacts
):
    model = source_model_artifacts.model
    text_model_config = source_model_artifacts.text_model_config
    quantization_recipe = export_config.quantization_recipe
    work_dir = export_config.work_dir
    embedder_module = exportable_module_cls(model)
    converter = converter_utils.Converter()
    sample_inputs = embedder_module.get_sample_inputs(text_model_config, export_config)
    for sig_name, (s_inputs, _) in sample_inputs.items():
        converter.add_signature(sig_name, embedder_module.eval(), sample_kwargs=s_inputs)
    lrt_model = converter.convert(
        lightweight_conversion=export_config.experimental_lightweight_conversion,
        strict_export=False,
    )
    model_path = os.path.join(work_dir, f'{name}.tflite')
    lrt_model.export(model_path)
    recipe_list = quantization_recipe.split(',') if quantization_recipe else [None]
    for recipe in recipe_list:
        model_path = export_lib.maybe_quantize_model(model_path, recipe)
        gc.collect()
    additional = exported_model_artifacts.additional_model_paths or {}
    additional[name] = model_path
    return dataclasses.replace(exported_model_artifacts, additional_model_paths=additional)

export_lib.export_additional_models_impl = _patched_additional_models_impl
```

**Correct import path:** `from litert_torch._convert import interface as converter_utils` (NOT `litert_torch.generative.export_hf.core.converter_utils` — that module doesn't exist).

#### Bug 3 — Vision encoder MLIR OOM (`export_vision_encoder_models`)

`export_vision_encoder_models` has **two** `converter.convert(strict_export=False)` calls — both missing `lightweight_conversion`. Both the encoder and adapter OOM. **Fix:** replace the entire function. See `phase1-recovery-v3.py` for the full replacement.

#### Phase-split for 32 GB RAM

With model loaded (24 GB), only 8 GB free for MLIR. The decoder quantization step also needs its own phase because it reads an 18 GB tflite and writes a 2.5 GB output — doing this with the HF model also in RAM = OOM.

**Phase order:**
1. `quantize_model(decoder_raw, recipe)` — standalone, no HF model loaded, peak ~22 GB
2. Load HF model, seed artifacts with quantized decoder path
3. `export_additional_models` (with Bug 2 patch)
4. `export_vision_encoder_models` (with Bug 3 patch)
5. `export_tokenizer`, `package_model`

### Two separate OOMs (Leo note)

1. **Conversion RAM OOM** — solve on conversion side (layer streaming, free other processes).
   Do NOT downsize model to avoid conversion OOM.
2. **Browser WASM heap OOM** — the real deliverable gate. Must measure peak heap with numbers.
