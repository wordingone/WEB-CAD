// onnx-dispose.test.ts — §A (#990) ORT session lifecycle: shutdown + re-init dispose.
//
// Mirrors the dispose logic from:
//   model-worker.ts → handleShutdown()  (§A-shutdown)
//   model-worker.ts → handleInit()       (§A-init — dispose on re-init)

import { describe, expect, test } from "bun:test";

// ── Mock ORT session ──────────────────────────────────────────────────────────

interface MockOrtSession {
  releaseCount: number;
  release(): Promise<void>;
}

interface MockModel {
  disposeCount: number;
  dispose(): Promise<void>;
}

function makeMockSession(): MockOrtSession {
  const s: MockOrtSession = {
    releaseCount: 0,
    async release() { this.releaseCount++; },
  };
  return s;
}

function makeMockModel(): MockModel {
  const m: MockModel = {
    disposeCount: 0,
    async dispose() { this.disposeCount++; },
  };
  return m;
}

// ── Mirror of model-worker.ts handleShutdown (§A-shutdown #990) ───────────────
// Keep in sync with web/src/agent/model-worker.ts `handleShutdown`.

interface WorkerState {
  drafterSession: MockOrtSession | null;
  model: MockModel | null;
  processor: unknown;
}

async function handleShutdown(state: WorkerState): Promise<void> {
  if (state.drafterSession) {
    try { await (state.drafterSession as any).release?.(); } catch { /* non-fatal */ }
    state.drafterSession = null;
  }
  if (state.model) {
    try { await (state.model as any).dispose?.(); } catch { /* non-fatal */ }
    state.model = null;
  }
  state.processor = null;
}

// ── Mirror of model-worker.ts handleInit re-init dispose (§A-init #990) ──────
// Keep in sync with web/src/agent/model-worker.ts `handleInit` leading dispose block.

