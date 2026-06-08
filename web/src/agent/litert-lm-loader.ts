// litert-lm-loader.ts — download, OPFS-cache, and instantiate the LiteRT-LM bundle (#617).
//
// E4B model is multi-GB; wasm32 has a 4GB address ceiling. Strategy:
//   1. Stream-write WASM + model to OPFS in chunks — O(chunk) RAM, not O(file) RAM.
//   2. On second load: serve from OPFS directly (cache hit).
//   3. Detect Memory64 flag in WASM binary header; warn if needed and browser lacks support.
//   4. Pass OPFS key to instance.load() — engine reads weights via FileSystemSyncAccessHandle
//      without materialising the full model in JS heap. Avoids wasm32 address-space collision.
//   5. Returns instantiated LiteRtLmModule — caller calls setLiteRtLmModule().
//
// Call site: LiteRtLmBackend.load() — posts model-ready/boot-complete via PostFn.

// Type-only import — erased at runtime; no circular runtime dependency.
import type { LiteRtLmModule } from "./litert-lm-backend.js";
import type { PostFn } from "./inference-backend.js";

// ── Bundle URL configuration ─────────────────────────────────────────────────
// Updated when Leo delivers the #66 build (HF repo slug + exact paths).
// Configurable via ?litert_js_url=&litert_wasm_url=&litert_model_url= for local testing.

const HF_BASE = "https://huggingface.co";

function hfResolveUrl(repo: string, path: string, revision = "main"): string {
  return `${HF_BASE}/${repo}/resolve/${revision}/${path}`;
}

export interface LiteRtBundleUrls {
  /** ESM entry wrapping the WASM (exports default factory). */
  jsUrl: string;
  /** Compiled WASM binary. */
  wasmUrl: string;
  /** .litertlm weights file — multi-GB, served from HF user account. */
  modelUrl: string;
}

// ── Swappable bundle URL config ───────────────────────────────────────────────
// DO NOT hardcode final production paths here — Leo delivers the served model URL +
// litert_lm.wasm/.js from the #66 build (prebuild recompiling past api-drift wall).
// Canonical upstream repo: litert-community/gemma-4-E4B-it-litert-lm
// Served copy mirrors to user's HF account (GB models are not served from Pages/jsdelivr).
// Update LITERT_WASM_URL, LITERT_JS_URL, LITERT_MODEL_URL when #66 lands.
//
// These constants are the single point of truth — no literals elsewhere in this file.

/** @stub — replace with Leo's #66 served URL when available */
export const LITERT_WASM_URL  = hfResolveUrl("litert-community/gemma-4-E4B-it-litert-lm", "litert_lm.wasm");
/** @stub — replace with Leo's #66 served URL when available */
export const LITERT_JS_URL    = hfResolveUrl("litert-community/gemma-4-E4B-it-litert-lm", "litert_lm.js");
/** @stub — replace with user's HF served model URL when Leo delivers #66 */
export const LITERT_MODEL_URL = hfResolveUrl("litert-community/gemma-4-E4B-it-litert-lm", "model.litertlm");

function resolveUrls(base: Partial<LiteRtBundleUrls> = {}): LiteRtBundleUrls {
  const params = (() => {
    try { return new URL(self.location.href).searchParams; } catch { return new URLSearchParams(); }
  })();
  return {
    jsUrl:    params.get("litert_js_url")    ?? base.jsUrl    ?? LITERT_JS_URL,
    wasmUrl:  params.get("litert_wasm_url")  ?? base.wasmUrl  ?? LITERT_WASM_URL,
    modelUrl: params.get("litert_model_url") ?? base.modelUrl ?? LITERT_MODEL_URL,
  };
}

// ── OPFS streaming cache ──────────────────────────────────────────────────────

async function opfsFileExists(key: string): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(key);
    const f  = await fh.getFile();
    return f.size > 0;
  } catch { return false; }
}

/** Stream a URL directly to OPFS — O(chunk) RAM, not O(file) RAM.
 *  Posts {type:"progress", phase, ...} per chunk via post(). */
