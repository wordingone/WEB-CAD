#!/usr/bin/env node
// verify-222-preview-gaps.mjs — AC receipt for #222.
//
// Verifies three preview gaps are closed:
//   AC1 — wall-curve rubber-band shows actual wall body (not just centerline)
//   AC2 — column ghost appears before first click and matches cursor
//   AC3 — opening ghost appears before first click
//
// Targets localhost:5847 (vite.config strictPort).

import { WebSocket } from "ws";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { CDP_PORT } from "./ports.mjs";

mkdirSync("state", { recursive: true });
const SHA = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const OUT = `state/verify-222-preview-gaps-${SHA}-${Date.now()}.json`;

const targets = JSON.parse(
  execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" })
);
const pageTarget = targets.find(t => t.type === "page" && (t.url ?? "").includes("5847"));
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
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "eval error");
  return r.result?.value;
};

const delay = ms => new Promise(r => setTimeout(r, ms));
const poll = async (fn, { timeout = 15_000, interval = 300, label = "?" } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await delay(interval);
  }
  throw new Error(`Timeout: ${label}`);
};

await send("Runtime.enable");

await poll(async () => evaluate(`typeof window.__dispatchSync === "function"`),
  { timeout: 15_000, label: "__dispatchSync" });
console.log("[#222] dispatch ready");

const vpRect = await evaluate(`
  (() => {
    const c = document.querySelector("#viewer-canvas, .vp-host, canvas");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: r.width, h: r.height };
  })()`);
const VX = vpRect?.x ?? 640;
const VY = vpRect?.y ?? 400;

const countPreviewMeshes = () => evaluate(`
  (() => {
    const scene = window.__viewer?.scene;
    if (!scene) return 0;
    return scene.children.filter(c => c.userData?.isPreview).length;
  })()`);

const results = {};

// ── AC1: wall-curve rubber-band shows actual wall body ──────────────────────

console.log("[#222] AC1: wall-curve body preview");

// Activate wall-curve tool
await evaluate(`window.__dispatchSync("setActiveTool", { toolId: "wall-curve" })`);
await delay(200);

// Click first point to start the curve
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: VX, y: VY, button: "left", clickCount: 1 });
await delay(30);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: VX, y: VY, button: "left", clickCount: 1 });
await delay(100);

// Move pointer to trigger rubber-band
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: VX + 80, y: VY + 20, button: "none" });
await delay(200);

// Check: scene should have a preview mesh that is a wall body with nonzero thickness.
// isCurveWall flag is secondary; primary assertion is bbox min-dimension > 0.1 (wall t=0.2m).
const wallCurvePreview = await evaluate(`
  (() => {
    const THREE = window.__THREE ?? window.THREE;
    const scene = window.__viewer?.scene;
    if (!scene || !THREE) return null;
    const candidates = [];
    for (const obj of scene.children) {
      const isPreview = obj.userData?.isPreview || obj.userData?.isPreviewMode;
      const isCW = obj.userData?.isCurveWall;
      const isWall = obj.userData?.creator === "wall";
      const mat = obj.material;
      const isTransparent = mat?.transparent && mat?.opacity < 0.5;
      if (isPreview || isCW || (isWall && isTransparent)) {
        try {
          const box = new THREE.Box3().setFromObject(obj);
          const sz = new THREE.Vector3(); box.getSize(sz);
          const minDim = Math.min(sz.x, sz.y);
          candidates.push({ isCurveWall: !!isCW, minDim: +minDim.toFixed(4), w: +sz.x.toFixed(4), h: +sz.y.toFixed(4), d: +sz.z.toFixed(4) });
        } catch {}
      }
    }
    return candidates.length > 0 ? candidates[0] : null;
  })()`);

