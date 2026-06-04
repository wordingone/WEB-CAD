#!/usr/bin/env node
// verify-house-south-voids.mjs — South-wall openings leg for #33 house audit.
// Leo gate (mail #13087): close openings leg via face-absence geometry (option b) +
// inside-camera angled perspective showing exterior through each void (option a).
//
// Option (b) — lossless backstop: traverse wall Group children; assert zero wall geometry
//   inside each opening's interior AABB (shrunk by 0.05m per edge). Programmatic, no render.
//
// Option (a) — inside-camera pixel discriminator: camera inside building looking south;
//   through-void → exterior background (dark); beside-void → teal wall material.
//   From inside, a floating frame (void not cut) shows teal wall where void should be → dist≈0.
//   A real cut shows exterior → dist >> 30.
//
// AC1 — static: bun run verify + audit-dispatch
// AC2 — cold-cache nav + app ready
// AC3 — build full 2-storey house (same as audit-house-2storey.mjs); collect opening positions/dims
// AC4 — face-absence geometry: 5 openings × wall Group segments, 0 vertices inside shrunk AABB
// AC5 — inside-camera pixel discriminator: GF door + 2 GF windows (3 openings); dist > 30 each
// AC6 — inside-camera screenshots: ground-floor and L2 angled south views
//
// Usage: bun scripts/verify-house-south-voids.mjs

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const CDP_BASE  = "http://localhost:9222";
const REPO      = fileURLToPath(new URL("..", import.meta.url));
const STATE_DIR = fileURLToPath(new URL("../state/verify-house-south-voids", import.meta.url));

mkdirSync(STATE_DIR, { recursive: true });

const results = [];
const pass = (ac, detail) => { console.log(`  PASS  ${ac}: ${detail}`); results.push({ ac, pass: true, detail }); };
const fail = (ac, detail) => { console.error(`  FAIL  ${ac}: ${detail}`); results.push({ ac, pass: false, detail }); };
const note = (msg) => console.log(`  note  ${msg}`);

// ── AC1: Static ───────────────────────────────────────────────────────────────

console.log("[sv] AC1: bun run verify + audit-dispatch");
try {
  execSync("bun run verify", { cwd: REPO, stdio: "pipe" });
  pass("AC1a", "bun run verify exit 0");
} catch (e) {
  fail("AC1a", `verify: ${e.stderr?.toString()?.slice(0, 200) ?? e.message?.slice(0, 200)}`);
}
try {
  execSync("bun scripts/audit-dispatch-routing.ts", { cwd: REPO, stdio: "pipe" });
  pass("AC1b", "audit-dispatch exit 0");
} catch (e) {
  fail("AC1b", `audit-dispatch: ${e.message?.slice(0, 200)}`);
}

// ── CDP setup ─────────────────────────────────────────────────────────────────

console.log("[sv] Connecting to CDP :9222");
const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) { fail("setup", `Cannot reach ${CDP_BASE}`); process.exit(1); }
const tab = targets.find(t => t.type === "page");
if (!tab) { fail("setup", "No page tab"); process.exit(1); }

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

const send = (method, params = {}) => new Promise(resolve => {
  const id = mid++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

async function evaluate(expr, timeoutMs = 30000) {
  const res = await Promise.race([
    send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("CDP timeout")), timeoutMs)),
  ]);
  if (res?.result?.result?.subtype === "error") throw new Error(res.result.result.description ?? "CDP eval error");
  return res?.result?.result?.value ?? null;
}

const dispatch = async (verb, args) => {
  const raw = await evaluate(`JSON.stringify(window.__dispatchSync(${JSON.stringify(verb)}, ${JSON.stringify(args)}))`, 15000);
  return JSON.parse(raw ?? "{}");
};

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");

// ── AC2: Cold-cache nav ───────────────────────────────────────────────────────

console.log("[sv] AC2: cold-cache nav");
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
  const h = msg => { if (msg.method === "Page.loadEventFired") { msgListeners.splice(msgListeners.indexOf(h), 1); r(); } };
  msgListeners.push(h);
});
await send("Page.navigate", { url: PAGES_URL });
await Promise.race([loadProm, new Promise(r => setTimeout(r, 30000))]);
await new Promise(r => setTimeout(r, 4000));

