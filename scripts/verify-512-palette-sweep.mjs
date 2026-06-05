#!/usr/bin/env node
// verify-512-palette-sweep.mjs
// Per-tool interactive UX matrix cert for the left palette (deployed Pages, cold-cache).
//
// Two axes per Leo spec (mail #13010/13011):
//   Axis-A  Winding/fill correctness (C16): CCW vertex order for fill producers (surface, plane).
//   Axis-B  Interaction-path intermediate states: mode-entry, preview, place, commit.
//
// Per-tool ACs:
//   AC-btn   mode entry via palette button click → activeTool assert
//   AC-kbd   keyboard path → command-at-cursor overlay appears
//   AC-prev  multi-step tool: noSnap preview object present after first click
//   AC-place committed geometry appears in scene (creator match)
//   AC-diff  canvas pixel diff > 15px (visible render)
//   AC-wind  C16 CCW winding on fill-producer committed geometry
//
// Tools covered:
//   CAD section: line, rect, circle, polygon, arc, polyline, curve, spline, point
//   Solid/OP:    surface (re-confirm #496-v3), plane (re-confirm #496-v3)
//   Arch:        wall, column

import { WebSocket } from "ws";
import { mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const CDP_PORT  = 9222;
const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const OUT_DIR   = fileURLToPath(new URL("../state/verify-512-palette-sweep", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

// ── CDP boilerplate (browser-level WS + Target.attachToTarget) ────────────────
// Using browser WS avoids the one-client-per-tab lock that kills direct tab WS
// when a prior script's WS was not cleanly closed.
const versionInfo = JSON.parse(execSync(`curl -s http://localhost:${CDP_PORT}/json/version`, { encoding: "utf8" }));
const browserWsUrl = versionInfo.webSocketDebuggerUrl;
if (!browserWsUrl) { console.error("No browser WS at :9222/json/version"); process.exit(1); }

const targets = JSON.parse(execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" }));

const ws = new WebSocket(browserWsUrl);
let mid = 1;
let _sessionId = null;
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
// send() auto-injects sessionId after attach
const send = (method, params = {}, timeoutMs = 20000) => new Promise((res, rej) => {
  const id = mid++;
  const timer = setTimeout(() => {
    pending.delete(id);
    rej(new Error(`CDP timeout: ${method}`));
  }, timeoutMs);
  pending.set(id, {
    res: v => { clearTimeout(timer); res(v); },
    rej: e => { clearTimeout(timer); rej(e); },
  });
  const msg = { id, method, params };
  if (_sessionId) msg.sessionId = _sessionId;
  ws.send(JSON.stringify(msg));
});
const onEvent = (event, cb) => {
  if (!evListeners.has(event)) evListeners.set(event, []);
  evListeners.get(event).push(cb);
};
const evaluate = async (expr, awaitP = false) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: awaitP, timeout: 30000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval error");
  return r.result?.value;
};
const delay = ms => new Promise(r => setTimeout(r, ms));

// Find the Pages tab — navigate browser to Pages if only intro/blank tab open
let target = targets.find(t => t.type === "page" && t.url.includes("wordingone.github.io"));
if (!target) {
  // Use any page tab (likely chrome://intro/) and navigate it
  target = targets.find(t => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!target) { console.error("No page tab at :9222"); ws.close(); process.exit(1); }
  console.log(`[sweep] nav intro tab → Pages`);
}
console.log(`[sweep] tab: ${target.url}`);

// Attach to the page target via browser session
const attachResult = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
_sessionId = attachResult.sessionId;
console.log(`[sweep] attached session: ${_sessionId?.slice(0, 16)}`);

// Enable CDP domains via the session
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

// ── Cold-cache reload (OPFS preserved) ───────────────────────────────────────
console.log("[sweep] cold-cache reload...");
await send("Network.clearBrowserCache");
await send("Storage.clearDataForOrigin", {
  origin: "https://wordingone.github.io",
  storageTypes: "cookies,cache_storage,service_workers,local_storage,shader_cache,indexeddb",
});
await evaluate(`(async()=>{ const r=await navigator.serviceWorker?.getRegistrations()||[]; await Promise.all(r.map(x=>x.unregister())); })()`, true).catch(()=>{});
// Navigate: Page.navigate resolves when nav commits (not load), so we poll readyState below.
await send("Page.navigate", { url: PAGES_URL }).catch(() => {});
// Wait for document.readyState === 'complete' (up to 90s)
for (let t = 0; t < 90; t++) {
  await delay(1000);
  const ready = await evaluate(`document.readyState`).catch(() => "loading");
  if (ready === "complete") { console.log(`[sweep] page ready at ~${t+1}s`); break; }
  if (t === 89) console.warn("[sweep] readyState timeout — proceeding anyway");
}

const exceptions = [];
onEvent("Runtime.exceptionThrown", p => {
  const desc = p.exceptionDetails?.exception?.description ?? "";
  if (!desc.includes("AbortError") && !desc.includes("NetworkError") && !desc.includes("Failed to fetch")) {
    exceptions.push(desc);
  }
});

// ── Boot-screen gate ──────────────────────────────────────────────────────────
console.log("[sweep] waiting for boot-screen removal...");
let bootGone = false;
for (let t = 0; t < 900; t++) {
  await delay(1000);
  const gone = await evaluate(`!document.getElementById('boot-screen')`).catch(() => true);
  if (gone) { bootGone = true; console.log(`[sweep] boot-screen gone at ~${t+1}s`); break; }
  if (t % 15 === 14) {
    const phase = await evaluate(`document.getElementById('boot-phase-label')?.textContent?.trim() ?? '?'`).catch(() => '?');
    console.log(`[sweep]   boot-screen still active (~${t+1}s): "${phase}"`);
  }
}
if (!bootGone) { console.error("[sweep] FAIL: boot-screen timeout"); ws.close(); process.exit(1); }
await delay(500);

// ── Canvas info ───────────────────────────────────────────────────────────────
const canvasInfo = await evaluate(`(function() {
  const c = document.querySelector('#viewer-canvas') ?? document.querySelector('canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  const ws = window.__projectToScreen?.(0, 0, 0);
  return {
    cx: ws ? Math.round(ws.x) : Math.round(r.left + r.width/2),
    cy: ws ? Math.round(ws.y) : Math.round(r.top + r.height/2),
    left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
  };
})()`);
const cx = canvasInfo?.cx ?? 730;
const cy = canvasInfo?.cy ?? 420;
console.log(`[sweep] canvas center: (${cx}, ${cy}), viewport: (${canvasInfo?.left},${canvasInfo?.top}) ${canvasInfo?.w}×${canvasInfo?.h}`);

// ── Interaction helpers ────────────────────────────────────────────────────────
const vpEl = `(document.getElementById('viewport-area-host') ?? document.elementFromPoint(${cx}, ${cy}))`;

const moveXY = (x, y) => evaluate(`(function() {
  const vp = ${vpEl};
  if (!vp) return;
  vp.dispatchEvent(new PointerEvent('pointermove', {bubbles:true,cancelable:true,clientX:${x},clientY:${y},buttons:0,button:-1}));
})()`);

const clickXY = (x, y) => evaluate(`(function() {
  const vp = ${vpEl};
  if (!vp) return;
  vp.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,cancelable:true,clientX:${x},clientY:${y},buttons:1,button:0,isPrimary:true}));
  vp.dispatchEvent(new PointerEvent('pointerup',   {bubbles:true,cancelable:true,clientX:${x},clientY:${y},buttons:0,button:0,isPrimary:true}));
  vp.dispatchEvent(new MouseEvent('click',         {bubbles:true,cancelable:true,clientX:${x},clientY:${y}}));
})()`);

// Dblclick: two clicks within 400ms at same spot — commitUnlimited fires when dt<500ms + dist<10px
const dblClickXY = async (x, y) => {
  await clickXY(x, y);
  await delay(180);
  await clickXY(x, y);
};

const pressKey = (key, code, keyCode) => evaluate(`(function() {
  document.dispatchEvent(new KeyboardEvent('keydown', {key:"${key}",code:"${code}",keyCode:${keyCode},bubbles:true,cancelable:true}));
  document.dispatchEvent(new KeyboardEvent('keyup',   {key:"${key}",code:"${code}",keyCode:${keyCode},bubbles:true,cancelable:true}));
})()`);

const pressEscape = () => evaluate(`(function() {
  document.dispatchEvent(new KeyboardEvent('keydown',{key:"Escape",code:"Escape",keyCode:27,bubbles:true,cancelable:true}));
  document.dispatchEvent(new KeyboardEvent('keyup',  {key:"Escape",code:"Escape",keyCode:27,bubbles:true,cancelable:true}));
})()`);

const pressCtrlZ = () => evaluate(`(function() {
  document.dispatchEvent(new KeyboardEvent('keydown',{key:"z",code:"KeyZ",keyCode:90,ctrlKey:true,bubbles:true,cancelable:true}));
  document.dispatchEvent(new KeyboardEvent('keyup',  {key:"z",code:"KeyZ",keyCode:90,ctrlKey:true,bubbles:true,cancelable:true}));
})()`);

const clickPaletteBtn = id => evaluate(`(function() {
  const btn = document.querySelector('button[data-tool="${id}"]');
  if (!btn) return false;
  btn.click();
  return true;
})()`);

const getActiveTool = () => evaluate(`window.__appState?.activeTool ?? "none"`);

const countByCreator = creator => evaluate(`(function() {
  const scene = window.__viewer?.getScene ? window.__viewer.getScene() : window.__viewer?.scene;
  if (!scene) return 0;
  let n = 0;
  scene.traverse(o => { if ((o.userData?.creator ?? o.userData?.dispatchVerb) === "${creator}" && !o.userData?.noSnap) n++; });
  return n;
})()`);

const countNoSnap = type => evaluate(`(function() {
  const scene = window.__viewer?.getScene ? window.__viewer.getScene() : window.__viewer?.scene;
  if (!scene) return 0;
  let n = 0;
  scene.traverse(o => { if (o.userData?.noSnap && o.type === "${type}") n++; });
  return n;
})()`);

// Capture canvas JPEG for diff
let _canvasClip = null;
const captureJpeg = async () => {
  if (!_canvasClip) {
    _canvasClip = await evaluate(`(function() {
      const c = document.querySelector('#viewer-canvas') ?? document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    })()`);
  }
  if (!_canvasClip) return "";
  const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 75, clip: { ..._canvasClip, scale: 0.5 } }).catch(() => ({ data: "" }));
  return r.data ?? "";
};

const diffJpeg = async (b4, af) => {
  if (!b4 || !af || b4 === af) return 0;
  try {
    return await evaluate(`(async () => {
      const decode = async b64 => {
        const blob = new Blob([Uint8Array.from(atob(b64), c=>c.charCodeAt(0))], {type:"image/jpeg"});
        const img = await createImageBitmap(blob);
        const c = document.createElement("canvas"); c.width=img.width; c.height=img.height;
        c.getContext("2d").drawImage(img,0,0); return c.getContext("2d").getImageData(0,0,c.width,c.height).data;
      };
      const [a,b] = await Promise.all([decode(${JSON.stringify(b4)}), decode(${JSON.stringify(af)})]);
      let d=0, len=Math.min(a.length,b.length);
      for (let i=0;i<len;i+=4) if (Math.abs(a[i]-b[i])>20||Math.abs(a[i+1]-b[i+1])>20||Math.abs(a[i+2]-b[i+2])>20) d++;
      return d;
    })()`, true);
  } catch { return 0; }
};

const screenshot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
  writeFileSync(`${OUT_DIR}/${name}.jpg`, Buffer.from(r.data, "base64"));
  return r.data;
};

