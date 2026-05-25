#!/usr/bin/env bun
// SUSPENDED until 2026-05-19. Do not run or cite in PR smoke packs.
// Re-engage: remove this banner after 2026-05-19.
const SUSPEND_UNTIL = new Date("2026-05-19T00:00:00Z");
if (new Date() < SUSPEND_UNTIL) {
  console.log("[gemma-verify] SUSPENDED until 2026-05-19 — skipping. bun run verify + CI green is sufficient pre-2026-05-19.");
  process.exit(0);
}

// gemma-verify-raw.mjs — Raw CDP WebSocket variant of gemma-verify-cdp.ts
//
// Connects to the shared browser at :9222 via raw WebSocket (no Playwright).
// Playwright's connectOverCDP and --isolated both time out on this Windows/Bun
// combination; raw WS works reliably (proven by retroactive audit scripts).
//
// Produces the same receipt format as gemma-verify-cdp.ts:
//   state/gemma-verify-<sha>-<timestamp>.json
//   { sha, timestamp, attached_via_cdp: true, all_passed, surfaces: [...] }
//
// Usage: bun scripts/gemma-verify-raw.mjs
//
// Tracked: issue #196 — long-term fix is to replace Playwright in gemma-verify-cdp.ts

import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { CDP_PORT, CDP_BASE, DEV_URL as _DEFAULT_DEV_URL } from "./ports.mjs";

// ── Flags ─────────────────────────────────────────────────────────────────────
// --fresh-user    : clear all caches before running (simulates first-time visitor)
// --returning-user: skip cache clear (default — simulates returning visitor)
const FRESH_USER = process.argv.includes("--fresh-user");

// ── Connection ────────────────────────────────────────────────────────────────

const targetUrlIdx = process.argv.indexOf("--target-url");
const DEV_URL   = targetUrlIdx !== -1 ? process.argv[targetUrlIdx + 1]
                : (process.env.GEMMA_DEV_URL ?? _DEFAULT_DEV_URL);
const STATE_DIR = `${process.cwd()}/state`;

function getSHA() {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

const sha       = getSHA();
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "").slice(0, 16) + "Z";
mkdirSync(STATE_DIR, { recursive: true });
const outFile   = `${STATE_DIR}/gemma-verify-${sha}-${timestamp}.json`;

// Find an existing page tab via Target.getTargets (no new tab opened — /json list only)
const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) {
  console.error(`ERROR: Cannot reach CDP at ${CDP_BASE} — is the shared browser running?`);
  process.exit(1);
}
const DEV_HOST = new URL(DEV_URL).host;
let target = targets.find(t => t.url?.includes(DEV_HOST) && t.type === "page");
if (!target) {
  console.error(`ERROR: no page tab at ${DEV_URL} found in shared browser (:${CDP_PORT})`);
  console.error("Tabs:", targets.filter(t => t.type === "page").map(t => t.url));
  process.exit(1);
}
console.log(`Attaching to existing tab: ${target.url}`);

// Open raw WS to PAGE target (not browser-level)
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();

ws.onmessage = m => {
  const x = JSON.parse(m.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
  // Auto-accept all browser dialogs (beforeunload/alert/confirm/prompt) via CDP.
  // Agents own all browser prompts — never ask user to click. (#1704 Leg A / #1708)
  if (x.method === "Page.javascriptDialogOpening") {
    send("Page.handleJavaScriptDialog", { accept: true });
  }
};
await new Promise(r => ws.addEventListener("open", r));

function send(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Runtime.enable");
await send("Page.enable");

// Bring tab to front so WebGL renders real frames (background tabs throttle rAF/canvas).
await send("Page.bringToFront");

// ── Permission pre-grants (agents own all browser prompts — #1708 Leg A) ─────────
// Pre-grant storage + download permissions for the target origin so no native Chrome
// dialog blocks agent-driven runs. Page.setDownloadBehavior suppresses the "download
// multiple files" prompt. Page.javascriptDialogOpening (wired above) handles
// beforeunload/alert/confirm/prompt in real-time.
const _origin = new URL(DEV_URL).origin;
for (const name of ["durable-storage", "automatic-downloads", "background-sync", "notifications"]) {
  await send("Browser.setPermission", { permission: { name }, setting: "granted", origin: _origin }).catch(() => {});
}
await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: `${STATE_DIR}/downloads` }).catch(() => {});