const appReady = await evaluate(`
  new Promise(resolve => {
    if (window.__APP_READY__) { resolve(true); return; }
    const t = setInterval(() => { if (window.__APP_READY__) { clearInterval(t); resolve(true); } }, 500);
    setTimeout(() => { clearInterval(t); resolve(false); }, 20000);
  })
`, 25000);
if (!appReady) { fail("AC2", "app not ready"); ws.close(); process.exit(1); }
note("app ready");
pass("AC2", `cold-cache nav + app ready at ${PAGES_URL}`);

// ── AC3: Build full 2-storey house ────────────────────────────────────────────

console.log("[sv] AC3: building 2-storey house");
// Openings: [label, x, z, voidW, voidH, wallCreator (gf/l2)]
const OPENINGS = [];

try {
  await dispatch("SdLevel", { elevation: 0, height: 3 });
  await dispatch("SdSlab",  { width: 10, depth: 8, thickness: 0.2 });
  await dispatch("SdWall",  { start: { x: -5, y: -4 }, end: { x: 5, y: -4 }, height: 3 });
  await dispatch("SdWall",  { start: { x: -5, y:  4 }, end: { x: 5, y:  4 }, height: 3 });
  await dispatch("SdWall",  { start: { x:  5, y: -4 }, end: { x: 5, y:  4 }, height: 3 });
  await dispatch("SdWall",  { start: { x: -5, y: -4 }, end: { x:-5, y:  4 }, height: 3 });

  const door = await dispatch("SdDoor",   { position: [0,   -4, 0] });
  const win1 = await dispatch("SdWindow", { position: [-2,  -4, 0], width: 1, height: 1.2, sill: 0.9 });
  const win2 = await dispatch("SdWindow", { position: [2,   -4, 0], width: 1, height: 1.2, sill: 0.9 });
  note(`GF: door.voidCut=${door?.result?.voidCut} win1.voidCut=${win1?.result?.voidCut} win2.voidCut=${win2?.result?.voidCut}`);

  await dispatch("SdLevel", { elevation: 3, height: 2.8 });
  await dispatch("SdSlab",  { width: 10, depth: 8, thickness: 0.2 });
  await dispatch("SdWall",  { start: { x: -5, y: -4 }, end: { x: 5, y: -4 }, height: 2.8 });
  await dispatch("SdWall",  { start: { x: -5, y:  4 }, end: { x: 5, y:  4 }, height: 2.8 });
  await dispatch("SdWall",  { start: { x:  5, y: -4 }, end: { x: 5, y:  4 }, height: 2.8 });
  await dispatch("SdWall",  { start: { x: -5, y: -4 }, end: { x:-5, y:  4 }, height: 2.8 });
  const win3 = await dispatch("SdWindow", { position: [-2, -4, 3], width: 1, height: 1.2, sill: 0.9 });
  const win4 = await dispatch("SdWindow", { position: [2,  -4, 3], width: 1, height: 1.2, sill: 0.9 });
  note(`L2: win3.voidCut=${win3?.result?.voidCut} win4.voidCut=${win4?.result?.voidCut}`);

  await dispatch("SdRoof", { roofType: "pitched", pitchDeg: 30, footprint: [[-5,-4],[5,-4],[5,4],[-5,4]] });

  // Collect actual dims from scene after dispatch
  const dims = await evaluate(`
    (() => {
      const scene = window.__viewer.getScene();
      const openings = [];
      scene.traverse(o => {
        const c = o.userData?.creator;
        if (c !== 'door' && c !== 'window') return;
        openings.push({
          creator: c,
          x: o.position.x,
          y: o.position.y,
          z: o.position.z,           // mesh base z (includes floor elev)
          voidW: o.userData.voidW,
          voidH: o.userData.voidH,
          voidSill: o.userData.voidSill ?? 0,
          levelId: o.userData.levelId,
        });
      });
      return openings;
    })()
  `);
  note(`openings from scene: ${JSON.stringify(dims)}`);
  OPENINGS.push(...(dims ?? []));

  pass("AC3", `house built — ${OPENINGS.length} openings found in scene`);
} catch (e) {
  fail("AC3", `build: ${e.message}`);
}

// ── AC4: Face-absence geometry — 5 openings × wall segments ──────────────────
// For each south-wall opening, check zero wall segment vertices inside shrunk AABB.
// Shrunk by 0.05m per edge to exclude boundary-touching segments (left/right columns,
// sill/header beams that touch the void boundary but don't enter it).

