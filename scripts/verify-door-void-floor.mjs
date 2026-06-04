#!/usr/bin/env node
// verify-door-void-floor.mjs — Door void reaches-floor cert (#33 house audit, Leo mail #13085).
//
// Leo gate (mail #13085): door void must reach z=0 (no solid strip at bottom), must not
// z-fight slab. Tests the geometric case NOT covered by #525 (window mid-wall).
//
// Test surface: isolated wall + door (no enclosing building) — avoids enclosed-building
// interior-wall pixel-discriminator limitation from audit-house-2storey.mjs.
//
// AC1 — static: bun run verify exit 0 + audit-dispatch exit 0
// AC2 — cold-cache nav to deployed Pages + app ready
// AC3 — dispatch SdWall (4m south) + SdDoor (center); assert wall.isGroup===true + voidCut:true
// AC4 — geometry: traverse wall Group bboxes; no child segment occupies door x-range at z<0.1m
//          (no bottom strip → door cuts all the way to the floor)
// AC5 — pixel discriminator (isolated wall): camera outside at ground level, through door
//          bottom (z≈0.1) → background; beside door on wall (z≈0.1) → teal wall; dist > 30
// AC6 — threshold close-up screenshot (camera low, angled toward door base)
//
// Usage:
//   bun scripts/verify-door-void-floor.mjs

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const CDP_BASE  = "http://localhost:9222";
const REPO      = fileURLToPath(new URL("..", import.meta.url));
const STATE_DIR = fileURLToPath(new URL("../state/verify-door-void-floor", import.meta.url));

mkdirSync(STATE_DIR, { recursive: true });

const results = [];
const pass = (ac, detail) => { console.log(`  PASS  ${ac}: ${detail}`); results.push({ ac, pass: true, detail }); };
const fail = (ac, detail) => { console.error(`  FAIL  ${ac}: ${detail}`); results.push({ ac, pass: false, detail }); };
const note = (msg) => console.log(`  note  ${msg}`);

// ── AC1: Static checks ────────────────────────────────────────────────────────

console.log("[door-floor] AC1: bun run verify + audit-dispatch");
try {
  execSync("bun run verify", { cwd: REPO, stdio: "pipe" });
  pass("AC1a", "bun run verify exit 0");
} catch (e) {
  fail("AC1a", `verify failed: ${e.stderr?.toString()?.slice(0, 200) ?? e.message?.slice(0, 200)}`);
}
try {
  execSync("bun scripts/audit-dispatch-routing.ts", { cwd: REPO, stdio: "pipe" });
  pass("AC1b", "audit-dispatch exit 0");
} catch (e) {
  fail("AC1b", `audit-dispatch failed: ${e.message?.slice(0, 200)}`);
}

// ── CDP setup ─────────────────────────────────────────────────────────────────

console.log("[door-floor] Connecting to CDP :9222");
const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) { fail("setup", `Cannot reach ${CDP_BASE}`); writeResults(); process.exit(1); }
const tab = targets.find(t => t.type === "page");
if (!tab) { fail("setup", "No page tab"); writeResults(); process.exit(1); }

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

async function dispatch(verb, args) {
  const raw = await evaluate(
    `JSON.stringify(window.__dispatchSync(${JSON.stringify(verb)}, ${JSON.stringify(args)}))`,
    15000
  );
  return JSON.parse(raw ?? "{}");
}

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");

// ── AC2: Cold-cache nav ───────────────────────────────────────────────────────

console.log("[door-floor] AC2: cold-cache nav to deployed Pages");
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

if (!appReady) { fail("AC2", "app not ready after 20s"); writeResults(); ws.close(); process.exit(1); }
note("app ready");
pass("AC2", `cold-cache nav + app ready at ${PAGES_URL}`);

// ── AC3: Dispatch isolated wall + door ────────────────────────────────────────
// Isolated: just one south wall + one door. No enclosing box.
// Wall: 4m wide (x=-2 to x=+2), 3m tall, at y=-2 (south).
// Door: default dims at x=0, y=-2, z=0.

console.log("[door-floor] AC3: dispatch SdWall + SdDoor (isolated, no enclosing box)");
let wallUuid = null;
let doorVoidCut = false;
let doorDims = null;