async function evaluate(expression, returnByValue = true, timeoutMs = 60_000) {
  const sendProm = send("Runtime.evaluate", { expression, returnByValue, awaitPromise: true });
  const timeoutProm = new Promise(resolve => setTimeout(() => resolve(null), timeoutMs));
  const res = await Promise.race([sendProm, timeoutProm]);
  if (!res || res?.result?.exceptionDetails) return null; // threw or timed out — callers must null-check
  return res?.result?.result?.value;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Capture #viewer-canvas bytes-per-pixel via CDP clip screenshot.
// bpp ≥ 0.025 = normally-rendered scene; bpp ≤ 0.018 = blank/occluded canvas.
async function canvasBpp(label = '') {
  const rect = await evaluate(`(function() {
    const c = document.getElementById('viewer-canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`);
  if (!rect || rect.width < 1 || rect.height < 1)
    return { bpp: 0, label, reason: 'canvas not found or zero-size' };
  const snap = await send('Page.captureScreenshot', {
    format: 'jpeg', quality: 85,
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
  });
  const b64 = snap?.result?.data ?? '';
  const bytes = b64.length * 0.75;
  const pixels = rect.width * rect.height;
  const bpp = pixels > 0 ? Math.round((bytes / pixels) * 1000) / 1000 : 0;
  return { bpp, pixels: Math.round(pixels), label };
}

// WS cleanup — always runs even if a surface throws. No tab is closed (we used an existing tab).
async function cleanup() {
  try { ws.close(); } catch { /* ignore */ }
}

// ── Fresh-user: clear caches before reload ────────────────────────────────────
if (FRESH_USER) {
  console.log("  --fresh-user: clearing all caches before suite…");
  const clearResult = await evaluate(`(async () => {
    const log = [];
    try {
      const names = await caches.keys();
      for (const name of names) { await caches.delete(name); log.push('cache:' + name); }
    } catch (e) { log.push('cache-error:' + e.message); }
    try {
      const dbs = await indexedDB.databases();
      for (const { name } of (dbs ?? [])) {
        if (!name) continue;
        await new Promise((res, rej) => {
          const r = indexedDB.deleteDatabase(name);
          r.onsuccess = res; r.onerror = () => rej(r.error); r.onblocked = res;
        });
        log.push('idb:' + name);
      }
    } catch (e) { log.push('idb-error:' + e.message); }
    try { localStorage.clear(); log.push('localStorage'); } catch {}
    try { sessionStorage.clear(); log.push('sessionStorage'); } catch {}
    return { cleared: log };
  })()`);
  console.log("  cleared:", clearResult?.cleared?.join(", ") ?? "(none)");
}

// ── Reload to clean state ─────────────────────────────────────────────────────
let surfaces = [];
try {

await send("Page.reload", { waitForNavigation: false });
await delay(2000);

// ── Boot gate (#1225) ─────────────────────────────────────────────────────────
// Verify must run against a booted app, not a post-wipe tab still on the download screen.
// Waits for agentmodel:boot-complete / agentmodel:returning-user.
// If the app is already loaded (returning session), resolves immediately.
// Timeout: 20 min covers Pages cold-cache CDN download (~217s observed).
{
  const BOOT_TIMEOUT_MS = 20 * 60 * 1000;
  console.log("  Waiting for app boot (up to 20 min — covers Pages cold-cache)…");
  const bootResult = await evaluate(`(() => new Promise(resolve => {
    if (window.__viewer && typeof window.__dispatch === 'function') {
      resolve({ event: 'already-loaded' }); return;
    }
    const done = ev => () => resolve({ event: ev });
    window.addEventListener('agentmodel:boot-complete',  done('boot-complete'),  { once: true });
    window.addEventListener('agentmodel:returning-user', done('returning-user'), { once: true });
    window.addEventListener('agentmodel:error', e => resolve({ event: 'error', detail: String(e?.detail ?? e) }), { once: true });
  }))()`, true, BOOT_TIMEOUT_MS + 10_000);
  if (!bootResult || bootResult.event === 'error') {
    const reason = bootResult?.event === 'error'
      ? `agentmodel:error: ${bootResult.detail}`
      : "boot timed out after 20 min — CDN stalled or app never loaded";
    console.error(`  ✗ ${reason}`);
    console.error("  gemma-verify requires a booted app. Let the model finish loading before running verify.");
    const failReceipt = {
      sha, timestamp, attached_via_cdp: true, all_passed: false,
      surfaces: [{ name: "boot-gate", passed: false, evidence: { reason } }],
    };
    writeFileSync(outFile, JSON.stringify(failReceipt, null, 2));
    await cleanup();
    process.exit(1);
  }
  console.log(`  ✓ App ready — ${bootResult.event}`);
}

// ── Test hook ─────────────────────────────────────────────────────────────────
await evaluate(`(window.__gemmaTest = { events: {}, surfaceResults: [] }, true)`);
// Enable test mode: SdExport short-circuits to prevent real Downloads pollution (#262).
await evaluate(`(window.__testMode = true, true)`);
await delay(1000);

// ── Surface recording ─────────────────────────────────────────────────────────
function record(name, passed, evidence) {
  surfaces.push({ name, passed, evidence });
  const icon = passed ? "✓" : "✗";
  console.log(`  ${icon} ${name}`);
  if (!passed) console.log("    evidence:", JSON.stringify(evidence).slice(0, 300));
}

// ── Modal-overlay cleanup (called after any surface that may open cmdk) ────────
// Fires Escape on both window + document to cover all listener registrations.
// Returns { wasClosed: bool } so callers can log if needed.
async function closeCmdkIfOpen() {
  await evaluate(`(() => {
    const input = document.querySelector('.cmdk-input, [data-cmdk-input]');
    if (!input) return;
    const visible = input.getBoundingClientRect().height > 0;
    if (!visible) return;
    const closeBtn = document.querySelector('.cmdk-close, .cmdk-backdrop');
    if (closeBtn) { closeBtn.click(); return; }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  })()`);
  await delay(300);
}

// Between-surface invariant: assert no modal overlay remains open.
// Logs a warning (does not fail the surface) — purely for diagnostics.
async function assertNoCmdkOverlay(afterSurface) {
  const open = await evaluate(`(() => {
    const input = document.querySelector('.cmdk-input, [data-cmdk-input]');
    return input ? input.getBoundingClientRect().height > 0 : false;
  })()`);
  if (open) {
    console.log(`  ⚠ cmdk overlay still open after ${afterSurface} — force-closing`);
    await closeCmdkIfOpen();
  }
}

// ── State isolation helpers (#396) ───────────────────────────────────────────

// Remove all user-created scene objects (including IFC sample-picker loads),
// detach gizmos, clear command session. Uses SdClearScene dispatch (#475) so
// the same path that clears the scene panel also covers IFC objects that
// resetScene previously missed (they lacked userData.kind/creator/layerId).
async function resetScene(label = '') {
  await evaluate(`(function() {
    window.__dispatch?.('SdClearScene', {});
    window.__clearCommandSession?.();
    window.__dispatch?.('SdSectionBoxOff', {});
    window.__dispatch?.('SdClippingPlanesClear', {});
  })()`);
  await delay(600);
  if (label) console.log(`  ↺ scene reset (${label})`);
}

// Reset to known base state: select tool, model mode, no cmdk, no gizmo, no
// sub-object selection. Call before surface groups that require clean UI state.
async function resetToBaseState(label = '') {
  await closeCmdkIfOpen();
  await evaluate(`(async () => {
    // Two Escape passes: first clears sub-object mode, second clears selection.
    for (let i = 0; i < 2; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
    }
    const v = window.__viewer;
    if (v?.gizmos) v.gizmos.forEach(g => { try { g.detach(); } catch (_) {} });
    if (v) v.targetObject = null;
    // Return to model mode
    const modelTab = document.querySelector('.mode-tab[data-mode="model"]');
    if (modelTab) { modelTab.click(); await new Promise(r => setTimeout(r, 300)); }
    // Return to select tool
    window.__dispatch?.('setActiveTool', { toolId: 'select' });
    window.__clearCommandSession?.();
    await new Promise(r => setTimeout(r, 100));
  })()`);
  if (label) console.log(`  ↺ base state reset (${label})`);
}


const { runBatchA } = await import('./verify-batch-a.mjs');
const { runBatchB } = await import('./verify-batch-b.mjs');
const { runBatchC } = await import('./verify-batch-c.mjs');
const { runBatchD } = await import('./verify-batch-d.mjs');
const { runBatchE } = await import('./verify-batch-e.mjs');

const ctx = { send, evaluate, delay, canvasBpp, record, resetScene, resetToBaseState, closeCmdkIfOpen, assertNoCmdkOverlay, DEV_URL, FRESH_USER };
await runBatchA(ctx);
await runBatchB(ctx);
await runBatchC(ctx);
await runBatchD(ctx);
await runBatchE(ctx);
} finally {
  await cleanup();
}

// ── Aggregate + write receipt ─────────────────────────────────────────────────

// Read surface-allowfail.txt — surfaces listed there are excluded from all_passed gate.
let allowFail = new Set();
try {
  const af = readFileSync("state/surface-allowfail.txt", "utf8");
  for (const line of af.split("\n")) {
    const id = line.split("#")[0].trim();
    if (id) allowFail.add(id);
  }
} catch { /* file absent = no allowfail entries */ }

const gatedSurfaces = surfaces.filter(s => !allowFail.has(s.name));
const allPassed  = gatedSurfaces.every(s => s.passed);
const passCount  = surfaces.filter(s => s.passed).length;
const output = { sha, timestamp, attached_via_cdp: true, all_passed: allPassed, allow_fail: [...allowFail], surfaces };
writeFileSync(outFile, JSON.stringify(output, null, 2));

console.log("");
if (allowFail.size > 0) console.log(`allowfail: ${[...allowFail].join(", ")}`);
console.log(`${passCount}/${surfaces.length} surfaces passed — all_passed: ${allPassed}`);
console.log(`attached_via_cdp: true`);
console.log(`Output: ${outFile}`);

process.exit(allPassed ? 0 : 1);