console.log("[sv] AC4: face-absence geometry check");
let geomResults = [];
try {
  const raw = await evaluate(`
    (() => {
      const scene = window.__viewer.getScene();

      // Collect all south-wall Groups (creator wall/SdWall, y≈-4, isGroup)
      const southWalls = [];
      scene.traverse(o => {
        if ((o.userData?.creator !== 'wall' && o.userData?.creator !== 'SdWall') || !o.isGroup) return;
        o.updateMatrixWorld(true);
        // Approximate wall center: mean of children bboxes
        let sumY = 0, count = 0;
        o.children.forEach(c => {
          const geo = c.geometry;
          if (!geo?.attributes?.position) return;
          const pos = geo.attributes.position;
          const mat = c.matrixWorld;
          for (let i = 0; i < pos.count; i++) {
            const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
            sumY += mat.elements[1]*lx + mat.elements[5]*ly + mat.elements[9]*lz + mat.elements[13];
            count++;
          }
        });
        const meanY = count > 0 ? sumY / count : 0;
        if (meanY > -5 && meanY < -3) southWalls.push(o); // y≈-4
      });

      // Collect all opening window/door meshes
      const openingMeshes = [];
      scene.traverse(o => {
        const c = o.userData?.creator;
        if (c !== 'door' && c !== 'window') return;
        openingMeshes.push({
          x: o.position.x,
          z: o.position.z,
          voidW: o.userData.voidW ?? 0.914,
          voidH: o.userData.voidH ?? 2.032,
          voidSill: (c === 'window') ? (o.userData.voidSill ?? 0.9) : 0,
          creator: c,
        });
      });

      if (!southWalls.length) return { error: 'no south wall Groups found' };
      if (!openingMeshes.length) return { error: 'no opening meshes found' };

      const EPS = 0.05; // shrink AABB by this per edge

      const perOpening = [];
      for (const op of openingMeshes) {
        // Door: mesh.position.z = elevation (floor elev); voidCenter z = elev + doorH/2
        // Window: mesh.position.z = floorElev + sill (from buildWindow)
        // For AABB, use actual void z-range:
        const sill = op.voidSill;
        const voidMinX = op.x - op.voidW / 2 + EPS;
        const voidMaxX = op.x + op.voidW / 2 - EPS;
        const voidMinZ = op.z + sill + EPS;
        const voidMaxZ = op.z + sill + op.voidH - EPS;
        // For door: sill=0, so voidMinZ = op.z + 0 + EPS ≈ EPS (floor level)

        let hitCount = 0;
        const hitDetails = [];

        for (const wall of southWalls) {
          wall.children.forEach(child => {
            const geo = child.geometry;
            if (!geo?.attributes?.position) return;
            const pos = geo.attributes.position;
            const mat = child.matrixWorld;
            for (let i = 0; i < pos.count; i++) {
              const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
              const wx = mat.elements[0]*lx + mat.elements[4]*ly + mat.elements[8]*lz + mat.elements[12];
              const wz = mat.elements[2]*lx + mat.elements[6]*ly + mat.elements[10]*lz + mat.elements[14];
              if (wx > voidMinX && wx < voidMaxX && wz > voidMinZ && wz < voidMaxZ) {
                hitCount++;
                if (hitDetails.length < 3) hitDetails.push({ wx: +wx.toFixed(3), wz: +wz.toFixed(3) });
              }
            }
          });
        }

        perOpening.push({
          creator: op.creator,
          x: op.x, z: op.z,
          voidW: op.voidW, voidH: op.voidH,
          aabb: { voidMinX: +voidMinX.toFixed(3), voidMaxX: +voidMaxX.toFixed(3), voidMinZ: +voidMinZ.toFixed(3), voidMaxZ: +voidMaxZ.toFixed(3) },
          hitCount,
          hitSamples: hitDetails,
          pass: hitCount === 0,
        });
      }

      return { southWalls: southWalls.length, openings: openingMeshes.length, perOpening };
    })()
  `, 25000);

  note(`face-absence: southWalls=${raw?.southWalls} openings=${raw?.openings}`);
  geomResults = raw?.perOpening ?? [];
  for (const r of geomResults) {
    note(`  ${r.creator} x=${r.x} z=${r.z}: hits=${r.hitCount} ${r.pass ? 'PASS' : 'FAIL'}`);
    if (!r.pass) note(`    AABB=${JSON.stringify(r.aabb)} samples=${JSON.stringify(r.hitSamples)}`);
  }

  if (raw?.error) throw new Error(raw.error);
  const failed = geomResults.filter(r => !r.pass);
  if (failed.length > 0) {
    throw new Error(`${failed.length} opening(s) have geometry inside void AABB: ${failed.map(r => `${r.creator}@x${r.x} (${r.hitCount} vertices)`).join(", ")}`);
  }
  pass("AC4", `face-absence PASS — 0 wall vertices inside any opening AABB (${geomResults.length} openings checked)`);
} catch (e) {
  fail("AC4", `face-absence: ${e.message}`);
}

