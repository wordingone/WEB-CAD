// litert-backend.ts — Dedicated-slot main-thread wrapper for the LiteRT-LM path (#71).
//
// Creates model-worker.ts?engine=litert in a dedicated Web Worker, fully isolated from
// the ONNX WebGPU worker. Mirrors StandardBackend's interface shape (init/generate/dispose)
// while carrying the complete ONNX-parity protocol:
//   Main→Worker: init | generate | shutdown | session-refresh | dispose-session
//   Worker→Main: model-ready | boot-complete | generate-done | generate-progress |
//                generate-error | error | progress | session-disposed | session-refresh-complete
//
// Activation: agent-harness.ts creates a LiteRtBackend when ?engine=litert is in the
// page URL, replacing the ONNX inference worker for that session.

import { LITERT_WASM_URL, LITERT_JS_URL, LITERT_MODEL_URL } from "./litert-lm-loader.js";

export interface LiteRtBackendOptions {
  /** Override bundle URLs for local testing (?litert_wasm_url=... etc. take effect too). */
  wasmUrl?:  string;
  jsUrl?:    string;
  modelUrl?: string;
}

export interface LiteRtGenResult {
  text:         string;
  tokensOut:    number;
  prefillMs:    number;
  decodeMs:     number;
  specAttempts: number;
  specAccepts:  number;
  inputLength:  number;
}

export type LiteRtGenIterable = AsyncIterable<string> & { resultPromise: Promise<LiteRtGenResult> };

export interface LiteRtGenerateOpts {
  turnId:        string;
  messages:      Array<{ role: string; content: string }>;
  imageUrl?:     string;
  maxNewTokens?: number;
  eosId?:        number;
  onProgress?:   (tokensGenerated: number) => void;
}

export class LiteRtBackend {
  private _worker: Worker | null = null;
  private _ready   = false;
  private _booted  = false;
  private readonly _opts: LiteRtBackendOptions;

  constructor(opts: LiteRtBackendOptions = {}) {
    this._opts = opts;
  }

  /** Create the worker + send init. Resolves when boot-complete fires. */
  async init(): Promise<void> {
    if (this._booted) return;
    if (this._worker) return; // already initializing

    // Pass ?engine=litert to the worker's own URL so model-worker.ts routes to LiteRtLmBackend.
    const workerUrl = new URL("./model-worker.ts", import.meta.url);
    workerUrl.searchParams.set("engine", "litert");

    // Propagate URL-param overrides from the page into the worker URL so litert-lm-loader
    // picks them up from self.location.href (same as ONNX loader reads ?gemma_model= etc.).
    const pageParams = typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
    for (const key of ["litert_wasm_url", "litert_js_url", "litert_model_url"]) {
      const v = pageParams.get(key);
      if (v) workerUrl.searchParams.set(key, v);
    }

    this._worker = new Worker(workerUrl, { type: "module" });

    return new Promise<void>((resolve, reject) => {
      const onBoot = (ev: MessageEvent<Record<string, unknown>>) => {
        const { type } = ev.data;
        if (type === "boot-complete") {
          this._booted = true;
          this._worker!.removeEventListener("message", onBoot);
          resolve();
        } else if (type === "model-ready") {
          this._ready = true;
        } else if (type === "error") {
          this._worker!.removeEventListener("message", onBoot);
          reject(new Error(ev.data.error as string));
        }
      };
      this._worker!.addEventListener("message", onBoot);

      this._worker!.postMessage({
        type:     "init",
        modelId:  "litert-lm",
        bundleUrls: {
          wasmUrl:  this._opts.wasmUrl  ?? LITERT_WASM_URL,
          jsUrl:    this._opts.jsUrl    ?? LITERT_JS_URL,
          modelUrl: this._opts.modelUrl ?? LITERT_MODEL_URL,
        },
      });
    });
  }

  get ready(): boolean { return this._ready; }
  get booted(): boolean { return this._booted; }