// C16 winding check on committed fill geometry.
// THREE.ShapeGeometry is INDEXED: position buffer stores contour boundary points in the
// order THREE.js chose (may differ from input); the INDEX buffer defines actual triangles.
// For front-face CCW winding (WebGL default), the first indexed triangle must be CCW.
// Non-indexed fallback: position[0,1,2] are consecutive triangle vertices directly.
const checkCCW = (creator) => evaluate(`(function() {
  const scene = window.__viewer?.getScene ? window.__viewer.getScene() : window.__viewer?.scene;
  if (!scene) return null;
  let result = null;
  scene.traverse(o => {
    if (result) return;
    if ((o.userData?.creator ?? o.userData?.dispatchVerb) !== "${creator}") return;
    if (o.userData?.noSnap) return;
    const pos = o.geometry?.attributes?.position;
    if (!pos || pos.count < 3) return;
    const idx = o.geometry?.index;
    let ax, ay, bx, by, cx2, cy2;
    if (idx && idx.count >= 3) {
      // Indexed geometry: use actual first triangle vertices from index buffer.
      ax = pos.getX(idx.getX(0)); ay = pos.getY(idx.getX(0));
      bx = pos.getX(idx.getX(1)); by = pos.getY(idx.getX(1));
      cx2 = pos.getX(idx.getX(2)); cy2 = pos.getY(idx.getX(2));
    } else {
      // Non-indexed: positions 0,1,2 are the first triangle directly.
      ax = pos.getX(0); ay = pos.getY(0);
      bx = pos.getX(1); by = pos.getY(1);
      cx2 = pos.getX(2); cy2 = pos.getY(2);
    }
    const cross = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
    result = { cross: +cross.toFixed(6), ccw: cross > 0, vertCount: pos.count, indexed: !!(idx && idx.count >= 3) };
  });
  return result;
})()`);

