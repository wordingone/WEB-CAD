/// <reference lib="webworker" />
// litert-lm-backend.ts — route-c: LiteRT-LM VisionLiteRtCompiledModelExecutor JS integration (#617).
//
// Replaces the broken route-b MediaPipe path (INVALID_ARGUMENT: LlmVisionInferenceCalculator,
// LiteRT-LM issue #2150). Leo's #66 WASM build (litert_lm.wasm/.js) exposes the native
// VisionLiteRtCompiledModelExecutor with these image-input tensors:
//   kImages    — Float32, [batch, num_patches, patch_dim]   preprocessed image patches
//   kPositionsXy — Int32, [batch, num_patches, 2]           patch position grid (col, row)
//
// Scaffold: image preprocessing + tensor construction are fully implemented here.
// The LiteRtLmModule interface is the stub that accepts the #66 bundle when Leo delivers it.
// Wire-in is: import the bundle, call LiteRtLmBackend.setModule(m), done — zero redesign.
//
// DO NOT remove route-b (litert-route-b-probe files) until route-c renders a real vision result.

import type { InferenceBackend, LoadOpts, PostFn } from "./inference-backend.js";

// ── Vision preprocessing constants (Gemma-4 E4B, SigLIP ViT-400M) ────────────

const IMG_SIZE    = 896;   // Resize target per tile (pixels)
const PATCH_SIZE  = 14;    // Patch side in pixels
const GRID_SIZE   = IMG_SIZE / PATCH_SIZE;    // 64 — patches per side
const NUM_PATCHES = GRID_SIZE * GRID_SIZE;    // 4096
const PATCH_DIM   = PATCH_SIZE * PATCH_SIZE * 3; // 588 — floats per patch (RGB)

// SigLIP normalization: pixel / 255 * 2 - 1  (maps [0,255] → [-1,+1])
const NORM_SCALE  = 2.0 / 255.0;
const NORM_BIAS   = -1.0;

// ── LiteRtLmModule — stub for Leo's #66 WASM bundle ─────────────────────────
// When litert_lm.wasm/.js lands, it must implement this interface.
// setModule() wires it in; until then, the backend returns a capability-check error.

export interface LiteRtLmRunRequest {
  kImages:     Float32Array;   // [batch * num_patches * PATCH_DIM]
  kPositionsXy: Int32Array;    // [batch * num_patches * 2]
  numPatches:  number;
  tokenIds:    Int32Array;
  maxNewTokens: number;
}

export interface LiteRtLmRunResult {
  tokenIds:   Int32Array;
  prefillMs:  number;
  decodeMs:   number;
}

export interface LiteRtLmModule {
  /** Async init — load model weights from the given URL or ArrayBuffer. */
  load(source: string | ArrayBuffer, opts?: { opfsKey?: string }): Promise<void>;
  /** Synchronous vision+text inference via VisionLiteRtCompiledModelExecutor. */
  run(req: LiteRtLmRunRequest): Promise<LiteRtLmRunResult>;
  /** Release VRAM. */
  dispose(): void;
}

let _module: LiteRtLmModule | null = null;

/** Called by the worker init path once litert_lm.wasm/.js is available. */
export function setLiteRtLmModule(m: LiteRtLmModule): void {
  _module = m;
}

// ── Image → kImages + kPositionsXy ──────────────────────────────────────────

/**
 * Resize an ImageBitmap to IMG_SIZE×IMG_SIZE via OffscreenCanvas, extract patches,
 * return kImages (Float32, shape [NUM_PATCHES, PATCH_DIM]) and
 * kPositionsXy (Int32, shape [NUM_PATCHES, 2]) as flat arrays ready for LiteRT-LM.
 *
 * Multi-tile pan-and-zoom: for images with aspect ratio > 1.5 or < 0.67, callers
 * should slice the image into N tiles before calling patchify on each and concatenate
 * the results. Single-tile path is implemented here; tile loop lives in the backend.
 */
export function patchifyImage(
  bitmap: ImageBitmap,
): { kImages: Float32Array; kPositionsXy: Int32Array } {
  const canvas = new OffscreenCanvas(IMG_SIZE, IMG_SIZE);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, IMG_SIZE, IMG_SIZE);
  const { data } = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE);

  const kImages     = new Float32Array(NUM_PATCHES * PATCH_DIM);
  const kPositionsXy = new Int32Array(NUM_PATCHES * 2);

  for (let pr = 0; pr < GRID_SIZE; pr++) {
    for (let pc = 0; pc < GRID_SIZE; pc++) {
      const patchIdx = pr * GRID_SIZE + pc;
      kPositionsXy[patchIdx * 2]     = pc; // x = column
      kPositionsXy[patchIdx * 2 + 1] = pr; // y = row
      const patchBase = patchIdx * PATCH_DIM;
      for (let py = 0; py < PATCH_SIZE; py++) {
        for (let px = 0; px < PATCH_SIZE; px++) {
          const imgX  = pc * PATCH_SIZE + px;
          const imgY  = pr * PATCH_SIZE + py;
          const pixel = (imgY * IMG_SIZE + imgX) * 4; // RGBA stride
          const dest  = patchBase + (py * PATCH_SIZE + px) * 3;
          kImages[dest]     = data[pixel]     * NORM_SCALE + NORM_BIAS; // R
          kImages[dest + 1] = data[pixel + 1] * NORM_SCALE + NORM_BIAS; // G
          kImages[dest + 2] = data[pixel + 2] * NORM_SCALE + NORM_BIAS; // B
        }
      }
    }
  }
  return { kImages, kPositionsXy };
}

