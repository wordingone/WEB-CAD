#!/usr/bin/env node
// verify-496-v3.mjs — #496 re-cert, Leo gate #12965/#12969 requirements:
//   (a) APP-READY: deterministic window.__APP_READY__ signal (not timeout)
//   (b) VISIBLE-RENDER: before/after JPEG diff on canvas — actual pixel change
//   (c) SCREENSHOTS: taken after render settle, must visibly show each preview
//   (d) OBJECT-DELTA: noSnap object count per AC
//
// ACs:
//   AC1: SURFACE mode → active-tool=surface (no frameDelta: renderer.info.render.frame
//        resets to 0 then increments to 1 on every render call via autoReset=true)
//   AC2: hover circle → noSnap Mesh + canvas diff > 15 changed pixels
//   AC3: click circle → surface geometry added + canvas diff > 15px (Leo #12980)
//   AC4: plane pt2 → noSnap Line + canvas diff > 15 changed pixels
//   AC5: plane pt3 → noSnap Group + canvas diff > 15 changed pixels
//   AC6: zero JS exceptions
//
// Circle radius=4 (not 50). At r=50, all 32 boundary vertices have
// camera-space z = 0.577*(vx+vy−8) > 0 (behind camera at pos(8,8,8));
// WebGL clips all ShapeGeometry triangles → fill renders 0 pixels.
// At r=4, max(vx+vy)=5.66 < 8 → all vertices in front of camera.

import { WebSocket }               from "ws";
import { mkdirSync, writeFileSync } from "fs";
import { execSync }                 from "child_process";
import { fileURLToPath }            from "url";

const CDP_PORT  = 9222;
const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const RUN_TS    = Date.now();
const OUT_DIR   = fileURLToPath(new URL(`../state/verify-496-v3-${RUN_TS}`, import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

const targets = JSON.parse(execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" }));
const target  = targets.find(t => t.type === "page" && !t.url.startsWith("devtools://"));
if (!target) { console.error("No page tab at :9222"); process.exit(1); }
console.log(`[v496v3] tab: ${target.url}`);

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
const delay = ms => new Promise(r => setTimeout(r, ms));

// Screenshot → PNG file
const screenshot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const path = `${OUT_DIR}/${name}.png`;
  writeFileSync(path, Buffer.from(r.data, "base64"));
  console.log(`[v496v3]   shot → ${path}`);
  return r.data;
};

// ── Before/after canvas diff ───────────────────────────────────────────────────
// Captures canvas region at half-res JPEG, returns base64.
// Two captures compared in-browser: counts pixels with total RGB change > 20.
let _canvasClip = null;
const captureCanvasJpeg = async () => {
  if (!_canvasClip) {
    _canvasClip = await evaluate(`(function() {
      const c = document.querySelector('#viewer-canvas') ?? document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    })()`);
  }
  if (!_canvasClip) throw new Error("canvas element not found");
  const clip = { ..._canvasClip, scale: 0.5 };
  const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 75, clip });
  return data;
};

const diffCanvasJpeg = (b64Before, b64After) => evaluate(`(async function() {
  try {
    const decode = async b64 => {
      const img = new Image();
      await new Promise((r,j) => { img.onload=r; img.onerror=j; img.src="data:image/jpeg;base64,"+b64; });
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      cv.getContext('2d').drawImage(img, 0, 0);
      return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    };
    const [d1, d2] = await Promise.all([decode(${JSON.stringify(b64Before)}), decode(${JSON.stringify(b64After)})]);
    let changed = 0, blueGain = 0;
    for (let i = 0; i < d1.length; i += 4) {
      const dr = Math.abs(d2[i]-d1[i]), dg = Math.abs(d2[i+1]-d1[i+1]), db = Math.abs(d2[i+2]-d1[i+2]);
      if (dr + dg + db > 20) changed++;
      if (d2[i+2] - d1[i+2] > 15) blueGain++;
    }
    return { changed, blueGain, total: d1.length/4, hasDiff: changed > 15 };
  } catch(e) { return { error: e.message }; }
})()`, true);

// ── Scene helpers ──────────────────────────────────────────────────────────────
// Note: renderer.info.render.frame is NOT used for activity checks — it resets
// to 0 then increments to 1 on every render call (autoReset=true in THREE.js).
const getFrame = () => evaluate(`(window.__viewer?.renderer?.info?.render?.frame ?? 0)`).catch(() => 0);

const countNoSnapByType = type => evaluate(`(function() {
  const s = window.__viewer?.getScene?.();
  if (!s) return 0;
  return s.children.filter(c => c.userData?.noSnap && c.type === ${JSON.stringify(type)}).length;
})()`);