try {
  // Set an explicit ground level
  await dispatch("SdLevel", { elevation: 0, height: 3 });

  const wallRes = await dispatch("SdWall", { start: { x: -2, y: -2 }, end: { x: 2, y: -2 }, height: 3 });
  note(`SdWall result: ${JSON.stringify(wallRes).slice(0, 120)}`);

  // Capture wall UUID before door cuts it
  wallUuid = await evaluate(`
    (() => {
      const scene = window.__viewer.getScene();
      let uid = null;
      scene.traverse(o => {
        if ((o.userData?.creator === 'wall' || o.userData?.creator === 'SdWall') && !uid) {
          uid = o.uuid;
        }
      });
      return uid;
    })()
  `);
  note(`wall uuid: ${wallUuid}`);

  const doorRes = await dispatch("SdDoor", { position: [0, -2, 0] });
  note(`SdDoor result: ${JSON.stringify(doorRes).slice(0, 120)}`);
  doorVoidCut = doorRes?.result?.voidCut === true;

  // Read door mesh userData for dims
  doorDims = await evaluate(`
    (() => {
      const scene = window.__viewer.getScene();
      let dims = null;
      scene.traverse(o => {
        if (o.userData?.creator === 'door' && !dims) {
          dims = { voidW: o.userData.voidW, voidH: o.userData.voidH };
        }
      });
      return dims;
    })()
  `);
  note(`door dims: ${JSON.stringify(doorDims)}`);

  // After door dispatch, wall UUID might change (Group replaces Mesh) — find current wall by creator
  const wallState = await evaluate(`
    (() => {
      const scene = window.__viewer.getScene();
      let state = null;
      scene.traverse(o => {
        const c = o.userData?.creator;
        if ((c === 'wall' || c === 'SdWall') && !state) {
          state = { uuid: o.uuid, isGroup: !!o.isGroup, isMesh: !!o.isMesh, childCount: o.isGroup ? o.children.length : 0 };
        }
      });
      return state;
    })()
  `);
  note(`wall state after door: ${JSON.stringify(wallState)}`);

  if (!wallState?.isGroup) {
    throw new Error(`wall is not a Group after SdDoor dispatch (isGroup=${wallState?.isGroup}, isMesh=${wallState?.isMesh}) — void cut did not fire`);
  }
  if (!doorVoidCut) {
    throw new Error(`SdDoor returned voidCut:false — void cut failed`);
  }

  // Update wallUuid to current (may have changed)
  wallUuid = wallState.uuid;

  pass("AC3", `wall.isGroup===true (${wallState.childCount} segments), voidCut:true — void cut performed`);
} catch (e) {
  fail("AC3", `dispatch/assert: ${e.message}`);
}

// ── AC4: Geometry — no bottom strip in door x-range ──────────────────────────
// Traverse wall Group children bboxes in world space.
// In the door's x-range (±doorW/2 ± 0.05 margin), no child should have bbox.min.z < 0.1.
// A bottom strip would have min.z≈0 and max.z≈(sill height or partial).

