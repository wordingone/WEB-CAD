#!/usr/bin/env node
// verify-224-args-entry.mjs — AC receipt for #224.
//
// Verifies that command-at-cursor args mode executes tools from typed dimensional
// values (imperial strings) with correct geometry dimensions.
// Targets localhost:5175 (serving tree, after autofwd sync from master).
//
// Acceptance criteria (#224):
//   AC1 — circle 5' → mesh created, bounding-box diameter ≈ 3.048 m (2 × 1.524)
//   AC2 — rect 10' × 16' → mesh width ≈ 3.048 m, length ≈ 4.877 m
//   AC3 — wall 20' → mesh x-span ≈ 6.096 m
//   AC4 — Esc in args mode closes overlay without creating geometry
//   AC5 — non-args tool (e.g. select) activates directly, no args prompt

import { WebSocket } from "ws";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { CDP_PORT } from "./ports.mjs";

mkdirSync("state", { recursive: true });
const SHA = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const OUT = `state/verify-224-args-entry-${SHA}-${Date.now()}.json`;

// ── CDP raw WS ──────────────────────────────────────────────────────────────

const targets = JSON.parse(
  execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" })
);
const pageTarget = targets.find(t => t.type === "page" && (t.url ?? "").includes("5175"));
const target = pageTarget ?? targets.find(t => t.type === "page");
if (!target) { console.error("No page target"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
const consoleErrors = [];

await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
ws.on("message", raw => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result ?? {});
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    const text = msg.params.args?.map(a => a.value ?? a.description ?? "").join(" ") ?? "";
    consoleErrors.push(text.slice(0, 200));
  }
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = msgId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "eval error");
  return r.result?.value;
};

const delay = ms => new Promise(r => setTimeout(r, ms));

const poll = async (fn, { timeout = 20_000, interval = 300, label = "?" } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await delay(interval);
  }
  throw new Error(`Timeout: ${label}`);
};

// Send a trusted keydown + keyup to the document
const trustedKey = async (key, opts = {}) => {
  const base = { type: "keyDown", key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0, ...opts };
  await send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await delay(30);
  await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await delay(30);
};

// Type a full string character by character into the focused element
const typeString = async (s) => {
  for (const ch of s) {
    await send("Input.dispatchKeyEvent", { type: "char", text: ch, key: ch,
      windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0) });
    await delay(20);
  }
};

await send("Runtime.enable");
console.log(`[#224] target: ${target.url}`);

// Confirm dispatch ready
await poll(async () => evaluate(`typeof window.__dispatchSync === "function"`),
  { timeout: 20_000, label: "__dispatchSync" });
console.log("[#224] dispatch ready");

// Move pointer to viewport center so unprojectToXY has a valid hit
const vpRect = await evaluate(`
  (() => {
    const c = document.querySelector("#viewer-canvas, .vp-host, canvas");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  })()`);
const VX = vpRect?.x ?? 640;
const VY = vpRect?.y ?? 400;
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: VX, y: VY, button: "none" });
await delay(100);

// Click the viewport to give it focus (so keydown fires on document)
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: VX, y: VY, button: "left", clickCount: 1 });
await delay(30);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: VX, y: VY, button: "left", clickCount: 1 });
await delay(200);

// Helper: count scene objects matching kind
const countKind = (kind) => evaluate(`
  (() => {
    const scene = window.__viewer?.scene;
    if (!scene) return 0;
    return scene.children.filter(c => c.userData?.kind === ${JSON.stringify(kind)}).length;
  })()`);

// Helper: get bounding box of last-added object of given kind
const getBBox = (kind) => evaluate(`
  (() => {
    const THREE = window.__THREE ?? window.THREE;
    const scene = window.__viewer?.scene;
    if (!scene || !THREE) return null;
    const objs = scene.children.filter(c => c.userData?.kind === ${JSON.stringify(kind)});
    if (!objs.length) return null;
    const obj = objs[objs.length - 1];
    try {
      const box = new THREE.Box3().setFromObject(obj);
      const sz = new THREE.Vector3(); box.getSize(sz);
      return { w: +sz.x.toFixed(4), h: +sz.y.toFixed(4), d: +sz.z.toFixed(4) };
    } catch { return null; }
  })()`);

// Clear scene before tests
await evaluate(`
  (() => {
    const s = window.__viewer?.scene;
    if (!s) return;
    s.children.filter(c => c.userData?.kind || c.userData?.creator).forEach(c => s.remove(c));
  })()`).catch(() => {});

const results = {};
const TOLERANCE = 0.05; // 5 cm tolerance for floating-point geometry

// ── AC1: circle 5' → radius 1.524 m ──────────────────────────────────────

console.log("[#224] AC1: circle 5'");

const circlesBefore = await countKind("circle") ?? 0;

// Type "c" to open overlay (first printable char triggers cmd-at-cursor)
await send("Input.dispatchKeyEvent", { type: "char", text: "c", key: "c",
  windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 });
await delay(300);

// Wait for overlay
const overlayOpen = await poll(async () =>
  evaluate(`!!document.querySelector(".cmd-cursor-overlay")`),
  { timeout: 5_000, label: "overlay" });