// ── AC5: Inside-camera pixel discriminator — through-void vs beside-void ──────
// Camera inside the building looking south. Through-void → exterior (dark).
// Beside-void → teal south wall interior surface. Real cut: dist > 30.

console.log("[sv] AC5: inside-camera pixel discriminator");
let pixResults = [];
try {
  const px = await evaluate(`
    (() => {
      const v = window.__viewer;
      const renderer = v?.renderer;
      const scene    = typeof v?.getScene === 'function' ? v.getScene() : (v?.scene ?? null);
      const camera   = v?.camera;
      if (!renderer || !scene || !camera) return { error: 'viewer not ready' };

      const w = renderer.domElement.width;
      const h = renderer.domElement.height;
      const gl = renderer.getContext();

      // Camera INSIDE ground floor, facing south wall (y=-4)
      camera.position.set(0, 2, 1.5);
      camera.up.set(0, 0, 1);
      if (v.controls) { v.controls.target.set(0, -4, 1.5); v.controls.update(); }
      camera.updateProjectionMatrix?.();
      renderer.render(scene, camera);

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

      // Collect actual dims from scene
      let doorX = 0, doorH = 2.032, doorW = 0.914;
      let win1X = -2, win2X = 2, winSill = 0.9, winH = 1.2, winW = 1;
      scene.traverse(o => {
        if (o.userData?.creator === 'door') { doorX = o.position.x; doorW = o.userData.voidW ?? doorW; doorH = o.userData.voidH ?? doorH; }
        if (o.userData?.creator === 'window' && o.position.x < 0) { win1X = o.position.x; winW = o.userData.voidW ?? winW; winH = o.userData.voidH ?? winH; }
        if (o.userData?.creator === 'window' && o.position.x > 0 && o.position.z < 1) win2X = o.position.x;
      });
      const wallY = -4;

      // For each GF opening: sample through-void center at mid-height, beside-void at same height
      // "beside" = 1m outside door/window edge on the solid wall portion
      const checks = [
        { label: 'door_mid',    voidX: doorX, voidZ: doorH / 2,          besideX: doorX + doorW / 2 + 1.0 },
        { label: 'door_thresh', voidX: doorX, voidZ: 0.15,               besideX: doorX + doorW / 2 + 1.0 },
        { label: 'win1_mid',    voidX: win1X, voidZ: winSill + winH / 2, besideX: win1X - winW / 2 - 1.0 },
        { label: 'win2_mid',    voidX: win2X, voidZ: winSill + winH / 2, besideX: win2X + winW / 2 + 1.0 },
      ];

      const out = [];
      for (const ck of checks) {
        const pV = project(ck.voidX, wallY, ck.voidZ);
        const pB = project(ck.besideX, wallY, ck.voidZ);
        const cV = readPx(pV.cx, pV.cy);
        const cB = readPx(pB.cx, pB.cy);
        const dist = l1(cV, cB);
        out.push({ label: ck.label, voidColor: cV, besideColor: cB, dist, pass: dist > 30 });
      }
      return out;
    })()
  `, 25000);

  pixResults = Array.isArray(px) ? px : [];
  for (const r of pixResults) {
    note(`  ${r.label}: through=${JSON.stringify(r.voidColor)} beside=${JSON.stringify(r.besideColor)} dist=${r.dist} → ${r.pass ? 'PASS' : 'FAIL'}`);
  }

  if (!pixResults.length) throw new Error("no pixel results returned");
  const failedPx = pixResults.filter(r => !r.pass);
  if (failedPx.length > 0) {
    throw new Error(`${failedPx.length} sample(s) show through==beside: ${failedPx.map(r => `${r.label} dist=${r.dist}`).join(", ")}`);
  }
  pass("AC5", `inside-camera pixel PASS — ${pixResults.length} samples all dist > 30 (through-void ≠ beside-wall)`);
} catch (e) {
  fail("AC5", `pixel discriminator: ${e.message}`);
}

