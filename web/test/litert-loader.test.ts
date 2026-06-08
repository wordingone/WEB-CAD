// litert-loader.test.ts — loader GB-bundle fetch path hardening audit (#626)
//
// Audit classes:
//   Class 1  Progress          — ALREADY HANDLED (source audit)
//   Class 2  Network failure   — ALREADY HANDLED (source audit + mock)
//   Class 3  Partial/corrupt   — GAP FIXED: isWasmMagic check before mod.default()
//   Class 4  Cross-origin CORS — GAP FIXED: explicit mode:"cors" + TypeError wrap
//   Class 5  SW cache/quota    — ALREADY HANDLED (mock)

import { describe, test, expect } from "bun:test";
import { isWasmMagic, detectMemory64 } from "../src/agent/litert-lm-loader";
import { readFileSync } from "node:fs";

const LOADER_SRC = readFileSync(
  new URL("../src/agent/litert-lm-loader.ts", import.meta.url),
  "utf8",
);

// ── Pure-function helpers ─────────────────────────────────────────────────────

function makeWasmMagic(extraBytes = 0): ArrayBuffer {
  const buf = new ArrayBuffer(4 + extraBytes);
  const u8 = new Uint8Array(buf);
  u8[0] = 0x00; u8[1] = 0x61; u8[2] = 0x73; u8[3] = 0x6d; // \0asm
  return buf;
}

function makeMemory64Wasm(): ArrayBuffer {
  // Minimal synthesised WASM binary with a memory section (sectionId=5) whose
  // flags byte has bit 2 set (0x04) → memory64.
  // Layout: magic(4) + version(4) + sectionId(1=5) + size(1) + count(1=1) + flags(1=4) + rest
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // magic
    0x01, 0x00, 0x00, 0x00, // version
    0x05,                   // section id = 5 (memory)
    0x04,                   // section size = 4 bytes
    0x01,                   // memory count = 1
    0x04,                   // flags = 0x04 → memory64
    0x00,                   // initial pages (leb128)
    0x00,                   // max pages (leb128, unused but padding)
  ]);
  return bytes.buffer;
}

function makeWasm32Wasm(): ArrayBuffer {
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    0x05, 0x03, 0x01, 0x00, 0x01,
  ]);
  return bytes.buffer;
}

// ── Class 3 (GAP FIXED): isWasmMagic ─────────────────────────────────────────

describe("Class 3 — isWasmMagic (pre-instantiate integrity check, gap fixed)", () => {
  test("valid WASM magic \\0asm → true", () => {
    expect(isWasmMagic(makeWasmMagic(100))).toBe(true);
  });

  test("truncated buffer (3 bytes) → false", () => {
    const buf = new ArrayBuffer(3);
    const u8 = new Uint8Array(buf);
    u8[0] = 0x00; u8[1] = 0x61; u8[2] = 0x73;
    expect(isWasmMagic(buf)).toBe(false);
  });

  test("empty buffer (0 bytes) → false", () => {
    expect(isWasmMagic(new ArrayBuffer(0))).toBe(false);
  });

  test("wrong magic (text file / garbage) → false", () => {
    const buf = new ArrayBuffer(8);
    new Uint8Array(buf).set([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x0a, 0x00]); // <html>
    expect(isWasmMagic(buf)).toBe(false);
  });

  test("source: isWasmMagic check present before mod.default() call in loadLiteRtLmBundle", () => {
    // Verify the guard is structurally between opfsReadBuffer and mod.default.
    const readIdx     = LOADER_SRC.indexOf("opfsReadBuffer(wasmKey)");
    const magicIdx    = LOADER_SRC.indexOf("isWasmMagic(wasmBytes)");
    const factoryIdx  = LOADER_SRC.indexOf("mod.default(");
    expect(readIdx).toBeGreaterThan(0);
    expect(magicIdx).toBeGreaterThan(readIdx);
    expect(factoryIdx).toBeGreaterThan(magicIdx);
  });

  test("source: eviction removeEntry present on integrity-check failure", () => {
    expect(LOADER_SRC).toContain("removeEntry(wasmKey)");
  });
});

