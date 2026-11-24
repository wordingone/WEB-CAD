// any-gpu-verify.mjs — real-browser check that no visitor is blocked by the boot gate.
//
// Usage: node scripts/any-gpu-verify.mjs <base-url> <case> [profile-dir]
//   case = adapter   print the real adapter this headless browser gets, then exit
//   case = igpu      real GPU, adapter NAME reported as Intel integrated (simulated name,
//                    real load): expects reload onto the small model, no modal, model ready; fails fast
//                    if no download starts within 2 min or progress stops for 10 min
//   case = deeplink / deeplink-nogpu   open <base>?demo=1&keep=1: the video player is open at once, no request
//                    to huggingface.co and no model download strip while it is open, Esc closes it, the
//                    URL loses only demo=1, and the normal app is there (deeplink-nogpu: with WebGPU off)
//   case = consent  FRESH profile (use ""), real WebGPU, default model: the consent dialog appears and no
//                    huggingface.co request is made before the visitor clicks Download; the dialog and the
//                    boot screen both carry a working demo button. Never clicks Download (no download).
//   case = nogpu     WebGPU removed: expects the modal, a working "Play demo video" button (the
//                    overlay opens a <video> whose src returns HTTP 200; nothing is fetched before
//                    the click; Esc closes it), and "Continue without AI" to work
//
// Headless, no visible window. Exit 0 = pass, 1 = fail.
import { chromium } from "playwright-core";

const [base, kase, profile] = process.argv.slice(2);
if (!base || !kase) { console.error("usage: any-gpu-verify.mjs <base-url> <case> [profile-dir]"); process.exit(2); }

const args = ["--headless=new", "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--window-position=-32000,-32000"];
if (kase === "nogpu" || kase === "deeplink-nogpu") args.push("--disable-features=WebGPU");
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
if (kase === "nogpu" || kase === "deeplink-nogpu") {
  await page.addInitScript(() => { try { Object.defineProperty(navigator, "gpu", { get: () => undefined }); } catch { /* flag already removed it */ } });
}

const hfRequests = [];
page.on("request", (r) => { if (/huggingface\.co/.test(r.url())) hfRequests.push(r.url()); });
await page.addInitScript(() => {
  window.__v = { loading: 0, last: null, bootComplete: false, error: null };
  window.addEventListener("agentmodel:loading", (e) => { window.__v.loading++; window.__v.last = e.detail?.file ?? null; });
  window.addEventListener("agentmodel:boot-complete", () => { window.__v.bootComplete = true; });
  window.addEventListener("agentmodel:error", (e) => { window.__v.error = String(e.detail); });
});
const startUrl = kase.startsWith("deeplink") ? base + (base.includes("?") ? "&" : "?") + "demo=1&keep=1" : base;
await page.goto(startUrl, { waitUntil: "domcontentloaded" });

if (kase === "consent") {
  const hfBefore = () => hfRequests.length;
  await page.waitForSelector("#model-consent-overlay", { timeout: 30_000 }).catch(() => {});
  if (!(await page.locator("#model-consent-overlay").count())) await fail("no consent dialog on a fresh visit (consentKey=" + (await page.evaluate(() => localStorage.getItem("gemma4-e4b-consent-v1"))) + ")");
  await page.waitForTimeout(8000); // a download that was going to start without an ask would have started by now
  const st = await page.evaluate(() => ({ loadingEvents: window.__v?.loading ?? 0, arc: window.__arc?.state ?? null, strip: !!document.getElementById("model-download-strip"),
    consentGranted: localStorage.getItem("gemma4-e4b-consent-v1"), demoInConsent: !!document.querySelector("#model-consent-overlay #consent-demo"),
    demoInBoot: !!document.querySelector("#boot-screen #boot-demo-link") }));
  console.log("consent:", JSON.stringify(st), "hf requests before click:", hfBefore());
  if (hfBefore() > 0) await fail("model files requested before the visitor clicked Download: " + hfRequests[0]);
  if (st.loadingEvents > 0 || st.strip || st.consentGranted === "1") await fail("model load started or consent auto-granted before any click: " + JSON.stringify(st));
  if (st.arc !== "idle") await fail("arc state should still be idle before consent, got " + st.arc);
  if (!st.demoInConsent) await fail("consent dialog has no demo button");
  if (!st.demoInBoot) await fail("boot screen has no demo link");
  for (const sel of ["#model-consent-overlay #consent-demo", "#boot-screen #boot-demo-link"]) {
    // the boot-screen link sits under the consent overlay, so click it through the DOM
    await page.evaluate((q) => document.querySelector(q).click(), sel);
    await page.waitForSelector("#demo-video-overlay video", { timeout: 10_000 }).catch(() => {});
    if (!(await page.locator("#demo-video-overlay video").count())) await fail("demo button did not open the player: " + sel);
    await page.keyboard.press("Escape");
    if (await page.locator("#demo-video-overlay").count()) await fail("Esc did not close the player");
    if (!(await page.locator("#model-consent-overlay").count())) await fail("closing the player must leave the consent dialog in place");
  }
  await page.waitForTimeout(3000);
  if (hfBefore() > 0) await fail("model files requested after watching the demo, before any Download click: " + hfRequests[0]);
  console.log("PASS consent: dialog shown on a fresh visit, zero huggingface requests before Download, demo buttons work");
  await ctx.close(); process.exit(0);
}

