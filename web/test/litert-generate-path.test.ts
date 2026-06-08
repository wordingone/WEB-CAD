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
