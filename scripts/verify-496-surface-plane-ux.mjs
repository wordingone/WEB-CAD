#!/usr/bin/env node
// verify-496-surface-plane-ux.mjs — Deployed-Pages CDP cert for PR #496.
// Leo gate AC:
//   AC1: SURFACE hover over closed curve → scene contains a preview mesh (noSnap=true)
//   AC2: SURFACE click closed curve → SdSurface dispatch ok, geometry added to scene
//   AC3: PLANE pt2 mousemove → scene contains a preview Line (noSnap=true)
//   AC4: PLANE pt3 mousemove → scene contains a preview Group with fill+outline (noSnap=true)
//   AC5: ZERO JS exceptions across the test

import { WebSocket }               from "ws";
import { mkdirSync, writeFileSync } from "fs";
import { execSync }                from "child_process";
import { fileURLToPath }           from "url";

const CDP_PORT  = 9222;
const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const OUT_DIR   = fileURLToPath(new URL("../state/verify-496", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

const targets = JSON.parse(execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" }));
const target  = targets.find(t => t.type === "page");
if (!target) { console.error("No page tab at :9222"); process.exit(1); }
console.log(`[v496] tab: ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 1;
const pending = new Map();
const evListeners = new Map();
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
ws.on("message", raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result ?? {});
  } else if (m.method) {
    (evListeners.get(m.method) ?? []).forEach(cb => cb(m.params));
  }
});
const send    = (method, params = {}) => new Promise((res, rej) => {
  const id = mid++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const onEvent = (event, cb) => {
  if (!evListeners.has(event)) evListeners.set(event, []);
  evListeners.get(event).push(cb);
};
const evaluate = async (expr, awaitP = false) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: awaitP });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval error");
  return r.result?.value;
};
const screenshot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const path = `${OUT_DIR}/${name}.png`;
  writeFileSync(path, Buffer.from(r.data, "base64"));
  console.log(`[v496]   screenshot → ${path}`);
  return path;
};
const delay = ms => new Promise(r => setTimeout(r, ms));

// Mouse helpers — drive events through the app pipeline (no internal mutation)
const mouse = async (type, x, y, btn = 0) => {
  await send("Input.dispatchMouseEvent", { type, x, y, button: btn === 0 ? "none" : "left", buttons: btn, clickCount: btn ? 1 : 0 });
};
const click = async (x, y) => {
  await mouse("mousePressed",  x, y, 1);
  await mouse("mouseReleased", x, y, 1);
};
const move  = async (x, y) => mouse("mouseMoved", x, y, 0);

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

// Track JS exceptions
const exceptions = [];
onEvent("Runtime.exceptionThrown", p => {
  const desc = p.exceptionDetails?.exception?.description ?? "unknown";
  if (!desc.includes("AbortError") && !desc.includes("NetworkError") && !desc.includes("Failed to fetch")) {
    exceptions.push(desc);
  }
});

// Cold-cache load
console.log("[v496] cold-cache load...");
await send("Network.clearBrowserCache");
await send("Storage.clearDataForOrigin", { origin: "https://wordingone.github.io", storageTypes: "all" });
await evaluate(`(async () => {
  if (!navigator.serviceWorker) return;
  const rs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(rs.map(r => r.unregister()));
})()`, true).catch(() => {});
const lp = new Promise(res => onEvent("Page.loadEventFired", res));
await send("Page.navigate", { url: PAGES_URL });
await lp;

// Wait for shell
let shellReady = false;
for (let t = 0; t < 90; t++) {
  await delay(1000);
  const ready = await evaluate(`!!(window.__viewer && window.__dispatchSync)`).catch(() => false);
  if (ready) { shellReady = true; console.log(`[v496] shell ready ~${t+1}s`); break; }
}
if (!shellReady) { console.error("[v496] FAIL: shell timeout"); process.exit(1); }
await delay(2000);

const results = [];

// ── Helpers ────────────────────────────────────────────────────────────────

// Count preview objects (noSnap=true, not in selection layer) in scene
const countPreviewObjects = async () => evaluate(`(function() {
  const scene = window.__viewer?.getScene?.();
  if (!scene) return 0;
  let count = 0;
  scene.traverse(o => { if (o.userData?.noSnap && o !== scene) count++; });
  return count;
})()`);

// Get scene object count (meshes/lines/groups visible as geometry)
const countSceneObjects = async () => evaluate(`(function() {
  const scene = window.__viewer?.getScene?.();
  if (!scene) return 0;
  let count = 0;
  scene.traverse(o => { if ((o.isMesh || o.isLine || o.isGroup) && !o.userData?.noSnap) count++; });
  return count;
})()`);

// Find button in toolbar by label text
const clickTool = async (label) => {
  const rect = await evaluate(`(function() {
    const btns = [...document.querySelectorAll('.tool-btn, [data-tool], button')];
    const b = btns.find(b => b.textContent?.trim() === ${JSON.stringify(label)} || b.dataset?.tool === ${JSON.stringify(label.toLowerCase())});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  if (!rect) {
    // fallback: dispatch setActiveTool
    console.log(`[v496]   tool '${label}' not found by DOM, dispatching via setActiveTool`);
    await evaluate(`window.__dispatchSync?.("setActiveTool", { toolId: ${JSON.stringify(label.toLowerCase())} })`);
    return;
  }
  await click(rect.x, rect.y);
};

// Dispatch a command via __dispatchSync (for setup only — not tested path)
const dispatchSync = async (cmd, args) =>
  evaluate(`JSON.stringify(window.__dispatchSync?.("${cmd}", ${JSON.stringify(args)}) ?? null)`);

// ── Setup: draw a rectangle to use as surface/extrude profile ──────────────

console.log("\n[v496] ── AC setup: draw rectangle ──────────────────────────");
// Place a 100×80 rectangle centered at viewport midpoint via dispatchSync
const viewCx = 640, viewCy = 400;  // approximate viewport center
const rectResult = JSON.parse(await dispatchSync("SdRectangle", {
  x: viewCx - 50, y: viewCy - 40,
  width: 100, height: 80,
}));
console.log(`[v496]   SdRectangle: ${JSON.stringify(rectResult)}`);

// Wait a frame for the geometry to land
await delay(500);
const objsBefore = await countSceneObjects();
console.log(`[v496]   scene objects after rect: ${objsBefore}`);

// Get the rectangle's screen-space centroid for hover/click targets
const rectCenter = await evaluate(`(function() {
  const scene = window.__viewer?.getScene?.();
  if (!scene) return null;
  let line = null;
  scene.traverse(o => { if (o.isLine && !o.userData?.noSnap) line = o; });
  if (!line) return null;
  // Project world position to screen
  const cam = window.__viewer?.getCamera?.();
  if (!cam) return null;
  const v = line.position.clone().project(cam);
  const w = window.innerWidth, h = window.innerHeight;
  return { x: (v.x + 1)/2 * w, y: (-v.y + 1)/2 * h };
})()`);
console.log(`[v496]   rect centroid on screen: ${JSON.stringify(rectCenter)}`);
const hx = rectCenter?.x ?? viewCx;
const hy = rectCenter?.y ?? viewCy;

// ── AC1: SURFACE hover → preview mesh in scene ────────────────────────────

console.log("\n[v496] ── AC1: SURFACE hover preview ────────────────────────");

// Activate surface tool
await evaluate(`window.__dispatchSync?.("setActiveTool", { toolId: "surface" })`);
await delay(300);

// Move mouse over the rectangle center
const preHover = await countPreviewObjects();
await move(hx, hy);
await delay(300);
const postHover = await countPreviewObjects();
console.log(`[v496]   preview objects: before=${preHover} after=${postHover}`);
await screenshot("ac1-surface-hover");

const ac1 = postHover > preHover;
results.push({ id: "AC1", desc: "surface hover → preview object added", pass: ac1, detail: `previewDelta=${postHover - preHover}` });
console.log(`[v496]   AC1: ${ac1 ? "PASS" : "FAIL"}`);

// ── AC2: SURFACE click → SdSurface dispatched, geometry in scene ──────────

console.log("\n[v496] ── AC2: SURFACE click → dispatch ──────────────────────");
const sceneBeforeClick = await countSceneObjects();
await click(hx, hy);
await delay(500);
const sceneAfterClick = await countSceneObjects();
console.log(`[v496]   scene objects: before=${sceneBeforeClick} after=${sceneAfterClick}`);
await screenshot("ac2-surface-click");

const ac2 = sceneAfterClick > sceneBeforeClick;
results.push({ id: "AC2", desc: "surface click → geometry added to scene", pass: ac2, detail: `delta=${sceneAfterClick - sceneBeforeClick}` });
console.log(`[v496]   AC2: ${ac2 ? "PASS" : "FAIL"}`);

// ── AC3: PLANE pt2 mousemove → line preview ────────────────────────────────

console.log("\n[v496] ── AC3: PLANE pt2 preview ────────────────────────────");

// Reset tool then start plane
await evaluate(`window.__dispatchSync?.("setActiveTool", { toolId: "select" })`);
await delay(200);
await evaluate(`window.__dispatchSync?.("setActiveTool", { toolId: "plane" })`);
await delay(300);

// Click pt1 (origin)
const pt1x = viewCx - 80, pt1y = viewCy + 60;
await click(pt1x, pt1y);
await delay(300);

// Now in plane_pt2: move mouse — expect a line preview
const prePt2 = await countPreviewObjects();
await move(pt1x + 120, pt1y);
await delay(300);
const postPt2 = await countPreviewObjects();
console.log(`[v496]   plane_pt2 preview objects: before=${prePt2} after=${postPt2}`);
await screenshot("ac3-plane-pt2");

const ac3 = postPt2 > prePt2;
results.push({ id: "AC3", desc: "plane pt2 mousemove → line preview added", pass: ac3, detail: `previewDelta=${postPt2 - prePt2}` });
console.log(`[v496]   AC3: ${ac3 ? "PASS" : "FAIL"}`);

// ── AC4: PLANE pt3 mousemove → group preview ──────────────────────────────

console.log("\n[v496] ── AC4: PLANE pt3 preview ────────────────────────────");

// Click pt2 (width edge)
await click(pt1x + 120, pt1y);
await delay(300);

// Now in plane_pt3: move mouse — expect outline+fill group
const prePt3 = await countPreviewObjects();
await move(pt1x + 120, pt1y - 80);
await delay(300);
const postPt3 = await countPreviewObjects();
console.log(`[v496]   plane_pt3 preview objects: before=${prePt3} after=${postPt3}`);
await screenshot("ac4-plane-pt3");

const ac4 = postPt3 > prePt3;
results.push({ id: "AC4", desc: "plane pt3 mousemove → outline+fill preview added", pass: ac4, detail: `previewDelta=${postPt3 - prePt3}` });
console.log(`[v496]   AC4: ${ac4 ? "PASS" : "FAIL"}`);

// Cancel plane tool
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", keyCode: 27 });
await delay(200);

// ── AC5: Zero exceptions ───────────────────────────────────────────────────

const ac5 = exceptions.length === 0;
results.push({ id: "AC5", desc: "zero JS exceptions", pass: ac5, detail: exceptions.slice(0, 3).join("; ") || "none" });
console.log(`\n[v496] ── AC5: exceptions=${exceptions.length} — ${ac5 ? "PASS" : "FAIL"}`);
if (!ac5) exceptions.forEach(e => console.error(`  ${e}`));

// ── Summary ────────────────────────────────────────────────────────────────

console.log("\n[v496] ═══ Results ═══════════════════════════════════════════");
let allPass = true;
for (const r of results) {
  const mark = r.pass ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${r.id}: ${r.desc} (${r.detail})`);
  if (!r.pass) allPass = false;
}
console.log(`\n[v496] overall: ${allPass ? "PASS" : "FAIL"}`);
ws.close();
process.exit(allPass ? 0 : 1);
