/// <reference lib="webworker" />
// litert-lm-backend.ts — route-c: LiteRT-LM SessionInterface JS integration (#617).
//
// Contract pinned from engine.h + io_types.h (Leo mail #14144, 2026-06-08):
//   Public surface: SessionInterface::GenerateContent(std::vector<InputData> contents)
//   InputData = variant<InputText, InputImage, InputImageEnd, ...>
//   Two-phase (encode → decode) is INTERNAL to the engine — JS never calls it.
//   InputImage accepts raw bytes OR TensorBuffer; prefer raw bytes → engine's
//   stb_image_preprocessor patchifies (896→4096×588) — eliminates JS/C++ drift.
//
// patchifyImage() is kept as the TensorBuffer-path fallback only.
//
// DO NOT remove route-b (litert-route-b-probe files) until route-c renders a real vision result.

import type { InferenceBackend, LoadOpts, PostFn } from "./inference-backend.js";
import { loadLiteRtLmBundle, type LoadBundleOpts, type LiteRtBundleUrls } from "./litert-lm-loader.js";

// ── InputData variant types (mirrors io_types.h) ─────────────────────────────

export interface InputText {
  kind: "text";
  text: string;
}

/** Raw-bytes path (preferred) — engine stb preprocessor patchifies internally. */
export interface InputImageBytes {
  kind: "image";
  bytes: Uint8Array;
  mimeType?: string;
}

/** TensorBuffer path (fallback) — JS-side patchify already done. */
export interface InputImageTensor {
  kind: "image-tensor";
  kImages: Float32Array;      // [NUM_PATCHES * PATCH_DIM]
  kPositionsXy: Int32Array;   // [NUM_PATCHES * 2]
  numPatches: number;
}

export interface InputImageEnd {
  kind: "image-end";
}

export type InputData = InputText | InputImageBytes | InputImageTensor | InputImageEnd;

// ── GenerateContent result ────────────────────────────────────────────────────

export interface LiteRtLmResult {
  tokenIds: Int32Array;
  prefillMs: number;
  decodeMs: number;
}

export type StreamCallback = (token: string) => void;

// ── LiteRtLmModule — stub for Leo's #66 WASM bundle ─────────────────────────
// When litert_lm.wasm/.js lands, it must implement this interface.
// setLiteRtLmModule() wires it in — zero redesign needed.

export interface LiteRtLmModule {
  /** Load model weights (OPFS-cached if opfsKey provided). */
  load(source: string | ArrayBuffer, opts?: { opfsKey?: string }): Promise<void>;
  /** Single-call inference: interleaved text/image inputs → output tokens.
   *  Internally orchestrates vision encode → prefill → decode. */
  generateContent(
    contents: InputData[],
    opts?: { maxNewTokens?: number; eosId?: number },
  ): Promise<LiteRtLmResult>;
  /** Streaming variant — fires callback per decoded token. */
  generateContentStream(
    contents: InputData[],
    callback: StreamCallback,
    opts?: { maxNewTokens?: number; eosId?: number },
  ): Promise<LiteRtLmResult>;
  /** Release VRAM. */
  dispose(): void;
}

let _module: LiteRtLmModule | null = null;

/** Wire in Leo's #66 WASM bundle — one call, zero redesign. */
export function setLiteRtLmModule(m: LiteRtLmModule): void {
  _module = m;
}

// ── Vision preprocessing constants (Gemma-4 E4B, SigLIP ViT-400M) ────────────
// Used for the TensorBuffer fallback path only.

const IMG_SIZE    = 896;
const PATCH_SIZE  = 14;
const GRID_SIZE   = IMG_SIZE / PATCH_SIZE;    // 64
const NUM_PATCHES = GRID_SIZE * GRID_SIZE;    // 4096
const PATCH_DIM   = PATCH_SIZE * PATCH_SIZE * 3; // 588

const NORM_SCALE  = 2.0 / 255.0;
const NORM_BIAS   = -1.0;

/**
 * TensorBuffer fallback — JS-side SigLIP patchify.
 * Use ONLY when the raw-bytes path is unavailable (engine too old to bundle stb).
 * Returns kImages (Float32, [NUM_PATCHES, PATCH_DIM]) + kPositionsXy (Int32, [NUM_PATCHES, 2]).
 */
