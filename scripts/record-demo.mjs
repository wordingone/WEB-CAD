// record-demo.mjs — record the "Play demo video" clip: a REAL, unedited session of the live app
// with the real in-browser model answering prompts. Headless only: no window, no desktop input.
//
// Usage:
//   node scripts/record-demo.mjs --base http://localhost:5871/ --profile <browser-profile-dir> \
//        [--model e4b|e2b] [--prompts wall,slab-with-hole,...] [--wait-speedup 4] [--out web/public/demo] \
//        [--work <dir for raw webm + logs>] [--warm-only] [--no-warm] [--probe]
//
// Phases
//   1. warm   (not recorded): load the page once so the model files are downloaded into the browser
//             profile. The first visit downloads several GB; recording that would be pointless.
//   2. take   (recorded, ONE continuous session): page load -> model load from cache -> each prompt
//             typed into the chat input and submitted -> final hold. Timeline marks are kept.
//   3. encode: ffmpeg turns the raw webm into demo.mp4 (H.264). Only WAITING segments (model load,
//             generation) may be sped up, by --wait-speedup; typing and results play at 1x. The factor
//             is written to demo.json and shown in the player caption. Nothing from other runs is
//             spliced in and no frame is drawn or altered.
//   --probe   run the take without recording or encoding, to find which prompts work (pass/fail only).
//
// Re-record from scratch:  see docs/demo-video.md ("Re-record").
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, statSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const flag = (k) => argv.includes("--" + k);

if (!opt("profile", null)) { console.error("--profile <dir> is required (a dedicated browser profile that holds the cached model)"); process.exit(2); }
const BASE = opt("base", "http://localhost:5871/");
const PROFILE = opt("profile", null);
const MODEL = opt("model", "e4b");
const OUT = resolve(opt("out", "web/public/demo"));
const WORK = resolve(opt("work", join(tmpdir(), "webcad-demo-work")));
const SPEEDUP = Number(opt("wait-speedup", "1"));
const PROMPT_IDS = opt("prompts", "wall,slab-with-hole,circular-column,four-walled-room,wall-with-doorway").split(",");
const PROBE = flag("probe");
// --local-files <dir>: serve model files that exist in <dir> (same file name, size and sha256 verified beforehand against the
// Hugging Face LFS oid) from disk instead of the network. Same bytes, same model; only the transfer is skipped. The recording
// note must say so.
const LOCAL = opt("local-files", null);
const VIEW = { width: 1280, height: 720 };
const HOLD_AFTER_LAST_MS = 4000;
const TURN_TIMEOUT_MS = Number(opt("turn-timeout", "360")) * 1000;
const BOOT_TIMEOUT_MS = 60 * 60_000; // first download is slow; the take itself loads from cache

const PROMPTS = {
  "wall": "Build a wall, 5.5m long, 0.2m thick, 2.8m tall.",
  "slab": "Place a 6 by 6m floor slab, 0.2m thick.",
  "roof-slab": "Place a 3 by 3m slab, 0.2m thick, raised 3m above ground.",
  "beam": "Place a horizontal beam 5m long, 0.3m wide and 0.4m deep, 3m above ground.",
  "rect-column": "A rectangular column 0.4m by 0.4m and 3.5m tall.",
  "wall-b": "Build a wall, 4m long, 0.2m thick, 2.8m tall.",
  "l-explicit": "Build two walls at right angles: one 6m long along x and one 4m long along y, both 0.2m thick and 2.8m tall.",
  "column-b": "A circular column with 0.3m radius and 4m height.",
  "circular-column": "A circular column with 0.45m radius and 5m height.",
  "raised-slab": "Place a 5 by 4m floor slab, 0.2m thick, raised 3m above ground.",
  "slab-with-hole": "Slab 6x6m x 0.2m thick with a 1x1m square hole at (2.5, 2.5).",
  "wall-with-doorway": "Wall 4.13x0.28x2.69m with a 1.01m x 2.1m doorway 1.77m from the left.",
  "l-walls": "Two walls forming an L: 8.45m and 9.25m, both 0.31m thick and 3.35m tall.",
  "four-walled-room": "Four-walled room 9.12m x 9.34m, 0.24m thick walls, 3.06m tall.",
  "stair-step": "Stair-step structure with 4 steps, run 0.39m, rise 0.21m, 2.77m wide.",
};
// NOTE: "circular-column" etc. are the ids used by --prompts; prompt text is the same sentence the
// bundled demo list (web/src/agent/demo-prompts.ts) uses, with ASCII x for the multiplication sign.

const url = MODEL === "e2b" ? `${BASE}${BASE.includes("?") ? "&" : "?"}gemma_model=e2b` : BASE;
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
mkdirSync(WORK, { recursive: true });