const countGeomChildren = () => evaluate(`(function() {
  const s = window.__viewer?.getScene?.();
  if (!s) return 0;
  return s.children.filter(c => !c.userData?.noSnap).length;
})()`);

// Palette button — removes palette-section--hidden from ancestors
const clickPaletteBtn = dataTool => evaluate(`(function() {
  const btn = document.querySelector('button[data-tool=${JSON.stringify(dataTool)}]');
  if (!btn) return false;
  let el = btn.parentElement;
  while (el && el !== document.body) {
    if (el.classList.contains('palette-section--hidden')) el.classList.remove('palette-section--hidden');
    el = el.parentElement;
  }
  btn.click();
  return true;
})()`);

// Pointer events — Input.dispatchMouseEvent does not fire pointermove on viewport
const moveXY = (x, y) => evaluate(`(function() {
  const vp = document.getElementById('viewport-area-host') ?? document.elementFromPoint(${x}, ${y});
  if (!vp) return;
  vp.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, cancelable:true, clientX:${x}, clientY:${y}, buttons:0, button:-1}));
})()`);

const clickXY = (x, y) => evaluate(`(function() {
  const vp = document.getElementById('viewport-area-host') ?? document.elementFromPoint(${x}, ${y});
  if (!vp) return;
  vp.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, clientX:${x}, clientY:${y}, buttons:1, button:0, isPrimary:true}));
  vp.dispatchEvent(new PointerEvent('pointerup',   {bubbles:true, cancelable:true, clientX:${x}, clientY:${y}, buttons:0, button:0, isPrimary:true}));
  vp.dispatchEvent(new MouseEvent('click',         {bubbles:true, cancelable:true, clientX:${x}, clientY:${y}}));
})()`);

// ── Init CDP ───────────────────────────────────────────────────────────────────
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

const exceptions = [];
onEvent("Runtime.exceptionThrown", p => {
  const desc = p.exceptionDetails?.exception?.description ?? "";
  if (!desc.includes("AbortError") && !desc.includes("NetworkError") && !desc.includes("Failed to fetch")) {
    exceptions.push(desc);
  }
});

// ── Cold-cache reload ──────────────────────────────────────────────────────────
console.log("[v496v3] cold-cache reload...");
await send("Network.clearBrowserCache");
await send("Storage.clearDataForOrigin", { origin: "https://wordingone.github.io", storageTypes: "all" });
await evaluate(`(async () => {
  const rs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
  await Promise.all(rs.map(r => r.unregister()));
})()`, true).catch(() => {});

const lp = new Promise(res => onEvent("Page.loadEventFired", res));
await send("Page.reload", { ignoreCache: true });
await lp;

// ── APP-READY — deterministic signal (window.__APP_READY__) ───────────────────
// window.__APP_READY__ is set by main.ts after all sync init + first rAF.
// This means viewer, dispatch, palette, and renderer are all live.
// Fires within ~1 second of page load — NO model download dependency.
// Falls back to shell+frame check for app versions predating the signal.
console.log("[v496v3] awaiting __APP_READY__...");
let appReady = false;
let readyMethod = "";
for (let t = 0; t < 600; t++) {
  await delay(1000);
  const ar = await evaluate(`window.__APP_READY__ === true`).catch(() => false);
  if (ar) { appReady = true; readyMethod = "__APP_READY__"; console.log(`[v496v3] __APP_READY__ at ~${t+1}s`); break; }
  // Fallback: pre-signal app versions (viewer + dispatch + frame > 0)
  if (t >= 5) {
    const shell = await evaluate(`!!(window.__viewer && window.__dispatchSync)`).catch(() => false);
    const frame = await getFrame();
    if (shell && frame > 0) {
      readyMethod = "shell+frame (pre-signal fallback)";
      appReady = true;
      console.log(`[v496v3] app-ready via fallback at ~${t+1}s (frame=${frame}); deploy __APP_READY__ for deterministic`);
      await delay(2000);
      break;
    }
  }
}
if (!appReady) { console.error("[v496v3] FAIL: app-ready timeout (600s)"); ws.close(); process.exit(1); }

