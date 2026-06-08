// litert-generate-path.test.ts — End-to-end test of the LiteRT generate path
// using the mock module. Exercises: load → generate → generate-done field parity
// with the ONNX protocol, MTP pass-through, and failure paths.
//
// The real WASM (litert_lm.wasm/.js) is a drop-in: replace mock with the real
// module via setLiteRtLmModule() and the same assertions hold.

import { describe, expect, test, beforeEach } from "bun:test";
import { LiteRtLmBackend, setLiteRtLmModule } from "../src/agent/litert-lm-backend";
import {
  createMockLiteRtLmModule,
  createMockLiteRtLmModuleWithMtp,
} from "../src/agent/litert-lm-mock";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePost(): { post: (m: Record<string, unknown>) => void; msgs: Record<string, unknown>[] } {
  const msgs: Record<string, unknown>[] = [];
  return { post: (m) => msgs.push(m), msgs };
}

function findMsg(msgs: Record<string, unknown>[], type: string): Record<string, unknown> | undefined {
  return msgs.find(m => m.type === type);
}

// ── Mock module installation ──────────────────────────────────────────────────

beforeEach(() => {
  // Reset module slot before each test so tests are isolated.
  setLiteRtLmModule(null as unknown as ReturnType<typeof createMockLiteRtLmModule>);
});

// ── LiteRtLmResult spec-stats pass-through ───────────────────────────────────

describe("LiteRtLmResult optional spec fields", () => {
  test("specAttempts/specAccepts forwarded from engine result (non-zero)", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    setLiteRtLmModule(createMockLiteRtLmModuleWithMtp({
      text: "hello",
      tokensOut: 4,
      prefillMs: 10,
      decodeMs: 50,
      specAttempts: 8,
      specAccepts: 6,
    }));
    // Bypass load() to inject module directly.
    (backend as unknown as { _loaded: boolean })._loaded = true;

    await backend.generate({
      turnId: "t1",
      messages: [{ role: "user", content: "hi" }],
    });

    const done = findMsg(msgs, "generate-done");
    expect(done).toBeDefined();
    expect(done!.specAttempts).toBe(8);
    expect(done!.specAccepts).toBe(6);
    expect(done!.text).toBe("hello");
    expect(done!.tokensOut).toBe(4);
  });

  test("specAttempts/specAccepts default 0 when engine returns undefined", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    setLiteRtLmModule(createMockLiteRtLmModule({ text: "world", tokensOut: 2 }));
    (backend as unknown as { _loaded: boolean })._loaded = true;

    await backend.generate({ turnId: "t2", messages: [{ role: "user", content: "test" }] });

    const done = findMsg(msgs, "generate-done");
    expect(done!.specAttempts).toBe(0);
    expect(done!.specAccepts).toBe(0);
  });
});

// ── ONNX-parity field names in generate-done ──────────────────────────────────

describe("generate-done ONNX parity (agent-harness line 720 field names)", () => {
  test("all required fields present with correct types", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    setLiteRtLmModule(createMockLiteRtLmModule({
      text: "response",
      tokensOut: 5,
      prefillMs: 12,
      decodeMs: 60,
    }));
    (backend as unknown as { _loaded: boolean })._loaded = true;

    await backend.generate({ turnId: "t3", messages: [{ role: "user", content: "go" }] });

    const done = findMsg(msgs, "generate-done");
    expect(done).toBeDefined();
    // Exact field names read by agent-harness WorkerGenResult
    expect(typeof done!.text).toBe("string");
    expect(typeof done!.tokensOut).toBe("number");
    expect(typeof done!.prefillMs).toBe("number");
    expect(typeof done!.decodeMs).toBe("number");
    expect(typeof done!.specAttempts).toBe("number");
    expect(typeof done!.specAccepts).toBe("number");
    expect(typeof done!.inputLength).toBe("number");
    expect(done!.turnId).toBe("t3");
  });

  test("generate-progress fires during streaming (watchdog parity)", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    setLiteRtLmModule(createMockLiteRtLmModule({
      text: "long response",
      tokensOut: 50,
      streamChunks: Array.from({ length: 3 }, (_, i) => `chunk${i}`),
    }));
    (backend as unknown as { _loaded: boolean })._loaded = true;

    await backend.generate({ turnId: "t4", messages: [{ role: "user", content: "go" }] });

    const progressMsgs = msgs.filter(m => m.type === "generate-progress");
    expect(progressMsgs.length).toBeGreaterThan(0);
    expect(progressMsgs[0].turnId).toBe("t4");
  });
});

