/// <reference lib="webworker" />
// model-worker.ts — routing shell: selects and delegates to an InferenceBackend (#591 P0).
// P0: OnnxTransformersBackend only. P1+: LiteRtMediapipeBackend added.
//
// Protocol (main → worker):
//   {type:"init", modelId, drafterUrl, drafterCacheKey}
//   {type:"generate", turnId, messages, imageUrl?, videoUrls?, maxNewTokens, eosId, draftK, useMtp}
//   {type:"abort", turnId}
//
// Protocol (worker → main): see onnx-transformers-backend.ts (unchanged from prior revision).

import { OnnxTransformersBackend } from "./onnx-transformers-backend.js";
import type { InferenceBackend } from "./inference-backend.js";

const DEFAULT_ENGINE = "onnx" as const;

function urlParam(key: string): string | null {
  try { return new URL(self.location.href).searchParams.get(key); } catch { return null; }
}

function post(msg: Record<string, unknown>): void {
  (self as unknown as Worker).postMessage(msg);
}

const engineId = (urlParam("engine") ?? DEFAULT_ENGINE) as "onnx" | "litert";

let backend: InferenceBackend;
if (engineId === "onnx") {
  backend = new OnnxTransformersBackend(post);
} else {
  post({ type: "error", error: `Unknown engine: ${engineId}. Available: onnx` });
  throw new Error(`Unknown engine: ${engineId}`);
}

self.onmessage = async (ev: MessageEvent<Record<string, unknown>>) => {
  const { type, ...data } = ev.data;
  try {
    if (type === "init")                 await backend.load(data.modelId as string, data);
    else if (type === "generate")        await backend.generate(data);
    else if (type === "shutdown")        await backend.dispose();
    else if (type === "destroy-device")  backend.destroyDevice?.();
    else if (type === "session-refresh") await backend.sessionRefresh?.();
    else if (type === "dispose-session") await backend.disposeSession?.();
    // "abort" handled via AbortController in backend.generate() (future work)
  } catch (e) {
    post({ type: "error", error: (e as Error).message });
  }
};