const ARGS = ["--headless=new", "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--window-position=-32000,-32000"];

// Tracks agent turns and the live scene from inside the page. Read-only instrumentation.
const INIT = `
window.__demo = { turns: [], bootComplete: false, bootError: null, genTicks: 0, progress: 0 };
window.addEventListener('agentmodel:generate-progress', () => { window.__demo.progress++; });
setInterval(() => { if (window.__arc && window.__arc.state === 'generating') window.__demo.genTicks++; }, 250);
window.addEventListener('agentmodel:boot-complete', () => { window.__demo.bootComplete = true; });
window.addEventListener('agentmodel:error', (e) => { window.__demo.bootError = String(e.detail); });
window.addEventListener('agent:turn-complete', (e) => {
  const v = window.__viewer && window.__viewer.scene ? window.__viewer.scene : null;
  window.__demo.turns.push({ verbs: (e.detail && e.detail.verbs) || [], sceneObjects: (e.detail && e.detail.sceneObjects) || 0,
    meshes: v ? v.children.filter((c) => c.isMesh || (c.children && c.children.some && c.children.some((k) => k.isMesh))).length : null });
});
`;

async function launch(record) {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome", headless: true, args: ARGS, viewport: VIEW,
    ...(record ? { recordVideo: { dir: WORK, size: VIEW } } : {}),
  });
  await ctx.addInitScript(INIT);
  if (LOCAL) {
    await ctx.route(/huggingface\.co\/.+\/resolve\//, async (route) => {
      const name = new URL(route.request().url()).pathname.split("/").pop();
      const f = join(LOCAL, name);
      if (!existsSync(f)) return route.continue();
      const buf = readFileSync(f);
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
      const headers = { "content-type": "application/octet-stream", "access-control-allow-origin": "*", "accept-ranges": "bytes" };
      if (range) {
        const a = Number(range[1]), b = range[2] ? Number(range[2]) : buf.length - 1;
        return route.fulfill({ status: 206, headers: { ...headers, "content-range": `bytes ${a}-${b}/${buf.length}` }, body: buf.subarray(a, b + 1) });
      }
      return route.fulfill({ status: 200, headers, body: buf });
    });
    log("local model files served from", LOCAL, readdirSync(LOCAL).join(", "));
  }
  const page = ctx.pages()[0] ?? await ctx.newPage();
  return { ctx, page };
}

async function acceptConsent(page) {
  const approve = page.locator("#model-consent-overlay #consent-approve");
  for (let i = 0; i < 20; i++) {
    if (await approve.count().catch(() => 0)) { await approve.click(); log("consent accepted"); return true; }
    await page.waitForTimeout(500);
  }
  return false;
}

async function waitBoot(page) {
  const t0 = Date.now();
  while (Date.now() - t0 < BOOT_TIMEOUT_MS) {
    const s = await page.evaluate(() => ({ ok: window.__demo?.bootComplete, err: window.__demo?.bootError, arc: window.__arc?.state ?? null })).catch(() => null);
    if (s?.ok) return { ok: true, ms: Date.now() - t0, arc: s.arc };
    if (s?.err) return { ok: false, error: s.err, ms: Date.now() - t0 };
    await page.waitForTimeout(1000);
  }
  return { ok: false, error: "boot timeout", ms: Date.now() - t0 };
}

// ---- phase 1: warm -----------------------------------------------------------------------------
if (!flag("no-warm")) {
  log("warm: loading the page once so the model is cached in the profile:", url);
  const { ctx, page } = await launch(false);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await acceptConsent(page);
  const b = await waitBoot(page);
  log("warm: boot", JSON.stringify(b));
  await ctx.close();
  if (!b.ok) { console.error("warm-up failed:", b.error); process.exit(1); }
  if (flag("warm-only")) process.exit(0);
}

// ---- phase 2: the take -------------------------------------------------------------------------
const marks = []; // {label, kind: "wait"|"live", t0, t1} in ms since the take started
const results = [];
log("take: start", PROBE ? "(probe, not recorded)" : "(recorded)");
const wallStart = Date.now();
const { ctx, page } = await launch(!PROBE);
const since = () => Date.now() - wallStart;
await page.goto(url, { waitUntil: "domcontentloaded" });
await acceptConsent(page); // present only when the model is not yet cached
const bootT0 = 0;
const boot = await waitBoot(page);
marks.push({ label: "page load + model load from cache", kind: "wait", t0: bootT0, t1: since() });
log("take: boot", JSON.stringify(boot));
if (!boot.ok) { await ctx.close(); console.error("boot failed:", boot.error); process.exit(1); }
await page.waitForTimeout(1500);
marks.push({ label: "app ready", kind: "live", t0: since() - 1500, t1: since() });