// ── Matrix tracking ───────────────────────────────────────────────────────────
const matrix = [];
let totalPass = 0, totalFail = 0;

function row(tool, acName, pass, detail) {
  matrix.push({ tool, ac: acName, status: pass ? "PASS" : "FAIL", detail });
  if (pass) totalPass++; else totalFail++;
  console.log(`  [${pass?"PASS":"FAIL"}] ${tool} ${acName}: ${detail}`);
}

// ── Switch to CAD tab (shows DRAW + SOLID sections) ──────────────────────────
console.log("\n[sweep] switching to CAD tab...");
await evaluate(`window.dispatchEvent(new CustomEvent("ribbon:section-tab", { detail: { tab: "CAD" } }))`);
await delay(300);

// ── Pre-create circle for surface tool ───────────────────────────────────────
console.log("[sweep] pre-create circle at world(0,0) r=4 for surface tool...");
const circleSetup = await evaluate(`JSON.stringify(window.__dispatchSync?.("SdCircle", {center:[0,0], radius:4}) ?? null)`);
console.log(`[sweep] SdCircle setup: ${circleSetup}`);
await delay(300);

const beforeJpeg = await captureJpeg();
await screenshot("00-before");

// ── DRAW TOOLS ────────────────────────────────────────────────────────────────
// Tool spec: id, creator, clicks (-1 = unlimited), minPts for unlimited
const DRAW_TOOLS = [
  { id: "line",    creator: "line",    clicks: 2, minPts: 2, hasPreview: false },
  { id: "rect",    creator: "rect",    clicks: 2, minPts: 2, hasPreview: true  },
  { id: "circle",  creator: "circle",  clicks: 2, minPts: 2, hasPreview: true  },
  { id: "polygon", creator: "polygon", clicks: 2, minPts: 2, hasPreview: true  },
  { id: "arc",     creator: "arc",     clicks: 3, minPts: 3, hasPreview: false },
  { id: "polyline",creator: "polyline",clicks: -1,minPts: 2, hasPreview: false },
  { id: "curve",   creator: "curve",   clicks: -1,minPts: 2, hasPreview: false },
  { id: "spline",  creator: "spline",  clicks: -1,minPts: 4, hasPreview: false },
  { id: "point",   creator: "point",   clicks: 1, minPts: 1, hasPreview: false },
];

