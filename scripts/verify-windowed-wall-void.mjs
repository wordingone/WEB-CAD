#!/usr/bin/env node
// verify-windowed-wall-void.mjs — See-through proof: windowed wall void renders
// as a real cut on deployed Pages (cold-cache). Leo gate mail #13069.
//
// Gate:
//   AC1 — handler integrity: SdWindow voidCut only set inside if(voidGroup); SdOpening fix
//   AC2 — cold-cache nav to deployed Pages + app ready
//   AC3 — dispatch SdWall + SdWindow, assert voidCut:true (handler returned success)
//   AC4 — screenshot saved (Leo runs independent Haiku see-through check on it)
//
// Usage:
//   bun scripts/verify-windowed-wall-void.mjs   # full CDP cert (browser required)
//
// The screenshot is saved to state/verify-windowed-wall-void/screenshot.jpg.
// cert.json is written with the see-through verdict.

import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";

const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const CDP_BASE  = "http://localhost:9222";
const STATE_DIR = fileURLToPath(new URL("../state/verify-windowed-wall-void", import.meta.url));
const REPO      = fileURLToPath(new URL("..", import.meta.url));

mkdirSync(STATE_DIR, { recursive: true });

const results = [];
const pass = (ac, detail) => { console.log(`  PASS  ${ac}: ${detail}`); results.push({ ac, pass: true, detail }); };
const fail = (ac, detail) => { console.error(`  FAIL  ${ac}: ${detail}`); results.push({ ac, pass: false, detail }); };
const note = (msg) => console.log(`  note  ${msg}`);

// ── AC1: Handler integrity (static) ──────────────────────────────────────────

console.log("[void-cert] AC1: handler integrity — voidCut only inside if(voidGroup)");
try {
  const src = readFileSync(`${REPO}/web/src/handlers/openings.ts`, "utf8");
  const lines = src.split("\n");

  // Check SdWindow handler: voidCut = true must follow 'if (voidGroup)'
  const winHandler = lines.slice(220, 250).join("\n");
  const winVoidCutIdx = winHandler.indexOf("voidCut = true");
  const winIfVoidGroupIdx = winHandler.indexOf("if (voidGroup)");
  const winOk = winIfVoidGroupIdx < winVoidCutIdx &&
    // voidCut must be INSIDE the if block — no semicolon-only line between them
    winHandler.slice(winIfVoidGroupIdx, winVoidCutIdx).includes("{");

  // Check SdOpening handler: same pattern (this was the bug; fixed in this PR)
  const opHandler = lines.slice(268, 290).join("\n");
  const opVoidCutIdx = opHandler.indexOf("voidCut = true");
  const opIfVoidGroupIdx = opHandler.indexOf("if (voidGroup)");
  const opOk = opIfVoidGroupIdx >= 0 && opIfVoidGroupIdx < opVoidCutIdx &&
    opHandler.slice(opIfVoidGroupIdx, opVoidCutIdx).includes("{");

  note(`SdWindow: voidCut inside if(voidGroup): ${winOk}`);
  note(`SdOpening: voidCut inside if(voidGroup): ${opOk} (was buggy — fixed)`);

  if (!winOk) throw new Error("SdWindow: voidCut = true is NOT inside if(voidGroup) block");
  if (!opOk) throw new Error("SdOpening: voidCut = true is NOT inside if(voidGroup) block");

  pass("AC1", `handler integrity ok — SdWindow voidCut inside if(voidGroup); SdOpening fix confirmed`);
} catch (e) {
  fail("AC1", `handler integrity check failed: ${e.message}`);
}

// ── CDP setup ─────────────────────────────────────────────────────────────────