console.log("[door-floor] AC4: geometry — no bottom strip at door threshold");
let geomAudit = null;
try {
  geomAudit = await evaluate(`
    (() => {
      const THREE = window.__viewer?.renderer?.info?.memory ? window.__viewer.renderer : null;
      const scene = window.__viewer.getScene();

      // Find the wall Group
      let wallGroup = null;
      scene.traverse(o => {
        if ((o.userData?.creator === 'wall' || o.userData?.creator === 'SdWall') && o.isGroup && !wallGroup) {
          wallGroup = o;
        }
      });
      if (!wallGroup) return { error: 'wall Group not found' };

      // Find the door mesh to get exact dims
      let doorW = 0.9, doorH = 2.0;
      scene.traverse(o => {
        if (o.userData?.creator === 'door') {
          doorW = o.userData.voidW ?? doorW;
          doorH = o.userData.voidH ?? doorH;
        }
      });

      // Use 80% of door half-width for the "inner door" check — avoids flagging the left/right
      // wall columns whose inner edges touch the door boundary exactly.
      const doorHW = doorW / 2;       // exact half-width
      const checkHW = doorHW * 0.8;  // 80% — segments must be INSIDE this to be suspect

      // Collect bboxes of all wall Group children in world space
      const segments = [];
      wallGroup.updateMatrixWorld(true);
      wallGroup.children.forEach(child => {
        child.updateMatrixWorld(true);
        // Compute world-space bbox via vertex iteration (avoids THREE.Box3.setFromObject needing import)
        const geo = child.geometry;
        if (!geo || !geo.attributes?.position) return;
        const pos = geo.attributes.position;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        const mat = child.matrixWorld;
        for (let i = 0; i < pos.count; i++) {
          const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
          // Transform to world: simplified for meshes with only translation/rotation (no scale)
          const wx = mat.elements[0]*lx + mat.elements[4]*ly + mat.elements[8]*lz  + mat.elements[12];
          const wz = mat.elements[2]*lx + mat.elements[6]*ly + mat.elements[10]*lz + mat.elements[14];
          if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
          if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
        }
        segments.push({ minX, maxX, minZ, maxZ });
      });

      // Check: any segment INSIDE the door x-range (not just touching the edge) AND minZ < 0.1
      // A bottom strip would be fully within ±checkHW and start at the floor.
      // Left/right wall columns touch the door boundary at ±doorHW but don't enter ±checkHW.
      const doorSuspect = segments.filter(s => s.maxX > -checkHW && s.minX < checkHW && s.minZ < 0.1);

      return {
        doorW, doorH, doorHW, checkHW,
        totalSegments: segments.length,
        segments,
        suspectStrips: doorSuspect,
        pass: doorSuspect.length === 0,
      };
    })()
  `, 20000);

  note(`geometry audit: totalSegments=${geomAudit?.totalSegments} suspectStrips=${geomAudit?.suspectStrips?.length}`);
  note(`door: w=${geomAudit?.doorW} h=${geomAudit?.doorH} halfW=${geomAudit?.doorHW} checkHW=${geomAudit?.checkHW}`);
  if (geomAudit?.segments) {
    for (const s of geomAudit.segments) {
      note(`  segment x=[${s.minX?.toFixed(3)},${s.maxX?.toFixed(3)}] z=[${s.minZ?.toFixed(3)},${s.maxZ?.toFixed(3)}]`);
    }
  }

  if (!geomAudit) throw new Error("geometry evaluate returned null");
  if (geomAudit.error) throw new Error(geomAudit.error);
  if (!geomAudit.pass) {
    const strips = geomAudit.suspectStrips.map(s => `x=[${s.minX?.toFixed(3)},${s.maxX?.toFixed(3)}] z=[${s.minZ?.toFixed(3)},${s.maxZ?.toFixed(3)}]`).join("; ");
    throw new Error(`bottom strip found at threshold: ${strips}`);
  }

  pass("AC4", `no wall segment in door x-range has z<0.1 — door void reaches floor (${geomAudit.totalSegments} segments total)`);
} catch (e) {
  fail("AC4", `geometry check: ${e.message}`);
}

// ── AC5: Pixel discriminator — through door bottom vs beside door at z≈0.1 ───
// Isolated wall: looking through door from outside → background (dark).
// Looking at wall beside door → teal wall material.
// Camera: positioned outside south wall at (0, -6, 1.5), looking toward (0, -2, 1.5).

