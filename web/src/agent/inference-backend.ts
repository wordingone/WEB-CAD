// inference-backend.ts — boundary contract for model inference backends (#591 P0).
// P0 impl: OnnxTransformersBackend. P1+: LiteRtMediapipeBackend.

/** Post function injected into backends for worker→main-thread messaging. */
export type PostFn = (msg: Record<string, unknown>) => void;

/** Options forwarded from the "init" message to backend.load(). */
export interface LoadOpts {
  drafterUrl?: string;
  drafterCacheKey?: string;
  noWarmup?: boolean;
  forceWasm?: boolean;
  warmupPrompt?: string;
  [key: string]: unknown;
}

export interface InferenceBackend {
  readonly id: "onnx" | "litert";
  readonly caps: { multimodal: boolean; mtp: boolean };
  /** Load model weights + warmup. Posts progress/model-ready/boot-complete via post(). */
  load(modelId: string, opts: LoadOpts): Promise<void>;
  /** Run inference. Posts generate-done/error/progress via post(). */
  generate(req: Record<string, unknown>): Promise<void>;
  /** Release VRAM/sessions. Posts shutdown-complete via post(). */
  dispose(): Promise<void>;
  /** Destroy the underlying WebGPU device (OnnxTransformersBackend only). */
  destroyDevice?(): void;
  /** Release sessions without terminating the worker (tab-hidden VRAM reclaim). */
  disposeSession?(): Promise<void>;
  /** Flush/reinit sessions after disposeSession (tab-visible recycle). */
  sessionRefresh?(): Promise<void>;
}
