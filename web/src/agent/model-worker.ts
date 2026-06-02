/// <reference lib="webworker" />
// model-worker.ts — Web Worker for on-device model load + inference (#936).
// Runs in a dedicated thread so from_pretrained() + model.generate() never block
// the main thread (tab-wedge fix for demo-blocker issue #936).
//
// Protocol (main → worker):
//   {type:"init", modelId, drafterUrl, drafterCacheKey}
//   {type:"generate", turnId, messages, imageUrl?, videoUrls?, maxNewTokens, eosId, draftK, useMtp}
//   {type:"abort", turnId}
//
// Protocol (worker → main):
//   {type:"returning-user"}                  // cached weights detected in Cache API before download
//   {type:"opfs-warm-start"}                  // §#1638: OPFS cache hit — advance bar to 50%, no READY snap
//   {type:"manifest",    totalBytesExpected}  // total expected bytes across all files
//   {type:"progress",    phase, file, bytes, total, throughputBytesPerSec, progress?}
//   {type:"model-ready", device}
//   {type:"warmup-done"}
//   {type:"drafter-ready"}
//   {type:"drafter-error", error}
//   {type:"boot-complete"}                    // model-ready + warmup-done + drafter done
//   {type:"ready",       device}
//   {type:"generate-done", turnId, text, specAttempts, specAccepts,
//                          prefillMs, decodeMs, inputLength, tokensOut}
//   {type:"generate-error", turnId, error}
//   {type:"error",       error}
//   {type:"phase_timing", phase, elapsed_ms}     // §#1595-M2: boot-phase diagnostic timing

import { Gemma4ForConditionalGeneration, AutoProcessor, RawImage, env as tfEnv } from "@huggingface/transformers";
import { getMtpSessions, runMtpSpecDecode, MTP_CONFIG_E4B } from "./webgpu-mtp-backend.js";
import { fetchDrafterCached } from "./drafter-cache.js";
// §C-ort-static (#1375): static import bundles ORT directly into the worker chunk.
// Dynamic `await import("onnxruntime-web")` caused vite to emit a separate
// hash-stamped ort.bundle.min-*.js that could 404 on Pages when deployment
// hashes drifted between builds. Static import eliminates the separate chunk.
import * as ort from "onnxruntime-web";

// §#281-mapasync-retry: intercept GPUBuffer.prototype.mapAsync to retry on D3D12 OOM.
// buffer_manager.cc:553 (wgpuBufferMapAsync) fires as async callback outside generate()'s
// try/catch — OOM can't be caught by retry loops around generate(). Root cause: D3D12's
// deferred buffer deletion queue hasn't drained between consecutive ORT inference calls.
// Fix: monkey-patch mapAsync so each retry's setTimeout yields to the event loop, giving
// D3D12 and JavaScript GC time to process pending buffer destructions before re-attempting.
// Must install before any ORT WebGPU session is created (static import = module init).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _gpuBufferCtor = (globalThis as any).GPUBuffer as (new(...a: unknown[]) => unknown) | undefined;
if (_gpuBufferCtor) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _gbu = _gpuBufferCtor as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _origMapAsync = _gbu.prototype.mapAsync as (...args: unknown[]) => Promise<void>;
  // §#281: D3D12 deferred deletion queue drains ~30s after prior inference/from_pretrained().
  // Early retries are optimistic; the 4th (15s) gives full drain time. Total budget: 34s.
  const _mapRetryDelays = [3000, 6000, 10000, 15000] as const; // ms per retry (4 retries max)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _gbu.prototype.mapAsync = async function (...args: unknown[]): Promise<void> {
    try {
      return await _origMapAsync.apply(this, args);
    } catch (_e0) {
      // First attempt failed — retry with increasing delays so D3D12 can drain.
      for (let _i = 0; _i < _mapRetryDelays.length; _i++) {
        console.warn(`[#281] mapAsync retry ${_i + 1}/${_mapRetryDelays.length} in ${_mapRetryDelays[_i]}ms`, _e0);
        await new Promise<void>(r => setTimeout(r, _mapRetryDelays[_i]));
        try {
          return await _origMapAsync.apply(this, args);
        } catch (_eN) {
          if (_i === _mapRetryDelays.length - 1) {
            console.error("[#281] mapAsync exhausted retries — surfacing original error", _e0);
            throw _e0; // re-throw first error (preserves original stack)
          }
          _e0 = _eN; // update for next iteration's warn
        }
      }
    }
  };
}

// §#1595-M2: module-level epoch for phase_timing elapsed_ms fields.
const _workerStartMs = Date.now();
// Sentinel: first OPFS write fires one phase_timing event then stays silent.
let _opfsFirstWriteFired = false;

// ── Worker state ──────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _model: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _processor: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _drafterSession: any = null;
// §#1410: true when model weights weren't in Cache API at boot time (cold download).
// Cold-cache paths have more pending GPU work after load → larger race window.
let _coldCacheBoot = false;
// §#307 diagnostic: count generate() calls in this worker session — proxy for WASM heap
// fragmentation level (more turns → more alloc/free cycles → higher misalignment risk).
let _generateCallCount = 0;

const WEBGPU_CONTEXT_LIMIT = 16384;
const GEMMA_ONNX_CPU_UNSUPPORTED =
  "Gemma ONNX Q4 CPU/WASM fallback is unsupported: onnxruntime-web WASM has no " +
  "GatherBlockQuantized kernel for the quantized Gemma graph (for example " +
  "node_embedding_Quant). Use WebGPU with a compatible dedicated GPU, a remote " +
  "Gemma endpoint, or the configured GGUF WASM backend instead.";

// MTP verification gate (#679).  True = real greedy token comparison is wired
// in webgpu-mtp-backend.ts (runMtpSpecDecode compares argmax(target) vs draftToken).
// Set false here to keep spec-decode dormant even if drafter loads successfully.
// Flip to false if verification is ever reverted to the "accept-all" placeholder.
const MTP_VERIFICATION_WIRED = true;

// Boot-completion tracking — boot-complete fires when all three phases done.
let _bootModelReady = false;
let _bootWarmupDone = false;
let _bootDrafterDone = false; // true when drafter-ready OR drafter-error OR no drafterUrl
// §#88-C: stored for transparent ORT session refresh (no re-download needed)
let _lastInitData: Record<string, unknown> | null = null;

// Throughput tracking for progress events.
let _progressLastBytes = 0;
let _progressLastTs = 0;

function calcThroughput(cumulativeBytes: number): number {
  const now = Date.now();
  const dtMs = now - _progressLastTs;
  const db = cumulativeBytes - _progressLastBytes;
  _progressLastBytes = cumulativeBytes;
  _progressLastTs = now;
  if (dtMs < 50 || db <= 0) return 0;
  return Math.round(db / (dtMs / 1000));
}

function post(msg: Record<string, unknown>): void {
  (self as unknown as Worker).postMessage(msg);
}

// §#83: GPU command queue flush — drain ORT WebGPU buffer destructions before each generate.
// buffer_manager.cc:553 race: wgpuBufferMapAsync fires before a prior destruction completes.
//
// §#281 enhanced flush: `onSubmittedWorkDone()` alone waits for submitted GPU COMMANDS but
// does NOT drain D3D12's deferred buffer deletion queue (separate fence/GC path). After a
// worker.terminate() recycle, the terminated worker's GPU resource destructions are still
// in-flight in D3D12's deferred queue — the new worker's inference hits them. Fix: submit an
// empty encoder before calling onSubmittedWorkDone(). An empty submit forces D3D12 to process
// its pending cleanup backlog (including the deferred deletion queue) before the fence resolves.
async function _flushWgpuQueue(tag: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _dev = (ort.env as any)?.webgpu?.device as
    | { createCommandEncoder?: () => { finish: () => unknown }; queue?: { submit?: (cmds: unknown[]) => void; onSubmittedWorkDone?: () => Promise<void> } }
    | undefined;
  if (!_dev?.queue?.onSubmittedWorkDone) return;
  // Submit empty command list — forces D3D12 deferred deletion queue processing.
  try {
    if (_dev.createCommandEncoder && _dev.queue.submit) {
      const _enc = _dev.createCommandEncoder();
      _dev.queue.submit([_enc.finish()]);
    }
  } catch { /* non-fatal — device may be lost */ }
  console.log(`[#83] wgpu-queue-flush ${tag}`);
  await _dev.queue.onSubmittedWorkDone().catch(() => { /* non-fatal */ });
}

