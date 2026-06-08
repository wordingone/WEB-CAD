// litert-lm-mock.ts — Test double for LiteRtLmModule (#71).
//
// Use in tests via:
//   import { createMockLiteRtLmModule } from "./litert-lm-mock.js";
//   import { setLiteRtLmModule } from "./litert-lm-backend.js";
//   setLiteRtLmModule(createMockLiteRtLmModule({ text: "hello", tokensOut: 3 }));
//
// Exercises the full generate → generate-progress → generate-done flow without
// the real WASM binary. All timing values are zero for deterministic tests.

import type { InputData, LiteRtLmModule, LiteRtLmResult, StreamCallback } from "./litert-lm-backend.js";

export interface MockLiteRtLmOpts {
  /** Text to return from generateContent. Default: "mock response". */
  text?: string;
  tokensOut?: number;
  prefillMs?: number;
  decodeMs?: number;
  /** MTP stats — non-zero to test MTP pass-through. */
  specAttempts?: number;
  specAccepts?: number;
  /** Reject every call with this error message (simulate load/generate failure). */
  failWith?: string;
  /** Stream token chunks — if provided, fires callback once per chunk. */
  streamChunks?: string[];
  /** Stall for this many ms before resolving — lets tests exercise watchdog/dispose-mid-stream. */
  stallForMs?: number;
}

/**
 * Create a mock LiteRtLmModule suitable for unit tests.
 * All methods resolve synchronously (zero delay) for fast test execution.
 */
export function createMockLiteRtLmModule(opts: MockLiteRtLmOpts = {}): LiteRtLmModule {
  const {
    text         = "mock response",
    tokensOut    = 3,
    prefillMs    = 0,
    decodeMs     = 0,
    specAttempts = 0,
    specAccepts  = 0,
    failWith,
    streamChunks,
    stallForMs,
  } = opts;

  const result: LiteRtLmResult = { text, tokensOut, prefillMs, decodeMs, specAttempts, specAccepts };

  return {
    async load(_source: string | ArrayBuffer, _opts?: { opfsKey?: string }): Promise<void> {
      if (failWith) throw new Error(failWith);
    },

    async generateContent(_contents: InputData[], _opts?: { maxNewTokens?: number; eosId?: number }): Promise<LiteRtLmResult> {
      if (failWith) throw new Error(failWith);
      if (stallForMs) await new Promise(r => setTimeout(r, stallForMs));
      return result;
    },

    async generateContentStream(
      _contents: InputData[],
      callback: StreamCallback,
      _opts?: { maxNewTokens?: number; eosId?: number },
    ): Promise<LiteRtLmResult> {
      if (failWith) throw new Error(failWith);
      if (stallForMs) await new Promise(r => setTimeout(r, stallForMs));
      if (streamChunks && streamChunks.length > 0) {
        for (let i = 0; i < streamChunks.length; i++) {
          callback(streamChunks[i], i + 1);
        }
      } else {
        // Default: fire a single progress event at token 1
        callback(text, 1);
      }
      return result;
    },

    dispose(): void { /* no-op */ },
  };
}

/**
 * Create a mock that also implements generateContentWithMtp? for MTP decode stub tests.
 */
export function createMockLiteRtLmModuleWithMtp(opts: MockLiteRtLmOpts & { specAttempts: number; specAccepts: number }): LiteRtLmModule {
  const base = createMockLiteRtLmModule(opts);
  const { text = "mock response", tokensOut = 3, prefillMs = 0, decodeMs = 0, specAttempts, specAccepts } = opts;
  return {
    ...base,
    async generateContentWithMtp(
      _contents: InputData[],
      callback: StreamCallback,
      _opts?: { maxNewTokens?: number; eosId?: number; draftK?: number },
    ): Promise<LiteRtLmResult> {
      callback(text, 1);
      return { text, tokensOut, prefillMs, decodeMs, specAttempts, specAccepts };
    },
  };
}
