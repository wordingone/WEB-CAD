import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
}

describe("Gemma ONNX fallback compatibility", () => {
  test("model worker does not attempt unsupported ONNX Q4 CPU/WASM fallback", () => {
    const worker = source("agent/model-worker.ts");

    expect(worker).toContain("GatherBlockQuantized");
    expect(worker).toContain("GEMMA_ONNX_CPU_UNSUPPORTED");
    expect(worker).not.toContain('{ device: "cpu", dtype: "q4" }');
    expect(worker).not.toContain("device: _wasmFallback ? \"cpu\" : \"auto\"");
  });

  test("boot capability modal does not offer unavailable WASM fallback without GGUF config", () => {
    const gate = source("agent/boot-capability-gate.ts");

    expect(gate).toContain("VITE_WASM_LLAMA_TARGET_URL");
    expect(gate).toContain("Fallback unavailable");
    expect(gate).toContain("Gemma ONNX Q4 model cannot run on ORT WASM/CPU");
  });
});