async function streamToOpfs(
  url: string, key: string, post: PostFn, phase: string,
): Promise<void> {
  const root     = await navigator.storage.getDirectory();
  const fh       = await root.getFileHandle(key, { create: true });
  const writable = await fh.createWritable();

  // Explicit mode:"cors" — HF is cross-origin; a CORS failure must throw typed, not silently return opaque.
  // Wrap TypeError (network/CORS refusal) so the error surfaces the URL and cause, not just "Failed to fetch".
  const resp = await fetch(url, { headers: { Accept: "*/*" }, mode: "cors" })
    .catch((e: Error) => {
      throw new Error(`network/CORS error fetching ${phase} (${url}): ${e.message}`);
    });
  if (!resp.ok) throw new Error(`fetch ${phase} ${url} → HTTP ${resp.status} ${resp.statusText}`);

  const total = Number(resp.headers.get("content-length") ?? 0);
  let   bytes = 0;
  const t0    = performance.now();
  const reader = resp.body!.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      bytes += value.byteLength;
      const elapsed = (performance.now() - t0) / 1000;
      post({
        type: "progress", phase,
        progress: total > 0 ? bytes / total : 0,
        bytes, total, file: key,
        throughputBytesPerSec: elapsed > 0 ? bytes / elapsed : 0,
      });
    }
    await writable.close();
  } catch (e) {
    await writable.abort();
    throw e;
  }
}

async function opfsReadBuffer(key: string): Promise<ArrayBuffer> {
  const root = await navigator.storage.getDirectory();
  const fh   = await root.getFileHandle(key);
  const f    = await fh.getFile();
  return f.arrayBuffer();
}

// ── WASM binary integrity checks ─────────────────────────────────────────────

/** Returns true if buf begins with the WASM magic bytes `\0asm` (00 61 73 6d).
 *  Called before WebAssembly.instantiate to catch truncated or corrupt downloads
 *  before they reach the engine and produce an opaque CompileError. */
export function isWasmMagic(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const u8 = new Uint8Array(buf, 0, 4);
  return u8[0] === 0x00 && u8[1] === 0x61 && u8[2] === 0x73 && u8[3] === 0x6d;
}

// ── Memory64 detection ────────────────────────────────────────────────────────
// A WASM binary using memory64 encodes the memory section flags byte with bit 2 set (0x04).
// wasm32 = 0x00. E4B is 4-bit quantized (~3-4GB total) — may require memory64 for weight buffer.
// Chrome 126+ supports memory64 unflagged. Earlier Chromium versions need --enable-experimental-webassembly-features.