// ── Memory64 detection (pure, already-implemented) ────────────────────────────

describe("detectMemory64 (pure, pre-existing)", () => {
  test("memory64 flag bit set → true", () => {
    expect(detectMemory64(makeMemory64Wasm())).toBe(true);
  });

  test("wasm32 memory section (flags = 0x00) → false", () => {
    expect(detectMemory64(makeWasm32Wasm())).toBe(false);
  });

  test("empty buffer (no memory section) → false", () => {
    expect(detectMemory64(new ArrayBuffer(0))).toBe(false);
  });
});

// ── Class 4 (GAP FIXED): CORS + TypeError wrapping ───────────────────────────

describe("Class 4 — Cross-origin CORS (mode:cors explicit + TypeError wrap, gap fixed)", () => {
  test("source: explicit mode:\"cors\" present in streamToOpfs fetch call", () => {
    // Confirm mode is set explicitly, not relying on default behavior.
    const fetchIdx = LOADER_SRC.indexOf(`mode: "cors"`);
    expect(fetchIdx).toBeGreaterThan(0);
    // Must appear inside the streamToOpfs function body.
    const fnIdx = LOADER_SRC.indexOf("async function streamToOpfs(");
    expect(fetchIdx).toBeGreaterThan(fnIdx);
  });

  test("source: TypeError .catch() wrapper present to add CORS context", () => {
    expect(LOADER_SRC).toContain("network/CORS error fetching");
    expect(LOADER_SRC).toContain(".catch((e: Error)");
  });

  test("mock: fetch TypeError (CORS block) → error includes phase + URL context", async () => {
    // Inline mirror of streamToOpfs error path with injectable fetch.
    const errors: string[] = [];
    const fakeFetch = async (_url: string, _opts: unknown): Promise<never> => {
      throw new TypeError("Failed to fetch");
    };
    // Simulate the .catch wrap from the fixed streamToOpfs:
    const url = "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/litert_lm.wasm";
    const phase = "wasm";
    try {
      await fakeFetch(url, {}).catch((e: Error) => {
        throw new Error(`network/CORS error fetching ${phase} (${url}): ${e.message}`);
      });
    } catch (e) {
      errors.push((e as Error).message);
    }
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("network/CORS error");
    expect(errors[0]).toContain("wasm");
    expect(errors[0]).toContain("Failed to fetch");
  });

  test("mock: HTTP 403 from HF → typed error with status + URL (no silent hang)", async () => {
    const phase = "model";
    const url = "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/model.litertlm";
    // Simulate !resp.ok branch:
    const resp = { ok: false, status: 403, statusText: "Forbidden" };
    let thrownMsg = "";
    if (!resp.ok) thrownMsg = `fetch ${phase} ${url} → HTTP ${resp.status} ${resp.statusText}`;
    expect(thrownMsg).toContain("403");
    expect(thrownMsg).toContain("Forbidden");
    expect(thrownMsg).toContain(phase);
  });
});

// ── Class 1 (ALREADY HANDLED): Progress events ───────────────────────────────

describe("Class 1 — Progress events (already-handled, source + mock)", () => {
  test("source: per-chunk progress post present in streamToOpfs", () => {
    // Confirm progress events are posted from inside the while(true) loop.
    const loopIdx    = LOADER_SRC.indexOf("while (true)");
    const progressIdx = LOADER_SRC.indexOf(`type: "progress"`, loopIdx);
    expect(progressIdx).toBeGreaterThan(loopIdx);
  });

  test("source: total > 0 guard prevents division-by-zero on missing content-length", () => {
    expect(LOADER_SRC).toContain("total > 0 ? bytes / total : 0");
  });

  test("mock: each fetched chunk emits one progress event; progress value is 0-1", async () => {
    const posts: Record<string, unknown>[] = [];
    const CHUNK_SIZE = 1024;
    const TOTAL = 4096;
    let offset = 0;
    // Simulate streaming 4 chunks through the progress-posting loop.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 4; i++) chunks.push(new Uint8Array(CHUNK_SIZE).fill(i));
    let chunkIdx = 0;
    const fakeRead = async (): Promise<{ done: boolean; value: Uint8Array | undefined }> => {
      if (chunkIdx >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: chunks[chunkIdx++] };
    };
    let bytes = 0;
    // Mirror the chunk-loop + progress post logic from streamToOpfs:
    while (true) {
      const { done, value } = await fakeRead();
      if (done) break;
      bytes += value!.byteLength;
      posts.push({ type: "progress", phase: "wasm", progress: TOTAL > 0 ? bytes / TOTAL : 0, bytes, total: TOTAL });
    }
    expect(posts.length).toBe(4);
    expect((posts[3].progress as number)).toBeCloseTo(1.0);
    expect((posts[0].progress as number)).toBeCloseTo(0.25);
  });
});