for (let ti = 0; ti < DRAW_TOOLS.length; ti++) {
  const { id, creator, clicks, minPts, hasPreview } = DRAW_TOOLS[ti];
  // Stagger click positions per tool to avoid overlap
  const ox = (ti % 3) * 90 - 90;
  const oy = Math.floor(ti / 3) * 90 - 90;
  const px1 = cx + ox,       py1 = cy + oy;
  const px2 = cx + ox + 60,  py2 = cy + oy + 60;
  const px3 = cx + ox + 30,  py3 = cy + oy - 40;

  console.log(`\n[sweep] ── ${id} ──`);

  // AC-btn: button click → activeTool
  const btnClicked = await clickPaletteBtn(id);
  await delay(300);
  const activeAfterBtn = await getActiveTool();
  const btnOk = btnClicked && activeAfterBtn === id;
  row(id, "AC-btn", btnOk, `clicked=${btnClicked} activeTool="${activeAfterBtn}"`);

  // AC-kbd: keyboard path → command-at-cursor overlay
  // Press first letter of tool label (keys open overlay)
  const kbdKey = id[0].toLowerCase(); // "l", "r", "c", "p", "a", "s"
  await clickPaletteBtn("select");    // reset tool first
  await delay(200);
  await pressKey(kbdKey, `Key${kbdKey.toUpperCase()}`, kbdKey.charCodeAt(0));
  await delay(300);
  const overlayExists = await evaluate(`!!document.querySelector('.cmd-cursor-input, .cmd-cursor-list')`);
  row(id, "AC-kbd", overlayExists, `key="${kbdKey}" overlay=${overlayExists}`);
  await pressEscape(); // dismiss overlay
  await delay(200);

  // Re-activate tool for placement
  await clickPaletteBtn(id);
  await delay(300);

  // AC-prev: for tools with preview (rect, circle, polygon), check noSnap after click+move
  if (hasPreview) {
    await clickXY(px1, py1); await delay(200);
    const preMesh = await countNoSnap("Mesh");
    const preLine = await countNoSnap("Line");
    const preLoop = await countNoSnap("LineLoop");
    await moveXY(px2, py2); await delay(400);
    const postMesh = await countNoSnap("Mesh");
    const postLine = await countNoSnap("Line");
    const postLoop = await countNoSnap("LineLoop");
    const preTotal = preMesh + preLine + preLoop;
    const postTotal = postMesh + postLine + postLoop;
    const previewOk = postTotal > preTotal;
    row(id, "AC-prev", previewOk, `noSnap delta: ${preTotal}→${postTotal} (Mesh/Line/Loop: ${preMesh}/${preLine}/${preLoop}→${postMesh}/${postLine}/${postLoop})`);
    // AC-place: second click commits
    const preCnt = await countByCreator(creator);
    const jpegPre = await captureJpeg();
    await clickXY(px2, py2); await delay(500);
    const postCnt = await countByCreator(creator);
    const jpegPost = await captureJpeg();
    const diff = await diffJpeg(jpegPre, jpegPost);
    row(id, "AC-place", postCnt > preCnt, `creator="${creator}" count: ${preCnt}→${postCnt}`);
    row(id, "AC-diff", diff > 15, `pixel diff=${diff}px (threshold >15)`);
  } else if (clicks === 1) {
    // single-click tools (point)
    const preCnt = await countByCreator(creator);
    const jpegPre = await captureJpeg();
    await clickXY(px1, py1); await delay(500);
    const postCnt = await countByCreator(creator);
    const jpegPost = await captureJpeg();
    const diff = await diffJpeg(jpegPre, jpegPost);
    row(id, "AC-place", postCnt > preCnt, `creator="${creator}" count: ${preCnt}→${postCnt}`);
    row(id, "AC-diff", diff > 15, `pixel diff=${diff}px (threshold >15)`);
  } else if (clicks === 2) {
    const preCnt = await countByCreator(creator);
    const jpegPre = await captureJpeg();
    await clickXY(px1, py1); await delay(200);
    await clickXY(px2, py2); await delay(500);
    const postCnt = await countByCreator(creator);
    const jpegPost = await captureJpeg();
    const diff = await diffJpeg(jpegPre, jpegPost);
    row(id, "AC-place", postCnt > preCnt, `creator="${creator}" count: ${preCnt}→${postCnt}`);
    row(id, "AC-diff", diff > 15, `pixel diff=${diff}px (threshold >15)`);
  } else if (clicks === 3) {
    // arc: center + radius + end
    const preCnt = await countByCreator(creator);
    const jpegPre = await captureJpeg();
    await clickXY(px1, py1); await delay(200);
    await clickXY(px2, py2); await delay(200);
    await clickXY(px3, py3); await delay(500);
    const postCnt = await countByCreator(creator);
    const jpegPost = await captureJpeg();
    const diff = await diffJpeg(jpegPre, jpegPost);
    row(id, "AC-place", postCnt > preCnt, `creator="${creator}" count: ${preCnt}→${postCnt}`);
    row(id, "AC-diff", diff > 15, `pixel diff=${diff}px (threshold >15)`);
  } else if (clicks === -1) {
    // unlimited: click minPts times, then dblclick at last point to commit
    const preCnt = await countByCreator(creator);
    const jpegPre = await captureJpeg();
    const pts = [];
    for (let i = 0; i < minPts; i++) pts.push({ x: px1 + i * 40, y: py1 + (i % 2) * 40 });
    for (let i = 0; i < pts.length - 1; i++) { await clickXY(pts[i].x, pts[i].y); await delay(180); }
    // dblclick at last point to commit
    await dblClickXY(pts[pts.length - 1].x, pts[pts.length - 1].y);
    await delay(600);
    const postCnt = await countByCreator(creator);
    const jpegPost = await captureJpeg();
    const diff = await diffJpeg(jpegPre, jpegPost);
    row(id, "AC-place", postCnt > preCnt, `creator="${creator}" count: ${preCnt}→${postCnt}`);
    row(id, "AC-diff", diff > 15, `pixel diff=${diff}px (threshold >15)`);
  }

  await screenshot(`tool-${id}`);

  // Reset: escape to cancel any pending, ctrl+z to undo committed
  await pressEscape(); await delay(150);
  await pressCtrlZ();  await delay(400);
}