export function detectMemory64(wasmBytes: ArrayBuffer): boolean {
  const u8 = new Uint8Array(wasmBytes, 0, Math.min(wasmBytes.byteLength, 8192));
  let i = 8; // skip magic (0000061 61736d) + version
  while (i < u8.length - 2) {
    const sectionId = u8[i++];
    let size = 0, shift = 0;
    while (i < u8.length) { const b = u8[i++]; size |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
    if (sectionId === 5) { // memory section
      let count = 0, s2 = 0;
      while (i < u8.length) { const b = u8[i++]; count |= (b & 0x7f) << s2; if (!(b & 0x80)) break; s2 += 7; }
      if (count > 0) {
        let flags = 0, s3 = 0;
        while (i < u8.length) { const b = u8[i++]; flags |= (b & 0x7f) << s3; if (!(b & 0x80)) break; s3 += 7; }
        return (flags & 0x04) !== 0;
      }
      break;
    }
    i += size;
  }
  return false;
}

// ── Bundle loader ─────────────────────────────────────────────────────────────

export interface LoadBundleOpts {
  urls?: Partial<LiteRtBundleUrls>;
  /** Force re-download even if OPFS cache hit. */
  forceRefresh?: boolean;
}

/**
 * Download, cache in OPFS, and instantiate the LiteRT-LM bundle.
 * Returns the live LiteRtLmModule — caller must call setLiteRtLmModule() and post model-ready.
 *
 * Large-model memory strategy:
 *   - WASM binary is fetched into an ArrayBuffer (~tens of MB) and passed to the factory
 *     so it can instantiate without a second network fetch.
 *   - Model weights (~GB) stay in OPFS. The engine receives the OPFS key and reads directly
 *     via FileSystemSyncAccessHandle (worker-only sync OPFS API) — no full-file JS-heap copy.
 *   - This keeps peak JS heap near zero for the weight-load phase.
 */
export async function loadLiteRtLmBundle(
  post: PostFn,
  opts: LoadBundleOpts = {},
): Promise<LiteRtLmModule> {
  const urls  = resolveUrls(opts.urls);
  const force = opts.forceRefresh ?? false;

  // ── 1. WASM binary → OPFS ─────────────────────────────────────────────────
  const wasmKey = "litert_lm.wasm";
  if (force || !(await opfsFileExists(wasmKey))) {
    post({ type: "progress", phase: "wasm", progress: 0, bytes: 0, total: 0, file: wasmKey, throughputBytesPerSec: 0 });
    await streamToOpfs(urls.wasmUrl, wasmKey, post, "wasm");
  }

  // ── 2. WASM integrity + Memory64 check ───────────────────────────────────
  // Read WASM header only (first 8KB is enough for the memory section).
  const wasmBytes = await opfsReadBuffer(wasmKey); // tens of MB — acceptable

  // Pre-instantiate integrity guard: reject truncated/corrupt downloads BEFORE
  // they reach WebAssembly.instantiate (which would produce an opaque CompileError).
  // Evict the bad cache entry so the next load attempt re-downloads from source.
  if (!isWasmMagic(wasmBytes)) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(wasmKey);
    } catch { /* eviction best-effort — non-fatal */ }
    throw new Error(
      `WASM integrity check failed: ${wasmKey} is not a valid WASM binary ` +
      `(${wasmBytes.byteLength} bytes). Evicted from OPFS cache — retry will re-download.`,
    );
  }

  if (detectMemory64(wasmBytes)) {
    const mem64Supported = (() => {
      try { new WebAssembly.Memory({ initial: 1, index: "i64" } as WebAssembly.MemoryDescriptor); return true; }
      catch { return false; }
    })();
    if (!mem64Supported) {
      post({ type: "warn", message: "LiteRT-LM WASM uses Memory64 but browser support is missing (need Chrome 126+). Load may fail." });
    }
  }

  // ── 3. Model weights → OPFS ───────────────────────────────────────────────
  const modelKey = "litert_lm_model.litertlm";
  if (force || !(await opfsFileExists(modelKey))) {
    post({ type: "progress", phase: "model", progress: 0, bytes: 0, total: 0, file: modelKey, throughputBytesPerSec: 0 });
    await streamToOpfs(urls.modelUrl, modelKey, post, "model");
  }

  // ── 4. Instantiate the JS factory ─────────────────────────────────────────
  // Leo's #66 build exports `default: (opts) => Promise<LiteRtLmModule>`.
  // We pass the cached WASM bytes so the factory never makes a second network request.
  post({ type: "progress", phase: "instantiate", progress: 0, bytes: 0, total: 0, file: "litert_lm.js", throughputBytesPerSec: 0 });
  type LiteRtFactory = (o: { wasmBinary?: ArrayBuffer }) => Promise<LiteRtLmModule>;
  const mod  = await import(/* @vite-ignore */ urls.jsUrl) as { default: LiteRtFactory };
  const instance = await mod.default({ wasmBinary: wasmBytes });
  // wasmBytes ArrayBuffer may be detached (transferred into WASM linear memory) from here on.

  // ── 5. Load model weights from OPFS ──────────────────────────────────────
  // Pass OPFS key as source. The engine is expected to use FileSystemSyncAccessHandle
  // (workers only) to read directly into WASM linear memory — zero JS-heap copy for the
  // multi-GB model. When the real #66 API lands, verify the exact call signature here.
  await instance.load(modelKey, { opfsKey: modelKey });

  return instance;
}