// A profile that has been used before offers "Restore your last session?"; discard it in the take, like a visitor would.
{
  const discard = page.locator("#restore-prompt:not([hidden]) #restore-discard-btn");
  if (await discard.count()) { await discard.click(); log("take: discarded the restore-session prompt"); await page.waitForTimeout(800); }
}

// prompt mode (the chat input lives in the prompt dock)
await page.evaluate(() => {
  try { localStorage.setItem("gemma-cad:console-mode-v1", "prompt"); } catch { /* */ }
  const pill = document.querySelector(".mode-pill");
  if (pill && pill.getAttribute("data-mode") === "console") pill.click();
});
const input = page.locator('.chat-input, textarea[name="prompt"], [data-role="chat-input"]').first();
if (!(await input.count())) { await ctx.close(); console.error("chat input not found"); process.exit(1); }

for (const id of PROMPT_IDS) {
  const text = PROMPTS[id];
  if (!text) { console.error("unknown prompt id", id); continue; }
  const turnsBefore = await page.evaluate(() => window.__demo.turns.length);
  const genBefore = await page.evaluate(() => window.__demo.genTicks);
  const progBefore = await page.evaluate(() => window.__demo.progress);
  const meshesBefore = await page.evaluate(() => { const v = window.__viewer?.scene; return v ? v.children.filter((c) => c.isMesh || (c.children && c.children.some && c.children.some((k) => k.isMesh))).length : null; });
  const tType0 = since();
  await input.click();
  await input.pressSequentially(text, { delay: 28 });
  await page.waitForTimeout(500);
  const tSend = since();
  marks.push({ label: `type: ${id}`, kind: "live", t0: tType0, t1: tSend });
  await input.press("Enter");
  // generation wait
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let done = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const n = await page.evaluate(() => window.__demo.turns.length);
    if (n > turnsBefore) { done = true; break; }
  }
  const tDone = since();
  if (!done) {
    if (PROBE) { results.push({ id, prompt: text, done: false, pass: false, genSeconds: +((tDone - tSend) / 1000).toFixed(1), turn: null, reply: [] }); log("probe: prompt", id, "FAIL (no turn within", TURN_TIMEOUT_MS / 1000, "s)");
      await page.reload({ waitUntil: "domcontentloaded" }); const b2 = await waitBoot(page); if (!b2.ok) break; continue; }
    console.error(`prompt ${id} did not finish within ${TURN_TIMEOUT_MS / 1000} s; this take does not ship`); await ctx.close(); process.exit(1);
  }
  marks.push({ label: `generate: ${id}`, kind: "wait", t0: tSend, t1: tDone });
  await page.waitForTimeout(3500); // let the viewport frame the result and let the viewer read it
  marks.push({ label: `result: ${id}`, kind: "live", t0: tDone, t1: since() });
  const turn = await page.evaluate(() => window.__demo.turns[window.__demo.turns.length - 1] ?? null);
  const reply = await page.evaluate(() => {
    const m = [...document.querySelectorAll(".chat-msg, .chat-message, [class*='chat-msg']")].map((e) => e.textContent?.trim()).filter(Boolean);
    return m.slice(-2);
  });
  // Evidence the live model (not a cache) answered: ARC state went to 'generating' and/or the worker streamed progress.
  const liveModel = (await page.evaluate(() => window.__demo.genTicks)) > genBefore || (await page.evaluate(() => window.__demo.progress)) > progBefore;
  // A prompt passes only if the turn ended with at least one build verb AND the number of scene meshes rose.
  const pass = !!turn && (turn.verbs?.length ?? 0) > 0 && turn.meshes != null && meshesBefore != null && turn.meshes > meshesBefore;
  results.push({ id, prompt: text, done, pass, liveModel, genSeconds: +((tDone - tSend) / 1000).toFixed(1), meshesBefore, turn, reply });
  log("take: prompt", id, JSON.stringify({ done, pass, liveModel, gen_s: (tDone - tSend) / 1000, verbs: turn?.verbs, meshesBefore, meshes: turn?.meshes }));
  if (!pass && !PROBE) { await page.screenshot({ path: join(WORK, `failed-${id}.png`) }).catch(() => {}); await ctx.close(); console.error(`prompt ${id} built nothing (verbs ${JSON.stringify(turn?.verbs)}, meshes ${meshesBefore} -> ${turn?.meshes}); this take does not ship`); process.exit(1); }
  if (PROBE) await page.screenshot({ path: join(WORK, `probe-${id}.png`) });
}
await page.waitForTimeout(HOLD_AFTER_LAST_MS);
marks.push({ label: "final hold", kind: "live", t0: since() - HOLD_AFTER_LAST_MS, t1: since() });
const takeEndWall = Date.now();
const video = page.video();
await ctx.close(); // flushes the recording
const rawPath = video ? await video.path() : null;
writeFileSync(join(WORK, "take-marks.json"), JSON.stringify({ marks, results, url, model: MODEL, startedAt: new Date(wallStart).toISOString() }, null, 2));
if (PROBE) { log("probe done; results in", WORK); process.exit(0); }
log("take: raw video", rawPath);