// ── SURFACE tool (OP — re-confirm from #496-v3) ───────────────────────────────
console.log("\n[sweep] ── surface (OP) ──");
{
  // AC-btn
  const btnClicked = await clickPaletteBtn("surface");
  await delay(300);
  const at = await getActiveTool();
  row("surface", "AC-btn", btnClicked && at === "surface", `clicked=${btnClicked} activeTool="${at}"`);

  // AC-prev (hover over pre-created circle → noSnap Mesh fill preview)
  const preMesh = await countNoSnap("Mesh");
  const jpegPreHover = await captureJpeg();
  await moveXY(cx, cy); await delay(600);
  const postMesh = await countNoSnap("Mesh");
  const jpegPostHover = await captureJpeg();
  const diffHover = await diffJpeg(jpegPreHover, jpegPostHover);
  row("surface", "AC-prev", postMesh > preMesh, `noSnap Mesh: ${preMesh}→${postMesh}`);
  row("surface", "AC-prev-diff", diffHover > 15, `hover diff=${diffHover}px`);

  // AC-place: click commits the surface
  const preCnt = await countByCreator("surface");
  const jpegPreClick = await captureJpeg();
  await clickXY(cx, cy); await delay(700);
  const postCnt = await countByCreator("surface");
  const jpegPostClick = await captureJpeg();
  const diffClick = await diffJpeg(jpegPreClick, jpegPostClick);
  row("surface", "AC-place", postCnt > preCnt, `creator="surface" count: ${preCnt}→${postCnt}`);
  row("surface", "AC-diff", diffClick > 15, `click diff=${diffClick}px`);

  // AC-wind (C16): committed surface fill must be CCW
  const wind = await checkCCW("surface");
  const windOk = wind ? wind.ccw : false;
  row("surface", "AC-wind", windOk, wind ? `cross=${wind.cross} ccw=${wind.ccw} verts=${wind.vertCount}` : "no surface geometry found");

  await screenshot("tool-surface");
  await pressEscape(); await delay(150);
  await pressCtrlZ(); await delay(400);
}