console.log("[void-cert] AC2: connecting to CDP :9222");
const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) { fail("AC2", `Cannot reach ${CDP_BASE} — is browser running?`); writeResults(); process.exit(1); }
const tab = targets.find(t => t.type === "page");
if (!tab) { fail("AC2", "No page tab found"); writeResults(); process.exit(1); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let mid = 1;
const pending = new Map();
const msgListeners = [];
ws.onmessage = ev => {
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  for (const fn of [...msgListeners]) fn(msg);
};
await new Promise(r => { ws.onopen = r; });

function send(method, params = {}) {
  return new Promise(resolve => {
    const id = mid++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr, timeoutMs = 30000) {
  const res = await Promise.race([
    send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("CDP evaluate timeout")), timeoutMs)),
  ]);
  if (res?.result?.result?.subtype === "error") {
    throw new Error(res.result.result.description ?? "CDP evaluation error");
  }
  return res?.result?.result?.value ?? null;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");

// Cold-cache clear
console.log("[void-cert] Clearing caches (cold-cache)");
await send("Network.clearBrowserCache");
await send("Network.clearBrowserCookies");
await send("Storage.clearDataForOrigin", {
  origin: PAGES_URL,
  storageTypes: "temporary,local_storage,indexeddb,cache_storage,service_workers,websql",
});
await evaluate(`(async () => {
  const keys = await caches.keys();
  for (const k of keys) await caches.delete(k);
  const regs = await navigator.serviceWorker?.getRegistrations() ?? [];
  for (const reg of regs) await reg.unregister();
})()`);

// Navigate
console.log(`[void-cert] Navigating to ${PAGES_URL}`);
const loadProm = new Promise(r => {
  const h = msg => { if (msg.method === "Page.loadEventFired") { msgListeners.splice(msgListeners.indexOf(h), 1); r(); } };
  msgListeners.push(h);
});
await send("Page.navigate", { url: PAGES_URL });
await Promise.race([loadProm, new Promise(r => setTimeout(r, 30000))]);
await new Promise(r => setTimeout(r, 4000)); // extra settle for WASM + model boot

// Wait for app ready
const appReady = await evaluate(`
  new Promise(resolve => {
    if (window.__APP_READY__) { resolve(true); return; }
    const t = setInterval(() => {
      if (window.__APP_READY__) { clearInterval(t); resolve(true); }
    }, 500);
    setTimeout(() => { clearInterval(t); resolve(false); }, 20000);
  })
`, 25000);

if (!appReady) { fail("AC2", "app not ready after 20s"); writeResults(); process.exit(1); }
note("app ready (__APP_READY__ === true)");
pass("AC2", `cold-cache nav to ${PAGES_URL} + app ready`);

// ── AC3: dispatch SdWall + SdWindow, assert voidCut:true ──────────────────────

console.log("[void-cert] AC3: dispatch SdWall + SdWindow → assert voidCut:true");
try {
  // Draw a wall: 4m long, 0.3m thick, 3m tall, centred at origin
  const wallResult = await evaluate(`
    JSON.stringify(window.__dispatchSync("SdWall", {
      x: 0, y: 0, z: 0,
      length: 4, thickness: 0.3, height: 3,
      label: "CertWall"
    }))
  `, 15000);
  const wall = JSON.parse(wallResult ?? "{}");
  note(`SdWall result: ${JSON.stringify(wall).slice(0, 120)}`);
  if (!wall?.created && !wall?.ok) throw new Error(`SdWall failed: ${JSON.stringify(wall)}`);

  // Add a window in the wall centre: 1m wide, 1.5m tall, 0.8m sill
  const winResult = await evaluate(`
    JSON.stringify(window.__dispatchSync("SdWindow", {
      x: 0, y: 0,
      width: 1, height: 1.5, sill: 0.8,
      label: "CertWindow"
    }))
  `, 15000);
  const win = JSON.parse(winResult ?? "{}");
  note(`SdWindow result: ${JSON.stringify(win).slice(0, 160)}`);

  if (win?.error) throw new Error(`SdWindow error: ${win.error}`);

  const voidCut = win?.result?.voidCut === true || win?.voidCut === true;
  note(`voidCut: ${voidCut} (raw: ${JSON.stringify(win?.result?.voidCut ?? win?.voidCut)})`);
  if (!voidCut) throw new Error(`voidCut=${win?.result?.voidCut ?? win?.voidCut} — void NOT cut (floating frame)`);

  pass("AC3", `SdWall + SdWindow dispatched; voidCut:true (wall host found, addVoidToWallObject returned Group)`);
} catch (e) {
  fail("AC3", `dispatch failed: ${e.message}`);
}

// ── AC4: screenshot (Leo's see-through check runs on this) ───────────────────

console.log("[void-cert] AC4: screenshot — orbit to oblique angle, capture");
let screenshotB64 = null;
try {
  // Orbit the camera to an oblique angle showing the void
  await evaluate(`
    (() => {
      const v = window.__viewer;
      if (!v) return;
      const cam = v.camera;
      if (!cam) return;
      // Oblique angle: in front and to the side, looking at wall centre
      cam.position.set(6, -6, 4);
      cam.up.set(0, 0, 1);
      if (v.controls) {
        v.controls.target.set(0, 0, 1.5);
        v.controls.update();
      }
      cam.updateProjectionMatrix?.();
    })()
  `);
  await new Promise(r => setTimeout(r, 2000)); // wait for animation loop to render

  // Force render + capture toDataURL in same sync call (preserveDrawingBuffer=false by default).
  // Three.js clears the drawing buffer after compositing — must render then immediately read.
  const canvasB64 = await evaluate(`
    (() => {
      const v = window.__viewer;
      if (!v) return null;
      const renderer = v.renderer;
      const scene    = typeof v.getScene === 'function' ? v.getScene() : (v.scene ?? null);
      const camera   = v.camera;
      if (renderer && scene && camera) {
        try { renderer.render(scene, camera); } catch(_) {}
      }
      const canvas = renderer?.domElement ?? document.querySelector('canvas');
      if (!canvas) return null;
      try { return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]; } catch(e) { return null; }
    })()
  `);
  if (canvasB64) {
    screenshotB64 = canvasB64;
    note("screenshot via canvas.toDataURL (WebGL)");
  } else {
    const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
    screenshotB64 = shot?.result?.data ?? null;
    if (!screenshotB64) note(`captureScreenshot raw: ${JSON.stringify(shot).slice(0, 200)}`);
    else note("screenshot via Page.captureScreenshot");
  }
  if (!screenshotB64) throw new Error("Page.captureScreenshot returned no data");

  const imgBytes = Buffer.from(screenshotB64, "base64");
  writeFileSync(`${STATE_DIR}/screenshot.jpg`, imgBytes);
  note(`screenshot saved: ${imgBytes.length} bytes → state/verify-windowed-wall-void/screenshot.jpg`);

  pass("AC4", `screenshot captured (${imgBytes.length} bytes) — Leo runs Haiku see-through check`);
} catch (e) {
  fail("AC4", `screenshot failed: ${e.message}`);
}

ws.close();

// ── Result collation ──────────────────────────────────────────────────────────

function writeResults() {
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total  = results.length;

  const cert = {
    script: "verify-windowed-wall-void.mjs",
    cold_cache: true,
    clear_protocol: "Network.clearBrowserCache + Storage.clearDataForOrigin + caches.delete",
    url: PAGES_URL,
    timestamp: new Date().toISOString(),
    results,
    screenshot: screenshotB64 ? "state/verify-windowed-wall-void/screenshot.jpg" : null,
    summary: {
      passed, failed, total,
      handler_integrity: "voidCut = !!voidGroup (inside if(voidGroup) block) for SdWindow + SdOpening",
      void_semantics: "voidCut:true means addVoidToWallObject returned a Group (real cut), not null (floating frame)",
    },
  };
  writeFileSync(`${STATE_DIR}/cert.json`, JSON.stringify(cert, null, 2));
  console.log(`\n[void-cert] ${passed}/${total} PASS · ${failed} FAIL → ${STATE_DIR}/cert.json`);
  if (screenshotB64) console.log(`[void-cert] screenshot: ${STATE_DIR}/screenshot.jpg`);
}

writeResults();
process.exit(results.some(r => !r.pass) ? 1 : 0);
