/// <reference lib="webworker" />
// onnx-transformers-backend.ts — OnnxTransformersBackend (#591 P0).
// Extracted from model-worker.ts; pure extraction, no behavior change.
// All model state (Gemma4ForConditionalGeneration, ORT, OPFS cache, warmup,
// MTP spec-decode, retry logic) lives here. The thin model-worker.ts shell
// instantiates this based on the ?engine URL param.

import { Gemma4ForConditionalGeneration, AutoProcessor, RawImage, env as tfEnv } from "@huggingface/transformers";
import { getMtpSessions, runMtpSpecDecode, MTP_CONFIG_E4B } from "./webgpu-mtp-backend.js";
import { fetchDrafterCached } from "./drafter-cache.js";
// §C-ort-static (#1375): static import bundles ORT directly into the worker chunk.
// Dynamic `await import("onnxruntime-web")` caused vite to emit a separate
// hash-stamped ort.bundle.min-*.js that could 404 on Pages when deployment
// hashes drifted between builds. Static import eliminates the separate chunk.
import * as ort from "onnxruntime-web";

import type { InferenceBackend, LoadOpts, PostFn } from "./inference-backend.js";

const WEBGPU_CONTEXT_LIMIT = 16384;
const GEMMA_ONNX_CPU_UNSUPPORTED =
  "Gemma ONNX Q4 CPU/WASM fallback is unsupported: onnxruntime-web WASM has no " +
  "GatherBlockQuantized kernel for the quantized Gemma graph (for example " +
  "node_embedding_Quant). Use WebGPU with a compatible dedicated GPU, a remote " +
  "Gemma endpoint, or the configured GGUF WASM backend instead.";

// MTP verification gate (#679).  True = real greedy token comparison is wired
// in webgpu-mtp-backend.ts (runMtpSpecDecode compares argmax(target) vs draftToken).
const MTP_VERIFICATION_WIRED = true;

export class OnnxTransformersBackend implements InferenceBackend {
  readonly id = "onnx" as const;
  readonly caps = { multimodal: true, mtp: true };

  private readonly _post: PostFn;

  // §#1595-M2: epoch for phase_timing elapsed_ms fields.
  private readonly _workerStartMs: number;
  // Sentinel: first OPFS write fires one phase_timing event then stays silent.
  private _opfsFirstWriteFired = false;

  // ── Worker state ─────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _model: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _processor: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _drafterSession: any = null;
  // §#1410: true when model weights weren't in Cache API at boot time.
  private _coldCacheBoot = false;
  // §#307 diagnostic: count generate() calls in this worker session.
  private _generateCallCount = 0;

  // Boot-completion tracking — boot-complete fires when all three phases done.
  private _bootModelReady = false;
  private _bootWarmupDone = false;
  private _bootDrafterDone = false;
  // §#88-C: stored for transparent ORT session refresh (no re-download needed)
  private _lastInitData: Record<string, unknown> | null = null;

  // Throughput tracking for progress events.
  private _progressLastBytes = 0;
  private _progressLastTs = 0;