// ---- phase 3: encode -----------------------------------------------------------------------------
// FFMPEG env var overrides the binary. Needs a modern ffmpeg with libx264 (an old build on PATH will not do).
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const ff = (args) => execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const probeDur = (f) => {
  // ffmpeg -i prints "Duration: HH:MM:SS.xx" on stderr and exits 1 without an output file.
  let err = "";
  try { execFileSync(FFMPEG, ["-hide_banner", "-i", f], { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { err = String(e.stderr ?? ""); }
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  if (!m) throw new Error("cannot read duration of " + f);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
};
const rawDur = probeDur(rawPath);
// Playwright starts recording at page creation, a little after launch began; align the end of the video
// with the end of the take, so every mark is shifted by the same offset.
const takeSpan = (takeEndWall - wallStart) / 1000;
const offset = Math.max(0, takeSpan - rawDur) * -1; // video time = mark time + offset (offset <= 0 means video started later)
log(`raw duration ${rawDur.toFixed(1)} s, take span ${takeSpan.toFixed(1)} s, offset ${offset.toFixed(2)} s`);

const segs = marks.filter((m) => m.t1 > m.t0).map((m) => {
  const a = Math.max(0, m.t0 / 1000 + offset), b = Math.min(rawDur, m.t1 / 1000 + offset);
  return { ...m, a, b };
}).filter((s) => s.b - s.a > 0.05);
// Segment boundaries between consecutive marks may leave tiny gaps (the awaits between them); fill by
// extending each segment to the start of the next so no footage is dropped or duplicated.
for (let i = 0; i < segs.length - 1; i++) segs[i].b = segs[i + 1].a;
segs[0].a = 0;
segs[segs.length - 1].b = rawDur;

const parts = [], chains = [];
segs.forEach((s, i) => {
  const sp = s.kind === "wait" ? SPEEDUP : 1;
  chains.push(`[0:v]trim=start=${s.a.toFixed(3)}:end=${s.b.toFixed(3)},setpts=(PTS-STARTPTS)/${sp},fps=25[v${i}]`);
  parts.push(`[v${i}]`);
});
const filter = chains.join(";") + `;${parts.join("")}concat=n=${segs.length}:v=1:a=0,format=yuv420p[out]`;
mkdirSync(OUT, { recursive: true });
const mp4 = join(OUT, "demo.mp4");
ff(["-i", rawPath, "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-preset", "slow", "-crf", "30",
  "-movflags", "+faststart", "-an", mp4]);
const dur = probeDur(mp4);
// poster: the last result frame (before the final hold ends)
ff(["-ss", String(Math.max(0, dur - 2)), "-i", mp4, "-frames:v", "1", "-q:v", "4", join(OUT, "demo-poster.jpg")]);
const speedNote = segs.filter((s) => s.kind === "wait").reduce((t, s) => t + (s.b - s.a), 0);
const hw = opt("hardware", "an RTX 4090");
const meta = {
  recordedOn: new Date(wallStart).toISOString().slice(0, 10),
  hardware: hw,
  model: MODEL === "e2b" ? "Gemma 4 E2B" : "Gemma 4 E4B",
  waitSpeedup: SPEEDUP > 1 ? SPEEDUP : null,
  note: opt("note", null),
  durationSeconds: Math.round(dur),
  rawSeconds: Math.round(rawDur),
  waitSecondsRaw: Math.round(speedNote),
  prompts: results.map((r) => ({ id: r.id, prompt: r.prompt, genSeconds: r.genSeconds, verbs: r.turn?.verbs ?? [], meshesBefore: r.meshesBefore, meshesAfter: r.turn?.meshes ?? null })),
};
writeFileSync(join(OUT, "demo.json"), JSON.stringify(meta, null, 2) + "\n");
copyFileSync(rawPath, join(WORK, "raw-take.webm"));
log(`encoded ${mp4}: ${(statSync(mp4).size / 1e6).toFixed(2)} MB, ${dur.toFixed(1)} s (raw ${rawDur.toFixed(1)} s)`);
process.exit(0);