console.log("[door-floor] AC5: pixel discriminator — door threshold (isolated wall)");
let pixData = null;
try {
  pixData = await evaluate(`
    (() => {
      const v = window.__viewer;
      const renderer = v?.renderer;
      const scene    = typeof v?.getScene === 'function' ? v.getScene() : (v?.scene ?? null);
      const camera   = v?.camera;
      if (!renderer || !scene || !camera) return { error: 'viewer not ready' };

      const w = renderer.domElement.width;
      const h = renderer.domElement.height;

      // Camera: outside, looking at south wall front-on at mid-height
      camera.position.set(0, -8, 1.5);
      camera.up.set(0, 0, 1);
      if (v.controls) { v.controls.target.set(0, -2, 1.5); v.controls.update(); }
      camera.updateProjectionMatrix?.();
      renderer.render(scene, camera);

      const gl = renderer.getContext();
      const project = (wx, wy, wz) => {
        const p = new (camera.position.constructor)(wx, wy, wz);
        p.project(camera);
        return { cx: Math.round((p.x + 1) / 2 * w), cy: Math.round((1 - p.y) / 2 * h) };
      };
      const readPx = (cx, cy) => {
        const arr = new Uint8Array(4);
        gl.readPixels(cx, h - cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, arr);
        return [arr[0], arr[1], arr[2], arr[3]];
      };
      const l1 = (a, b) => Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]);

      // Get actual door dims from scene
      let doorW = 0.9, doorH = 2.0;
      scene.traverse(o => {
        if (o.userData?.creator === 'door') {
          doorW = o.userData.voidW ?? doorW;
          doorH = o.userData.voidH ?? doorH;
        }
      });

      // Three sample points:
      // (a) Through door at bottom-center (z=0.15 — just above floor)
      // (b) Through door at mid-height (z=doorH/2 — well inside void)
      // (c) Beside door on wall (x=doorW/2+0.3, same z as (a))
      const pThreshCenter = project(0,       -2, 0.15);
      const pMidVoid      = project(0,       -2, doorH / 2);
      const pBeside       = project(doorW / 2 + 0.3, -2, 0.15);

      const cThreshCenter = readPx(pThreshCenter.cx, pThreshCenter.cy);
      const cMidVoid      = readPx(pMidVoid.cx,      pMidVoid.cy);
      const cBeside       = readPx(pBeside.cx,        pBeside.cy);

      const distThresh = l1(cThreshCenter, cBeside);
      const distMid    = l1(cMidVoid,      cBeside);

      return {
        doorW, doorH,
        thresh: { px: pThreshCenter, color: cThreshCenter },
        midVoid: { px: pMidVoid,     color: cMidVoid },
        beside:  { px: pBeside,      color: cBeside },
        distThresh,   // through-door at floor level vs beside door — key: must be >30
        distMid,      // through-door at mid-height vs beside door — sanity check
        passThresh: distThresh > 30,
        passMid:    distMid    > 30,
      };
    })()
  `, 20000);

  note(`pixel: thresh_dist=${pixData?.distThresh} mid_dist=${pixData?.distMid}`);
  note(`  threshold-center px=${JSON.stringify(pixData?.thresh?.px)} color=${JSON.stringify(pixData?.thresh?.color)}`);
  note(`  mid-void         px=${JSON.stringify(pixData?.midVoid?.px)} color=${JSON.stringify(pixData?.midVoid?.color)}`);
  note(`  beside-door      px=${JSON.stringify(pixData?.beside?.px)} color=${JSON.stringify(pixData?.beside?.color)}`);

  if (!pixData) throw new Error("evaluate returned null");
  if (pixData.error) throw new Error(pixData.error);

  if (!pixData.passThresh) {
    throw new Error(`door threshold pixel dist=${pixData.distThresh} ≤ 30 — bottom of door not visually distinct from wall (solid strip or z-fight)`);
  }
  if (!pixData.passMid) {
    // Mid-void failing while thresh passes = unusual; note but don't gate on it separately
    note(`WARN: mid-void dist=${pixData.distMid} ≤ 30 (unexpected — threshold passed but mid-height did not)`);
  }

  pass("AC5", `threshold dist=${pixData.distThresh} > 30, mid dist=${pixData.distMid} — door void reaches floor, visually see-through from outside`);
} catch (e) {
  fail("AC5", `pixel discriminator: ${e.message}`);
}

// ── AC6: Threshold close-up screenshot ────────────────────────────────────────
// Camera low, angled down toward door base to show threshold clearly.

