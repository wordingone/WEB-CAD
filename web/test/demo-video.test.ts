import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import {
  demoCaption, isDemoDeepLink, withoutDemoParam, whenDemoClosed, openDemoFromUrl, openDemoVideo, closeDemoVideo, makeDemoButton,
  DEMO_OVERLAY_ID, DEMO_VIDEO_URL, DEMO_POSTER_URL,
} from "../src/agent/demo-video";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("demo video caption", () => {
  const meta = { recordedOn: "2026-11-24", hardware: "an RTX 4090", model: "Gemma 4 E4B" };
  test("states date, hardware, model and that it is a real session", () => {
    expect(demoCaption(meta)).toBe("Recorded 2026-11-24 on an RTX 4090, Gemma 4 E4B, real session.");
  });
  test("a speed-up note appears only when waits were shortened", () => {
    expect(demoCaption({ ...meta, waitSpeedup: 4 })).toContain("Waits shortened 4x.");
    expect(demoCaption({ ...meta, waitSpeedup: 1 })).not.toContain("shortened");
    expect(demoCaption({ ...meta, waitSpeedup: null })).not.toContain("shortened");
  });
  test("an optional note is appended after the speed-up note", () => {
    expect(demoCaption({ ...meta, waitSpeedup: 3, note: "Model files were already cached." }))
      .toBe("Recorded 2026-11-24 on an RTX 4090, Gemma 4 E4B, real session. Waits shortened 3x. Model files were already cached.");
  });
  test("missing metadata falls back to a generic, still honest caption", () => {
    expect(demoCaption(null)).toContain("real session");
    expect(demoCaption({ recordedOn: "2026-11-24" })).toContain("real session");
  });
});

describe("demo video player", () => {
  beforeEach(() => { closeDemoVideo(); document.body.innerHTML = ""; });

  test("nothing is in the page, and no video element exists, until the visitor asks", () => {
    expect(document.getElementById(DEMO_OVERLAY_ID)).toBeNull();
    expect(document.querySelector("video")).toBeNull();
    const html = read("../index.html");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("demo.mp4");
  });

  test("opens a native <video controls> that does not preload, with a caption and a close button", () => {
    openDemoVideo();
    const overlay = document.getElementById(DEMO_OVERLAY_ID)!;
    expect(overlay).not.toBeNull();
    const v = overlay.querySelector("video")!;
    expect(v.hasAttribute("controls")).toBe(true);
    expect(v.getAttribute("preload")).toBe("none");
    expect(v.getAttribute("poster")).toBe(DEMO_POSTER_URL);
    expect(v.getAttribute("src")).toBe(DEMO_VIDEO_URL);
    expect(overlay.querySelector(".dv-caption")!.textContent!.length).toBeGreaterThan(10);
    expect(overlay.querySelector(".dv-close")).not.toBeNull();
  });

  test("opening twice does not stack players", () => {
    openDemoVideo(); openDemoVideo();
    expect(document.querySelectorAll(`#${DEMO_OVERLAY_ID}`).length).toBe(1);
  });

  test("Close button and Esc both close it", () => {
    openDemoVideo();
    (document.querySelector(".dv-close") as HTMLButtonElement).click();
    expect(document.getElementById(DEMO_OVERLAY_ID)).toBeNull();
    openDemoVideo();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(document.getElementById(DEMO_OVERLAY_ID)).toBeNull();
  });

  test("the button opens the player", () => {
    const b = makeDemoButton();
    document.body.appendChild(b);
    b.click();
    expect(document.getElementById(DEMO_OVERLAY_ID)).not.toBeNull();
  });
});

describe("demo video is reachable from every entry point", () => {
  test("model consent dialog, next to the download button", () => {
    const src = read("../src/agent/model-consent.ts");
    expect(src).toContain('id="consent-demo"');
    expect(src).toContain("openDemoVideo()");
  });
  test("no-WebGPU modal, alongside Continue without AI", () => {
    const src = read("../src/agent/boot-capability-gate.ts");
    expect(src).toContain("data-demo-video");
    expect(src).toContain("openDemoVideo()");
    expect(src).toContain('data-path="cad-only"');
  });
  test("Help menu in the app chrome", () => {
    const src = read("../src/shell/shell.ts");
    expect(src).toContain('label: "Play demo video"');
  });
});

describe("?demo=1 deep link", () => {
  beforeEach(() => { closeDemoVideo(); document.body.innerHTML = ""; });
  test("recognised with other params present, and only for demo=1", () => {
    expect(isDemoDeepLink("?demo=1")).toBe(true);
    expect(isDemoDeepLink("?gemma_model=e2b&demo=1&mtp=off")).toBe(true);
    expect(isDemoDeepLink("?demo=0")).toBe(false);
    expect(isDemoDeepLink("?demo")).toBe(false);
    expect(isDemoDeepLink("")).toBe(false);
  });
  test("closing drops only the demo param", () => {
    const u = new URL(withoutDemoParam("https://example.test/WEB-CAD/?gemma_model=e2b&demo=1&mtp=off#view"));
    expect(u.searchParams.has("demo")).toBe(false);
    expect(u.searchParams.get("gemma_model")).toBe("e2b");
    expect(u.searchParams.get("mtp")).toBe("off");
    expect(u.hash).toBe("#view");
  });
  test("model prefetch waits while the player is open and goes on when it closes", async () => {
    await whenDemoClosed(); // not open: resolves at once
    openDemoVideo();
    let released = false;
    const p = whenDemoClosed().then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    closeDemoVideo();
    await p;
    expect(released).toBe(true);
  });
  test("boot wires the deep link before the model load, and the load waits on the player", () => {
    const wb = read("../src/shell/workbench.ts");
    expect(wb).toContain("openDemoFromUrl()");
    expect(wb.indexOf("initBootScreen();")).toBeLessThan(wb.indexOf("openDemoFromUrl()"));
    const chat = read("../src/shell/workbench-legacy-chat-input.ts");
    expect(chat.indexOf("await whenDemoClosed()")).toBeLessThan(chat.indexOf("checkConsentAndLoad(MODEL_ID"));
  });
  test("openDemoFromUrl does nothing without the param", () => {
    expect(openDemoFromUrl()).toBe(false);
    expect(document.getElementById(DEMO_OVERLAY_ID)).toBeNull();
  });
});