// §#88: conversation trimming — drop oldest turns when input token count exceeds the
// VRAM-safe ceiling. Preserves system prompt (first message) + latest user message (last).
// Uses char/token ratio from the current tokenization to estimate how many messages to drop.
function _trimConversationMessages(
  messages: Array<{ role: string; content: string }>,
  currentTokenCount: number,
  tokenCeiling: number,
): Array<{ role: string; content: string }> {
  if (currentTokenCount <= tokenCeiling) return messages;
  const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
  if (totalChars === 0) return messages;
  // Target char count proportional to token ceiling (preserve ratio)
  const targetChars = Math.floor((tokenCeiling / currentTokenCount) * totalChars);
  // Preserve system prompt (index 0 if role=system) + latest user message (last)
  const hasSystem = messages.length > 0 && messages[0].role === "system";
  const keepFixed = hasSystem ? [messages[0]] : [];
  const rest = messages.slice(hasSystem ? 1 : 0);
  if (rest.length <= 1) return messages; // nothing to drop — only latest user message
  const latestUser = rest[rest.length - 1];
  const middle = rest.slice(0, -1); // oldest eligible pairs
  const fixedChars = [...keepFixed, latestUser].reduce((s, m) => s + m.content.length, 0);
  let currentTotal = fixedChars + middle.reduce((s, m) => s + m.content.length, 0);
  // Drop oldest messages until total is within target
  let dropCount = 0;
  while (dropCount < middle.length && currentTotal > targetChars) {
    currentTotal -= middle[dropCount].content.length;
    dropCount++;
  }
  if (dropCount === 0) return messages;
  return [...keepFixed, ...middle.slice(dropCount), latestUser];
}

function checkBootComplete(): void {
  if (_bootModelReady && _bootWarmupDone && _bootDrafterDone) {
    post({ type: "boot-complete" });
  }
}

// Check if model weights are already in Cache API — indicates a returning user.
// transformers.js stores downloaded files in Cache Storage keyed to their CDN URLs.
async function checkReturningUser(modelId: string): Promise<boolean> {
  try {
    if (!("caches" in globalThis)) return false;
    const names = await (globalThis as unknown as { caches: CacheStorage }).caches.keys();
    for (const name of names) {
      const cache = await (globalThis as unknown as { caches: CacheStorage }).caches.open(name);
      const keys = await cache.keys();
      if (keys.some((req) => req.url.includes(modelId))) return true;
    }
  } catch { /* Cache API unavailable (private mode / quota) */ }
  return false;
}

// §#26: evict Cache API entries for old model versions — runs after init confirms currentModelId.
// Deletes any cache whose URLs contain model file extensions but NO URLs for currentModelId.
async function evictStaleModelCaches(currentModelId: string): Promise<void> {
  if (!("caches" in globalThis)) return;
  try {
    const cs = (globalThis as unknown as { caches: CacheStorage }).caches;
    const names = await cs.keys();
    for (const name of names) {
      const cache = await cs.open(name);
      const keys = await cache.keys();
      const hasCurrentModel = keys.some((r) => r.url.includes(currentModelId));
      const hasModelFiles = keys.some((r) => /\.(onnx|safetensors|bin|msgpack)/.test(r.url));
      if (!hasCurrentModel && hasModelFiles) {
        await cs.delete(name);
        console.info(`[model-worker] §#26 evicted stale cache "${name}" (no URLs for ${currentModelId})`);
      }
    }
  } catch { /* non-fatal */ }
}

// ── Message router ────────────────────────────────────────────────────────────
self.onmessage = async (ev: MessageEvent<Record<string, unknown>>) => {
  const { type, ...data } = ev.data;
  try {
    if (type === "init")             await handleInit(data);
    else if (type === "generate")    await handleGenerate(data);
    else if (type === "shutdown")    await handleShutdown();
    else if (type === "destroy-device") handleDestroyDevice();
    else if (type === "session-refresh") await handleSessionRefresh();
    else if (type === "dispose-session") await handleDisposeSession();
    // "abort" is handled via the AbortController in handleGenerate (future work)
  } catch (e) {
    post({ type: "error", error: (e as Error).message });
  }
};

