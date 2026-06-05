#!/usr/bin/env node
// verify-496-surface-plane-ux.mjs — Deployed-Pages CDP cert for PR #496.
// Leo gate AC:
//   AC1: SURFACE tool activated → surface_pick phase entered
//   AC2: SURFACE hover over rect → noSnap Mesh added as direct scene child
//   AC3: SURFACE click rect → SdSurface dispatched (scene object count increases)
//   AC4: PLANE pt2 mousemove → noSnap Line added as direct scene child
//   AC5: PLANE pt3 mousemove → noSnap Group added as direct scene child
//   AC6: ZERO JS exceptions across the test

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

// Click a palette button — first make its section visible if hidden, then click.
// Palette sections use class 'palette-section--hidden' to collapse content.
const clickPaletteBtn = async (dataTool) => {
  return await evaluate(`(function() {
    const btn = document.querySelector('button[data-tool=${JSON.stringify(dataTool)}]');
    if (!btn) return false;
    // Unhide any ancestor palette-section that's collapsed
    let el = btn.parentElement;
    while (el && el !== document.body) {
      if (el.classList.contains('palette-section--hidden')) {
        el.classList.remove('palette-section--hidden');
      }
      el = el.parentElement;
    }
    btn.click();
    return true;
  })()`);
};
// Generic click-by-selector (for non-palette elements like select btn)
const clickEl = async (selector) => {
  const clicked = await evaluate(`(function() {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  return clicked;
};

// Dispatch pointer events directly to viewport-area-host via evaluate.
// Input.dispatchMouseEvent fires mousemove but not pointermove reliably in this app.
const moveXY = async (x, y) => {
  await evaluate(`(function() {
    const vp = document.getElementById('viewport-area-host') ?? document.querySelector('[id*="viewport"]') ?? document.elementFromPoint(${x}, ${y});
    if (!vp) return;
    vp.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, cancelable:true, clientX:${x}, clientY:${y}, buttons:0, button:-1}));
  })()`);
};
// Clicks via evaluate → pointerdown+pointerup on viewport-area-host.
const clickXY = async (x, y) => {
  await evaluate(`(function() {
    const vp = document.getElementById('viewport-area-host') ?? document.elementFromPoint(${x}, ${y});
    if (!vp) return;
    vp.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, clientX:${x}, clientY:${y}, buttons:1, button:0, isPrimary:true}));
    vp.dispatchEvent(new PointerEvent('pointerup',   {bubbles:true, cancelable:true, clientX:${x}, clientY:${y}, buttons:0, button:0, isPrimary:true}));
    vp.dispatchEvent(new MouseEvent('click',         {bubbles:true, cancelable:true, clientX:${x}, clientY:${y}}));
  })()`);
};

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

// ── Cold-cache load ────────────────────────────────────────────────────────
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

// Wait for shell (__viewer + __dispatchSync)
let shellReady = false;
for (let t = 0; t < 90; t++) {
  await delay(1000);
  const ready = await evaluate(`!!(window.__viewer && window.__dispatchSync)`).catch(() => false);
  if (ready) { shellReady = true; console.log(`[v496] shell ready ~${t+1}s`); break; }
}
if (!shellReady) { console.error("[v496] FAIL: shell timeout"); process.exit(1); }
// Extra settle for palette init (buttons register their click handlers)
await delay(3000);

const results = [];

// ── Helper: count specific preview objects in DIRECT scene children ────────
// opUpdateSurfacePickPreview adds Mesh; opUpdatePlanePreview adds Line (pt2) or Group (pt3).
// All have noSnap=true. Only check DIRECT children to avoid snap dot traversal noise.
const countDirectNoSnapByType = async (type) => evaluate(`(function() {
  const scene = window.__viewer?.getScene?.();
  if (!scene) return 0;
  return scene.children.filter(c => c.userData?.noSnap && c.type === ${JSON.stringify(type)}).length;
})()`);

const sceneDirectTotal = async () => evaluate(`(function() {
  const scene = window.__viewer?.getScene?.();
  if (!scene) return 0;
  return scene.children.length;
})()`);

// Count non-noSnap direct children (the actual geometry objects)
const countGeomChildren = async () => evaluate(`(function() {
  const scene = window.__viewer?.getScene?.();
  if (!scene) return 0;
  return scene.children.filter(c => !c.userData?.noSnap).length;
})()`);

// ── Setup: draw circle at world (0,0), project to screen ──────────────────
// viewer.camera (not getCamera()), viewer.canvas or renderer.domElement for rect.
console.log("\n[v496] ── setup: SdCircle at world(0,0) ──────────────────");
const circleResult = JSON.parse(await evaluate(`
  JSON.stringify(window.__dispatchSync?.("SdCircle", { center: [0, 0], radius: 50 }) ?? null)