// ── Canvas layout ──────────────────────────────────────────────────────────────
const canvasInfo = await evaluate(`(function() {
  const viewer = window.__viewer;
  if (!viewer) return null;
  const canvas = document.querySelector('#viewer-canvas') ?? document.querySelector('canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  // Project world origin to screen via __projectToScreen
  const ws = window.__projectToScreen?.(0, 0, 0);
  return {
    screenOriginX: ws ? Math.round(ws.x) : Math.round(rect.left + rect.width/2),
    screenOriginY: ws ? Math.round(ws.y) : Math.round(rect.top + rect.height/2),
    canvasCenterX: Math.round(rect.left + rect.width/2),
    canvasCenterY: Math.round(rect.top + rect.height/2),
    canvasLeft: Math.round(rect.left), canvasTop: Math.round(rect.top),
    canvasW: Math.round(rect.width),   canvasH: Math.round(rect.height),
    hasProjectFn: !!window.__projectToScreen,
  };
})()`);
console.log(`[v496v3] canvas info: ${JSON.stringify(canvasInfo)}`);

// Interaction target: world origin projected to screen, or canvas center as fallback
const cx = canvasInfo?.screenOriginX ?? 730;
const cy = canvasInfo?.screenOriginY ?? 560;
console.log(`[v496v3] interaction target: (${cx}, ${cy})`);

await screenshot("00-app-ready");

// ── Setup: draw test circle ────────────────────────────────────────────────────
// radius=4: all boundary vertices project to camera-space z<0 (in front)
console.log("\n[v496v3] setup: SdCircle at world(0,0) radius=4...");
const circleResult = await evaluate(`JSON.stringify(window.__dispatchSync?.("SdCircle", {center:[0,0], radius:4}) ?? null)`);
console.log(`[v496v3]   SdCircle result: ${circleResult}`);
await delay(400);

const geomAfterCircle = await countGeomChildren();
console.log(`[v496v3]   scene geom after circle: ${geomAfterCircle}`);
if (geomAfterCircle === 0) {
  console.error("[v496v3] FAIL: SdCircle produced no scene object");
}

// Diagnostic: where does world(0,0) project to screen? Confirm fill region.
const projOrigin = await evaluate(`(function() {
  const p = window.__projectToScreen?.(0, 0, 0);
  const p50 = window.__projectToScreen?.(50, 0, 0);
  return { origin: p, edge50: p50 };
})()`);
console.log(`[v496v3]   world(0,0)→screen: ${JSON.stringify(projOrigin?.origin)}, world(50,0)→screen: ${JSON.stringify(projOrigin?.edge50)}`);

await screenshot("01-circle-drawn");

const results = [];

// ── AC1: SURFACE tool activation ───────────────────────────────────────────────
console.log("\n[v496v3] ── AC1: SURFACE activation ───────────────────────");
const surfaceClicked = await clickPaletteBtn("surface");
await delay(600);
const activeTool = await evaluate(`document.querySelector('button.palette-btn.active')?.dataset?.tool ?? "none"`).catch(() => "none");
console.log(`[v496v3]   clicked=${surfaceClicked} activeTool=${activeTool}`);
await screenshot("ac1-surface-activated");

const ac1 = surfaceClicked && activeTool === "surface";
results.push({ id: "AC1", desc: "SURFACE mode entered", pass: ac1,
  detail: `clicked=${surfaceClicked} activeTool=${activeTool}` });
console.log(`[v496v3]   AC1: ${ac1 ? "PASS" : "FAIL"}`);

// ── AC2: SURFACE hover → fill preview ─────────────────────────────────────────
console.log("\n[v496v3] ── AC2: SURFACE hover preview ────────────────────");
const preMesh2  = await countNoSnapByType("Mesh");
const b64Before2 = await captureCanvasJpeg();          // before hover

await moveXY(cx, cy);
await delay(600);

const postMesh2   = await countNoSnapByType("Mesh");
const b64After2   = await captureCanvasJpeg();         // after hover + settle
const diff2       = await diffCanvasJpeg(b64Before2, b64After2);
console.log(`[v496v3]   noSnap Mesh: ${preMesh2}→${postMesh2}`);
console.log(`[v496v3]   canvas diff: ${JSON.stringify(diff2)}`);
await screenshot("ac2-surface-hover");

// Diagnostic: mesh info if fill not visible
if (!diff2?.hasDiff) {
  const meshInfo = await evaluate(`(function() {
    const s = window.__viewer?.getScene?.();
    if (!s) return null;
    const m = s.children.find(c => c.userData?.noSnap && c.type === 'Mesh');
    if (!m) return null;
    const pos = m.geometry?.getAttribute('position');
    const first3 = pos ? [[pos.getX(0),pos.getY(0),pos.getZ(0)],[pos.getX(1),pos.getY(1),pos.getZ(1)],[pos.getX(2),pos.getY(2),pos.getZ(2)]] : null;
    return {
      type: m.type, renderOrder: m.renderOrder, visible: m.visible,
      matOpacity: m.material?.opacity, matTransparent: m.material?.transparent,
      matColor: m.material?.color?.getHexString?.(),
      meshPosZ: m.position.z, vertCount: pos?.count,
      first3verts: first3,
    };
  })()`);
  console.log(`[v496v3]   DIAG fill mesh: ${JSON.stringify(meshInfo)}`);
  // Project first vertex to screen
  if (meshInfo?.first3verts?.[0]) {
    const [vx,vy,vz] = meshInfo.first3verts[0];
    const sp = await evaluate(`window.__projectToScreen?.(${vx},${vy},${vz})`);
    console.log(`[v496v3]   DIAG first vert world(${vx},${vy},${vz}) → screen ${JSON.stringify(sp)}`);
  }
}