// ── Init: from_pretrained + warmup probe + drafter ───────────────────────────
async function handleInit(data: Record<string, unknown>): Promise<void> {
  _lastInitData = { ...data }; // §#88-C: store for transparent session refresh
  post({ type: "phase_timing", phase: "worker_init", elapsed_ms: Date.now() - _workerStartMs });
  // §A-init (#990): dispose prior ORT sessions on re-init (model swap) — prevents VRAM leak.
  if (_drafterSession) {
    try { await (_drafterSession as any).release?.(); } catch { /* non-fatal */ }
    _drafterSession = null;
  }
  if (_model) {
    try { await (_model as any).dispose?.(); } catch { /* non-fatal */ }
    _model = null;
  }
  _processor = null;

  const modelId = data.modelId as string;
  const drafterUrl = data.drafterUrl as string;
  const drafterCacheKey = data.drafterCacheKey as string;
  // noWarmup: set by recycle path. GPU device+compiled shaders persist across worker
  // terminate/recreate; skip sanity probe and warmup to avoid ~120s re-compilation.
  const noWarmup = (data.noWarmup as boolean | undefined) === true;
  // §#1637 Path 2: forceWasm=true → skip WebGPU adapter entirely, load with WASM EP only.
  const forceWasm = (data.forceWasm as boolean | undefined) === true;
  // §C-warmup-context (#1362): representative system prompt passed from main thread.
  // Used to exercise ~1000-token KV cache allocations during the warmup probe so the
  // GPU buffer pools are pre-sized before the first real inference call.
  const warmupPrompt = (data.warmupPrompt as string | undefined) ?? "";

  // Returning-user detection: if model files are already in Cache API, skip the
  // loading screen and show a fast-path pulse instead.
  const isReturning = await checkReturningUser(modelId);
  _coldCacheBoot = !isReturning; // §#1410: track cold-cache state for retry backoff + post-drafter probe
  if (isReturning) {
    post({ type: "returning-user" });
  }
  // §#1630-B: flag for OPFS warm-load returning-user signal (checkReturningUser only checks
  // Cache API; OPFS warm loads need a separate signal so the progress bar doesn't stay at 0%).
  let _opfsReturningUserPosted = isReturning;

  // Emit manifest with estimated total bytes so the overlay can show aggregate %.
  // E4B: model ONNX q4f16 ≈ 2.5 GB + embed_tokens ≈ 2.0 GB + drafter ≈ 158 MB + tokenizer ≈ 5 MB.
  // 5.5 GB ceiling (~300 MB headroom) prevents bar freeze at 69% when actual > estimate (#1452).
  const ESTIMATED_MODEL_BYTES = 5_500_000_000;
  post({ type: "manifest", totalBytesExpected: ESTIMATED_MODEL_BYTES });

  // §C-quota-probe (#1490): incognito / low-storage devices expose only ~100–200 MB quota.
  // When transformers.js calls cache.put() on model shards, the write fails with
  // UnknownError. The download loop stalls at 0 bytes because transformers.js retries
  // cache writes without surfacing the error. Fix: check available quota upfront and
  // skip caching entirely when quota < model size, so the worker streams directly to
  // memory without ever touching the Cache API.
  try {
    const nav = globalThis.navigator as (Navigator & { storage?: StorageManager }) | undefined;
    if (nav?.storage && typeof nav.storage.estimate === "function") {
      const est = await nav.storage.estimate();
      const quota = est.quota ?? 0;
      const used  = est.usage ?? 0;
      const free  = quota - used;
      if (quota > 0 && free < ESTIMATED_MODEL_BYTES) {
        tfEnv.useBrowserCache = false;
      }
    }
  } catch { /* navigator.storage not available in all worker contexts */ }

  // Cumulative bytes downloaded (all model files combined) for aggregate throughput.
  // Track per-file to correctly accumulate across shard boundaries — `info.loaded`
  // resets to 0 for each new file, so Math.max() was wrong (#1365).
  const _fileBytes = new Map<string, number>();
  let _cumulativeBytes = 0;
  let _modelLoadSource: "network" | "opfs-cache" = "network";

  const progressCb = (info: Record<string, unknown>) => {
    if (info.status === "downloading") {
      const bytes = (info.loaded as number | undefined) ?? 0;
      const total = (info.total as number | undefined) ?? 0;
      const name = (info.name as string | undefined) ?? "";
      const prev = _fileBytes.get(name) ?? 0;
      _fileBytes.set(name, bytes);
      _cumulativeBytes += bytes - prev;
      const throughputBytesPerSec = calcThroughput(_cumulativeBytes);
      post({
        type: "progress",
        phase: "model",
        progress: (info.progress as number | undefined) ?? 0,
        file: ((info.name as string | undefined) ?? "").split("/").pop() ?? "",
        bytes,
        total,
        throughputBytesPerSec,
      });
    } else if (info.status === "initiate") {
      // §A-shard-boundary (#1216): "initiate" fires when a new shard fetch starts,
      // before first bytes arrive. Without this, the 30s stall watchdog fires
      // during the CDN inter-shard gap, producing variable STALLED screen counts.
      post({
        type: "progress",
        phase: "model",
        progress: 0,
        file: ((info.name as string | undefined) ?? "").split("/").pop() ?? "",
        bytes: 0,
        total: 0,
        throughputBytesPerSec: 0,
      });
    } else if (info.status === "loading") {
      post({ type: "progress", phase: "model-init", bytes: 0, total: 0, throughputBytesPerSec: 0 });
    }
  };

  // §C-cache-put-fallback (#1490): belt-and-suspenders for cache.put() UnknownError.
  // The quota probe above handles incognito / low-quota devices, but Chrome can also
  // reject cache.put() internally (UnknownError) even at HIGH quota (10+ GB free).
  // Monkey-patch Cache.prototype.put for the duration of model loading so that ANY
  // cache.put() rejection disables browser caching mid-load and resolves without
  // rethrowing, allowing the shard to proceed in-memory without hanging.
  type CachePutFn = (request: RequestInfo | URL, response: Response) => Promise<void>;
  const _origCachePut: CachePutFn | null =
    typeof Cache !== "undefined" && typeof Cache.prototype.put === "function"
      ? (Cache.prototype.put as CachePutFn)
      : null;
  if (_origCachePut) {
    Cache.prototype.put = function(request: RequestInfo | URL, response: Response): Promise<void> {
      return (_origCachePut.call(this, request, response) as Promise<void>).catch((err: unknown) => {
        console.warn("[model-worker] cache.put() rejected — disabling browser cache:", err);
        tfEnv.useBrowserCache = false;
        // Resolve (not reject): shard stays in memory, download continues
      });
    };
  }

  // §#1581-S1 (OPFS custom cache): replace Cache API with Origin Private File System.
  // Cache API fails on cold-cache Chrome under cross-origin cache pressure (cache.put
  // UnknownError → model in-memory-only → buffer_manager race on first real inference).
  // OPFS is persistent, not evicted by browser data-clearing, and has no per-origin quota cap
  // that triggers UnknownError. First visit: download + store to OPFS. Subsequent: serve from
  // OPFS directly (no network, no cache pressure). Falls back silently if OPFS unavailable.
  try {
    const _nav = (globalThis as unknown as { navigator?: { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } } }).navigator;
    const opfsRoot = await _nav?.storage?.getDirectory?.();
    if (opfsRoot) {
      const modelCacheDir = await opfsRoot.getDirectoryHandle("model-cache", { create: true });
      const _urlToOpfsName = (url: string): string => {
        const hash = Array.from(url).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
        const safe = url.replace(/[^a-zA-Z0-9._-]/g, "_");
        return `${(hash >>> 0).toString(16).padStart(8, "0")}_${safe.slice(-180)}`;
      };
      tfEnv.useCustomCache = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tfEnv as any).customCache = {
        async match(url: string): Promise<Response | undefined> {
          try {
            const fh = await modelCacheDir.getFileHandle(_urlToOpfsName(url));
            const file = await fh.getFile();
            const buf = await file.arrayBuffer();
            _modelLoadSource = "opfs-cache";
            // §#1638: first OPFS cache hit — advance bar to 50% floor without READY snap.
            // posting "returning-user" here raced with model_init/warmup events (bar 100% → reset).
            // boot-screen's monotonic guard holds 50% as floor; actual phases continue from there.
            if (!_opfsReturningUserPosted) {
              _opfsReturningUserPosted = true;
              post({ type: "opfs-warm-start" });
            }
            return new Response(buf, {
              headers: { "Content-Type": "application/octet-stream", "Content-Length": String(buf.byteLength) },
            });
          } catch { return undefined; }
        },
        async put(url: string, response: Response, progress_callback?: (d: { progress: number; loaded: number; total: number }) => void): Promise<void> {
          const filename = _urlToOpfsName(url);
          // Skip if already cached
          try { await modelCacheDir.getFileHandle(filename); return; } catch { /* not cached yet */ }
          const total = parseInt(response.headers.get("content-length") ?? "0", 10);
          let data: ArrayBuffer;
          if (response.body) {
            // §#1636: stream always so progress events fire even without progress_callback.
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let loaded = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value!);
              loaded += value!.byteLength;
              _cumulativeBytes += value!.byteLength;
              post({ type: "progress", phase: "model", file: filename, bytes: _cumulativeBytes, total: ESTIMATED_MODEL_BYTES, throughputBytesPerSec: calcThroughput(_cumulativeBytes) });
              if (progress_callback && total > 0) {
                progress_callback({ progress: (loaded / total) * 100, loaded, total });
              }
            }
            const merged = new Uint8Array(loaded);
            let off = 0;
            for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
            data = merged.buffer;
          } else {
            data = await response.arrayBuffer();
            _cumulativeBytes += data.byteLength;
          }
          try {
            if (!_opfsFirstWriteFired) {
              _opfsFirstWriteFired = true;
              post({ type: "phase_timing", phase: "opfs_first_write", elapsed_ms: Date.now() - _workerStartMs });
            }
            const fh = await modelCacheDir.getFileHandle(filename, { create: true });
            const writable = await fh.createWritable();
            await writable.write(data);
            await writable.close();
          } catch (writeErr) {
            console.warn("[model-worker] OPFS write failed, model stays in-memory:", writeErr);
          }
        },
      };
      console.info("[model-worker] OPFS cache active — model storage via Origin Private File System");
    }
  } catch (opfsErr) {
    console.warn("[model-worker] OPFS unavailable, falling back to browser cache:", opfsErr);
  }

  // §#1501: pre-acquire WebGPU device so ORT uses our reference (not an unexposed internal
  // one). On some integrated GPUs requestDevice() resolves AFTER ORT "loads" successfully
  // but before ort.env.webgpu.device is populated — causing warmup-flush + post-drafter-flush
  // to see hasDevice:false and skip, leaving the GPU command queue unflushed → buffer_manager
  // OOM on first real inference. Pre-acquiring here guarantees ort.env.webgpu.device is
  // non-null for the entire warmup path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _preAcquiredGpuDevice: any = null;
  // §#1627-C: hoisted so backends array can use it for classification-aware device selection.
  let _adClassification: "dgpu" | "igpu" | "software" | "unknown" = "unknown";
  try {
    const nav = (globalThis as unknown as { navigator?: Navigator }).navigator;
    if (nav?.gpu && !forceWasm) {  // §#1637: forceWasm=true skips WebGPU acquisition entirely
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = await (nav.gpu as any).requestAdapter({ powerPreference: "high-performance" })
        .catch(() => null);
      if (adapter) {
        // §#1627-A: adapter fingerprint — classify GPU class before device acquisition.
        // Emits one console.log + one phase_timing on every load (cold + warm) so any
        // user-shared console log carries the vendor/arch/classification discriminator
        // needed to diagnose cross-device parity issues (#1497 root cause).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const _adInfo = (adapter as any).info ?? {};
        const _adVendor = String(_adInfo.vendor ?? "").toLowerCase();
        const _adArch   = String(_adInfo.architecture ?? "").toLowerCase();
        const _adIsFallback = !!(adapter as any).isFallbackAdapter;
        const _adMaxBufferMB = Math.round(
          ((adapter as any).limits?.maxBufferSize ?? 0) / (1024 * 1024)
        );
        let _adClass: "dgpu" | "igpu" | "software" | "unknown";
        if (_adIsFallback) {
          _adClass = "software";
        } else if (
          _adVendor === "intel" &&
          (_adArch.startsWith("gen-") || _adArch.includes("iris") || _adArch.includes("uhd") || _adArch.includes("xe-lp"))
        ) {
          _adClass = "igpu";
        } else if (_adVendor === "amd" && (_adArch.includes("vega-igpu") || _adArch.includes("gfx10-igpu"))) {
          _adClass = "igpu";
        } else if (_adVendor === "apple") {
          _adClass = "igpu"; // unified memory — iGPU class for memory-pressure purposes
        } else if (_adVendor === "") {
          _adClass = "unknown";
        } else {
          _adClass = "dgpu";
        }
        _adClassification = _adClass; // §#1627-C: hoist for backends array
        const _adFingerprint = {
          vendor: (_adInfo.vendor as string | undefined) ?? null,
          architecture: (_adInfo.architecture as string | undefined) ?? null,
          device: ((_adInfo.description ?? _adInfo.device) as string | undefined) ?? null,
          maxBufferMB: _adMaxBufferMB,
          isFallback: _adIsFallback,
          classification: _adClass,
        };
        console.log(
          `[#1627] adapter vendor=${_adFingerprint.vendor ?? "?"} architecture=${_adFingerprint.architecture ?? "?"} device='${_adFingerprint.device ?? ""}' maxBuffer=${_adMaxBufferMB}MB isIntegrated=${_adClass === "igpu" || _adClass === "software"} classification=${_adClass}`
        );
        post({ type: "phase_timing", phase: "adapter_fingerprint", elapsed_ms: Date.now() - _workerStartMs, adapter_info: _adFingerprint });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _preAcquiredGpuDevice = await (adapter as any).requestDevice().catch(() => null) as GPUDevice | null;
        if (_preAcquiredGpuDevice) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (ort.env as any).webgpu = { ...((ort.env as any).webgpu ?? {}), device: _preAcquiredGpuDevice };
          // §#1627-D: classification-aware device.lost handler.
          // device.lost resolves when the GPU device is unexpectedly removed (TDR, driver crash,
          // resource pressure). Reason "destroyed" = intentional handleDestroyDevice cleanup — skip.
          // dgpu: retryBudget=1 → main thread recycles via existing D3D12 OOM path (one retry).
          // igpu/software: retryBudget=0 → main thread navigates to ?gpu=wasm (no WebGPU retry).
          const _lostBudget = _adClassification === "dgpu" ? 1 : 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (_preAcquiredGpuDevice as any).lost
            ?.then(async (info: { reason: string; message: string }) => {
              if (info?.reason === "destroyed") return; // intentional — handleDestroyDevice, non-fatal
              console.log(`[#1627-D] device.lost reason=${info?.reason ?? "unknown"} adClass=${_adClassification} retryBudget=${_lostBudget}`);
              // §#156 Layer 4: dispose ORT sessions before signaling harness — prevents holding
              // references to a dead GPU context (eliminates "TDR + app retries on lost device").
              if (_drafterSession) {
                try { await (_drafterSession as any).release?.(); } catch { /* non-fatal */ }
                _drafterSession = null;
              }
              if (_model) {
                try { await (_model as any).dispose?.(); } catch { /* non-fatal */ }
                _model = null;
              }
              _processor = null;
              post({ type: "device-lost", adClass: _adClassification, reason: info?.reason ?? "unknown", retryBudget: _lostBudget });
            })
            .catch(() => { /* device destroyed before .lost resolved — non-fatal */ });
        }
      }
    }
  } catch { /* navigator.gpu unavailable — fall through to CPU backend */ }

  // §#1627-C: iGPU/software classification and forceWasm both bypass "auto" (which independently
  // calls navigator.gpu.requestAdapter internally and picks WebGPU when available). Use explicit
  // "cpu" to guarantee WASM ORT EP without any WebGPU probe inside transformers.js.
  const _wasmFallback = forceWasm || _adClassification === "igpu" || _adClassification === "software";
  if (_wasmFallback && !forceWasm) {
    // User did not explicitly choose WASM — classification triggered it.
    console.log(`[#1627-C] classification-triggered-wasm-fallback adClass=${_adClassification} — cpu device (WASM ORT EP)`);
    post({ type: "phase_timing", phase: "wasm_fallback_classification", elapsed_ms: Date.now() - _workerStartMs, adClass: _adClassification });
  }
  const backends: Array<{ device: "webgpu"; dtype: "q4f16"; label: string }> = [
    { device: "webgpu", dtype: "q4f16", label: "GPU" },
  ];

  let loadedLabel = "CPU";

  post({ type: "phase_timing", phase: "from_pretrained_start", elapsed_ms: Date.now() - _workerStartMs });
  for (const { device, dtype, label } of backends) {
    // §#1501: if WebGPU device acquisition failed at the top, skip webgpu backend entirely.
    // §#1637: forceWasm=true also skips WebGPU — user chose WASM EP fallback path.
    if (device === "webgpu" && (!_preAcquiredGpuDevice || forceWasm)) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let model: Awaited<ReturnType<typeof Gemma4ForConditionalGeneration.from_pretrained>>;
      try {
        model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
          dtype, device, progress_callback: progressCb,
        });
      } catch (loadErr) {
        // §B-cache-retry (#1316): Cache.put() failure on fresh chromium profiles causes
        // Cache API to drop model shards silently, making ORT unable to find external data.
        // Retry once with browser cache disabled — forces direct fetch, bypassing Cache API.
        const isExternalDataErr = /Failed to load external data file|Can't create a session|Deserialize tensor/i
          .test((loadErr as Error).message ?? "");
        if (!isExternalDataErr) throw loadErr;
        tfEnv.useBrowserCache = false;
        await new Promise<void>(r => setTimeout(r, 500));
        model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
          dtype, device, progress_callback: progressCb,
        });
      }
      const processor = await AutoProcessor.from_pretrained(modelId);
      post({ type: "phase_timing", phase: "from_pretrained_end", elapsed_ms: Date.now() - _workerStartMs, downloaded_bytes: _cumulativeBytes, load_source: _modelLoadSource });

      // WebGPU sanity probe — same as main-thread path (#128/#133).
      // Skipped on recycle (noWarmup): GPU device is persistent, shaders already compiled.
      if (device === "webgpu" && !noWarmup) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const proc = processor as any;
          // Short probe: verify WebGPU backend can run at all. Real inference at ~1300 tok
          // (trimmed system prompt #1194) stays under SafeInt overflow threshold.
          const probeText = proc.tokenizer.apply_chat_template(
            [{ role: "user", content: "test" }],
            { tokenize: false, add_generation_prompt: true },
          ) as string;
          const probeIn = await proc(probeText);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (model as any).generate({ ...probeIn, max_new_tokens: 1 });
        } catch {
          if (_adClassification === "igpu" || _adClassification === "software") {
            console.log(`[#1627-C] webgpu-probe-failed adClass=${_adClassification} — falling back to WASM EP`);
            post({ type: "phase_timing", phase: "wasm_fallback_probe_failure", elapsed_ms: Date.now() - _workerStartMs, adClass: _adClassification });
          }
          continue; // WebGPU probe failed → try CPU
        }
      }

      _model = model;
      _processor = processor;
      loadedLabel = label;
      break;
    } catch (e) {
      post({ type: "error", error: (e as Error).message });
      return;
    }
  }

  // Restore original Cache.prototype.put — monkey-patch only covers model init.
  if (_origCachePut) Cache.prototype.put = _origCachePut as typeof Cache.prototype.put;

  if (!_model) {
    const reason = forceWasm || _wasmFallback
      ? GEMMA_ONNX_CPU_UNSUPPORTED
      : `${GEMMA_ONNX_CPU_UNSUPPORTED} WebGPU model load failed or no WebGPU device was acquired.`;
    post({ type: "error", error: reason });
    return;
  }

  _bootModelReady = true;
  post({ type: "model-ready", device: loadedLabel });
  post({ type: "phase_timing", phase: "model_ready", elapsed_ms: Date.now() - _workerStartMs });
  checkBootComplete();

  // Warmup probe — warms GPU shader pipeline; non-fatal if it fails.
  // Skipped on recycle (noWarmup): compiled pipelines persist in GPU driver cache.
  post({ type: "phase_timing", phase: "warmup_start", elapsed_ms: Date.now() - _workerStartMs });
  if (!noWarmup) {
    post({ type: "progress", phase: "warmup", bytes: 0, total: 0, throughputBytesPerSec: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = _processor as any;
    // §C-warmup-context (#1362): include system prompt so the probe exercises the same
    // KV cache buffer sizes as real inference (~1300 tokens). Without this, the probe
    // uses ~6 tokens and leaves GPU buffers undersized, causing ORT buffer_manager.cc:553
    // to crash (ERROR_CODE=1) on the first full-length inference call.
    //
    // §C-warmup-decode (#1362-B): generate 8 tokens (not 1) to exercise the GPU→CPU
    // readback path (BufferManager::Download) across multiple decode steps. The cold-cache
    // Schultz crash fires during multi-step decode — a 1-step warmup leaves the
    // wgpuBufferMapAsync→unmap pipeline untested, letting the race condition manifest on
    // the first real inference. 8 steps add ~1.5s to warmup and pre-allocate the decode
    // buffer pool to steady-state before the user submits any prompt.
    //
    // §#281 warmup-retry: warmup itself can fail with buffer_manager.cc:553 because deferred
    // GPU destructions from from_pretrained() are still in-flight when warmup fires. The fix:
    // retry warmup with exponential backoff. Each retry + flush gives destructions time to
    // settle. Once warmup succeeds, buffers are in steady-state before real inference.
    const warmupMessages: Array<{ role: string; content: string }> = warmupPrompt
      ? [{ role: "system", content: warmupPrompt }, { role: "user", content: "." }]
      : [{ role: "user", content: "." }];
    const chatText = proc.apply_chat_template(
      warmupMessages,
      { add_generation_prompt: true, tokenize: false },
    ) as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _warmupInputs: any = await proc(chatText, null);
    const tokCount: number = _warmupInputs.input_ids?.dims?.[1] ?? 0;
    if (tokCount < WEBGPU_CONTEXT_LIMIT - 64) {
      // §#1420: 30s timeout per attempt — best-effort; lets boot continue if WebGPU stalls.
      // Retry delays: 2s, 3s, 5s, 8s (total 18s wait across 4 retries + 5 attempts).
      const _warmupRetryDelays = [0, 2000, 3000, 5000, 8000];
      for (let _wr = 0; _wr < _warmupRetryDelays.length; _wr++) {
        if (_wr > 0) {
          const _d = _warmupRetryDelays[_wr];
          console.warn(`[model-worker] warmup-retry-${_wr} — flushing+waiting ${_d}ms`);
          await new Promise(r => setTimeout(r, _d));
          await _flushWgpuQueue(`warmup-retry-${_wr}`);
        }
        try {
          // §#1469-revert: max_new_tokens 2048 → 8. Phase J runs on b336897→91bb931 (5 SHAs)
          // confirmed max_new_tokens has no effect on +60s OOM — ORT does not pre-allocate
          // KV pool based on max_new_tokens (lazy-allocates per decode step instead). 2048 added
          // ~20s boot overhead with zero diagnostic value; reverting to minimize boot noise.
          //
          // §#1587: NOT the same issue as #1469. #1469 targeted +60s OOM (pool pre-sizing).
          // #1587 targets `buffer_manager.cc:553` race (wgpuBufferMapAsync fires before buffer
          // mapping resolves — a different mechanism). The lever here is running MORE DECODE
          // STEPS during the safe warmup window, forcing lazy buffer-lifecycle allocations to
          // settle before the first real inference. cold-cache Chrome path loads model in-memory
          // (cache.put rejected → useBrowserCache=false fallback) → higher GPU buffer pressure
          // → 8 steps insufficient. Cold-cache uses 64 steps (~12s extra); warm-cache stays at 8.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await Promise.race([
            (_model as any).generate({ ..._warmupInputs, max_new_tokens: _coldCacheBoot ? 64 : 8, do_sample: false }),
            new Promise<void>(r => setTimeout(r, 30_000)),
          ]);
          // §#1463: flush GPU command queue after warmup generate so all pending D3D12
          // buffer destructions complete before turn 1's OrtRun allocates. Without this,
          // async destroy() calls queue D3D12 commands that haven't executed by the time
          // turn 1 allocates, causing buffer_manager.cc:553 OOM → recycle.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const _wgpuDev = (ort.env as any)?.webgpu?.device as
            | { queue?: { onSubmittedWorkDone?: () => Promise<void> } }
            | undefined;
          if (_wgpuDev?.queue?.onSubmittedWorkDone) {
            console.log("[#1463] warmup-flush fired");
            await _wgpuDev.queue.onSubmittedWorkDone().catch(() => {/* non-fatal */});
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const _ortEnv = ort.env as any;
            console.log("[#1463] warmup-flush skipped — webgpu device unavailable", { hasWebgpu: !!_ortEnv?.webgpu, hasDevice: !!_ortEnv?.webgpu?.device });
          }
          console.log(`[model-worker] warmup-settled after ${_wr} retries`);
          // §#281 post-warmup settle (proactive-yield): from_pretrained() creates large
          // GPU buffer allocations; D3D12's deferred deletion queue takes ~30s to drain
          // these destructions. Validate-281 evidence: retries at ~30s after BOOT_COMPLETE
          // always succeed; retries at <11s always fail. Yield the event loop for 30s so
          // D3D12 drains BEFORE the first real inference (prevent, not recover-after-OOM).
          // Applies to cold-cache boots (initial and post-D3D12_OOM recycle with
          // nextInitNoWarmup=false, per agent-runtime-controller.ts D3D12_OOM case).
          if (_coldCacheBoot) {
            console.log("[#281] post-warmup settle: 30s proactive-yield for D3D12 destructions");
            await new Promise(r => setTimeout(r, 30_000));
            await _flushWgpuQueue("post-warmup-settle");
          }
          break; // warmup succeeded — buffers settled
        } catch (e) {
          if (_wr === _warmupRetryDelays.length - 1) {
            console.warn("[model-worker] warmup exhausted all retries:", (e as Error).message ?? e);
          }
          // else: continue retry loop (non-fatal on intermediate failures)
        }
      }
    }
  }
  post({ type: "phase_timing", phase: "warmup_end", elapsed_ms: Date.now() - _workerStartMs });

  _bootWarmupDone = true;
  post({ type: "warmup-done", skipped: noWarmup }); // #1313: skipped=true when noWarmup (recycle path)
  checkBootComplete();

  // §#1471-diag: Force drafter disabled — definitive isolation for +60s turn-1 OOM.
  // b336897 (iter-3) + 2e18375 (iter-8) both used WASM-only drafter (zero GPU VRAM) and
  // still showed +60s OOM. VRAM competition theory falsified. This diagnostic removes the
  // drafter entirely (no fetch, no session.create, no CPU RAM overhead) to test whether
  // drafter LOADING in any form triggers the OOM vs main-model decode being the source.
  // If OOM disappears → some aspect of drafter loading (shared ORT state, async init, event
  // loop pressure) is the trigger. If OOM persists → drafter is irrelevant, decode path itself.
  const _effectiveDrafterUrl: string | null = null;
  // Drafter load — fire after warmup; drafter-error is non-fatal (standard path covers)
  if (_effectiveDrafterUrl) {
    // §#1454: hoisted so catch block can check byteLength for WASM fallback.
    let drafterBuf: ArrayBuffer | null = null;
    try {
      post({ type: "progress", phase: "drafter", progress: 0, bytes: 0, total: 0, throughputBytesPerSec: 0 });
      let _drafterLastBytes = 0;
      let _drafterLastTs = Date.now();
      // §#1420: 10-min fetch cap — drafter is ~300MB; 10 min allows for slow CDN.
      // Reject path falls through to catch → drafter-error (non-fatal, standard backend covers).
      drafterBuf = await Promise.race([
        fetchDrafterCached(drafterUrl, drafterCacheKey, (loaded, total) => {
          const now = Date.now();
          const dtMs = now - _drafterLastTs;
          const throughputBytesPerSec = dtMs >= 50 ? Math.round((loaded - _drafterLastBytes) / (dtMs / 1000)) : 0;
          _drafterLastBytes = loaded;
          _drafterLastTs = now;
          post({
            type: "progress",
            phase: "drafter",
            progress: total > 0 ? (loaded / total) * 100 : -1,
            bytes: loaded,
            total,
            throughputBytesPerSec,
          });
        }),
        new Promise<ArrayBuffer>((_, reject) =>
          setTimeout(() => reject(new Error("drafter-fetch-timeout-600s")), 600_000)
        ),
      ]);
      // §#1470: WASM-only drafter — diagnostic for +60s turn-1 buffer_manager OOM.
      // 5 SHAs tested (b336897, 3427aeb, 63a60fd, a0a5541, 91bb931): OOM at exactly
      // +60574ms into turn 1 regardless of drafter WebGPU timeout (60s, 180s), device
      // flush path, or warmup max_new_tokens (8, 2048). Hypothesis: drafter WebGPU
      // session holds GPU VRAM (weight buffers + shader intermediates) that competes
      // with the main model's KV cache growth during decode. WASM-only → zero GPU VRAM
      // consumed by drafter → more headroom for KV cache → OOM moves later or disappears.
      // MTP gate (line 594: inputLength < 900) already skips drafter on typical prompts;
      // WASM decode speed loss is irrelevant for those cases.
      _drafterSession = await ort.InferenceSession.create(drafterBuf, {
        executionProviders: ["wasm"],
        preferredOutputLocation: { logits: "cpu", proj_state: "cpu" },
      });
      _bootDrafterDone = true;
      post({ type: "drafter-ready" });
    } catch (e) {
      _bootDrafterDone = true;
      const errMsg = (e as Error).message ?? "";
      if (errMsg === "drafter-ort-timeout-180s" && (drafterBuf as ArrayBuffer)?.byteLength > 0) {
        // §#1454: WebGPU shader compilation deadlocked. The abandoned ORT init still holds
        // the GPU queue, causing OrtRun failures on the main model during inference.
        // Retry with WASM-only — CPU execution avoids the GPU device conflict entirely.
        try {
          _drafterSession = await Promise.race([
            ort.InferenceSession.create(drafterBuf as ArrayBuffer, {
              executionProviders: ["wasm"],
              preferredOutputLocation: { logits: "cpu", proj_state: "cpu" },
            }),
            new Promise<any>((_, reject) =>
              setTimeout(() => reject(new Error("drafter-wasm-timeout-120s")), 120_000)
            ),
          ]);
          post({ type: "drafter-ready" });
        } catch (wasmErr) {
          post({ type: "drafter-error", error: `gpu-deadlock+wasm-failed: ${(wasmErr as Error).message?.slice(0, 80)}` });
        }
      } else {
        post({ type: "drafter-error", error: errMsg.slice(0, 120) });
      }
    }
  } else {
    // No drafter URL — drafter phase is skipped.
    _bootDrafterDone = true;
  }

  // §C-post-drafter-probe (#1410): The main warmup probe runs before the drafter
  // ORT session initializes its WebGPU context. ORT's WebGPU pipeline compilation
  // queues GPU commands that can interfere with the buffer Download path, causing
  // wgpuBufferMapAsync to fire BEFORE the buffer is ready. Run one generate step
  // after drafter init to flush the GPU command queue into steady state before
  // the first real inference. Only needed on cold-cache boot — warm-cache skips
  // the drafter WebGPU init path (ORT session is restored from OPFS cache).
  if (!noWarmup && _coldCacheBoot && _model && _processor) {
    try {
      const proc = _processor as any;
      const _syncText = proc.apply_chat_template(
        [{ role: "user", content: "." }],
        { add_generation_prompt: true, tokenize: false },
      ) as string;
      const _syncIn = await proc(_syncText, null);
      if ((_syncIn.input_ids?.dims?.[1] ?? 0) < WEBGPU_CONTEXT_LIMIT - 64) {
        // §#1416: Promise.race with 30s timeout — generate() can hang indefinitely on
        // cold-cache if drafter ORT WebGPU shader compilation still holds the GPU queue.
        // The probe is best-effort; timeout ensures checkBootComplete() always runs.
        // §#1587: second-pass deeper probe on cold-cache — same rationale as main warmup
        // increase above. 64 tokens exercises the buffer pool to cover first real inference.
        await Promise.race([
          (_model as any).generate({ ..._syncIn, max_new_tokens: _coldCacheBoot ? 64 : 1, do_sample: false }),
          new Promise<void>(r => setTimeout(r, 30_000)),
        ]);
        // §#1463: same GPU queue flush as main warmup probe — ensures post-drafter
        // probe's GPU commands complete before boot-complete fires.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const _wgpuDev2 = (ort.env as any)?.webgpu?.device as
          | { queue?: { onSubmittedWorkDone?: () => Promise<void> } }
          | undefined;
        if (_wgpuDev2?.queue?.onSubmittedWorkDone) {
          console.log("[#1463] post-drafter-flush fired");
          await _wgpuDev2.queue.onSubmittedWorkDone().catch(() => {/* non-fatal */});
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const _ortEnv2 = ort.env as any;
          console.log("[#1463] post-drafter-flush skipped — webgpu device unavailable", { hasWebgpu: !!_ortEnv2?.webgpu, hasDevice: !!_ortEnv2?.webgpu?.device });
        }
      }
    } catch { /* non-fatal — flush is best-effort */ }
  }

  checkBootComplete();
  void evictStaleModelCaches(modelId); // §#26: fire-and-forget; non-fatal
  post({ type: "ready", device: loadedLabel });
}

