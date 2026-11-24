import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { planBoot, smallModelUrl, explicitModelParam } from "../src/agent/boot-capability-gate";

describe("boot capability plan: no visitor has to change a browser flag", () => {
  test("every real WebGPU adapter proceeds without the blocking modal", () => {
    for (const cl of ["dgpu", "igpu", "unknown"] as const) {
      expect(planBoot(cl, "").modal).toBe(false);
      expect(planBoot(cl, "e4b").modal).toBe(false);
    }
  });

  test("the modal is shown only when no usable WebGPU adapter exists", () => {
    expect(planBoot("no-webgpu", "").modal).toBe(true);
    expect(planBoot("software", "").modal).toBe(true);
    expect(planBoot("no-webgpu", "").stepDownToSmallModel).toBe(false);
  });

  test("integrated graphics get the small model unless the visitor chose one", () => {
    expect(planBoot("igpu", "").stepDownToSmallModel).toBe(true);
    expect(planBoot("igpu", "e2b").stepDownToSmallModel).toBe(false);
    expect(planBoot("igpu", "e4b").stepDownToSmallModel).toBe(false);
    expect(planBoot("dgpu", "").stepDownToSmallModel).toBe(false);
    expect(planBoot("unknown", "").stepDownToSmallModel).toBe(false);
  });

  test("the flag steps are an optional tip, shown only on integrated graphics", () => {
    expect(planBoot("igpu", "e2b").speedTip).toBe(true);
    expect(planBoot("dgpu", "").speedTip).toBe(false);
  });

  test("small-model URL keeps other params and the hash", () => {
    const u = new URL(smallModelUrl("https://example.test/app/?mtp=off#view"));
    expect(u.searchParams.get("gemma_model")).toBe("e2b");
    expect(u.searchParams.get("mtp")).toBe("off");
    expect(u.hash).toBe("#view");
    expect(explicitModelParam("?gemma_model=E2B")).toBe("e2b");
    expect(explicitModelParam("")).toBe("");
  });

  test("a failed default-model load steps down instead of dead-ending", () => {
    const harness = readFileSync(new URL("../src/agent/agent-harness.ts", import.meta.url), "utf8");
    expect(harness).toContain("stepDownToSmallModel(_errMsg)");
    // the ?gpu=wasm redirect is only taken when a CPU model is actually configured
    expect(harness).toContain("_budget === 0 && WASM_BACKEND_ENABLED");
  });
});