const ac2_meshAdded = postMesh2 > preMesh2;
const ac2_visible   = diff2?.hasDiff ?? false;
const ac2 = ac2_meshAdded && ac2_visible;
results.push({ id: "AC2", desc: "surface hover → fill preview (noSnap Mesh + canvas diff > 15px)",
  pass: ac2,
  detail: `meshDelta=${postMesh2-preMesh2} diffChanged=${diff2?.changed ?? "?"} blueGain=${diff2?.blueGain ?? "?"} hasDiff=${ac2_visible}` });
console.log(`[v496v3]   AC2: ${ac2 ? "PASS" : "FAIL"} (meshAdded=${ac2_meshAdded} visible=${ac2_visible})`);

// ── AC3: SURFACE click → geometry + visible render ────────────────────────────
// Leo #12980: committed surface must show non-zero render-diff (not just scene-graph +1).
// CW-wound commit produces 0 triangles → mesh present but invisible.
console.log("\n[v496v3] ── AC3: SURFACE click ────────────────────────────");
const geomPre3 = await countGeomChildren();
const b64Before3 = await captureCanvasJpeg();    // before commit click

await clickXY(cx, cy);
await delay(700);

const geomPost3  = await countGeomChildren();
const b64After3  = await captureCanvasJpeg();    // after committed surface added
const diff3      = await diffCanvasJpeg(b64Before3, b64After3);
console.log(`[v496v3]   geom: ${geomPre3}→${geomPost3}`);
console.log(`[v496v3]   canvas diff: ${JSON.stringify(diff3)}`);
await screenshot("ac3-surface-click");

// Diagnostic if committed surface invisible
if (!(diff3?.hasDiff)) {
  const meshInfo3 = await evaluate(`(function() {
    const s = window.__viewer?.getScene?.();
    if (!s) return null;
    const m = s.children.filter(c => !c.userData?.noSnap && c.userData?.kind === 'surface').slice(-1)[0];
    if (!m) return null;
    const pos = m.geometry?.getAttribute('position');
    const first3 = pos ? [[pos.getX(0),pos.getY(0),pos.getZ(0)],[pos.getX(1),pos.getY(1),pos.getZ(1)],[pos.getX(2),pos.getY(2),pos.getZ(2)]] : null;
    return { vertCount: pos?.count, first3verts: first3, visible: m.visible,
             matOpacity: m.material?.opacity, matSide: m.material?.side };
  })()`);
  console.log(`[v496v3]   DIAG committed surface: ${JSON.stringify(meshInfo3)}`);
}

const ac3_geomAdded = geomPost3 > geomPre3;
const ac3_visible   = diff3?.hasDiff ?? false;
const ac3 = ac3_geomAdded && ac3_visible;
results.push({ id: "AC3", desc: "surface click → geometry added + visible render",
  pass: ac3,
  detail: `geomDelta=${geomPost3-geomPre3} diffChanged=${diff3?.changed ?? "?"} hasDiff=${ac3_visible}` });
console.log(`[v496v3]   AC3: ${ac3 ? "PASS" : "FAIL"} (geomAdded=${ac3_geomAdded} visible=${ac3_visible})`);

// ── AC4: PLANE pt2 line preview ────────────────────────────────────────────────
console.log("\n[v496v3] ── AC4: PLANE pt2 preview ────────────────────────");
await evaluate(`(function() { const btn = document.querySelector('button[data-tool="select"]'); if (btn) btn.click(); })()`);
await delay(300);
await clickPaletteBtn("plane");
await delay(500);

const pt1x = cx - 120, pt1y = cy + 80;
await clickXY(pt1x, pt1y);
await delay(400);

const pt2x = pt1x + 200, pt2y = pt1y;
const preLine4   = await countNoSnapByType("Line");
const b64Before4 = await captureCanvasJpeg();

await moveXY(pt2x, pt2y);
await delay(600);