// ── Shutdown: release ORT sessions when worker is terminated ─────────────────
// §B-device-destroy (#1313): destroy the underlying WebGPU GPUDevice so D3D12 buffer
// pressure is fully released before the worker is terminated. Non-fatal — always posts
// device-destroyed so the main thread can proceed without waiting indefinitely.
//
// §C-destroy-null-ref (#1381-L1): after destroy(), null out the tfEnv device reference
// so ORT cannot reuse the destroyed handle on the next load path.
// NOTE: Lead 2 (await device.lost) was reverted — it caused a NEW failure class
// ("operation does not support unaligned accesses" + Aborted()) by leaving the WebGPU
// buffer pool partially-released before the null assignment, producing misaligned offsets
// on the next Worker's WASM imports. Synchronous destroy + immediate null is the correct shape.
function handleDestroyDevice(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backends = (tfEnv.backends as any);
    const device = backends?.onnx?.webgpu?.device as
      | { destroy?: () => void }
      | undefined;
    if (device && typeof device.destroy === "function") device.destroy();
    // L1: null the reference so ORT cannot resolve it on next load
    if (backends?.onnx?.webgpu) backends.onnx.webgpu.device = null;
  } catch { /* non-fatal — best-effort cleanup */ }
  post({ type: "device-destroyed" });
}