results.ac1_overlay_open = !!overlayOpen;
console.log(`  overlay open: ${results.ac1_overlay_open}`);

// Select circle: arrow down to circle item, or type more to filter
await typeString("ircle");
await delay(200);

// Press Enter to confirm selection (should open args mode)
await trustedKey("Enter");
await delay(300);

// Check args mode: label "RADIUS:" should be present
const argLabelVisible = await evaluate(`
  (() => {
    const label = document.querySelector(".cmd-cursor-arg-label");
    return label ? label.textContent.trim() : null;
  })()`);
results.ac1_args_label = argLabelVisible;
console.log(`  args label: "${argLabelVisible}"`);

// Type "5'" for radius
await typeString("5'");
await delay(100);
await trustedKey("Enter");
await delay(400);

// Overlay should close
const overlayGone = await evaluate(`!document.querySelector(".cmd-cursor-overlay")`);
results.ac1_overlay_closed = !!overlayGone;

// Circle should be created
const circlesAfter = await countKind("circle") ?? 0;
results.ac1_circle_created = circlesAfter > circlesBefore;
console.log(`  circle created: ${results.ac1_circle_created}  (before=${circlesBefore} after=${circlesAfter})`);

// Check bounding box — diameter should be ≈ 3.048 (2 × 1.524m = 2 × 5ft)
const circleBBox = await getBBox("circle");
const expectedDiameter = 2 * 0.3048 * 5; // 3.048m
results.ac1_bbox = circleBBox;
results.ac1_diameter_ok = circleBBox
  ? Math.abs(circleBBox.w - expectedDiameter) < TOLERANCE &&
    Math.abs(circleBBox.h - expectedDiameter) < TOLERANCE
  : false;
console.log(`  bbox: ${JSON.stringify(circleBBox)}  expected diameter≈${expectedDiameter.toFixed(3)}`);
console.log(`  AC1 diameter ok: ${results.ac1_diameter_ok}`);

// ── AC2: rect 10' × 16' ──────────────────────────────────────────────────

console.log("[#224] AC2: rect 10' × 16'");

// Refocus viewport
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: VX, y: VY, button: "left", clickCount: 1 });
await delay(30);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: VX, y: VY, button: "left", clickCount: 1 });
await delay(200);

const rectsBefore = await countKind("rectangle") ?? 0;

// "r" to open overlay
await send("Input.dispatchKeyEvent", { type: "char", text: "r", key: "r",
  windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82 });
await delay(300);

await typeString("ect");
await delay(200);
await trustedKey("Enter");
await delay(300);

const widthLabel = await evaluate(`
  document.querySelector(".cmd-cursor-arg-label")?.textContent?.trim() ?? null`);
results.ac2_width_label = widthLabel;
console.log(`  width label: "${widthLabel}"`);

// Width: 10'
await typeString("10'");
await trustedKey("Enter");
await delay(200);

const lengthLabel = await evaluate(`
  document.querySelector(".cmd-cursor-arg-label")?.textContent?.trim() ?? null`);
results.ac2_length_label = lengthLabel;
console.log(`  length label: "${lengthLabel}"`);

// Length: 16'
await typeString("16'");
await trustedKey("Enter");
await delay(400);

const rectsAfter = await countKind("rectangle") ?? 0;
results.ac2_rect_created = rectsAfter > rectsBefore;
console.log(`  rect created: ${results.ac2_rect_created}`);

const rectBBox = await getBBox("rectangle");
const expectedW = 10 * 0.3048; // 3.048m
const expectedL = 16 * 0.3048; // 4.877m
results.ac2_bbox = rectBBox;
results.ac2_dims_ok = rectBBox
  ? Math.abs(rectBBox.w - expectedW) < TOLERANCE &&
    Math.abs(rectBBox.h - expectedL) < TOLERANCE
  : false;
console.log(`  bbox: ${JSON.stringify(rectBBox)}  expected w≈${expectedW.toFixed(3)} l≈${expectedL.toFixed(3)}`);
console.log(`  AC2 dims ok: ${results.ac2_dims_ok}`);

// ── AC3: wall 20' ─────────────────────────────────────────────────────────

console.log("[#224] AC3: wall 20'");

await send("Input.dispatchMouseEvent", { type: "mousePressed", x: VX, y: VY, button: "left", clickCount: 1 });
await delay(30);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: VX, y: VY, button: "left", clickCount: 1 });
await delay(200);

const wallsBefore = await countKind("wall") ?? 0;

