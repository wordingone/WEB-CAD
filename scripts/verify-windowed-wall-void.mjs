#!/usr/bin/env node
// verify-windowed-wall-void.mjs — See-through proof: windowed wall void renders
// as a real cut on deployed Pages (cold-cache). Leo gate mails #13069/#13071/#13073.
//
// Gate (tightened after 3rd recurrence per #13073):
//   AC1 — handler integrity: SdWindow + SdOpening voidCut only inside if(voidGroup)
//   AC2 — cold-cache nav to deployed Pages + app ready
//   AC3 — dispatch SdWall (centered) + SdWindow (center) → geometry assertion:
//           wall object replaced by THREE.Group (Mesh → Group confirms actual cut);
//           voidCut:true from handler
//   AC4 — rendered see-through discriminator: pixel THROUGH void ≠ pixel BESIDE void
//           (floating frame has through == beside == floor; real cut has beside = wall color)
//   AC5 — screenshot saved (Leo runs independent Haiku see-through check)
//
// Usage:
//   bun scripts/verify-windowed-wall-void.mjs   # requires browser on CDP :9222
//
// cert.json + screenshot saved to state/verify-windowed-wall-void/.

import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";

const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const CDP_BASE  = "http://localhost:9222";
const STATE_DIR = fileURLToPath(new URL("../state/verify-windowed-wall-void", import.meta.url));
const REPO      = fileURLToPath(new URL("..", import.meta.url));

mkdirSync(STATE_DIR, { recursive: true });

const results = [];
let screenshotB64 = null;
const pass = (ac, detail) => { console.log(`  PASS  ${ac}: ${detail}`); results.push({ ac, pass: true, detail }); };
const fail = (ac, detail) => { console.error(`  FAIL  ${ac}: ${detail}`); results.push({ ac, pass: false, detail }); };
const note = (msg) => console.log(`  note  ${msg}`);

// ── AC1: Handler integrity (static) ──────────────────────────────────────────

console.log("[void-cert] AC1: handler integrity");
try {
  const src = readFileSync(`${REPO}/web/src/handlers/openings.ts`, "utf8");
  const lines = src.split("\n");

  const winHandler = lines.slice(220, 250).join("\n");
  const winVoidIdx = winHandler.indexOf("voidCut = true");
  const winIfIdx   = winHandler.indexOf("if (voidGroup)");
  const winOk = winIfIdx < winVoidIdx && winHandler.slice(winIfIdx, winVoidIdx).includes("{");

  const opHandler = lines.slice(268, 290).join("\n");
  const opVoidIdx = opHandler.indexOf("voidCut = true");
  const opIfIdx   = opHandler.indexOf("if (voidGroup)");
  const opOk = opIfIdx >= 0 && opIfIdx < opVoidIdx && opHandler.slice(opIfIdx, opVoidIdx).includes("{");

  note(`SdWindow voidCut inside if(voidGroup): ${winOk}`);
  note(`SdOpening voidCut inside if(voidGroup): ${opOk} (was buggy — fixed)`);
  if (!winOk) throw new Error("SdWindow: voidCut not inside if(voidGroup)");
  if (!opOk)  throw new Error("SdOpening: voidCut not inside if(voidGroup)");
  pass("AC1", "handler integrity ok — voidCut inside if(voidGroup) for SdWindow + SdOpening");
} catch (e) {
  fail("AC1", `handler integrity failed: ${e.message}`);
}

// ── CDP setup ─────────────────────────────────────────────────────────────────

console.log("[void-cert] AC2: CDP connect + cold-cache nav");
const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) { fail("AC2", `Cannot reach ${CDP_BASE}`); writeResults(); process.exit(1); }
const tab = targets.find(t => t.type === "page");
if (!tab) { fail("AC2", "No page tab"); writeResults(); process.exit(1); }

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
    new Promise((_, rej) => setTimeout(() => rej(new Error("CDP timeout")), timeoutMs)),
  ]);
  if (res?.result?.result?.subtype === "error") {
    throw new Error(res.result.result.description ?? "CDP eval error");
  }
  return res?.result?.result?.value ?? null;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");

// Cold cache
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

const loadProm = new Promise(r => {
  const h = msg => {
    if (msg.method === "Page.loadEventFired") { msgListeners.splice(msgListeners.indexOf(h), 1); r(); }
  };
  msgListeners.push(h);
});
await send("Page.navigate", { url: PAGES_URL });
await Promise.race([loadProm, new Promise(r => setTimeout(r, 30000))]);
await new Promise(r => setTimeout(r, 4000));

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
note("app ready");
pass("AC2", `cold-cache nav to ${PAGES_URL} + app ready`);

// ── AC3: dispatch SdWall (centered) + SdWindow (centered) → geometry assertion ─