// §A-shutdown (#990): called via {type:"shutdown"} message before terminateWorker().
// Releases _drafterSession (ORT InferenceSession) and disposes _model (transformers.js).
// Non-fatal on any release error — worker still posts shutdown-complete.
async function handleShutdown(): Promise<void> {
  if (_drafterSession) {
    try { await (_drafterSession as any).release?.(); } catch { /* non-fatal */ }
    _drafterSession = null;
  }
  if (_model) {
    try { await (_model as any).dispose?.(); } catch { /* non-fatal */ }
    _model = null;
  }
  _processor = null;
  post({ type: "shutdown-complete" });
}

// §#156 Layer 3: tab-hidden VRAM reclaim — releases ORT sessions + model when tab goes hidden.
// Unlike handleShutdown, the worker stays alive and _lastInitData is preserved so
// handleSessionRefresh() can transparently reinitialise on next tab-visible event.
async function handleDisposeSession(): Promise<void> {
  if (_drafterSession) {
    try { await (_drafterSession as any).release?.(); } catch { /* non-fatal */ }
    _drafterSession = null;
  }
  if (_model) {
    try { await (_model as any).dispose?.(); } catch { /* non-fatal */ }
    _model = null;
  }
  _processor = null;
  // §#156 Layer 4: flush GPU queue after dispose to ensure memory returns to allocator.
  await _flushWgpuQueue("dispose-session");
  post({ type: "session-disposed" });
}