  constructor(post: PostFn) {
    this._post = post;
    this._workerStartMs = Date.now();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private _calcThroughput(cumulativeBytes: number): number {
    const now = Date.now();
    const dtMs = now - this._progressLastTs;
    const db = cumulativeBytes - this._progressLastBytes;
    this._progressLastBytes = cumulativeBytes;
    this._progressLastTs = now;
    if (dtMs < 50 || db <= 0) return 0;
    return Math.round(db / (dtMs / 1000));
  }

  // §#83: GPU command queue flush — drain ORT WebGPU buffer destructions before each generate.
  private async _flushWgpuQueue(tag: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _dev = (ort.env as any)?.webgpu?.device as
      | { queue?: { onSubmittedWorkDone?: () => Promise<void> } }
      | undefined;
    if (_dev?.queue?.onSubmittedWorkDone) {
      console.log(`[#83] wgpu-queue-flush ${tag}`);
      await _dev.queue.onSubmittedWorkDone().catch(() => { /* non-fatal */ });
    }
  }

  // §#88: conversation trimming — drop oldest turns when input token count exceeds ceiling.
  private _trimConversationMessages(
    messages: Array<{ role: string; content: string }>,
    currentTokenCount: number,
    tokenCeiling: number,
  ): Array<{ role: string; content: string }> {
    if (currentTokenCount <= tokenCeiling) return messages;
    const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
    if (totalChars === 0) return messages;
    const targetChars = Math.floor((tokenCeiling / currentTokenCount) * totalChars);
    const hasSystem = messages.length > 0 && messages[0].role === "system";
    const keepFixed = hasSystem ? [messages[0]] : [];
    const rest = messages.slice(hasSystem ? 1 : 0);
    if (rest.length <= 1) return messages;
    const latestUser = rest[rest.length - 1];
    const middle = rest.slice(0, -1);
    const fixedChars = [...keepFixed, latestUser].reduce((s, m) => s + m.content.length, 0);
    let currentTotal = fixedChars + middle.reduce((s, m) => s + m.content.length, 0);
    let dropCount = 0;
    while (dropCount < middle.length && currentTotal > targetChars) {
      currentTotal -= middle[dropCount].content.length;
      dropCount++;
    }
    if (dropCount === 0) return messages;
    return [...keepFixed, ...middle.slice(dropCount), latestUser];
  }

  private _checkBootComplete(): void {
    if (this._bootModelReady && this._bootWarmupDone && this._bootDrafterDone) {
      this._post({ type: "boot-complete" });
    }
  }

  private async _checkReturningUser(modelId: string): Promise<boolean> {
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

  // §#26: evict Cache API entries for old model versions.
  private async _evictStaleModelCaches(currentModelId: string): Promise<void> {
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
          console.info(`[onnx-backend] §#26 evicted stale cache "${name}" (no URLs for ${currentModelId})`);
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── load (handleInit) ─────────────────────────────────────────────────────────

  async load(modelId: string, opts: LoadOpts): Promise<void> {
    this._lastInitData = { modelId, ...opts }; // §#88-C: store for transparent session refresh
    this._post({ type: "phase_timing", phase: "worker_init", elapsed_ms: Date.now() - this._workerStartMs });
    // §A-init (#990): dispose prior ORT sessions on re-init (model swap) — prevents VRAM leak.
    if (this._drafterSession) {
      try { await (this._drafterSession as any).release?.(); } catch { /* non-fatal */ }
      this._drafterSession = null;
    }
    if (this._model) {
      try { await (this._model as any).dispose?.(); } catch { /* non-fatal */ }
      this._model = null;
    }
    this._processor = null;

    const drafterUrl = opts.drafterUrl as string;
    const drafterCacheKey = opts.drafterCacheKey as string;
    // noWarmup: set by recycle path.
    const noWarmup = (opts.noWarmup as boolean | undefined) === true;
    // §#1637 Path 2: forceWasm=true → skip WebGPU adapter entirely.
    const forceWasm = (opts.forceWasm as boolean | undefined) === true;
    // §C-warmup-context (#1362): representative system prompt passed from main thread.
    const warmupPrompt = (opts.warmupPrompt as string | undefined) ?? "";

    const isReturning = await this._checkReturningUser(modelId);
    this._coldCacheBoot = !isReturning;
    if (isReturning) {
      this._post({ type: "returning-user" });
    }
    let _opfsReturningUserPosted = isReturning;

    const ESTIMATED_MODEL_BYTES = 5_500_000_000;
    this._post({ type: "manifest", totalBytesExpected: ESTIMATED_MODEL_BYTES });

    // §C-quota-probe (#1490): incognito / low-storage devices.
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
        const throughputBytesPerSec = this._calcThroughput(_cumulativeBytes);
        this._post({
          type: "progress",
          phase: "model",
          progress: (info.progress as number | undefined) ?? 0,
          file: ((info.name as string | undefined) ?? "").split("/").pop() ?? "",
          bytes,
          total,
          throughputBytesPerSec,
        });
      } else if (info.status === "initiate") {
        const initFile = ((info.name as string | undefined) ?? "").split("/").pop() ?? "";
        // §#19-P1-ac1: log component names so CDP gate detects them on OPFS warm loads
        if (initFile) console.log("[#19-P1] loading:", initFile);
        this._post({
          type: "progress",
          phase: "model",
          progress: 0,
          file: initFile,
          bytes: 0,
          total: 0,
          throughputBytesPerSec: 0,
        });
      } else if (info.status === "loading") {
        this._post({ type: "progress", phase: "model-init", bytes: 0, total: 0, throughputBytesPerSec: 0 });
      }
    };

    // §C-cache-put-fallback (#1490): belt-and-suspenders for cache.put() UnknownError.
    type CachePutFn = (request: RequestInfo | URL, response: Response) => Promise<void>;
    const _origCachePut: CachePutFn | null =
      typeof Cache !== "undefined" && typeof Cache.prototype.put === "function"
        ? (Cache.prototype.put as CachePutFn)
        : null;
    if (_origCachePut) {
      Cache.prototype.put = function(request: RequestInfo | URL, response: Response): Promise<void> {
        return (_origCachePut.call(this, request, response) as Promise<void>).catch((err: unknown) => {
          console.warn("[onnx-backend] cache.put() rejected — disabling browser cache:", err);
          tfEnv.useBrowserCache = false;
        });
      };
    }

    // §#1581-S1 (OPFS custom cache)
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
          match: async (url: string): Promise<Response | undefined> => {
            try {
              const fh = await modelCacheDir.getFileHandle(_urlToOpfsName(url));
              const file = await fh.getFile();
              const buf = await file.arrayBuffer();
              _modelLoadSource = "opfs-cache";
              // §#1638: first OPFS cache hit — advance bar to 50% floor without READY snap.
              if (!_opfsReturningUserPosted) {
                _opfsReturningUserPosted = true;
                this._post({ type: "opfs-warm-start" });
              }
              return new Response(buf, {
                headers: { "Content-Type": "application/octet-stream", "Content-Length": String(buf.byteLength) },
              });
            } catch { return undefined; }
          },
          put: async (url: string, response: Response, progress_callback?: (d: { progress: number; loaded: number; total: number }) => void): Promise<void> => {
            const filename = _urlToOpfsName(url);
            try { await modelCacheDir.getFileHandle(filename); return; } catch { /* not cached yet */ }
            const total = parseInt(response.headers.get("content-length") ?? "0", 10);
            let data: ArrayBuffer;
            if (response.body) {
              const reader = response.body.getReader();
              const chunks: Uint8Array[] = [];
              let loaded = 0;
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value!);
                loaded += value!.byteLength;
                _cumulativeBytes += value!.byteLength;
                this._post({ type: "progress", phase: "model", file: filename, bytes: _cumulativeBytes, total: ESTIMATED_MODEL_BYTES, throughputBytesPerSec: this._calcThroughput(_cumulativeBytes) });
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
              if (!this._opfsFirstWriteFired) {
                this._opfsFirstWriteFired = true;
                this._post({ type: "phase_timing", phase: "opfs_first_write", elapsed_ms: Date.now() - this._workerStartMs });
              }
              const fh = await modelCacheDir.getFileHandle(filename, { create: true });
              const writable = await fh.createWritable();
              await writable.write(data);
              await writable.close();
            } catch (writeErr) {
              console.warn("[onnx-backend] OPFS write failed, model stays in-memory:", writeErr);
            }
          },
        };
        console.info("[onnx-backend] OPFS cache active — model storage via Origin Private File System");
      }
    } catch (opfsErr) {
      console.warn("[onnx-backend] OPFS unavailable, falling back to browser cache:", opfsErr);
    }

    // §#1501: pre-acquire WebGPU device so ORT uses our reference.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let _preAcquiredGpuDevice: any = null;
    // §#1627-C: hoisted so backends array can use it for classification-aware device selection.
    let _adClassification: "dgpu" | "igpu" | "software" | "unknown" = "unknown";
    try {
      const nav = (globalThis as unknown as { navigator?: Navigator }).navigator;
      if (nav?.gpu && !forceWasm) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const adapter = await (nav.gpu as any).requestAdapter({ powerPreference: "high-performance" })
          .catch(() => null);
        if (adapter) {
          // §#1627-A: adapter fingerprint.
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
            _adClass = "igpu";
          } else if (_adVendor === "") {
            _adClass = "unknown";
          } else {
            _adClass = "dgpu";
          }
          _adClassification = _adClass;
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
          this._post({ type: "phase_timing", phase: "adapter_fingerprint", elapsed_ms: Date.now() - this._workerStartMs, adapter_info: _adFingerprint });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          _preAcquiredGpuDevice = await (adapter as any).requestDevice().catch(() => null) as GPUDevice | null;
          if (_preAcquiredGpuDevice) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (ort.env as any).webgpu = { ...((ort.env as any).webgpu ?? {}), device: _preAcquiredGpuDevice };
            // §#1627-D: classification-aware device.lost handler.
            const _lostBudget = _adClassification === "dgpu" ? 1 : 0;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (_preAcquiredGpuDevice as any).lost
              ?.then(async (info: { reason: string; message: string }) => {
                if (info?.reason === "destroyed") return;
                console.log(`[#1627-D] device.lost reason=${info?.reason ?? "unknown"} adClass=${_adClassification} retryBudget=${_lostBudget}`);
                // §#156 Layer 4: dispose ORT sessions before signaling harness.
                if (this._drafterSession) {
                  try { await (this._drafterSession as any).release?.(); } catch { /* non-fatal */ }
                  this._drafterSession = null;
                }
                if (this._model) {
                  try { await (this._model as any).dispose?.(); } catch { /* non-fatal */ }
                  this._model = null;
                }
                this._processor = null;
                this._post({ type: "device-lost", adClass: _adClassification, reason: info?.reason ?? "unknown", retryBudget: _lostBudget });
              })
              .catch(() => { /* device destroyed before .lost resolved — non-fatal */ });
          }
        }
      }
    } catch { /* navigator.gpu unavailable — fall through to CPU backend */ }

    // §#1627-C: classification-aware WASM fallback.
    const _wasmFallback = forceWasm || _adClassification === "igpu" || _adClassification === "software";
    if (_wasmFallback && !forceWasm) {
      console.log(`[#1627-C] classification-triggered-wasm-fallback adClass=${_adClassification} — cpu device (WASM ORT EP)`);
      this._post({ type: "phase_timing", phase: "wasm_fallback_classification", elapsed_ms: Date.now() - this._workerStartMs, adClass: _adClassification });
    }
    // opts.dtype=undefined → let transformers.js_config in config.json drive (QAT model uses q2f16/fp16).
    // No "q4f16" fallback: preserve undefined so the conditional spread in from_pretrained omits dtype.
    const _backendDtype = opts.dtype as string | undefined;
    const backends: Array<{ device: "webgpu"; dtype: string | undefined; label: string }> = [
      { device: "webgpu", dtype: _backendDtype, label: "GPU" },
    ];

    let loadedLabel = "CPU";

    this._post({ type: "phase_timing", phase: "from_pretrained_start", elapsed_ms: Date.now() - this._workerStartMs });
    // §#19-P1-ac1-b: expose class name to main thread BEFORE from_pretrained.
    this._post({ type: "model-class", className: "Gemma4ForConditionalGeneration" });
    for (const { device, dtype, label } of backends) {
      // §#1501: skip webgpu if device acquisition failed. §#1637: forceWasm also skips.
      if (device === "webgpu" && (!_preAcquiredGpuDevice || forceWasm)) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let model: Awaited<ReturnType<typeof Gemma4ForConditionalGeneration.from_pretrained>>;
        try {
          // dtype undefined → transformers.js reads transformers.js_config.dtype from config.json
          model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(dtype !== undefined ? { dtype: dtype as any } : {}),
            device, progress_callback: progressCb,
          });
        } catch (loadErr) {
          // §B-cache-retry (#1316): Cache.put() failure → retry with browser cache disabled.
          const isExternalDataErr = /Failed to load external data file|Can't create a session|Deserialize tensor/i
            .test((loadErr as Error).message ?? "");
          if (!isExternalDataErr) throw loadErr;
          tfEnv.useBrowserCache = false;
          await new Promise<void>(r => setTimeout(r, 500));
          model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(dtype !== undefined ? { dtype: dtype as any } : {}),
            device, progress_callback: progressCb,
          });
        }
        const processor = await AutoProcessor.from_pretrained(modelId);
        // §#19-qat: JS heap measurement for footprint eval (Chrome only, non-fatal).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const _perf = (globalThis as any).performance as (Performance & { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } }) | undefined;
        const _heapUsed = _perf?.memory?.usedJSHeapSize ?? null;
        this._post({ type: "phase_timing", phase: "from_pretrained_end", elapsed_ms: Date.now() - this._workerStartMs, downloaded_bytes: _cumulativeBytes, load_source: _modelLoadSource, heap_used_bytes: _heapUsed });

        // WebGPU sanity probe.
        if (device === "webgpu" && !noWarmup) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const proc = processor as any;
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
              this._post({ type: "phase_timing", phase: "wasm_fallback_probe_failure", elapsed_ms: Date.now() - this._workerStartMs, adClass: _adClassification });
            }
            continue;
          }
        }

        this._model = model;
        this._processor = processor;
        loadedLabel = label;
        break;
      } catch (e) {
        this._post({ type: "error", error: (e as Error).message });
        return;
      }
    }

    // Restore original Cache.prototype.put.
    if (_origCachePut) Cache.prototype.put = _origCachePut as typeof Cache.prototype.put;

    if (!this._model) {
      const reason = forceWasm || _wasmFallback
        ? GEMMA_ONNX_CPU_UNSUPPORTED
        : `${GEMMA_ONNX_CPU_UNSUPPORTED} WebGPU model load failed or no WebGPU device was acquired.`;
      this._post({ type: "error", error: reason });
      return;
    }

    this._bootModelReady = true;
    this._post({ type: "model-ready", device: loadedLabel });
    this._post({ type: "phase_timing", phase: "model_ready", elapsed_ms: Date.now() - this._workerStartMs });
    this._checkBootComplete();

    // Warmup probe.
    this._post({ type: "phase_timing", phase: "warmup_start", elapsed_ms: Date.now() - this._workerStartMs });
    if (!noWarmup) {
      try {
        this._post({ type: "progress", phase: "warmup", bytes: 0, total: 0, throughputBytesPerSec: 0 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const proc = this._processor as any;
        // §C-warmup-context (#1362): include system prompt so probe exercises real KV cache buffer sizes.
        const warmupMessages: Array<{ role: string; content: string }> = warmupPrompt
          ? [{ role: "system", content: warmupPrompt }, { role: "user", content: "." }]
          : [{ role: "user", content: "." }];
        const chatText = proc.apply_chat_template(
          warmupMessages,
          { add_generation_prompt: true, tokenize: false },
        ) as string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const inputs: any = await proc(chatText, null);
        const tokCount: number = inputs.input_ids?.dims?.[1] ?? 0;
        if (tokCount < WEBGPU_CONTEXT_LIMIT - 64) {
          // §#1587: cold-cache uses 64 steps; warm-cache stays at 8.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await Promise.race([
            (this._model as any).generate({ ...inputs, max_new_tokens: this._coldCacheBoot ? 64 : 8, do_sample: false }),
            new Promise<void>(r => setTimeout(r, 30_000)),
          ]);
          // §#1463: flush GPU queue after warmup.
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
        }
      } catch (e) {
        console.warn("[onnx-backend] warmup probe failed:", (e as Error).message ?? e);
      }
    }
    this._post({ type: "phase_timing", phase: "warmup_end", elapsed_ms: Date.now() - this._workerStartMs });

    this._bootWarmupDone = true;
    this._post({ type: "warmup-done", skipped: noWarmup });
    this._checkBootComplete();

    // §#1471-diag: Force drafter disabled.
    const _effectiveDrafterUrl: string | null = null;
    if (_effectiveDrafterUrl) {
      let drafterBuf: ArrayBuffer | null = null;
      try {
        this._post({ type: "progress", phase: "drafter", progress: 0, bytes: 0, total: 0, throughputBytesPerSec: 0 });
        let _drafterLastBytes = 0;
        let _drafterLastTs = Date.now();
        drafterBuf = await Promise.race([
          fetchDrafterCached(drafterUrl, drafterCacheKey, (loaded, total) => {
            const now = Date.now();
            const dtMs = now - _drafterLastTs;
            const throughputBytesPerSec = dtMs >= 50 ? Math.round((loaded - _drafterLastBytes) / (dtMs / 1000)) : 0;
            _drafterLastBytes = loaded;
            _drafterLastTs = now;
            this._post({
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
        this._drafterSession = await ort.InferenceSession.create(drafterBuf, {
          executionProviders: ["wasm"],
          preferredOutputLocation: { logits: "cpu", proj_state: "cpu" },
        });
        this._bootDrafterDone = true;
        this._post({ type: "drafter-ready" });
      } catch (e) {
        this._bootDrafterDone = true;
        const errMsg = (e as Error).message ?? "";
        if (errMsg === "drafter-ort-timeout-180s" && (drafterBuf as ArrayBuffer)?.byteLength > 0) {
          // §#1454: WebGPU shader compilation deadlocked → retry with WASM-only.
          try {
            this._drafterSession = await Promise.race([
              ort.InferenceSession.create(drafterBuf as ArrayBuffer, {
                executionProviders: ["wasm"],
                preferredOutputLocation: { logits: "cpu", proj_state: "cpu" },
              }),
              new Promise<any>((_, reject) =>
                setTimeout(() => reject(new Error("drafter-wasm-timeout-120s")), 120_000)
              ),
            ]);
            this._post({ type: "drafter-ready" });
          } catch (wasmErr) {
            this._post({ type: "drafter-error", error: `gpu-deadlock+wasm-failed: ${(wasmErr as Error).message?.slice(0, 80)}` });
          }
        } else {
          this._post({ type: "drafter-error", error: errMsg.slice(0, 120) });
        }
      }
    } else {
      this._bootDrafterDone = true;
    }

    // §C-post-drafter-probe (#1410).
    if (!noWarmup && this._coldCacheBoot && this._model && this._processor) {
      try {
        const proc = this._processor as any;
        const _syncText = proc.apply_chat_template(
          [{ role: "user", content: "." }],
          { add_generation_prompt: true, tokenize: false },
        ) as string;
        const _syncIn = await proc(_syncText, null);
        if ((_syncIn.input_ids?.dims?.[1] ?? 0) < WEBGPU_CONTEXT_LIMIT - 64) {
          await Promise.race([
            (this._model as any).generate({ ..._syncIn, max_new_tokens: this._coldCacheBoot ? 64 : 1, do_sample: false }),
            new Promise<void>(r => setTimeout(r, 30_000)),
          ]);
          // §#1463: post-drafter GPU queue flush.
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

    this._checkBootComplete();
    void this._evictStaleModelCaches(modelId);
    this._post({ type: "ready", device: loadedLabel });
  }

  // ── dispose (handleShutdown) ──────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this._drafterSession) {
      try { await (this._drafterSession as any).release?.(); } catch { /* non-fatal */ }
      this._drafterSession = null;
    }
    if (this._model) {
      try { await (this._model as any).dispose?.(); } catch { /* non-fatal */ }
      this._model = null;
    }
    this._processor = null;
    this._post({ type: "shutdown-complete" });
  }

  // ── destroyDevice (handleDestroyDevice) ───────────────────────────────────────

  destroyDevice(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const backends = (tfEnv.backends as any);
      const device = backends?.onnx?.webgpu?.device as
        | { destroy?: () => void }
        | undefined;
      if (device && typeof device.destroy === "function") device.destroy();
      if (backends?.onnx?.webgpu) backends.onnx.webgpu.device = null;
    } catch { /* non-fatal — best-effort cleanup */ }
    this._post({ type: "device-destroyed" });
  }

  // ── disposeSession (handleDisposeSession) ─────────────────────────────────────

  async disposeSession(): Promise<void> {
    if (this._drafterSession) {
      try { await (this._drafterSession as any).release?.(); } catch { /* non-fatal */ }
      this._drafterSession = null;
    }
    if (this._model) {
      try { await (this._model as any).dispose?.(); } catch { /* non-fatal */ }
      this._model = null;
    }
    this._processor = null;
    await this._flushWgpuQueue("dispose-session");
    this._post({ type: "session-disposed" });
  }

  // ── sessionRefresh (handleSessionRefresh) ─────────────────────────────────────

  async sessionRefresh(): Promise<void> {
    try { await this._sessionRefreshInner(); } catch (e) {
      const _msg = (e as Error)?.message ?? String(e);
      console.warn("[session-refresh] outer guard caught:", _msg.slice(0, 120));
      this._post({ type: "session-refresh-complete", skipped: true, reason: "guard-caught" });
    }
  }

  private async _sessionRefreshInner(): Promise<void> {
    if (!this._lastInitData) {
      this._post({ type: "session-refresh-complete", skipped: true, reason: "no-init-data" });
      return;
    }

    // §#197-reinit: model was PAUSED — reload from stored init data.
    if (!this._model || !this._processor) {
      this._bootModelReady = false;
      this._bootWarmupDone = false;
      this._bootDrafterDone = false;
      const { modelId, ...restOpts } = this._lastInitData;
      await this.load(modelId as string, { ...restOpts, noWarmup: true } as LoadOpts);
      this._post({ type: "session-refresh-complete", skipped: false });
      return;
    }

    // §#380: drain GPU queue — completes deferred buffer_manager destructions.
    await this._flushWgpuQueue("inter-turn-flush");
    await new Promise(r => setTimeout(r, 200));

    this._post({ type: "session-refresh-complete", skipped: false });
  }

  // ── generate (handleGenerate) ─────────────────────────────────────────────────

  async generate(req: Record<string, unknown>): Promise<void> {
    this._generateCallCount++;
    if (!this._model || !this._processor) {
      this._post({ type: "generate-error", turnId: req.turnId, error: "model not loaded" });
      return;
    }

    const turnId      = req.turnId as string;
    const messages    = req.messages as Array<{ role: string; content: string }>;
    const imageUrl    = req.imageUrl as string | undefined;
    const videoUrls   = req.videoUrls as string[] | undefined;
    const maxNewTokens = req.maxNewTokens as number;
    const eosId       = req.eosId as number;
    const draftK      = req.draftK as number;
    const useMtp      = req.useMtp as boolean;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = this._processor as any;
    const t0 = performance.now();

    // Image: load from URL if provided
    let imageList: unknown[] = [];
    if (imageUrl) {
      try { imageList = [await RawImage.fromURL(imageUrl)]; } catch { /* skip on failure */ }
    }

    // §#693 Video: load each frame URL as RawImage[].
    let videoFrames: unknown[] = [];
    if (videoUrls && videoUrls.length > 0) {
      for (const url of videoUrls) {
        try { videoFrames.push(await RawImage.fromURL(url)); } catch { /* skip bad frame */ }
      }
    }
    const hasVideo = videoFrames.length > 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let messagesForTemplate: any[] = messages;
    if (hasVideo) {
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
      enable_thinking: false,
    }) as string;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let inputs: any = hasVideo
      ? await proc(chatText, null, [videoFrames])
      : await proc(chatText, imageList.length > 0 ? imageList : null);
    const tProc = performance.now();
    let inputLength: number = inputs.input_ids?.dims?.[1] ?? 0;
    this._post({ type: "context-budget", inputLength, limit: WEBGPU_CONTEXT_LIMIT });

    // §#88: conversation trimming.
    const CONV_TRIM_TOKEN_CEILING = 4096;
    if (inputLength > CONV_TRIM_TOKEN_CEILING && !hasVideo && imageList.length === 0) {
      const _trimmedMsgs = this._trimConversationMessages(messages, inputLength, CONV_TRIM_TOKEN_CEILING);
      if (_trimmedMsgs.length < messages.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const _trimChatText = proc.apply_chat_template(_trimmedMsgs, {
          add_generation_prompt: true, tokenize: false, enable_thinking: false,
        }) as string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const _trimInputs: any = await proc(_trimChatText, null);
        const _trimLength: number = _trimInputs.input_ids?.dims?.[1] ?? 0;
        console.log(`[#88] [CONV-TRIM] trimmed ${inputLength - _trimLength} tokens (${messages.length - _trimmedMsgs.length} msgs) from ${inputLength} total → keeping ${_trimLength} (${_trimmedMsgs.length} msgs)`);
        for (const _v of Object.values(inputs ?? {})) {
          try { (_v as any)?.dispose?.(); } catch { /* non-fatal */ }
        }
        inputs = _trimInputs;
        inputLength = _trimLength;
      }
    }

    const safeMaxNewTokens = Math.min(maxNewTokens, WEBGPU_CONTEXT_LIMIT - inputLength);
    if (safeMaxNewTokens <= 0) {
      this._post({ type: "generate-error", turnId, error: `Your conversation is too long for the model to process. Starting a new conversation will allow shorter inputs. (prompt: ${inputLength} tok, limit: ${WEBGPU_CONTEXT_LIMIT})` });
      return;
    }
    if (safeMaxNewTokens < maxNewTokens / 2) {
      this._post({
        type: "generate-warning",
        turnId,
        message: `Conversation is getting long — the model's reply budget has been reduced to ${safeMaxNewTokens} tokens. Starting a new conversation may improve response quality.`,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let outputs: any;
    let specAttempts = 0;
    let specAccepts  = 0;

    // MTP spec-decode.
    if (useMtp && this._drafterSession && MTP_VERIFICATION_WIRED && inputLength < 900) {
      try {
        const mtpSessions = getMtpSessions(this._model);
        if (mtpSessions) {
          const inputIdsTensor = inputs.input_ids as { data: BigInt64Array; dims: number[] };
          const result = await runMtpSpecDecode(
            mtpSessions, this._drafterSession, ort,
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
        console.warn("[onnx-backend] MTP error, standard fallback:", (e as Error).message);
        specAttempts = 0;
        specAccepts  = 0;
        outputs = undefined;
      }
    }

    // Standard generate fallback.
    if (!outputs) {
      let _initPutSeen = false;
      let _tokensGenerated = 0;
      const _progressStreamer = {
        put: (_tokenIds: unknown) => {
          if (!_initPutSeen) { _initPutSeen = true; return; }
          _tokensGenerated++;
          if (_tokensGenerated === 1 || _tokensGenerated % 50 === 0) {
            this._post({ type: "generate-progress", turnId, tokens_generated: _tokensGenerated });
          }
        },
        end: () => {
          if (_tokensGenerated > 0) {
            this._post({ type: "generate-progress", turnId, tokens_generated: _tokensGenerated });
          }
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const _doGenerate = () => (this._model as any).generate({
        ...inputs,
        max_new_tokens: safeMaxNewTokens,
        do_sample: false,
        streamer: _progressStreamer,
      });
      // §#83: flush ORT GPU queue before initial attempt.
      await this._flushWgpuQueue("pre-generate");
      // §#307 per-turn alignment sample.
      {
        const _byteOff = (inputs as any)?.input_ids?.data?.byteOffset ?? -1;
        this._post({ type: 'align-sample-307', data: {
          generateCount: this._generateCallCount,
          inputIdsByteOffset: _byteOff,
          mod8: _byteOff >= 0 ? _byteOff % 8 : -1,
        }});
      }
      try {
        outputs = await _doGenerate();
      } catch (genErr) {
        const _msg = String(genErr);
        if (/buffer_manager|BufferManager|unmapped before mapping|unaligned accesses/i.test(_msg)) {
          // §C-decode-retry (#1362-C, updated #1410, #83, #1632).
          const _isAlignErr = /unaligned accesses/i.test(_msg);
          const _delay1 = (this._coldCacheBoot || _isAlignErr) ? 2000 : 500;
          console.warn("[onnx-backend] buffer_manager race — flushing+retrying after " + _delay1 + "ms", _msg.slice(0, 120));
          await new Promise(r => setTimeout(r, _delay1));
          await this._flushWgpuQueue("retry-1");
          try {
            outputs = await _doGenerate();
          } catch (retryErr) {
            // §#1410 + §C-wasm-align (#1632): second retry.
            if (/buffer_manager|BufferManager|unmapped before mapping|unaligned accesses/i.test(String(retryErr)) &&
                (this._coldCacheBoot || /unaligned accesses/i.test(String(retryErr)))) {
              console.warn("[onnx-backend] buffer_manager retry-2 — flushing+waiting 3000ms");
              await new Promise(r => setTimeout(r, 3000));
              await this._flushWgpuQueue("retry-2");
              try {
                outputs = await _doGenerate();
              } catch (finalErr) {
                if (/unaligned accesses/i.test(String(finalErr))) {
                  const _ortEnv = (ort as any).env ?? {};
                  const _diag = {
                    generateCount:  this._generateCallCount,
                    inputTokens:    inputLength,
                    inputIdsDims:   (inputs as any)?.input_ids?.dims ?? [],
                    inputIdsByteOffset: (inputs as any)?.input_ids?.data?.byteOffset ?? -1,
                    ortBackend:     _ortEnv.webgpu?.device ? 'webgpu' : 'wasm',
                    ortVersion:     String((ort as any).version ?? 'unknown'),
                    errMsg:         String(finalErr).slice(0, 200),
                    errStack:       ((finalErr as Error).stack ?? '').slice(0, 400),
                  };
                  console.warn('[align-diag-307]', JSON.stringify(_diag));
                  this._post({ type: 'align-diag-307', data: _diag });
                }
                throw finalErr;
              }
            } else {
              throw retryErr;
            }
          }
        } else {
          throw genErr;
        }
      }
    }

    const tGen = performance.now();

    const generated = inputLength > 0
      ? (outputs as any).slice(null, [inputLength, null])
      : outputs;
    const tokensOut: number = (generated as any)?.dims?.[1] ?? 0;

    const decoded: string[] = proc.batch_decode(
      typeof (generated as any).tolist === "function" ? (generated as any).tolist() : generated,
      { skip_special_tokens: true },
    );

    // §A (#990): release GPU-backed ORT tensors.
    try { if (generated !== outputs) (generated as any)?.dispose?.(); } catch { /* non-fatal */ }
    try { (outputs as any)?.dispose?.(); } catch { /* non-fatal */ }
    // §A-inputs (#1303): release input tensors each turn.
    for (const v of Object.values(inputs ?? {})) {
      try { (v as any)?.dispose?.(); } catch { /* non-fatal */ }
    }
    // §#412-reverted: post-dispose flush removed.

    this._post({
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
}