// ── AC6: Inside-camera screenshots ────────────────────────────────────────────

async function captureInside(label, camX, camY, camZ, tgtX, tgtY, tgtZ) {
  console.log(`[sv] AC6: screenshot — ${label}`);
  try {
    const b64 = await evaluate(`
      (() => {
        const v = window.__viewer;
        const renderer = v?.renderer;
        const scene    = typeof v?.getScene === 'function' ? v.getScene() : (v?.scene ?? null);
        const camera   = v?.camera;
        if (!renderer || !scene || !camera) return null;
        camera.position.set(${camX}, ${camY}, ${camZ});
        camera.up.set(0, 0, 1);
        if (v.controls) { v.controls.target.set(${tgtX}, ${tgtY}, ${tgtZ}); v.controls.update(); }
        camera.updateProjectionMatrix?.();
        renderer.render(scene, camera);
        const canvas = renderer.domElement;
        try { return canvas.toDataURL('image/jpeg', 0.92).split(',')[1]; } catch(_) { return null; }
      })()
    `, 15000);
    if (!b64) throw new Error("toDataURL null");
    const path = `${STATE_DIR}/${label}.jpg`;
    writeFileSync(path, Buffer.from(b64, "base64"));
    note(`${label}: saved (${Buffer.from(b64, "base64").length} bytes)`);
    return true;
  } catch (e) {
    note(`${label}: FAILED — ${e.message}`);
    return false;
  }
}

// Inside GF looking south — shows door + 2 windows as voids
const gfOk  = await captureInside("inside-gf-south",   3,  2, 1.5,  0, -4, 1.5);
// Inside L2 looking south — shows 2 L2 windows as voids
const l2Ok  = await captureInside("inside-l2-south",   3,  2, 4.5,  0, -4, 4.5);
// Low angle from inside at door threshold showing floor through door
const lowOk = await captureInside("inside-gf-thresh",  3,  2, 0.3,  0, -4, 0.3);
// Outside angled shot for context (same as Leo asked for)
const extOk = await captureInside("outside-angled",    4, -8,   3,  0, -4, 1.5);

const shots = [gfOk, l2Ok, lowOk, extOk].filter(Boolean).length;
if (shots === 4) {
  pass("AC6", "4/4 inside-camera screenshots captured");
} else {
  fail("AC6", `only ${shots}/4 screenshots captured`);
}

ws.close();

// ── Result collation ──────────────────────────────────────────────────────────

function writeResults() {
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const cert = {
    script: "verify-house-south-voids.mjs",
    issue: 33,
    gate: "Leo mail #13087 — south-wall openings leg: face-absence + inside-camera discriminator",
    cold_cache: true,
    clear_protocol: "Network.clearBrowserCache + Storage.clearDataForOrigin + caches.delete",
    url: PAGES_URL,
    timestamp: new Date().toISOString(),
    results,
    geometry: geomResults,
    pixels: pixResults,
    methodology: {
      option_b: "face-absence: zero wall vertices inside shrunk opening AABB (±0.05m per edge)",
      option_a: "inside-camera from (3,2,1.5) facing (0,-4,1.5); through-void=exterior, beside=teal wall",
      why_inside: "from inside, void→exterior(dark) vs beside→teal wall gives unambiguous discriminator even for enclosed buildings",
      why_shrunk_aabb: "shrink by 0.05m per edge excludes boundary-touching sill/header/column segments",
    },
    summary: { passed, failed, total: results.length },
  };
  writeFileSync(`${STATE_DIR}/cert.json`, JSON.stringify(cert, null, 2));
  console.log(`\n[sv] ${passed}/${results.length} PASS · ${failed} FAIL → ${STATE_DIR}/cert.json`);
}

writeResults();
process.exit(results.some(r => !r.pass) ? 1 : 0);