  /** Run inference. Returns streaming AsyncIterable<string> + resultPromise. */
  generate(opts: LiteRtGenerateOpts): LiteRtGenIterable {
    if (!this._worker || !this._booted) throw new Error("LiteRtBackend: not initialized");

    const { turnId, onProgress } = opts;
    const worker = this._worker;

    worker.postMessage({
      type:          "generate",
      turnId,
      messages:      opts.messages,
      imageUrl:      opts.imageUrl,
      maxNewTokens:  opts.maxNewTokens ?? 512,
      eosId:         opts.eosId ?? 1,
    });

    let resolveResult!: (r: LiteRtGenResult) => void;
    let rejectResult!:  (e: Error) => void;
    const resultPromise = new Promise<LiteRtGenResult>((res, rej) => {
      resolveResult = res;
      rejectResult  = rej;
    });

    // Async-iterable token stream — each generate-progress fires onProgress callback;
    // generate-done resolves resultPromise.
    const tokenQueue: string[] = [];
    let iterResolve: ((v: IteratorResult<string>) => void) | null = null;
    let streamDone = false;

    const push = (chunk: string): void => {
      if (iterResolve) {
        const r = iterResolve;
        iterResolve = null;
        r({ value: chunk, done: false });
      } else {
        tokenQueue.push(chunk);
      }
    };

    const onMessage = (ev: MessageEvent<Record<string, unknown>>) => {
      const msg = ev.data;
      if (msg.turnId !== turnId && msg.type !== "error") return;

      if (msg.type === "generate-progress") {
        onProgress?.(msg.tokens_generated as number);
      } else if (msg.type === "generate-done") {
        streamDone = true;
        worker.removeEventListener("message", onMessage);
        resolveResult({
          text:         msg.text         as string,
          tokensOut:    msg.tokensOut    as number ?? 0,
          prefillMs:    msg.prefillMs    as number ?? 0,
          decodeMs:     msg.decodeMs     as number ?? 0,
          specAttempts: msg.specAttempts as number ?? 0,
          specAccepts:  msg.specAccepts  as number ?? 0,
          inputLength:  msg.inputLength  as number ?? 0,
        });
        if (iterResolve) { const r = iterResolve; iterResolve = null; r({ value: "", done: true }); }
      } else if (msg.type === "generate-error" || msg.type === "error") {
        streamDone = true;
        worker.removeEventListener("message", onMessage);
        rejectResult(new Error(msg.error as string ?? "litert-generate-error"));
        if (iterResolve) { const r = iterResolve; iterResolve = null; r({ value: "", done: true }); }
      }
    };
    worker.addEventListener("message", onMessage);

    const iterable: LiteRtGenIterable = {
      resultPromise,
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            if (tokenQueue.length > 0) return Promise.resolve({ value: tokenQueue.shift()!, done: false });
            if (streamDone)            return Promise.resolve({ value: "", done: true });
            return new Promise<IteratorResult<string>>(res => { iterResolve = res; });
          },
          return(): Promise<IteratorResult<string>> {
            streamDone = true;
            worker.removeEventListener("message", onMessage);
            worker.postMessage({ type: "abort", turnId });
            return Promise.resolve({ value: "", done: true });
          },
        };
      },
    };
    return iterable;
  }

  /** Release sessions without terminating the worker (VRAM reclaim when tab hidden). */
  async disposeSession(): Promise<void> {
    if (!this._worker) return;
    return new Promise<void>(resolve => {
      const onDone = (ev: MessageEvent<Record<string, unknown>>) => {
        if (ev.data.type === "session-disposed") {
          this._worker!.removeEventListener("message", onDone);
          resolve();
        }
      };
      this._worker!.addEventListener("message", onDone);
      this._worker!.postMessage({ type: "dispose-session" });
      // Safety timeout — resolve anyway after 5s if no ack
      setTimeout(() => { this._worker?.removeEventListener("message", onDone); resolve(); }, 5000);
    });
  }

  /** Reinitialize sessions after disposeSession (tab visible again). */
  async sessionRefresh(): Promise<void> {
    if (!this._worker) return;
    return new Promise<void>(resolve => {
      const onDone = (ev: MessageEvent<Record<string, unknown>>) => {
        if (ev.data.type === "session-refresh-complete") {
          this._worker!.removeEventListener("message", onDone);
          resolve();
        }
      };
      this._worker!.addEventListener("message", onDone);
      this._worker!.postMessage({ type: "session-refresh" });
      setTimeout(() => { this._worker?.removeEventListener("message", onDone); resolve(); }, 5000);
    });
  }

  /** Terminate the worker and release all resources. */
  dispose(): void {
    if (!this._worker) return;
    this._worker.postMessage({ type: "shutdown" });
    // Give the worker a tick to post shutdown-complete, then hard-terminate.
    setTimeout(() => { this._worker?.terminate(); this._worker = null; }, 200);
    this._ready  = false;
    this._booted = false;
  }
}