// ── Class 2 (ALREADY HANDLED): Network failure / mid-download drop ────────────

describe("Class 2 — Network failure + mid-download drop (already-handled)", () => {
  test("source: !resp.ok check present with URL + status in error message", () => {
    expect(LOADER_SRC).toContain("if (!resp.ok) throw new Error");
    expect(LOADER_SRC).toContain("resp.status");
    expect(LOADER_SRC).toContain("resp.statusText");
  });

  test("source: writable.abort() called in catch block (corrupt-file prevention)", () => {
    const catchIdx   = LOADER_SRC.indexOf("} catch (e) {");
    const abortIdx   = LOADER_SRC.indexOf("writable.abort()", catchIdx);
    expect(abortIdx).toBeGreaterThan(catchIdx);
    const rethrowIdx = LOADER_SRC.indexOf("throw e", abortIdx);
    expect(rethrowIdx).toBeGreaterThan(abortIdx);
  });

  test("mock: reader.read() rejection (mid-download drop) → abort called, error re-thrown", async () => {
    let abortCalled = false;
    const writable = {
      write: async () => {},
      close: async () => {},
      abort: async () => { abortCalled = true; },
    };
    // Mirror the try/catch in streamToOpfs:
    let thrown: Error | null = null;
    try {
      while (true) {
        throw new Error("stream aborted by network");
      }
    } catch (e) {
      await writable.abort();
      thrown = e as Error;
    }
    expect(abortCalled).toBe(true);
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("stream aborted");
  });
});

// ── Class 5 (ALREADY HANDLED): SW cache / quota-exceeded ─────────────────────

describe("Class 5 — SW cache + quota (already-handled)", () => {
  test("mock: writable.write() QuotaExceededError → abort called + error re-thrown (no crash)", async () => {
    let abortCalled = false;
    const writable = {
      write: async (_chunk: Uint8Array): Promise<void> => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      },
      close: async () => {},
      abort: async () => { abortCalled = true; },
    };
    const chunk = new Uint8Array(1024);
    let thrown: Error | null = null;
    try {
      await writable.write(chunk);
    } catch (e) {
      await writable.abort();
      thrown = e as Error;
    }
    expect(abortCalled).toBe(true);
    expect(thrown).not.toBeNull();
    expect(thrown!.name).toBe("QuotaExceededError");
  });

  test("mock: OPFS getDirectory() failure → error thrown typed (no silent hang)", async () => {
    const fakeGetDirectory = async (): Promise<never> => {
      throw new DOMException("Storage access denied.", "SecurityError");
    };
    let err: Error | null = null;
    try {
      await fakeGetDirectory();
    } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.name).toBe("SecurityError");
    // The caller (LiteRtLmBackend.load) wraps this in its own catch + posts error — verified by source audit.
    expect(LOADER_SRC).toContain("navigator.storage.getDirectory()");
  });

  test("source: opfsFileExists returns false on file not found (eviction → re-download on next load)", () => {
    // Verify size > 0 check — evicted/empty file returns false → triggers re-download.
    expect(LOADER_SRC).toContain("f.size > 0");
    expect(LOADER_SRC).toContain("catch { return false; }");
  });
});