// ── PLANE tool (OP — re-confirm from #496-v3) ────────────────────────────────
console.log("\n[sweep] ── plane (OP) ──");
{
  const pt1x = cx - 100, pt1y = cy + 60;
  const pt2x = pt1x + 180, pt2y = pt1y;
  const pt3x = pt2x - 60, pt3y = pt1y - 100;

  const btnClicked = await clickPaletteBtn("plane");
  await delay(300);
  const at = await getActiveTool();
  row("plane", "AC-btn", btnClicked && at === "plane", `clicked=${btnClicked} activeTool="${at}"`);

  // AC-prev: after pt1 click, move pt2 → noSnap Line appears
  await clickXY(pt1x, pt1y); await delay(300);
  const preLine = await countNoSnap("Line");
  await moveXY(pt2x, pt2y); await delay(500);
  const postLine = await countNoSnap("Line");
  row("plane", "AC-prev", postLine > preLine, `noSnap Line: ${preLine}→${postLine}`);

  // AC-place: click pt2 + pt3 → plane committed
  const preCnt = await countByCreator("plane");
  const jpegPre = await captureJpeg();
  await clickXY(pt2x, pt2y); await delay(300);
  await clickXY(pt3x, pt3y); await delay(700);
  const postCnt = await countByCreator("plane");
  const jpegPost = await captureJpeg();
  const diff = await diffJpeg(jpegPre, jpegPost);
  row("plane", "AC-place", postCnt > preCnt, `creator="plane" count: ${preCnt}→${postCnt}`);
  row("plane", "AC-diff", diff > 15, `diff=${diff}px`);

  // AC-wind (C16)
  const wind = await checkCCW("plane");
  const windOk = wind ? wind.ccw : false;
  row("plane", "AC-wind", windOk, wind ? `cross=${wind.cross} ccw=${wind.ccw} verts=${wind.vertCount}` : "no plane geometry found");

  await screenshot("tool-plane");
  await pressEscape(); await delay(150);
  await pressCtrlZ(); await delay(400);
}

