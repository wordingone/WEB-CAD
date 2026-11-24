// any-gpu-verify.mjs — real-browser check that no visitor is blocked by the boot gate.
//
// Usage: node scripts/any-gpu-verify.mjs <base-url> <case> [profile-dir]
//   case = adapter   print the real adapter this headless browser gets, then exit
//   case = igpu      real GPU, adapter NAME reported as Intel integrated (simulated name,
//                    real load): expects reload onto the small model, no modal, model ready
//   case = nogpu     WebGPU removed: expects the modal, a working "Play demo video" button (the
//                    overlay opens a <video> whose src returns HTTP 200; nothing is fetched before
//                    the click; Esc closes it), and "Continue without AI" to work
//
// Headless, no visible window. Exit 0 = pass, 1 = fail.
import { chromium } from "playwright-core";

const [base, kase, profile] = process.argv.slice(2);
if (!base || !kase) { console.error("usage: any-gpu-verify.mjs <base-url> <case> [profile-dir]"); process.exit(2); }

const args = ["--headless=new", "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--window-position=-32000,-32000"];
if (kase === "nogpu") args.push("--disable-features=WebGPU");
const ctx = await chromium.launchPersistentContext(profile ?? "", {
  channel: "chrome", headless: true, args, viewport: { width: 1400, height: 900 },
});
const page = ctx.pages()[0] ?? await ctx.newPage();
const logs = [];
const demoRequests = [];
page.on("request", (r) => { if (/\/demo\/demo\.mp4/.test(r.url())) demoRequests.push(r.url()); });
page.on("console", (m) => { const t = m.text(); if (/boot-capability-gate|#1627|gemma|stepping down|adapter/i.test(t)) logs.push(t.slice(0, 300)); });

const fail = async (why) => { console.log("FAIL:", why); console.log(logs.slice(-25).join("\n")); await ctx.close(); process.exit(1); };

if (kase === "igpu") {
  // Report the real adapter under an Intel integrated name; everything else is the real GPU.
  await page.addInitScript(() => {
    const gpu = navigator.gpu; if (!gpu) return;
    const orig = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (o) => {
      const a = await orig(o); if (!a) return a;
      return new Proxy(a, { get(t, k) {
        if (k === "info") return { vendor: "intel", architecture: "gen-12", description: "Intel Gen12 (name simulated)" };
        const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
      } });
    };
  });
}
if (kase === "nogpu") {
  await page.addInitScript(() => { try { Object.defineProperty(navigator, "gpu", { get: () => undefined }); } catch { /* flag already removed it */ } });
}

await page.goto(base, { waitUntil: "domcontentloaded" });

if (kase === "adapter") {
  const info = await page.evaluate(async () => {
    if (!navigator.gpu) return { webgpu: false };
    const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!a) return { webgpu: true, adapter: null };
    return { webgpu: true, vendor: a.info?.vendor, architecture: a.info?.architecture, description: a.info?.description,
      fallback: !!a.isFallbackAdapter, maxBufferGB: +(a.limits.maxBufferSize / 2 ** 30).toFixed(2), f16: a.features.has("shader-f16"),
      isolated: self.crossOriginIsolated };
  });
  console.log(JSON.stringify(info)); await ctx.close(); process.exit(0);
}

// Wait for the gate to settle (it may reload once onto the small model).
await page.waitForFunction(() => !!(window).__bcg || !!document.querySelector(".bcg-modal"), null, { timeout: 60_000 }).catch(() => {});
const state = async () => page.evaluate(() => ({
  url: location.search, bcg: (window).__bcg ?? null, modal: !!document.querySelector(".bcg-modal"),
  tip: !!document.querySelector(".bcg-tip"), title: document.querySelector(".bcg-title")?.textContent ?? null,
  promptDisabled: document.querySelector('.dock-tab[data-tab="prompt"]')?.classList.contains("dock-tab--disabled") ?? null,
}));
let s = await state();
console.log("gate:", JSON.stringify(s));

if (kase === "nogpu") {
  if (!s.modal) await fail("expected the modal when WebGPU is absent");
  if (await page.locator('[data-path="wasm-fallback"]').count()) await fail("CPU option offered though no CPU model is configured");
  // Demo video: button present, nothing fetched yet, click opens a <video> with a live src.
  if (await page.locator(".bcg-modal [data-demo-video]").count() !== 1) await fail("no 'Play demo video' button in the modal");
  if (demoRequests.length) await fail("demo video was requested before the click");
  await page.locator(".bcg-modal [data-demo-video]").click();
  await page.waitForSelector("#demo-video-overlay video", { timeout: 10_000 }).catch(() => {});
  const demo = await page.evaluate(async () => {
    const v = document.querySelector("#demo-video-overlay video");
    if (!v) return null;
    const res = await fetch(v.currentSrc || v.src, { method: "HEAD" });
    return { controls: v.hasAttribute("controls"), preload: v.getAttribute("preload"), src: v.currentSrc || v.src,
      status: res.status, type: res.headers.get("content-type"), len: Number(res.headers.get("content-length") ?? 0),
      caption: document.querySelector("#demo-video-overlay .dv-caption")?.textContent ?? "" };
  });
  console.log("demo:", JSON.stringify(demo));
  if (!demo) await fail("clicking 'Play demo video' did not open the player");
  if (demo.status !== 200) await fail("demo video src did not resolve: HTTP " + demo.status);
  if (!/^video\//.test(demo.type ?? "")) await fail("demo video src is not a video: " + demo.type);
  if (!demo.controls || demo.preload !== "none") await fail("player must have controls and preload=none");
  if (!/real session/.test(demo.caption)) await fail("caption missing: " + demo.caption);
  // HTTP 200 is not playback: actually play it (muted, as autoplay policy requires) and watch the clock.
  const played = await page.evaluate(async () => {
    const v = document.querySelector("#demo-video-overlay video");
    v.muted = true;
    try { await v.play(); } catch (e) { return { ok: false, error: String(e) }; }
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: v.currentTime > 0.3 && v.videoWidth > 0, currentTime: +v.currentTime.toFixed(2), videoWidth: v.videoWidth,
      videoHeight: v.videoHeight, duration: +v.duration.toFixed(1), error: v.error?.message ?? null };
  });
  console.log("play:", JSON.stringify(played));
  if (!played.ok) await fail("demo video did not play: " + JSON.stringify(played));
  await page.keyboard.press("Escape");
  if (await page.locator("#demo-video-overlay").count()) await fail("Esc did not close the demo player");
  if (!(await page.locator(".bcg-modal").count())) await fail("closing the player must leave the modal in place");
  await page.locator('[data-path="cad-only"]').click();
  await page.waitForFunction(() => (window).__bcg?.path === "cad-only", null, { timeout: 20_000 });
  // The same video is reachable from the app chrome (Help menu) once the app is in use.
  await page.locator(".menu-item", { hasText: "Help" }).first().click();
  await page.locator('.menu-dropdown[data-for="help"] .menu-row', { hasText: "Play demo video" }).click();
  await page.waitForSelector("#demo-video-overlay video", { timeout: 10_000 }).catch(() => {});
  if (!(await page.locator("#demo-video-overlay video").count())) await fail("Help > Play demo video did not open the player");
  await page.keyboard.press("Escape");
  if (await page.locator("#demo-video-overlay").count()) await fail("Esc did not close the player opened from Help");
  console.log("PASS nogpu: modal shown, demo video plays from its button, app usable without AI"); await ctx.close(); process.exit(0);
}

// igpu case
if (s.modal) await fail("blocking modal shown for a real adapter");
if (!/gemma_model=e2b/.test(s.url)) await fail("did not switch to the small model: " + s.url);
if (!s.tip) await fail("optional speed tip missing");
if (s.bcg?.path !== "dgpu-proceed") await fail("gate path " + s.bcg?.path);

// Consent, then wait for a real model load.
const approve = page.locator("#model-consent-overlay #consent-approve");
if (await approve.count().catch(() => 0)) { await approve.click(); console.log("consent accepted"); }
const t0 = Date.now();
const done = await page.evaluate(() => new Promise((res) => {
  const w = window;
  if (w.__agentBootError) return res({ ok: false, error: w.__agentBootError });
  w.addEventListener("agentmodel:boot-complete", () => res({ ok: !w.__agentBootError, error: w.__agentBootError ?? null }));
  w.addEventListener("agentmodel:error", (e) => res({ ok: false, error: String(e.detail) }));
  setTimeout(() => res({ ok: false, error: "timeout 40 min" }), 40 * 60_000);
}));
console.log(`load: ${JSON.stringify(done)} after ${Math.round((Date.now() - t0) / 1000)} s`);
if (!done.ok) await fail("model did not load: " + done.error);
const badge = await page.evaluate(() => document.getElementById("ai-model-badge")?.textContent ?? "");
console.log("badge:", badge.trim());
console.log(logs.filter((l) => /#1627\] adapter|model/i.test(l)).slice(-6).join("\n"));
console.log("PASS igpu: no modal, small model loaded on the GPU");
await ctx.close(); process.exit(0);