console.log("[door-floor] AC6: threshold close-up screenshot");
let threshScreenshot = null;
try {
  const b64 = await evaluate(`
    (() => {
      const v = window.__viewer;
      const renderer = v?.renderer;
      const scene    = typeof v?.getScene === 'function' ? v.getScene() : (v?.scene ?? null);
      const camera   = v?.camera;
      if (!renderer || !scene || !camera) return null;

      // Low camera: outside at (0, -5, 0.8), looking toward door base (0, -2, 0.2)
      camera.position.set(0, -5, 0.8);
      camera.up.set(0, 0, 1);
      if (v.controls) { v.controls.target.set(0, -2, 0.2); v.controls.update(); }
      camera.updateProjectionMatrix?.();
      renderer.render(scene, camera);
      const canvas = renderer.domElement;
      try { return canvas.toDataURL('image/jpeg', 0.92).split(',')[1]; } catch(_) { return null; }
    })()
  `, 15000);

  if (!b64) throw new Error("canvas.toDataURL returned null");
  const path = `${STATE_DIR}/threshold-closeup.jpg`;
  writeFileSync(path, Buffer.from(b64, "base64"));
  threshScreenshot = `${Buffer.from(b64, "base64").length} bytes`;
  note(`threshold-closeup: saved (${threshScreenshot})`);
  pass("AC6", `threshold close-up saved — ${threshScreenshot}`);
} catch (e) {
  fail("AC6", `screenshot: ${e.message}`);
}

// Also capture front elevation for context
console.log("[door-floor] AC6b: front elevation for context");
let frontScreenshot = null;
try {
  const b64front = await evaluate(`
    (() => {
      const v = window.__viewer;
      const renderer = v?.renderer;
      const scene    = typeof v?.getScene === 'function' ? v.getScene() : (v?.scene ?? null);
      const camera   = v?.camera;
      if (!renderer || !scene || !camera) return null;
      camera.position.set(0, -12, 2);
      camera.up.set(0, 0, 1);
      if (v.controls) { v.controls.target.set(0, -2, 1.5); v.controls.update(); }
      camera.updateProjectionMatrix?.();
      renderer.render(scene, camera);
      const canvas = renderer.domElement;
      try { return canvas.toDataURL('image/jpeg', 0.92).split(',')[1]; } catch(_) { return null; }
    })()
  `, 15000);
  if (b64front) {
    writeFileSync(`${STATE_DIR}/front-elevation.jpg`, Buffer.from(b64front, "base64"));
    frontScreenshot = `${Buffer.from(b64front, "base64").length} bytes`;
    note(`front-elevation: saved (${frontScreenshot})`);
  }
} catch (_) {}

ws.close();

// ── Result collation ──────────────────────────────────────────────────────────

function writeResults() {
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total  = results.length;

  const cert = {
    script: "verify-door-void-floor.mjs",
    issue: 33,
    gate: "Leo mail #13085 — door void reaches floor, no bottom strip, no slab z-fight",
    cold_cache: true,
    clear_protocol: "Network.clearBrowserCache + Storage.clearDataForOrigin + caches.delete",
    url: PAGES_URL,
    timestamp: new Date().toISOString(),
    results,
    geometry: geomAudit,
    pixels: pixData,
    screenshots: {
      threshold_closeup: threshScreenshot ? "threshold-closeup.jpg" : null,
      front_elevation: frontScreenshot ? "front-elevation.jpg" : null,
    },
    methodology: {
      test_surface: "isolated wall + door (no enclosing box) — avoids enclosed-building interior-wall ambiguity",
      geometry_check: "wall Group child bboxes — no segment in door x-range with z<0.1",
      pixel_check: "camera outside at ground level; through-door-bottom vs beside-door at z=0.15; dist>30",
      pixel_note: "isolated wall gives unambiguous discriminator: void → background, wall → teal",
    },
    summary: { passed, failed, total },
  };

  writeFileSync(`${STATE_DIR}/cert.json`, JSON.stringify(cert, null, 2));
  console.log(`\n[door-floor] ${passed}/${total} PASS · ${failed} FAIL → ${STATE_DIR}/cert.json`);
  if (threshScreenshot) console.log(`[door-floor] threshold-closeup: ${STATE_DIR}/threshold-closeup.jpg`);
  if (frontScreenshot)  console.log(`[door-floor] front-elevation: ${STATE_DIR}/front-elevation.jpg`);
}

writeResults();

const anyFail = results.some(r => !r.pass);
process.exit(anyFail ? 1 : 0);