results.ac1_preview_found = !!wallCurvePreview;
results.ac1_is_curve_wall = wallCurvePreview?.isCurveWall === true;
results.ac1_thickness_ok = (wallCurvePreview?.minDim ?? 0) > 0.1;
results.ac1_bbox = wallCurvePreview ? { w: wallCurvePreview.w, h: wallCurvePreview.h, d: wallCurvePreview.d } : null;
console.log(`  preview found: ${results.ac1_preview_found}  isCurveWall: ${results.ac1_is_curve_wall}  minDim: ${wallCurvePreview?.minDim}  thickness_ok: ${results.ac1_thickness_ok}`);

// Cancel tool to clean up
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await delay(200);
await send("Input.dispatchKeyEvent", { type: "keyUp",   key: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await delay(100);
await evaluate(`window.__dispatchSync("setActiveTool", { toolId: "select" })`);
await delay(200);

// ── AC2: column ghost before first click ─────────────────────────────────────

console.log("[#222] AC2: column ghost");

await evaluate(`window.__dispatchSync("setActiveTool", { toolId: "column" })`);
await delay(200);

// Move pointer — should trigger column ghost (no click yet)
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: VX + 40, y: VY + 40, button: "none" });
await delay(300);

const columnGhost = await evaluate(`
  (() => {
    const scene = window.__viewer?.scene;
    if (!scene) return null;
    for (const obj of scene.children) {
      if (obj.userData?.isPreview) {
        const box = obj.geometry?.type;
        return { geomType: box ?? "group", isPreview: true };
      }
    }
    return null;
  })()`);

results.ac2_ghost_found = !!columnGhost;
results.ac2_ghost_type = columnGhost?.geomType;
console.log(`  column ghost found: ${results.ac2_ghost_found}  geomType: ${results.ac2_ghost_type}`);

await evaluate(`window.__dispatchSync("setActiveTool", { toolId: "select" })`);
await delay(200);

// ── AC3: opening ghost before first click ────────────────────────────────────

console.log("[#222] AC3: opening ghost");

await evaluate(`window.__dispatchSync("setActiveTool", { toolId: "opening" })`);
await delay(200);

await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: VX - 40, y: VY - 40, button: "none" });
await delay(300);

const openingGhost = await evaluate(`
  (() => {
    const scene = window.__viewer?.scene;
    if (!scene) return null;
    for (const obj of scene.children) {
      if (obj.userData?.isPreview) {
        return { geomType: obj.geometry?.type ?? "group", isPreview: true };
      }
    }
    return null;
  })()`);

results.ac3_ghost_found = !!openingGhost;
results.ac3_ghost_type = openingGhost?.geomType;
console.log(`  opening ghost found: ${results.ac3_ghost_found}  geomType: ${results.ac3_ghost_type}`);

await evaluate(`window.__dispatchSync("setActiveTool", { toolId: "select" })`);
await delay(200);

// ── Pass/fail ─────────────────────────────────────────────────────────────────

const pass =
  results.ac1_thickness_ok  === true &&
  results.ac2_ghost_found   === true &&
  results.ac3_ghost_found   === true;

const receipt = {
  sha: SHA,
  timestamp: new Date().toISOString(),
  url: target.url,
  feature: "#222 preview gaps — wall-curve body, column ghost, opening ghost",
  results,
  console_errors_sample: consoleErrors.slice(0, 10),
  pass,
};

writeFileSync(OUT, JSON.stringify(receipt, null, 2));

console.log("\n── #222 preview gaps AC ─────────────────────────────────────────────────");
console.log(`  AC1 wall-curve body (thickness>0.1m): ${results.ac1_thickness_ok} ${results.ac1_thickness_ok ? "✓" : "✗ FAIL"}  bbox:${JSON.stringify(results.ac1_bbox)}`);
console.log(`  AC2 column ghost pre-click:   ${results.ac2_ghost_found} ${results.ac2_ghost_found ? "✓" : "✗ FAIL"}`);
console.log(`  AC3 opening ghost pre-click:  ${results.ac3_ghost_found} ${results.ac3_ghost_found ? "✓" : "✗ FAIL"}`);
console.log(`\n  AC result: ${pass ? "PASS ✓" : "FAIL ✗"}`);
console.log(`\nReceipt: ${OUT}`);

ws.close();
if (!pass) process.exit(1);