await send("Input.dispatchKeyEvent", { type: "char", text: "w", key: "w",
  windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
await delay(300);
await typeString("all");
await delay(200);
await trustedKey("Enter");
await delay(300);

const wallLenLabel = await evaluate(`
  document.querySelector(".cmd-cursor-arg-label")?.textContent?.trim() ?? null`);
results.ac3_length_label = wallLenLabel;
console.log(`  length label: "${wallLenLabel}"`);

await typeString("20'");
await trustedKey("Enter");
await delay(400);

const wallsAfter = await countKind("wall") ?? 0;
results.ac3_wall_created = wallsAfter > wallsBefore;
console.log(`  wall created: ${results.ac3_wall_created}`);

const wallBBox = await getBBox("wall");
const expectedWallLen = 20 * 0.3048; // 6.096m
results.ac3_bbox = wallBBox;
results.ac3_length_ok = wallBBox
  ? Math.abs(wallBBox.w - expectedWallLen) < TOLERANCE
  : false;
console.log(`  bbox: ${JSON.stringify(wallBBox)}  expected length≈${expectedWallLen.toFixed(3)}`);
console.log(`  AC3 length ok: ${results.ac3_length_ok}`);

// ── AC4: Esc in args mode closes overlay, no geometry ─────────────────────

console.log("[#224] AC4: Esc during args mode");

await send("Input.dispatchMouseEvent", { type: "mousePressed", x: VX, y: VY, button: "left", clickCount: 1 });
await delay(30);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: VX, y: VY, button: "left", clickCount: 1 });
await delay(200);

const circlesBeforeEsc = await countKind("circle") ?? 0;

await send("Input.dispatchKeyEvent", { type: "char", text: "c", key: "c",
  windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 });
await delay(300);
await typeString("ircle");
await delay(200);
await trustedKey("Enter"); // → args mode
await delay(300);

const inArgsMode = await evaluate(`!!document.querySelector(".cmd-cursor-arg-label")`);
results.ac4_args_mode_reached = !!inArgsMode;

await trustedKey("Escape"); // cancel
await delay(200);

const overlayGoneAC4 = await evaluate(`!document.querySelector(".cmd-cursor-overlay")`);
const circlesAfterEsc = await countKind("circle") ?? 0;
results.ac4_overlay_closed = !!overlayGoneAC4;
results.ac4_no_new_geometry = circlesAfterEsc === circlesBeforeEsc;
console.log(`  args mode reached: ${results.ac4_args_mode_reached}  overlay closed: ${results.ac4_overlay_closed}  no new geometry: ${results.ac4_no_new_geometry}`);

// ── AC5: non-args tool (select) activates without prompt ──────────────────

console.log("[#224] AC5: select → no args prompt");

await send("Input.dispatchMouseEvent", { type: "mousePressed", x: VX, y: VY, button: "left", clickCount: 1 });
await delay(30);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: VX, y: VY, button: "left", clickCount: 1 });
await delay(200);

await send("Input.dispatchKeyEvent", { type: "char", text: "s", key: "s",
  windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 });
await delay(300);
await typeString("elect");
await delay(200);
await trustedKey("Enter");
await delay(300);

const argsShownForSelect = await evaluate(`!!document.querySelector(".cmd-cursor-arg-label")`);
const overlayGoneAC5   = await evaluate(`!document.querySelector(".cmd-cursor-overlay")`);
results.ac5_no_args_prompt = !argsShownForSelect;
results.ac5_overlay_closed = !!overlayGoneAC5;
console.log(`  no args prompt: ${results.ac5_no_args_prompt}  overlay closed: ${results.ac5_overlay_closed}`);

// ── Pass / fail ────────────────────────────────────────────────────────────

const pass =
  results.ac1_circle_created === true &&
  results.ac1_diameter_ok    === true &&
  results.ac2_rect_created   === true &&
  results.ac2_dims_ok        === true &&
  results.ac3_wall_created   === true &&
  results.ac3_length_ok      === true &&
  results.ac4_overlay_closed === true &&
  results.ac4_no_new_geometry === true &&
  results.ac5_no_args_prompt === true;

const receipt = {
  sha: SHA,
  timestamp: new Date().toISOString(),
  url: target.url,
  feature: "#224 command-at-cursor args-entry",
  results,
  console_errors_sample: consoleErrors.slice(0, 10),
  pass,
};

writeFileSync(OUT, JSON.stringify(receipt, null, 2));

console.log("\n── #224 args-entry AC ───────────────────────────────────────────────────");
console.log(`  AC1 circle 5' diameter≈${(2*0.3048*5).toFixed(3)}m:  ${results.ac1_diameter_ok} ${results.ac1_diameter_ok ? "✓" : "✗ FAIL"}`);
console.log(`  AC2 rect 10'×16' dims:              ${results.ac2_dims_ok} ${results.ac2_dims_ok ? "✓" : "✗ FAIL"}`);
console.log(`  AC3 wall 20' length:                ${results.ac3_length_ok} ${results.ac3_length_ok ? "✓" : "✗ FAIL"}`);
console.log(`  AC4 Esc cancels, no geometry:       ${results.ac4_overlay_closed && results.ac4_no_new_geometry} ${results.ac4_overlay_closed && results.ac4_no_new_geometry ? "✓" : "✗ FAIL"}`);
console.log(`  AC5 select: no args prompt:         ${results.ac5_no_args_prompt} ${results.ac5_no_args_prompt ? "✓" : "✗ FAIL"}`);
console.log(`\n  AC result: ${pass ? "PASS ✓" : "FAIL ✗"}`);
console.log(`\nReceipt: ${OUT}`);

ws.close();
if (!pass) process.exit(1);