console.log("[void-cert] AC3: dispatch + geometry assertion (wall Mesh → Group)");
let wallUuid = null;
try {
  // Wall centered at world origin: x=-2 to x=2, y=0, z=0 to 3
  const wallRaw = await evaluate(`
    JSON.stringify(window.__dispatchSync("SdWall", {
      start: { x: -2, y: 0 },
      end:   { x: 2,  y: 0 },
      height: 3,
      label: "CertWall"
    }))
  `, 15000);
  const wallRes = JSON.parse(wallRaw ?? "{}");
  note(`SdWall: ${JSON.stringify(wallRes).slice(0, 100)}`);
  if (wallRes.error || (!wallRes.ok && !wallRes.created)) throw new Error(`SdWall failed: ${JSON.stringify(wallRes)}`);

  // Get wall UUID (only SdWall creator=wall at this point)
  wallUuid = await evaluate(`
    (() => {
      let u = null;
      window.__viewer.getScene().traverse(o => {
        if (!u && o.userData?.creator === 'wall') u = o.uuid;
      });
      return u;
    })()
  `);
  note(`wall uuid: ${wallUuid}`);

  // Window at center of wall (x:0 = center since wall is -2..2)
  const winRaw = await evaluate(`
    JSON.stringify(window.__dispatchSync("SdWindow", {
      x: 0, y: 0,
      width: 1, height: 1.5, sill: 0.8,
      label: "CertWindow"
    }))
  `, 15000);
  const winRes = JSON.parse(winRaw ?? "{}");
  note(`SdWindow: ${JSON.stringify(winRes).slice(0, 160)}`);
  if (winRes.error) throw new Error(`SdWindow error: ${winRes.error}`);

  const voidCut = winRes?.result?.voidCut === true || winRes?.voidCut === true;
  note(`voidCut flag: ${voidCut}`);

  // Geometry assertion: the wall object must now be a THREE.Group (Mesh → Group proves actual cut)
  // Use isGroup/isMesh (Three.js instance flags) — preserved through minification unlike constructor.name
  const wallObjectType = wallUuid ? await evaluate(`
    (() => {
      const o = window.__viewer.getScene().getObjectByProperty('uuid', ${JSON.stringify(wallUuid)});
      if (!o) return 'not-found';
      if (o.isGroup) return 'Group';
      if (o.isMesh)  return 'Mesh';
      return 'unknown-' + typeof o;
    })()
  `) : null;
  note(`wall object type after void cut: ${wallObjectType}`);

  if (!voidCut) throw new Error(`voidCut=false — handler reported no cut`);
  if (wallObjectType !== "Group") throw new Error(`wall is still ${wallObjectType} — addVoidToWallObject did not replace Mesh with Group (isGroup !== true)`);

  pass("AC3", `dispatch ok; voidCut:true; wall replaced Mesh→Group (geometry cut confirmed)`);
} catch (e) {
  fail("AC3", `${e.message}`);
}

// ── AC4: rendered see-through discriminator ───────────────────────────────────
// Camera at oblique angle. Orbit, force render, read pixels THROUGH void and BESIDE void.
// Real cut: through=black/void, beside=wall-teal → colorDist > threshold.
// Floating frame: through=floor, beside=floor → colorDist ≈ 0 → FAIL.