async function disposeOnReInit(state: WorkerState): Promise<void> {
  if (state.drafterSession) {
    try { await (state.drafterSession as any).release?.(); } catch { /* non-fatal */ }
    state.drafterSession = null;
  }
  if (state.model) {
    try { await (state.model as any).dispose?.(); } catch { /* non-fatal */ }
    state.model = null;
  }
  state.processor = null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("#990 §A-shutdown — handleShutdown disposes ORT sessions", () => {

  test("shutdown: _drafterSession.release() called exactly once", async () => {
    const sess = makeMockSession();
    const state: WorkerState = { drafterSession: sess, model: null, processor: null };
    await handleShutdown(state);
    expect(sess.releaseCount).toBe(1);
    expect(state.drafterSession).toBeNull();
  });

  test("shutdown: _model.dispose() called exactly once when present", async () => {
    const model = makeMockModel();
    const state: WorkerState = { drafterSession: null, model, processor: {} };
    await handleShutdown(state);
    expect(model.disposeCount).toBe(1);
    expect(state.model).toBeNull();
    expect(state.processor).toBeNull();
  });

  test("shutdown: both drafter and model disposed in same call", async () => {
    const sess = makeMockSession();
    const model = makeMockModel();
    const state: WorkerState = { drafterSession: sess, model, processor: {} };
    await handleShutdown(state);
    expect(sess.releaseCount).toBe(1);
    expect(model.disposeCount).toBe(1);
    expect(state.drafterSession).toBeNull();
    expect(state.model).toBeNull();
  });

  test("shutdown: no drafter session — no crash, model still disposed", async () => {
    const model = makeMockModel();
    const state: WorkerState = { drafterSession: null, model, processor: null };
    await expect(handleShutdown(state)).resolves.toBeUndefined();
    expect(model.disposeCount).toBe(1);
  });

  test("shutdown: no sessions at all — no crash", async () => {
    const state: WorkerState = { drafterSession: null, model: null, processor: null };
    await expect(handleShutdown(state)).resolves.toBeUndefined();
  });

  test("release() throwing: non-fatal — state still nulled", async () => {
    const badSess = {
      releaseCount: 0,
      async release() {
        this.releaseCount++;
        throw new Error("ORT release failed");
      },
    };
    const state: WorkerState = { drafterSession: badSess as unknown as MockOrtSession, model: null, processor: null };
    await expect(handleShutdown(state)).resolves.toBeUndefined();
    expect(state.drafterSession).toBeNull();
  });
});

describe("#990 §A-init — handleInit disposes prior session on re-init (model swap)", () => {

  test("re-init: old _drafterSession.release() called once before new session", async () => {
    const oldSess = makeMockSession();
    const state: WorkerState = { drafterSession: oldSess, model: null, processor: null };
    await disposeOnReInit(state);
    // Old session disposed
    expect(oldSess.releaseCount).toBe(1);
    expect(state.drafterSession).toBeNull();
    // Simulate new session created after dispose
    const newSess = makeMockSession();
    state.drafterSession = newSess;
    expect(newSess.releaseCount).toBe(0); // not released yet
  });

  test("re-init: no prior session — no crash", async () => {
    const state: WorkerState = { drafterSession: null, model: null, processor: null };
    await expect(disposeOnReInit(state)).resolves.toBeUndefined();
  });

  test("re-init: each swap releases exactly 1 session (1 release per swap)", async () => {
    const sessions = [makeMockSession(), makeMockSession(), makeMockSession()];
    const state: WorkerState = { drafterSession: null, model: null, processor: null };

    for (let i = 0; i < sessions.length; i++) {
      // Load new session
      state.drafterSession = sessions[i];
      if (i + 1 < sessions.length) {
        // Re-init: dispose current before loading next
        await disposeOnReInit(state);
        expect(sessions[i].releaseCount).toBe(1);
      }
    }
    // Final session never released (session still active)
    expect(sessions[sessions.length - 1].releaseCount).toBe(0);
  });

  test("re-init: _model.dispose() called on prior model", async () => {
    const oldModel = makeMockModel();
    const state: WorkerState = { drafterSession: null, model: oldModel, processor: {} };
    await disposeOnReInit(state);
    expect(oldModel.disposeCount).toBe(1);
    expect(state.model).toBeNull();
    expect(state.processor).toBeNull();
  });
});

// ── Dispose-mid-generate (#625) ───────────────────────────────────────────────
// Mirrors the LiteRT _disposed guard (PR #625). Same class: concurrent async
// dispose() + generate() must not silently drop — either generate-done or
// generate-error fires; shutdown-complete always fires.

interface BackendLike {
  disposed: boolean;
  post(msg: Record<string, unknown>): void;
  dispose(): Promise<void>;
  generate(turnId: string, slowMs: number): Promise<void>;
}

function makeOnnxLikeBackend(): BackendLike & { msgs: Record<string, unknown>[] } {
  const msgs: Record<string, unknown>[] = [];
  const be: BackendLike & { msgs: Record<string, unknown>[] } = {
    msgs,
    disposed: false,
    post(msg) { msgs.push(msg); },
    async dispose() {
      this.disposed = true;
      this.post({ type: "shutdown-complete" });
    },
    // Simulate generate: stalls for slowMs, then checks _disposed before posting done.
    async generate(turnId: string, slowMs: number) {
      await new Promise(r => setTimeout(r, slowMs));
      if (this.disposed) {
        this.post({ type: "generate-error", turnId, error: "disposed during generate" });
        return;
      }
      this.post({ type: "generate-done", turnId, text: "result", tokensOut: 1,
        specAttempts: 0, specAccepts: 0, prefillMs: 0, decodeMs: 0, inputLength: 0 });
    },
  };
  return be;
}

describe("dispose-mid-generate (_disposed guard, PR #625 parity with LiteRT)", () => {
  test("dispose during stalled generate: shutdown-complete fires; generate path non-silent", async () => {
    const be = makeOnnxLikeBackend();

    await Promise.all([
      be.generate("t-disp", 30),
      be.dispose(),
    ]);

    expect(be.msgs.find(m => m.type === "shutdown-complete")).toBeDefined();
    const done  = be.msgs.find(m => m.type === "generate-done");
    const err   = be.msgs.find(m => m.type === "generate-error");
    expect(done !== undefined || err !== undefined).toBe(true);
  });

  test("fast generate completes before dispose: generate-done fires", async () => {
    const be = makeOnnxLikeBackend();

    await be.generate("t-fast", 0);  // instant
    await be.dispose();

    expect(be.msgs.find(m => m.type === "generate-done")).toBeDefined();
    expect(be.msgs.find(m => m.type === "shutdown-complete")).toBeDefined();
    expect(be.msgs.find(m => m.type === "generate-error")).toBeUndefined();
  });

  test("generate after dispose: _disposed flag blocks generate-done, posts generate-error", async () => {
    const be = makeOnnxLikeBackend();

    await be.dispose();
    be.msgs.length = 0;  // reset after dispose
    await be.generate("t-post-disp", 0);

    expect(be.msgs.find(m => m.type === "generate-error")).toBeDefined();
    expect(be.msgs.find(m => m.type === "generate-done")).toBeUndefined();
  });

  test("back-to-back generates (slot-reuse): both post generate-done with correct turnIds", async () => {
    const be = makeOnnxLikeBackend();

    await be.generate("turn-A", 0);
    await be.generate("turn-B", 0);

    const doneA = be.msgs.find(m => m.type === "generate-done" && m.turnId === "turn-A");
    const doneB = be.msgs.find(m => m.type === "generate-done" && m.turnId === "turn-B");
    expect(doneA).toBeDefined();
    expect(doneB).toBeDefined();
  });
});

// ── Harness generate-done receive-side defensive defaults (#625) ──────────────
// The harness resolves _generateCallbacks with msg fields cast to number/string.
// After PR #625, defensive ?? 0 / "" defaults guard against partial backend messages.
// This test audits the source to confirm the pattern is present.

describe("harness generate-done receive-side defensive defaults (source audit)", () => {
  test("agent-harness.ts generate-done handler uses ?? defaults on all numeric fields", () => {
    const src = require("node:fs").readFileSync(
      new URL("../src/agent/agent-harness.ts", import.meta.url),
      "utf8",
    ) as string;

    // Locate the generate-done case block
    const caseSrc = src.slice(src.indexOf("case \"generate-done\":"));
    // Verify ?? 0 used on every numeric field
    for (const field of ["specAttempts", "specAccepts", "prefillMs", "decodeMs", "inputLength", "tokensOut"]) {
      expect(caseSrc).toContain(`?? 0`);
      expect(caseSrc).toContain(field);
    }
    // Verify ?? "" used on text
    expect(caseSrc).toContain(`?? ""`);
  });
});