if (kase.startsWith("deeplink")) {
  await page.waitForSelector("#demo-video-overlay video", { timeout: 15_000 }).catch(() => {});
  if (!(await page.locator("#demo-video-overlay video").count())) await fail("?demo=1 did not open the player");
  await page.waitForTimeout(6000); // time for a model download or consent dialog to appear if it were going to
  const open = await page.evaluate(() => ({
    overlay: !!document.querySelector("#demo-video-overlay"), strip: !!document.getElementById("model-download-strip"),
    url: location.search, caption: document.querySelector("#demo-video-overlay .dv-caption")?.textContent ?? "",
  }));
  console.log("deeplink open:", JSON.stringify(open), "hf requests:", hfRequests.length);
  if (!open.overlay) await fail("player closed by itself");
  if (hfRequests.length) await fail("model files requested while the demo video is open: " + hfRequests[0]);
  if (open.strip) await fail("model download strip appeared while the demo video is open");
  await page.keyboard.press("Escape");
  if (await page.locator("#demo-video-overlay").count()) await fail("Esc did not close the player");
  const after = await page.evaluate(() => ({ url: location.search, app: !!document.querySelector(".menu-item") }));
  console.log("after close:", JSON.stringify(after));
  if (/demo=/.test(after.url) || !/keep=1/.test(after.url)) await fail("URL after close should lose only demo=1: " + after.url);
  if (!after.app) await fail("the normal app is not there after closing");
  if (kase === "deeplink-nogpu") {
    await page.waitForSelector(".bcg-modal", { timeout: 20_000 }).catch(() => {});
    if (!(await page.locator(".bcg-modal").count())) await fail("normal no-WebGPU modal did not follow the video");
  }
  console.log("PASS " + kase + ": ?demo=1 opens the video first; nothing downloads while it is open; closing leaves the normal app");
  await ctx.close(); process.exit(0);
}

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

// Wait for a real model load. Fails fast when no download starts (2 min) or progress stops (10 min).
// A fresh visitor sees no consent dialog when the app auto-grants consent (arc state "idle"); if it does
// appear, accept it.
const approve = page.locator("#model-consent-overlay #consent-approve");
await approve.waitFor({ timeout: 20_000 }).catch(() => {}); // fresh profile: the dialog must appear first
if (await approve.count().catch(() => 0)) {
  if (hfRequests.length) await fail("model files requested before the consent click: " + hfRequests[0]);
  await approve.click(); console.log("consent accepted (no huggingface request before the click)");
} else console.log("no consent dialog: model already cached or consent stored in this profile");
const t0 = Date.now();
const snap = () => page.evaluate(async () => {
  const v = window.__v ?? {};
  let usage = 0; try { usage = (await navigator.storage.estimate()).usage ?? 0; } catch { /* */ }
  return { loadingEvents: v.loading ?? 0, lastLoading: v.last ?? null, bootComplete: !!v.bootComplete, error: v.error ?? window.__agentBootError ?? null,
    arc: window.__arc?.state ?? null, usage, consentGranted: localStorage.getItem("gemma4-e4b-consent-v1"),
    strip: document.getElementById("model-download-strip")?.textContent?.replace(/\s+/g, " ").trim() ?? null };
}).catch(() => null);
let lastSig = "", lastChange = Date.now(), started = false, lastPrint = 0, cur = null;
for (;;) {
  cur = await snap();
  const el = Math.round((Date.now() - t0) / 1000);
  if (cur) {
    if (cur.error) await fail("model load error: " + cur.error);
    if (cur.bootComplete) break;
    if (!started && (cur.loadingEvents > 0 || hfRequests.length > 0)) { started = true; console.log(`download/load started after ${el} s (${hfRequests.length} huggingface requests)`); }
    const sig = [cur.loadingEvents, hfRequests.length, Math.round(cur.usage / 1e6), cur.strip].join("|");
    if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
    if (Date.now() - lastPrint > 60_000) { lastPrint = Date.now(); console.log(`  +${el}s arc=${cur.arc} usage=${(cur.usage / 1e6).toFixed(0)}MB loading-events=${cur.loadingEvents} hf=${hfRequests.length} ${cur.strip ?? ""}`.slice(0, 260)); }
  }
  if (!started && Date.now() - t0 > 120_000) await fail("no model download or load started within 2 minutes (consent=" + cur?.consentGranted + ", arc=" + cur?.arc + ")");
  if (Date.now() - lastChange > 600_000) await fail("model load made no progress for 10 minutes: " + JSON.stringify(cur));
  if (Date.now() - t0 > 3_600_000) await fail("model load did not finish within 60 minutes");
  await page.waitForTimeout(5000);
}
const done = { ok: true };
console.log(`load: ${JSON.stringify(done)} after ${Math.round((Date.now() - t0) / 1000)} s`);
const badge = await page.evaluate(() => document.getElementById("ai-model-badge")?.textContent ?? "");
console.log("badge:", badge.trim());
const final = await page.evaluate(() => ({ arc: window.__arc?.state, adapterClass: window.__bcg?.adapterClass, url: location.search, device: window.__arc?.deviceLabel ?? null }));
console.log("final:", JSON.stringify(final));
if (final.adapterClass !== "igpu") await fail("gate did not classify the adapter as integrated: " + final.adapterClass);
if (!["ready", "idle"].includes(final.arc)) await fail("model not ready: arc=" + final.arc);
console.log(logs.filter((l) => /#1627\] adapter|model/i.test(l)).slice(-6).join("\n"));
console.log("PASS igpu: no modal, small model loaded on the GPU");
await ctx.close(); process.exit(0);