console.log("[void-cert] AC4: rendered see-through discriminator");
let discriminatorResult = null;
try {
  const pixelData = await evaluate(`
    (() => {
      const v = window.__viewer;
      if (!v) return null;
      const renderer = v.renderer;
      const scene    = typeof v.getScene === 'function' ? v.getScene() : (v.scene ?? null);
      const camera   = v.camera;
      if (!renderer || !scene || !camera) return { error: 'missing viewer props' };

      // Orbit: oblique angle showing wall face; wall centered at origin
      camera.position.set(6, -6, 4);
      camera.up.set(0, 0, 1);
      if (v.controls) {
        v.controls.target.set(0, 0, 1.5);
        v.controls.update();
      }
      camera.updateProjectionMatrix?.();

      // Force render — must call readPixels in same sync task
      renderer.render(scene, camera);

      const w = renderer.domElement.width;
      const h = renderer.domElement.height;

      // Project a world point to canvas pixel coords (canvas y=0 at top)
      const project = (wx, wy, wz) => {
        // Use camera.position.clone() to get a THREE.Vector3 without needing window.THREE
        const p = camera.position.clone().set(wx, wy, wz);
        p.project(camera);
        return {
          cx: Math.round((p.x + 1) / 2 * w),
          cy: Math.round((1 - p.y) / 2 * h),
        };
      };

      // Wall center (void hole): world (0, 0, 1.55) — midpoint of opening
      // Wall beside (left solid segment center): world (-1.25, 0, 1.5)
      // Wall beside (right solid segment center): world (1.25, 0, 1.5)
      const pVoid   = project(0,     0, 1.55);
      const pLeft   = project(-1.25, 0, 1.5);
      const pRight  = project( 1.25, 0, 1.5);

      const gl = renderer.getContext();
      const readPx = (cx, cy) => {
        const arr = new Uint8Array(4);
        // WebGL y=0 at bottom; canvas y=0 at top → flip
        gl.readPixels(cx, h - cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, arr);
        return [arr[0], arr[1], arr[2], arr[3]];
      };

      const voidColor  = readPx(pVoid.cx,  pVoid.cy);
      const leftColor  = readPx(pLeft.cx,  pLeft.cy);
      const rightColor = readPx(pRight.cx, pRight.cy);

      const l1 = (a, b) => Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]);
      const distLeft  = l1(voidColor, leftColor);
      const distRight = l1(voidColor, rightColor);
      const maxDist   = Math.max(distLeft, distRight);

      return {
        canvasDims: { w, h },
        voidPx:     pVoid,
        leftPx:     pLeft,
        rightPx:    pRight,
        voidColor,
        leftColor,
        rightColor,
        distLeft,
        distRight,
        maxDist,
        discriminates: maxDist > 30,
      };
    })()
  `, 20000);

  discriminatorResult = pixelData;
  note(`pixel data: ${JSON.stringify(pixelData)}`);

  if (!pixelData) throw new Error("evaluate returned null — viewer unavailable");
  if (pixelData.error) throw new Error(`viewer error: ${pixelData.error}`);
  if (!pixelData.discriminates) {
    throw new Error(
      `discriminator FAIL — through≈beside (maxDist=${pixelData.maxDist} ≤ 30); ` +
      `voidColor=${JSON.stringify(pixelData.voidColor)}, leftColor=${JSON.stringify(pixelData.leftColor)}, rightColor=${JSON.stringify(pixelData.rightColor)}. ` +
      `Floating frame: same backdrop through void AND beside wall.`
    );
  }
  pass("AC4", `discriminator PASS — maxDist=${pixelData.maxDist} (through≠beside; void=${JSON.stringify(pixelData.voidColor)}, beside=${JSON.stringify(pixelData.leftColor)})`);
} catch (e) {
  fail("AC4", `discriminator: ${e.message}`);
}

// ── AC5: screenshot for Leo's independent Haiku check ────────────────────────

console.log("[void-cert] AC5: screenshot");
try {
  // Force another render at same camera (already set by AC4) and capture
  const canvasB64 = await evaluate(`
    (() => {
      const v = window.__viewer;
      const renderer = v?.renderer;
      const scene    = typeof v?.getScene === 'function' ? v.getScene() : (v?.scene ?? null);
      const camera   = v?.camera;
      if (renderer && scene && camera) {
        try { renderer.render(scene, camera); } catch(_) {}
      }
      const canvas = renderer?.domElement ?? document.querySelector('canvas');
      if (!canvas) return null;
      try { return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]; } catch(_) { return null; }
    })()
  `);
  if (!canvasB64) throw new Error("canvas.toDataURL returned null");
  const imgBytes = Buffer.from(canvasB64, "base64");
  writeFileSync(`${STATE_DIR}/screenshot.jpg`, imgBytes);
  screenshotB64 = canvasB64;
  note(`screenshot saved: ${imgBytes.length} bytes`);
  pass("AC5", `screenshot captured (${imgBytes.length} bytes) — Leo runs Haiku see-through check`);
} catch (e) {
  fail("AC5", `screenshot: ${e.message}`);
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
    discriminator: discriminatorResult,
    screenshot: screenshotB64 ? "state/verify-windowed-wall-void/screenshot.jpg" : null,
    summary: {
      passed, failed, total,
      wall_dispatch: "start:{x:-2,y:0} end:{x:2,y:0} — wall centered at world origin",
      window_dispatch: "x:0 y:0 — window at wall center (local x=0 = center of -2..2 range)",
      geometry_gate: "wall object type Mesh→Group proves addVoidToWallObject performed actual cut",
      discriminator_gate: "pixel THROUGH void ≠ pixel BESIDE void (maxDist > 30); floating frame fails (through==beside)",
    },
  };
  writeFileSync(`${STATE_DIR}/cert.json`, JSON.stringify(cert, null, 2));
  console.log(`\n[void-cert] ${passed}/${total} PASS · ${failed} FAIL → ${STATE_DIR}/cert.json`);
  if (screenshotB64) console.log(`[void-cert] screenshot: ${STATE_DIR}/screenshot.jpg`);
}

writeResults();
process.exit(results.some(r => !r.pass) ? 1 : 0);