`));
console.log(`[v496]   SdCircle: ${JSON.stringify(circleResult)}`);
await delay(300);

// Project world (0,0,0) to screen using manual NDC math (THREE not global).
// viewer.camera and viewer.canvas are the correct property names.
const screenCenter = await evaluate(`(function() {
  const viewer = window.__viewer;
  if (!viewer) return null;
  const cam = viewer.camera;
  const canvas = viewer.canvas ?? viewer.renderer?.domElement ?? document.querySelector('canvas');
  if (!cam || !canvas) return null;
  cam.updateMatrixWorld(true);
  const mwi = cam.matrixWorldInverse.elements; // col-major
  const prj = cam.projectionMatrix.elements;
  // World (0,0,0) → view space
  const vx = mwi[12], vy = mwi[13], vz = mwi[14], pw = mwi[15];
  // View → clip
  const cx_ = prj[0]*vx + prj[4]*vy + prj[8]*vz  + prj[12]*pw;
  const cy_ = prj[1]*vx + prj[5]*vy + prj[9]*vz  + prj[13]*pw;
  const cw  = prj[3]*vx + prj[7]*vy + prj[11]*vz + prj[15]*pw;
  const ndcX = cx_ / cw, ndcY = cy_ / cw;
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.round((ndcX + 1) / 2 * rect.width  + rect.left),
    y: Math.round((-ndcY + 1) / 2 * rect.height + rect.top),
    canvasLeft: Math.round(rect.left), canvasTop: Math.round(rect.top),
    canvasW: Math.round(rect.width), canvasH: Math.round(rect.height),
  };
})()`);
console.log(`[v496] world(0,0) → screen: ${JSON.stringify(screenCenter)}`);

// Use projected world origin as hover/click target; fall back to canvas center.
const canvasCx = (screenCenter?.canvasLeft ?? 82) + (screenCenter?.canvasW ?? 1297) / 2;
const canvasCy = (screenCenter?.canvasTop ?? 146) + (screenCenter?.canvasH ?? 826) / 2;
const cx = screenCenter?.x ?? Math.round(canvasCx);
const cy = screenCenter?.y ?? Math.round(canvasCy);
console.log(`[v496]   hover target: (${cx}, ${cy})`);

// Verify the circle appeared — count non-noSnap direct children before tests
const geomBefore = await countGeomChildren();
console.log(`[v496]   non-noSnap direct children after circle: ${geomBefore}`);

// ── AC1: SURFACE tool activated → surface_pick phase entered ───────────────
console.log("\n[v496] ── AC1: SURFACE tool activation ───────────────────");
// Unhide the palette section then click the surface button
const surfaceClicked = await clickPaletteBtn("surface");
console.log(`[v496]   button clicked: ${surfaceClicked}`);
await delay(500);

// Verify: the active tool button should now be "surface"
const activeTool = await evaluate(`document.querySelector('button.palette-btn.active')?.dataset?.tool ?? "none"`);
console.log(`[v496]   active tool btn: ${activeTool}`);

// Check prompt text for phase indicator
const phaseText = await evaluate(`document.querySelector('[id*="prompt"],[class*="prompt"],[class*="pt-prompt"]')?.textContent?.trim() ?? ""`);
console.log(`[v496]   phase prompt text: "${phaseText}"`);

await screenshot("ac1-surface-activated");
const ac1 = surfaceClicked && activeTool === "surface";
results.push({ id: "AC1", desc: "SURFACE tool activated (active btn = surface)", pass: ac1, detail: `activeTool=${activeTool}` });
console.log(`[v496]   AC1: ${ac1 ? "PASS" : "FAIL"}`);

// ── AC2: SURFACE hover over circle → noSnap Mesh added ────────────────────
console.log("\n[v496] ── AC2: SURFACE hover preview ────────────────────");
const preHoverMesh = await countDirectNoSnapByType("Mesh");
console.log(`[v496]   noSnap Mesh (direct) before hover: ${preHoverMesh}`);
// Move mouse to world(0,0) screen position (center of circle)
await moveXY(cx, cy);
await delay(400);
const postHoverMesh = await countDirectNoSnapByType("Mesh");
console.log(`[v496]   noSnap Mesh (direct) after hover: ${postHoverMesh}`);
await screenshot("ac2-surface-hover");

const ac2 = postHoverMesh > preHoverMesh;
results.push({ id: "AC2", desc: "surface hover → noSnap Mesh preview added", pass: ac2, detail: `mesh delta: ${postHoverMesh - preHoverMesh}` });
console.log(`[v496]   AC2: ${ac2 ? "PASS" : "FAIL"}`);

// ── AC3: SURFACE click → geometry dispatched ──────────────────────────────
console.log("\n[v496] ── AC3: SURFACE click → dispatch ──────────────────");
const geomBeforeClick = await countGeomChildren();
await clickXY(cx, cy);
await delay(600);
const geomAfterClick = await countGeomChildren();
console.log(`[v496]   non-noSnap direct children: before=${geomBeforeClick} after=${geomAfterClick}`);
await screenshot("ac3-surface-click");

const ac3 = geomAfterClick > geomBeforeClick;
results.push({ id: "AC3", desc: "surface click → geometry added to scene", pass: ac3, detail: `delta=${geomAfterClick - geomBeforeClick}` });
console.log(`[v496]   AC3: ${ac3 ? "PASS" : "FAIL"}`);

// ── AC4: PLANE pt2 mousemove → noSnap Line preview ────────────────────────
console.log("\n[v496] ── AC4: PLANE pt2 preview ────────────────────────");

// Reset to select, then activate plane
await clickEl('button[data-tool="select"]');
await delay(300);
const planeClicked = await clickPaletteBtn("plane");
console.log(`[v496]   plane button clicked: ${planeClicked}`);
await delay(500);

// Click pt1 at offset from center (use Input.dispatchMouseEvent for positioned click)
const pt1x = cx - 120, pt1y = cy + 80;
await clickXY(pt1x, pt1y);
await delay(400);

// Now in plane_pt2: move to a different position, expect a Line preview
const prePt2Line = await countDirectNoSnapByType("Line");
await moveXY(pt1x + 180, pt1y);
await delay(400);
const postPt2Line = await countDirectNoSnapByType("Line");
console.log(`[v496]   plane_pt2 noSnap Line: before=${prePt2Line} after=${postPt2Line}`);
await screenshot("ac4-plane-pt2");

const ac4 = postPt2Line > prePt2Line;
results.push({ id: "AC4", desc: "plane pt2 mousemove → noSnap Line preview", pass: ac4, detail: `line delta: ${postPt2Line - prePt2Line}` });
console.log(`[v496]   AC4: ${ac4 ? "PASS" : "FAIL"}`);

// ── AC5: PLANE pt3 mousemove → noSnap Group preview ───────────────────────
console.log("\n[v496] ── AC5: PLANE pt3 preview ────────────────────────");

// Click pt2 to advance to pt3
await clickXY(pt1x + 180, pt1y);
await delay(400);

// Now in plane_pt3: move, expect a Group (outline+fill) preview
const prePt3Group = await countDirectNoSnapByType("Group");
await moveXY(pt1x + 180, pt1y - 120);
await delay(400);
const postPt3Group = await countDirectNoSnapByType("Group");
console.log(`[v496]   plane_pt3 noSnap Group: before=${prePt3Group} after=${postPt3Group}`);
await screenshot("ac5-plane-pt3");

const ac5 = postPt3Group > prePt3Group;
results.push({ id: "AC5", desc: "plane pt3 mousemove → noSnap Group preview", pass: ac5, detail: `group delta: ${postPt3Group - prePt3Group}` });
console.log(`[v496]   AC5: ${ac5 ? "PASS" : "FAIL"}`);

// Cancel
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", keyCode: 27 });
await delay(200);

// ── AC6: Zero exceptions ───────────────────────────────────────────────────
const ac6 = exceptions.length === 0;
results.push({ id: "AC6", desc: "zero JS exceptions", pass: ac6, detail: exceptions.slice(0, 3).join("; ") || "none" });
console.log(`\n[v496] ── AC6: exceptions=${exceptions.length} — ${ac6 ? "PASS" : "FAIL"}`);
if (!ac6) exceptions.forEach(e => console.error(`  ${e}`));

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