// ── Module not ready guard ────────────────────────────────────────────────────

describe("generate when not loaded", () => {
  test("posts generate-error when module not set", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    // Do NOT setLiteRtLmModule or set _loaded

    await backend.generate({ turnId: "t5", messages: [{ role: "user", content: "hi" }] });

    const err = findMsg(msgs, "generate-error");
    expect(err).toBeDefined();
    expect(err!.error).toContain("not ready");
  });
});

// ── Lifecycle stubs ───────────────────────────────────────────────────────────

describe("lifecycle stubs", () => {
  test("disposeSession posts session-disposed", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    await backend.disposeSession();
    expect(findMsg(msgs, "session-disposed")).toBeDefined();
  });

  test("sessionRefresh posts session-refresh-complete with skipped=true", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    await backend.sessionRefresh();
    const msg = findMsg(msgs, "session-refresh-complete");
    expect(msg).toBeDefined();
    expect(msg!.skipped).toBe(true);
  });

  test("dispose posts shutdown-complete", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    await backend.dispose();
    expect(findMsg(msgs, "shutdown-complete")).toBeDefined();
  });
});

// ── Mock module helpers ───────────────────────────────────────────────────────

describe("createMockLiteRtLmModule", () => {
  test("failWith causes generateContent to throw", async () => {
    const mod = createMockLiteRtLmModule({ failWith: "WASM OOM" });
    await expect(mod.generateContent([])).rejects.toThrow("WASM OOM");
  });

  test("streamChunks fires callback once per chunk", async () => {
    const mod = createMockLiteRtLmModule({ streamChunks: ["a", "b", "c"], tokensOut: 3 });
    const received: string[] = [];
    const result = await mod.generateContentStream([], (partial) => received.push(partial));
    expect(received).toEqual(["a", "b", "c"]);
    expect(result.tokensOut).toBe(3);
  });

  test("generateContentWithMtp returns specAttempts/specAccepts", async () => {
    const mod = createMockLiteRtLmModuleWithMtp({ specAttempts: 10, specAccepts: 8 });
    expect(mod.generateContentWithMtp).toBeDefined();
    const result = await mod.generateContentWithMtp!([], () => {});
    expect(result.specAttempts).toBe(10);
    expect(result.specAccepts).toBe(8);
  });
});

// ── Dispose-mid-stream ────────────────────────────────────────────────────────

describe("dispose-mid-stream", () => {
  test("dispose during stalled generate posts shutdown-complete and does not hang silently", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    setLiteRtLmModule(createMockLiteRtLmModule({ text: "result", stallForMs: 30 }));
    (backend as unknown as { _loaded: boolean })._loaded = true;

    // Start generate (stalls 30ms) and dispose concurrently — simulates session teardown mid-inference.
    await Promise.all([
      backend.generate({ turnId: "t-disp", messages: [{ role: "user", content: "hi" }] }),
      backend.dispose(),
    ]);

    const shutdown = findMsg(msgs, "shutdown-complete");
    const done     = findMsg(msgs, "generate-done");
    const err      = findMsg(msgs, "generate-error");

    // shutdown-complete must always fire
    expect(shutdown).toBeDefined();
    // generate path must not be silent — either done (if fast enough) or error (disposed-during)
    expect(done !== undefined || err !== undefined).toBe(true);
  });

  test("generate after dispose posts generate-error (not-ready guard)", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    setLiteRtLmModule(createMockLiteRtLmModule({ text: "result" }));
    (backend as unknown as { _loaded: boolean })._loaded = true;

    await backend.dispose();
    // Reset message list; call generate on a disposed backend
    msgs.length = 0;
    await backend.generate({ turnId: "t-after-disp", messages: [{ role: "user", content: "hi" }] });

    const err = findMsg(msgs, "generate-error");
    expect(err).toBeDefined();
    expect(err!.turnId).toBe("t-after-disp");
  });
});

// ── Progress-watchdog timeout → recovery ─────────────────────────────────────