// ── ARCH tools (switch back to ARCH tab) ──────────────────────────────────────
console.log("\n[sweep] switching to ARCH tab...");
await evaluate(`window.dispatchEvent(new CustomEvent("ribbon:section-tab", { detail: { tab: "ARCH" } }))`);
await delay(300);

// wall
console.log("\n[sweep] ── wall ──");
{
  const btnClicked = await clickPaletteBtn("wall");
  await delay(300);
  const at = await getActiveTool();
  row("wall", "AC-btn", btnClicked && at === "wall", `clicked=${btnClicked} activeTool="${at}"`);

  const preCnt = await countByCreator("wall");
  const jpegPre = await captureJpeg();
  await clickXY(cx - 80, cy + 80); await delay(200);
  await clickXY(cx + 80, cy + 80); await delay(600);
  const postCnt = await countByCreator("wall");
  const jpegPost = await captureJpeg();
  const diff = await diffJpeg(jpegPre, jpegPost);
  row("wall", "AC-place", postCnt > preCnt, `creator="wall" count: ${preCnt}→${postCnt}`);
  row("wall", "AC-diff", diff > 15, `diff=${diff}px`);

  await screenshot("tool-wall");
  await pressEscape(); await delay(150);
  await pressCtrlZ(); await delay(400);
}

// column
console.log("\n[sweep] ── column ──");
{
  const btnClicked = await clickPaletteBtn("column");
  await delay(300);
  const at = await getActiveTool();
  row("column", "AC-btn", btnClicked && at === "column", `clicked=${btnClicked} activeTool="${at}"`);

  const preCnt = await countByCreator("column");
  const jpegPre = await captureJpeg();
  await clickXY(cx + 60, cy - 60); await delay(600);
  const postCnt = await countByCreator("column");
  const jpegPost = await captureJpeg();
  const diff = await diffJpeg(jpegPre, jpegPost);
  row("column", "AC-place", postCnt > preCnt, `creator="column" count: ${preCnt}→${postCnt}`);
  row("column", "AC-diff", diff > 15, `diff=${diff}px`);

  await screenshot("tool-column");
  await pressEscape(); await delay(150);
  await pressCtrlZ(); await delay(400);
}

// ── Final state ───────────────────────────────────────────────────────────────
await screenshot("99-final");
const afterJpeg = await captureJpeg();
const totalDiff = await diffJpeg(beforeJpeg, afterJpeg);

// ── Write cert ────────────────────────────────────────────────────────────────
if (beforeJpeg) writeFileSync(`${OUT_DIR}/before.jpg`, Buffer.from(beforeJpeg, "base64"));
if (afterJpeg)  writeFileSync(`${OUT_DIR}/after.jpg`,  Buffer.from(afterJpeg, "base64"));

const cert = {
  script: "verify-512-palette-sweep.mjs",
  timestamp: new Date().toISOString(),
  url: PAGES_URL,
  cold_cache: true,
  clear_protocol: "Network.clearBrowserCache + Storage.clearDataForOrigin(excludes file_systems/OPFS)",
  screenshots: { before: "before.jpg", after: "after.jpg" },
  exceptions: exceptions.length,
  canvas_diff_total_px: totalDiff,
  matrix, totalPass, totalFail,
};
writeFileSync(`${OUT_DIR}/cert.json`, JSON.stringify(cert, null, 2));

// Summary
console.log("\n=== PALETTE SWEEP CERT ===");
console.log(`PASS: ${totalPass}  FAIL: ${totalFail}`);
const failures = matrix.filter(r => r.status === "FAIL");
if (failures.length) {
  console.log("FAILURES:");
  failures.forEach(r => console.log(`  ${r.tool} ${r.ac}: ${r.detail}`));
}
console.log(`cert → ${OUT_DIR}/cert.json`);
console.log(`exceptions: ${exceptions.length}`);

ws.close();
process.exit(totalFail > 0 ? 1 : 0);