// §#380: inter-turn GPU flush — persistent-worker, no dispose/reload.
// Flushes deferred GPU destructions from prior-turn §A tensor disposal (generated/outputs/inputs).
// The ORT session and WebGPU device stay alive across turns; only the GPU queue is drained.
// This is the "in-place KV-reset": buffer_manager returns complete without destroying the device.
// Eliminates the dispose→reload→warmup OOM cycle that caused ghost every 3rd turn (b5af554).
async function handleSessionRefresh(): Promise<void> {
  try { await _handleSessionRefreshInner(); } catch (e) {
    const _msg = (e as Error)?.message ?? String(e);
    console.warn("[session-refresh] outer guard caught:", _msg.slice(0, 120));
    post({ type: "session-refresh-complete", skipped: true, reason: "guard-caught" });
  }
}
async function _handleSessionRefreshInner(): Promise<void> {
  if (!_lastInitData) {
    post({ type: "session-refresh-complete", skipped: true, reason: "no-init-data" });
    return;
  }

  // §#380: drain the GPU queue — completes deferred buffer_manager destructions from
  // prior-turn §A tensor dispose() calls. 200ms settle lets the destructions finalize
  // before T(n+1) inference begins. No model dispose, no reload, no warmup probe.
  await _flushWgpuQueue("inter-turn-flush");
  await new Promise(r => setTimeout(r, 200));

  post({ type: "session-refresh-complete", skipped: false });
}