describe("progress-watchdog timeout", () => {
  test("stalled generate with _watchdogMs posts generate-error containing 'watchdog'", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    setLiteRtLmModule(createMockLiteRtLmModule({ text: "slow", stallForMs: 200 }));
    (backend as unknown as { _loaded: boolean })._loaded = true;

    await backend.generate({
      turnId: "t-wdog",
      messages: [{ role: "user", content: "hi" }],
      _watchdogMs: 5,  // 5ms watchdog << 200ms stall
    });

    const err = findMsg(msgs, "generate-error");
    expect(err).toBeDefined();
    expect((err!.error as string)).toContain("watchdog");
    expect(findMsg(msgs, "generate-done")).toBeUndefined();
  });

  test("fast generate completes normally even when _watchdogMs set", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    setLiteRtLmModule(createMockLiteRtLmModule({ text: "fast", tokensOut: 2 }));
    (backend as unknown as { _loaded: boolean })._loaded = true;

    await backend.generate({
      turnId: "t-fast",
      messages: [{ role: "user", content: "hi" }],
      _watchdogMs: 500,  // generous timeout — should not fire
    });

    expect(findMsg(msgs, "generate-done")).toBeDefined();
    expect(findMsg(msgs, "generate-error")).toBeUndefined();
  });
});

// ── Malformed / partial generate-done fields (defensive parse) ───────────────

describe("malformed generate-done fields (defensive parse)", () => {
  test("engine returning partial result: missing numeric fields default to 0", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);

    // Inline mock: bare result with only text — simulates older bundle build missing timing fields.
    const bareResult = { text: "partial" } as import("../src/agent/litert-lm-backend.js").LiteRtLmResult;
    setLiteRtLmModule({
      async load()                  { return; },
      async generateContent()       { return bareResult; },
      async generateContentStream(_c, cb) { cb("partial", 1); return bareResult; },
      dispose()                     { return; },
    });
    (backend as unknown as { _loaded: boolean })._loaded = true;

    await backend.generate({ turnId: "t-partial", messages: [{ role: "user", content: "hi" }] });

    const done = findMsg(msgs, "generate-done");
    expect(done).toBeDefined();
    expect(done!.text).toBe("partial");
    expect(done!.tokensOut).toBe(0);
    expect(done!.prefillMs).toBe(0);
    expect(done!.decodeMs).toBe(0);
    expect(done!.specAttempts).toBe(0);
    expect(done!.specAccepts).toBe(0);
  });

  test("engine returning undefined text: text defaults to empty string", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);

    const emptyResult = {} as import("../src/agent/litert-lm-backend.js").LiteRtLmResult;
    setLiteRtLmModule({
      async load()                  { return; },
      async generateContent()       { return emptyResult; },
      async generateContentStream(_c, cb) { cb("", 1); return emptyResult; },
      dispose()                     { return; },
    });
    (backend as unknown as { _loaded: boolean })._loaded = true;

    await backend.generate({ turnId: "t-empty", messages: [{ role: "user", content: "hi" }] });

    const done = findMsg(msgs, "generate-done");
    expect(done).toBeDefined();
    expect(done!.text).toBe("");
  });
});

// ── Back-to-back turns (slot reuse) ──────────────────────────────────────────

describe("back-to-back turns without reinit (slot reuse)", () => {
  test("two sequential generates both post generate-done with correct turnIds", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    setLiteRtLmModule(createMockLiteRtLmModule({ text: "answer", tokensOut: 3 }));
    (backend as unknown as { _loaded: boolean })._loaded = true;

    await backend.generate({ turnId: "turn-A", messages: [{ role: "user", content: "first" }] });
    await backend.generate({ turnId: "turn-B", messages: [{ role: "user", content: "second" }] });

    const doneA = msgs.find(m => m.type === "generate-done" && m.turnId === "turn-A");
    const doneB = msgs.find(m => m.type === "generate-done" && m.turnId === "turn-B");
    expect(doneA).toBeDefined();
    expect(doneB).toBeDefined();
    expect(doneA!.text).toBe("answer");
    expect(doneB!.text).toBe("answer");
  });

  test("three sequential turns all complete without cross-contamination", async () => {
    const { post, msgs } = makePost();
    const backend = new LiteRtLmBackend(post);
    setLiteRtLmModule(createMockLiteRtLmModule({ text: "ok", tokensOut: 1 }));
    (backend as unknown as { _loaded: boolean })._loaded = true;

    for (const id of ["tA", "tB", "tC"]) {
      await backend.generate({ turnId: id, messages: [{ role: "user", content: id }] });
    }

    const dones = msgs.filter(m => m.type === "generate-done");
    expect(dones.length).toBe(3);
    expect(dones.map(d => d.turnId)).toEqual(["tA", "tB", "tC"]);
  });
});