const postLine4   = await countNoSnapByType("Line");
const b64After4   = await captureCanvasJpeg();
const diff4       = await diffCanvasJpeg(b64Before4, b64After4);
console.log(`[v496v3]   noSnap Line: ${preLine4}→${postLine4}`);
console.log(`[v496v3]   canvas diff: ${JSON.stringify(diff4)}`);
await screenshot("ac4-plane-pt2");

const ac4_lineAdded = postLine4 > preLine4;
const ac4_visible   = diff4?.hasDiff ?? false;
const ac4 = ac4_lineAdded && ac4_visible;
results.push({ id: "AC4", desc: "plane pt2 → line preview (noSnap Line + canvas diff > 15px)",
  pass: ac4,
  detail: `lineDelta=${postLine4-preLine4} diffChanged=${diff4?.changed ?? "?"} hasDiff=${ac4_visible}` });
console.log(`[v496v3]   AC4: ${ac4 ? "PASS" : "FAIL"} (lineAdded=${ac4_lineAdded} visible=${ac4_visible})`);

// ── AC5: PLANE pt3 parallelogram preview ───────────────────────────────────────
console.log("\n[v496v3] ── AC5: PLANE pt3 preview ────────────────────────");
await clickXY(pt2x, pt2y);
await delay(400);

const pt3x = pt2x, pt3y = pt2y - 150;
const preGroup5   = await countNoSnapByType("Group");
const b64Before5  = await captureCanvasJpeg();

await moveXY(pt3x, pt3y);
await delay(600);

const postGroup5  = await countNoSnapByType("Group");
const b64After5   = await captureCanvasJpeg();
const diff5       = await diffCanvasJpeg(b64Before5, b64After5);
console.log(`[v496v3]   noSnap Group: ${preGroup5}→${postGroup5}`);
console.log(`[v496v3]   canvas diff: ${JSON.stringify(diff5)}`);
await screenshot("ac5-plane-pt3");

const ac5_groupAdded = postGroup5 > preGroup5;
const ac5_visible    = diff5?.hasDiff ?? false;
const ac5 = ac5_groupAdded && ac5_visible;
results.push({ id: "AC5", desc: "plane pt3 → parallelogram preview (noSnap Group + canvas diff > 15px)",
  pass: ac5,
  detail: `groupDelta=${postGroup5-preGroup5} diffChanged=${diff5?.changed ?? "?"} hasDiff=${ac5_visible}` });
console.log(`[v496v3]   AC5: ${ac5 ? "PASS" : "FAIL"} (groupAdded=${ac5_groupAdded} visible=${ac5_visible})`);

await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", keyCode: 27 });
await delay(200);

// ── AC6: zero JS exceptions ────────────────────────────────────────────────────
const ac6 = exceptions.length === 0;
results.push({ id: "AC6", desc: "zero JS exceptions", pass: ac6,
  detail: exceptions.slice(0, 3).join("; ") || "none" });
console.log(`\n[v496v3] ── AC6: exceptions=${exceptions.length} — ${ac6 ? "PASS" : "FAIL"}`);
if (!ac6) exceptions.forEach(e => console.error(`  ${e}`));

// ── Summary + cert ─────────────────────────────────────────────────────────────
console.log("\n[v496v3] ═══ Results ═══════════════════════════════════════════");
let allPass = true;
for (const r of results) {
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.id}: ${r.desc} (${r.detail})`);
  if (!r.pass) allPass = false;
}

const certPath = `${OUT_DIR}/cert-496-v3.json`;
writeFileSync(certPath, JSON.stringify({
  script: "verify-496-v3.mjs",
  pages_url: PAGES_URL,
  cold_cache: true,
  clear_protocol: "Storage.clearDataForOrigin(all) + Network.clearBrowserCache + SW unregister + Page.reload(ignoreCache:true)",
  app_ready_signal: readyMethod,
  circle_radius: 4,
  radius_rationale: "r=50 puts all ShapeGeometry vertices behind camera(8,8,8) → WebGL clips all triangles; r=4 ensures max(vx+vy)=5.66<8 → all in front",
  visible_render_method: "before/after JPEG diff on canvas (scale:0.5, quality:75) — changed pixels > 15 threshold",
  pixel_diff_method: "CDP captureScreenshot → browser Image+2D canvas decode → per-pixel RGB delta sum > 20",
  framedelta_removed: "renderer.info.render.frame resets to 0 then increments to 1 every render call (autoReset=true); not usable as monotonic counter",
  results,
  allPass,
}, null, 2));

console.log(`\n[v496v3] overall: ${allPass ? "ALL PASS" : "FAIL"}`);
console.log(`[v496v3] cert → ${certPath}`);
ws.close();
process.exit(allPass ? 0 : 1);
