import { beforeEach, describe, expect, test } from "bun:test";
import { checkConsentAndLoad } from "../src/agent/model-consent";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("model consent cancellation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    delete (window as unknown as Record<string, unknown>).__agentModelStatus;
    // agent-harness.ts sets window.__arc at import time (reachable transitively from earlier
    // test files in the same bun process). checkConsentAndLoad treats an "idle"/"ready" __arc
    // as "model already loaded" and skips the dialog (370b11c, #310), so clear it here.
    delete (window as unknown as Record<string, unknown>).__arc;
  });

  test("Not now explicitly skips AI boot without calling model load", async () => {
    let proceeded = false;
    const skipped = new Promise<{ reason?: string }>((resolve) => {
      window.addEventListener("agentmodel:boot-skipped", (ev) => {
        resolve((ev as CustomEvent<{ reason?: string }>).detail ?? {});
      }, { once: true });
    });

    checkConsentAndLoad("test/model", () => { proceeded = true; });
    await nextTick();
    await nextTick();

    const overlay = document.getElementById("model-consent-overlay");
    expect(overlay).toBeTruthy();
    overlay?.querySelector<HTMLButtonElement>("#consent-cancel")?.click();

    const detail = await skipped;
    expect(detail.reason).toBe("user-cancelled-model-download");
    expect(proceeded).toBe(false);
    expect(document.getElementById("model-consent-overlay")).toBeNull();
    expect((window as unknown as { __agentModelStatus?: { state?: string; reason?: string } }).__agentModelStatus).toEqual({
      state: "skipped",
      reason: "user-cancelled-model-download",
    });
  });
});