export function patchifyImage(
  bitmap: ImageBitmap,
): { kImages: Float32Array; kPositionsXy: Int32Array } {
  const canvas = new OffscreenCanvas(IMG_SIZE, IMG_SIZE);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, IMG_SIZE, IMG_SIZE);
  const { data } = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE);

  const kImages      = new Float32Array(NUM_PATCHES * PATCH_DIM);
  const kPositionsXy = new Int32Array(NUM_PATCHES * 2);

  for (let pr = 0; pr < GRID_SIZE; pr++) {
    for (let pc = 0; pc < GRID_SIZE; pc++) {
      const patchIdx = pr * GRID_SIZE + pc;
      kPositionsXy[patchIdx * 2]     = pc;
      kPositionsXy[patchIdx * 2 + 1] = pr;
      const patchBase = patchIdx * PATCH_DIM;
      for (let py = 0; py < PATCH_SIZE; py++) {
        for (let px = 0; px < PATCH_SIZE; px++) {
          const imgX  = pc * PATCH_SIZE + px;
          const imgY  = pr * PATCH_SIZE + py;
          const pixel = (imgY * IMG_SIZE + imgX) * 4;
          const dest  = patchBase + (py * PATCH_SIZE + px) * 3;
          kImages[dest]     = data[pixel]     * NORM_SCALE + NORM_BIAS;
          kImages[dest + 1] = data[pixel + 1] * NORM_SCALE + NORM_BIAS;
          kImages[dest + 2] = data[pixel + 2] * NORM_SCALE + NORM_BIAS;
        }
      }
    }
  }
  return { kImages, kPositionsXy };
}

/** Fetch raw image bytes from a URL — preferred InputImage path. */
async function fetchImageBytes(url: string): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

// ── Build InputData[] from messages + optional image URL ────────────────────

async function buildContents(
  messages: Array<{ role: string; content: string }>,
  imageUrl: string | undefined,
): Promise<InputData[]> {
  const contents: InputData[] = [];

  if (imageUrl) {
    const bytes = await fetchImageBytes(imageUrl);
    if (bytes) {
      // Infer MIME from URL extension; default to JPEG (most common)
      const ext = imageUrl.split(".").pop()?.toLowerCase() ?? "";
      const mimeMap: Record<string, string> = { png: "image/png", webp: "image/webp", gif: "image/gif" };
      const mimeType = mimeMap[ext] ?? "image/jpeg";
      contents.push({ kind: "image", bytes, mimeType });
      contents.push({ kind: "image-end" });
    }
  }

  for (const msg of messages) {
    contents.push({ kind: "text", text: `${msg.role}: ${msg.content}` });
  }
  contents.push({ kind: "text", text: "assistant:" });

  return contents;
}

// ── LiteRtLmBackend ───────────────────────────────────────────────────────────

export class LiteRtLmBackend implements InferenceBackend {
  readonly id   = "litert" as const;
  readonly caps = { multimodal: true, mtp: false } as const;

  private readonly _post: PostFn;
  private _loaded = false;

  constructor(post: PostFn) {
    this._post = post;
  }

  async load(_modelId: string, opts: LoadOpts): Promise<void> {
    // bundleUrls can be forwarded from the "init" message for local testing overrides.
    const bundleOpts: LoadBundleOpts = {
      urls: (opts.bundleUrls as Partial<LiteRtBundleUrls> | undefined) ?? {},
      forceRefresh: (opts.forceRefresh as boolean | undefined) ?? false,
    };
    try {
      const instance = await loadLiteRtLmBundle(this._post, bundleOpts);
      setLiteRtLmModule(instance);
      this._loaded = true;
      this._post({ type: "model-ready" });
      this._post({ type: "boot-complete" });
    } catch (e) {
      this._post({ type: "error", error: `LiteRT-LM bundle load failed: ${(e as Error).message}` });
    }
  }

  async generate(req: Record<string, unknown>): Promise<void> {
    if (!_module || !this._loaded) {
      this._post({ type: "error", error: "LiteRT-LM not ready" });
      return;
    }

    const messages     = req.messages as Array<{ role: string; content: string }>;
    const imageUrl     = req.imageUrl as string | undefined;
    const maxNewTokens = (req.maxNewTokens as number | undefined) ?? 512;
    const eosId        = (req.eosId as number | undefined) ?? 1;
    const t0           = performance.now();

    const contents = await buildContents(messages, imageUrl);

    this._post({ type: "progress", phase: "inference", progress: 0, throughputBytesPerSec: 0 });

    const result = await _module.generateContent(contents, { maxNewTokens, eosId });

    const elapsed = performance.now() - t0;
    const tps = result.tokenIds.length > 0
      ? Math.round(result.tokenIds.length / (result.decodeMs / 1000))
      : 0;

    this._post({
      type:       "generate-done",
      turnId:     req.turnId,
      tokenIds:   Array.from(result.tokenIds),
      prefill_ms: result.prefillMs,
      decode_ms:  result.decodeMs,
      elapsed_ms: elapsed,
      tg_tps:     tps,
      tokens_out: result.tokenIds.length,
      eos_hit:    result.tokenIds[result.tokenIds.length - 1] === eosId,
    });
  }

  async dispose(): Promise<void> {
    _module?.dispose();
    this._loaded = false;
    this._post({ type: "shutdown-complete" });
  }
}

export { NUM_PATCHES, PATCH_DIM, GRID_SIZE, PATCH_SIZE, IMG_SIZE };