/**
 * Fetch an image URL, decode to ImageBitmap, and patchify.
 * Returns null on fetch/decode failure (non-fatal — generate continues text-only).
 */
async function fetchAndPatchify(
  url: string,
): Promise<{ kImages: Float32Array; kPositionsXy: Int32Array } | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob   = await resp.blob();
    const bitmap = await createImageBitmap(blob, { resizeWidth: IMG_SIZE, resizeHeight: IMG_SIZE, resizeQuality: "high" });
    const tensors = patchifyImage(bitmap);
    bitmap.close();
    return tensors;
  } catch {
    return null;
  }
}

// ── LiteRtLmBackend ───────────────────────────────────────────────────────────

export class LiteRtLmBackend implements InferenceBackend {
  readonly id   = "litert" as const;
  readonly caps = { multimodal: true, mtp: false } as const;

  private readonly _post: PostFn;
  private _modelId  = "";
  private _eosId    = 1;
  private _loaded   = false;

  constructor(post: PostFn) {
    this._post = post;
  }

  async load(modelId: string, opts: LoadOpts): Promise<void> {
    this._modelId = modelId;
    if (!_module) {
      this._post({ type: "error", error: "LiteRT-LM WASM module not loaded — awaiting #66 bundle" });
      return;
    }
    this._post({ type: "progress", phase: "model", progress: 0, file: "litert_lm.wasm", bytes: 0, total: 0, throughputBytesPerSec: 0 });
    await _module.load(modelId, { opfsKey: modelId });
    this._loaded = true;
    this._post({ type: "model-ready" });
    this._post({ type: "boot-complete", coldCache: opts.noWarmup !== true });
  }

  async generate(req: Record<string, unknown>): Promise<void> {
    if (!_module || !this._loaded) {
      this._post({ type: "error", error: "LiteRT-LM not ready" });
      return;
    }

    const messages     = req.messages as Array<{ role: string; content: string }>;
    const imageUrl     = req.imageUrl as string | undefined;
    const maxNewTokens = (req.maxNewTokens as number | undefined) ?? 512;
    const eosId        = (req.eosId as number | undefined) ?? this._eosId;
    const t0           = performance.now();

    // Image preprocessing → kImages / kPositionsXy
    let imageTensors: { kImages: Float32Array; kPositionsXy: Int32Array } | null = null;
    if (imageUrl) {
      imageTensors = await fetchAndPatchify(imageUrl);
    }

    // Tokenize prompt (stub — needs LiteRT-LM tokenizer API from #66 bundle)
    // When #66 lands: replace with _module.tokenize(chatText, { addBos: true })
    const chatText  = messages.map(m => `${m.role}: ${m.content}`).join("\n") + "\nassistant:";
    const tokenIds  = new Int32Array(0); // placeholder — tokenizer not yet wired

    const runReq: LiteRtLmRunRequest = {
      kImages:      imageTensors?.kImages     ?? new Float32Array(0),
      kPositionsXy: imageTensors?.kPositionsXy ?? new Int32Array(0),
      numPatches:   imageTensors ? NUM_PATCHES : 0,
      tokenIds,
      maxNewTokens,
    };

    this._post({ type: "progress", phase: "inference", progress: 0, throughputBytesPerSec: 0 });
    const result = await _module.run(runReq);

    const elapsed = performance.now() - t0;
    const tps = result.tokenIds.length > 0 ? Math.round(result.tokenIds.length / (result.decodeMs / 1000)) : 0;

    this._post({
      type:         "generate-done",
      turnId:       req.turnId,
      tokenIds:     Array.from(result.tokenIds),
      prefill_ms:   result.prefillMs,
      decode_ms:    result.decodeMs,
      elapsed_ms:   elapsed,
      tg_tps:       tps,
      tokens_out:   result.tokenIds.length,
      eos_hit:      result.tokenIds[result.tokenIds.length - 1] === eosId,
    });
  }

  async dispose(): Promise<void> {
    _module?.dispose();
    this._loaded = false;
    this._post({ type: "shutdown-complete" });
  }
}

// Export constants so the probe page can verify shapes without re-importing backend
export { NUM_PATCHES, PATCH_DIM, GRID_SIZE, PATCH_SIZE, IMG_SIZE };