// ── Generate: apply_chat_template + tokenize + (MTP or standard) + decode ────
async function handleGenerate(data: Record<string, unknown>): Promise<void> {
  // §#281 pre-generate proactive-yield: inference output buffers (KV cache updates,
  // logits) go into D3D12's deferred deletion queue after each generate() completes.
  // Without a yield, the next generate() fires before D3D12 drains them → OOM.
  // Yield 10s for inter-turn (smaller activation buffers than from_pretrained();
  // post-warmup-settle covers the first generate; this handles all subsequent ones).
  if (_generateCallCount > 0) {
    console.log("[#281] pre-generate proactive-yield: 10s for inter-turn D3D12 drain");
    await new Promise<void>(r => setTimeout(r, 10_000));
    await _flushWgpuQueue("pre-generate-yield");
  }
  _generateCallCount++; // §#307: session-level counter for heap-fragmentation estimation
  if (!_model || !_processor) {
    post({ type: "generate-error", turnId: data.turnId, error: "model not loaded" });
    return;
  }

  const turnId      = data.turnId as string;
  const messages    = data.messages as Array<{ role: string; content: string }>;
  const imageUrl    = data.imageUrl as string | undefined;
  const videoUrls   = data.videoUrls as string[] | undefined; // §#693 video content blocks
  const maxNewTokens = data.maxNewTokens as number;
  const eosId       = data.eosId as number;
  const draftK      = data.draftK as number;
  const useMtp      = data.useMtp as boolean;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = _processor as any;
  const t0 = performance.now();

  // Image: load from URL if provided
  let imageList: unknown[] = [];
  if (imageUrl) {
    try { imageList = [await RawImage.fromURL(imageUrl)]; } catch { /* skip on failure */ }
  }

  // §#693 Video: load each frame URL as RawImage[] for the video content block.
  // Gemma 4 processor accepts: proc(chatText, images=null, videos=[[frame, ...]])
  let videoFrames: unknown[] = [];
  if (videoUrls && videoUrls.length > 0) {
    for (const url of videoUrls) {
      try { videoFrames.push(await RawImage.fromURL(url)); } catch { /* skip bad frame */ }
    }
  }
  const hasVideo = videoFrames.length > 0;

  // Format messages into a single string via apply_chat_template
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let messagesForTemplate: any[] = messages;
  if (hasVideo) {
    // Video content block: { type: "video", video: RawImage[] } in last user message.
    const lastUser = [...messages];
    let ui = -1;
    for (let i = lastUser.length - 1; i >= 0; i--) {
      if (lastUser[i].role === "user") { ui = i; break; }
    }
    if (ui >= 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lastUser[ui] = { role: "user", content: [{ type: "video", video: videoFrames }, { type: "text", text: lastUser[ui].content }] as any };
      messagesForTemplate = lastUser;
    }
  } else if (imageUrl && imageList.length > 0) {
    // Splice image into the last user message as a multimodal content array
    const lastUser = [...messages];
    let ui = -1;
    for (let i = lastUser.length - 1; i >= 0; i--) {
      if (lastUser[i].role === "user") { ui = i; break; }
    }
    if (ui >= 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lastUser[ui] = { role: "user", content: [{ type: "image", image: imageList[0] }, { type: "text", text: lastUser[ui].content }] as any };
      messagesForTemplate = lastUser;
    }
  }
  const chatText = proc.apply_chat_template(messagesForTemplate, {
    add_generation_prompt: true,
    tokenize: false,
    enable_thinking: false, // #1044: skip <|think|> → all output budget for <tool_call> blocks
  }) as string;

  // Tokenize (pass image/video lists separately for processor's vision encoder).
  // Video: proc(chatText, images=null, videos=[[frame, ...]]) per transformers.js v4 API.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inputs: any = hasVideo
    ? await proc(chatText, null, [videoFrames])
    : await proc(chatText, imageList.length > 0 ? imageList : null);
  const tProc = performance.now();
  let inputLength: number = inputs.input_ids?.dims?.[1] ?? 0;
  // §C-budget (#1439): emit token budget ratio so main thread can show a chip when context is near-full.
  post({ type: "context-budget", inputLength, limit: WEBGPU_CONTEXT_LIMIT });

  // §#88: conversation trimming — VRAM guard for long multi-turn sessions.
  // T3 failure class: full conversation history (T1 27-dispatch output + T2) pushes the KV
  // cache allocation over available VRAM even when inputLength < WEBGPU_CONTEXT_LIMIT.
  // The GPU device-lost fires at +9s during initial KV allocation — before any bufMgr race.
  // Fix: if inputLength > 4096, drop oldest conversation pairs at message level, re-tokenize.
  // Skipped for video/image turns — they don't accumulate long multi-turn histories.
  const CONV_TRIM_TOKEN_CEILING = 4096;
  if (inputLength > CONV_TRIM_TOKEN_CEILING && !hasVideo && imageList.length === 0) {
    const _trimmedMsgs = _trimConversationMessages(messages, inputLength, CONV_TRIM_TOKEN_CEILING);
    if (_trimmedMsgs.length < messages.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const _trimChatText = proc.apply_chat_template(_trimmedMsgs, {
        add_generation_prompt: true, tokenize: false, enable_thinking: false,
      }) as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const _trimInputs: any = await proc(_trimChatText, null);
      const _trimLength: number = _trimInputs.input_ids?.dims?.[1] ?? 0;
      console.log(`[#88] [CONV-TRIM] trimmed ${inputLength - _trimLength} tokens (${messages.length - _trimmedMsgs.length} msgs) from ${inputLength} total → keeping ${_trimLength} (${_trimmedMsgs.length} msgs)`);
      // Dispose original inputs before replacing
      for (const _v of Object.values(inputs ?? {})) {
        try { (_v as any)?.dispose?.(); } catch { /* non-fatal */ }
      }
      inputs = _trimInputs;
      inputLength = _trimLength;
    }
  }

  const safeMaxNewTokens = Math.min(maxNewTokens, WEBGPU_CONTEXT_LIMIT - inputLength);
  if (safeMaxNewTokens <= 0) {
    post({ type: "generate-error", turnId, error: `Your conversation is too long for the model to process. Starting a new conversation will allow shorter inputs. (prompt: ${inputLength} tok, limit: ${WEBGPU_CONTEXT_LIMIT})` });
    return;
  }
  // Warn when context saturation severely reduces output budget — produces empty plans with no error.
  if (safeMaxNewTokens < maxNewTokens / 2) {
    post({
      type: "generate-warning",
      turnId,
      message: `Conversation is getting long — the model's reply budget has been reduced to ${safeMaxNewTokens} tokens. Starting a new conversation may improve response quality.`,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outputs: any;
  let specAttempts = 0;
  let specAccepts  = 0;

  // MTP spec-decode — disabled for long prompts: drafter produces degenerate output
  // (NaN verifier logits) on large inputs due to drafter KV window mismatch (#979).
  // Threshold 900: conservative safe zone; two-story-house prompt is ~997 tok.
  // WEBGPU_CONTEXT_LIMIT is now 16384 — this threshold is about drafter quality, not ceiling.
  if (useMtp && _drafterSession && MTP_VERIFICATION_WIRED && inputLength < 900) {
    try {
      const mtpSessions = getMtpSessions(_model);
      if (mtpSessions) {
        const inputIdsTensor = inputs.input_ids as { data: BigInt64Array; dims: number[] };
        const result = await runMtpSpecDecode(
          mtpSessions, _drafterSession, ort,
          inputIdsTensor.data, safeMaxNewTokens, draftK, eosId, MTP_CONFIG_E4B,
        );
        specAttempts = result.specAttempts;
        specAccepts  = result.specAccepts;
        const allNums = [...Array.from(inputIdsTensor.data, Number), ...result.tokens];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const makeTensor = (nums: number[]): any => ({
          data: new BigInt64Array(nums.map(BigInt)),
          dims: [1, nums.length],
          tolist: () => [nums.slice()],
          slice: (_ax: null, range: [number, null | undefined]) => makeTensor(nums.slice(range[0])),
        });
        outputs = makeTensor(allNums);
      }
    } catch (e) {
      console.warn("[model-worker] MTP error, standard fallback:", (e as Error).message);
      specAttempts = 0;
      specAccepts  = 0;
      outputs = undefined;
    }
  }

  // Standard generate fallback
  if (!outputs) {
    // Progress streamer — skip the initial prompt put, then post every 50 tokens generated.
    // Keeps the UI alive during long plans (two-story house ≈ 800 tokens @ 5-10 t/s = 80-160s).
    let _initPutSeen = false;
    let _tokensGenerated = 0;
    const _progressStreamer = {
      put: (_tokenIds: unknown) => {
        if (!_initPutSeen) { _initPutSeen = true; return; }
        _tokensGenerated++;
        if (_tokensGenerated === 1 || _tokensGenerated % 50 === 0) {
          post({ type: "generate-progress", turnId, tokens_generated: _tokensGenerated });
        }
      },
      end: () => {
        if (_tokensGenerated > 0) {
          post({ type: "generate-progress", turnId, tokens_generated: _tokensGenerated });
        }
      },
    };
    // §C-decode-retry (#1362-C): buffer_manager.cc:553 "Buffer was unmapped before mapping
    // was resolved" is a D3D12 CPU/GPU sync race triggered during multi-step decode.
    // §#83: pre-generate GPU flush added — drains ORT buffer destructions from prior turn
    // before new allocations begin. Each retry also flushes to clear the failed attempt's
    // pending destructions before the next attempt allocates fresh buffers.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _doGenerate = () => (_model as any).generate({
      ...inputs,
      max_new_tokens: safeMaxNewTokens,
      do_sample: false,
      streamer: _progressStreamer,
    });
    // §#83: flush ORT GPU queue before initial attempt — ensures all buffer destructions
    // from warmup probes and prior turns are committed before this turn allocates.
    await _flushWgpuQueue("pre-generate");
    // §#307 per-turn alignment sample — logged before every generate attempt so we build
    // a continuous inputIdsByteOffset distribution, not just the fatal-trap snapshot.
    {
      const _byteOff = (inputs as any)?.input_ids?.data?.byteOffset ?? -1;
      post({ type: 'align-sample-307', data: {
        generateCount: _generateCallCount,
        inputIdsByteOffset: _byteOff,
        mod8: _byteOff >= 0 ? _byteOff % 8 : -1,
      }});
    }
    try {
      outputs = await _doGenerate();
    } catch (genErr) {
      const _msg = String(genErr);
      if (!/buffer_manager|BufferManager|unmapped before mapping|unaligned accesses/i.test(_msg)) {
        throw genErr;
      }
      // §C-decode-retry (#1362-C, updated #1410, #83, #1632, #281): buffer_manager race OR WASM
      // alignment error — deferred GPU destructions from from_pretrained() fire during inference.
      // §#281: cold-cache extended to 4 retries [2s+3s+5s+8s=18s total]. T9 evidence: destructions
      // settle within ~18s of boot. Warmup retry loop handles the common (noWarmup=false) path;
      // this loop is the fallback for recycle-boot (noWarmup=true). Warm-cache: 1 retry [500ms].
      const _isAlignErr0 = /unaligned accesses/i.test(_msg);
      const _coldOrAlign = _coldCacheBoot || _isAlignErr0;
      const _retryDelays = _coldOrAlign ? [2000, 3000, 5000, 8000] : [500];
      for (let _ri = 0; _ri < _retryDelays.length; _ri++) {
        const _d = _retryDelays[_ri];
        console.warn(`[model-worker] buffer_manager retry-${_ri + 1} — flushing+waiting ${_d}ms`, _ri === 0 ? _msg.slice(0, 120) : "");
        await new Promise(r => setTimeout(r, _d));
        await _flushWgpuQueue(`retry-${_ri + 1}`); // §#83
        try {
          outputs = await _doGenerate();
          break; // succeeded
        } catch (retryErr) {
          const _retryMsg = String(retryErr);
          if (!/buffer_manager|BufferManager|unmapped before mapping|unaligned accesses/i.test(_retryMsg)) {
            throw retryErr; // different error class — not retryable
          }
          const _isAlignErr = /unaligned accesses/i.test(_retryMsg);
          // Warm-cache non-align path: only 1 retry — do not continue
          if (!_coldOrAlign && !_isAlignErr) throw retryErr;
          if (_ri === _retryDelays.length - 1) {
            // §#307 diagnostic: capture alignment context on exhausted-retry fail.
            if (_isAlignErr) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const _ortEnv = (ort as any).env ?? {};
              const _diag = {
                generateCount:  _generateCallCount,
                inputTokens:    inputLength,
                inputIdsDims:   (inputs as any)?.input_ids?.dims ?? [],
                // byteOffset of the typed-array backing buffer — alignment indicator
                inputIdsByteOffset: (inputs as any)?.input_ids?.data?.byteOffset ?? -1,
                ortBackend:     _ortEnv.webgpu?.device ? 'webgpu' : 'wasm',
                ortVersion:     String((ort as any).version ?? 'unknown'),
                errMsg:         _retryMsg.slice(0, 200),
                errStack:       ((retryErr as Error).stack ?? '').slice(0, 400),
              };
              console.warn('[align-diag-307]', JSON.stringify(_diag));
              post({ type: 'align-diag-307', data: _diag });
            }
            throw retryErr;
          }
          // else: continue retry loop
        }
      }
    }
  }

  const tGen = performance.now();

  // Decode newly generated tokens only
  const generated = inputLength > 0
    ? (outputs as any).slice(null, [inputLength, null])
    : outputs;
  const tokensOut: number = (generated as any)?.dims?.[1] ?? 0;

  const decoded: string[] = proc.batch_decode(
    typeof (generated as any).tolist === "function" ? (generated as any).tolist() : generated,
    { skip_special_tokens: true },
  );

  // §A (#990): release GPU-backed ORT tensors after decode — prevents KV VRAM leak at 16K depth.
  try { if (generated !== outputs) (generated as any)?.dispose?.(); } catch { /* non-fatal */ }
  try { (outputs as any)?.dispose?.(); } catch { /* non-fatal */ }
  // §A-inputs (#1303): release input tensors (WebGPU-backed by processor) each turn.
  for (const v of Object.values(inputs ?? {})) {
    try { (v as any)?.dispose?.(); } catch { /* non-fatal */ }
  }
  // §#412-reverted: post-dispose flush removed. The ghost (#281) was caused by
  // unplannedOomCount not resetting in recovery path (fixed in #418 via BOOT_COMPLETE reset),
  // not by between-turn async destructions. Flush was dead weight — OOMs fire mid-inference
  // (confirmed: window.__agent_d3d12_recycles=8/8 turns on deployed receipt).
  post({
    type: "generate-done",
    turnId,
    text:         decoded[0] ?? "",
    specAttempts,
    specAccepts,
    prefillMs:    tProc - t0,
    decodeMs:     tGen - tProc,
    inputLength,
    tokensOut,
  });
}
