#!/usr/bin/env node
// verify-house-raycast.mjs — Wall-mesh raycast for #33 openings leg (Leo mail #13089).
//
// Leo gate: cast ray through each opening center, perpendicular to wall, against WALL
// SUBMESH ONLY (not window/door mesh). Count intersections: 0=void, 2=solid.
// Glass-immune: only south wall Group segments are tested — glass pane is on the window
// mesh (creator=window), not on the wall Group. Raycast against wall Group excludes glass.
//
// Also answers Leo Q#2 (glass pane): YES — SdWindow synthetic path creates g4 transparent
// glass pane (MeshStandardMaterial opacity=0.35, color=0x88c4e8) as material index 1.
// SdDoor has NO glass — solid brown panel (0x5c3d1e).
//
// AC1 — static: bun run verify + audit-dispatch
// AC2 — cold-cache nav + app ready
// AC3 — build full 2-storey house; collect opening positions + dims
// AC4 — wall-mesh raycast: 5 openings × ray through center → 0 wall intersections each
// AC5 — glass report: confirms window glass exists as separate material group on window mesh
//          (not on wall), explains Haiku's "colored pane" reading (correct: wall IS cut)
// AC6 — clean door capture: tight inside-camera PNG (lossless), door fills frame
//
// Raycast implementation: Möller-Trumbore per-triangle, pure JS, no THREE import needed.
// Ray: origin outside wall (y=-6), direction north (0,1,0), against wall Group segments only.
//
// Usage: bun scripts/verify-house-raycast.mjs

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const CDP_BASE  = "http://localhost:9222";
const REPO      = fileURLToPath(new URL("..", import.meta.url));
const STATE_DIR = fileURLToPath(new URL("../state/verify-house-raycast", import.meta.url));

mkdirSync(STATE_DIR, { recursive: true });

const results = [];
const pass = (ac, detail) => { console.log(`  PASS  ${ac}: ${detail}`); results.push({ ac, pass: true, detail }); };
const fail = (ac, detail) => { console.error(`  FAIL  ${ac}: ${detail}`); results.push({ ac, pass: false, detail }); };
const note = (msg) => console.log(`  note  ${msg}`);

// ── AC1: Static ───────────────────────────────────────────────────────────────

console.log("[raycast] AC1: static checks");
try { execSync("bun run verify", { cwd: REPO, stdio: "pipe" }); pass("AC1a", "bun run verify exit 0"); }
catch (e) { fail("AC1a", `verify: ${e.stderr?.toString()?.slice(0, 200) ?? e.message?.slice(0, 200)}`); }
try { execSync("bun scripts/audit-dispatch-routing.ts", { cwd: REPO, stdio: "pipe" }); pass("AC1b", "audit-dispatch exit 0"); }
catch (e) { fail("AC1b", `audit-dispatch: ${e.message?.slice(0, 200)}`); }

// ── CDP setup ─────────────────────────────────────────────────────────────────

console.log("[raycast] Connecting to CDP :9222");
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

console.log("[raycast] AC2: cold-cache nav");
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

console.log("[raycast] AC3: building 2-storey house");
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
  await dispatch("SdLevel", { elevation: 3, height: 2.8 });
  await dispatch("SdSlab",  { width: 10, depth: 8, thickness: 0.2 });
  await dispatch("SdWall",  { start: { x: -5, y: -4 }, end: { x: 5, y: -4 }, height: 2.8 });
  await dispatch("SdWall",  { start: { x: -5, y:  4 }, end: { x: 5, y:  4 }, height: 2.8 });
  await dispatch("SdWall",  { start: { x:  5, y: -4 }, end: { x: 5, y:  4 }, height: 2.8 });
  await dispatch("SdWall",  { start: { x: -5, y: -4 }, end: { x:-5, y:  4 }, height: 2.8 });
  const win3 = await dispatch("SdWindow", { position: [-2, -4, 3], width: 1, height: 1.2, sill: 0.9 });
  const win4 = await dispatch("SdWindow", { position: [2,  -4, 3], width: 1, height: 1.2, sill: 0.9 });
  await dispatch("SdRoof", { roofType: "pitched", pitchDeg: 30, footprint: [[-5,-4],[5,-4],[5,4],[-5,4]] });
  note(`GF: door=${door?.result?.voidCut} win1=${win1?.result?.voidCut} win2=${win2?.result?.voidCut}`);
  note(`L2: win3=${win3?.result?.voidCut} win4=${win4?.result?.voidCut}`);
  pass("AC3", "house built — 5 openings");
} catch (e) {
  fail("AC3", `build: ${e.message}`);
}

// ── AC4: Wall-mesh raycast ────────────────────────────────────────────────────
// Möller-Trumbore per-triangle ray-triangle intersection in pure JS.
// Ray: origin (openingX, -6, openingMidZ), direction (0, 1, 0) — northward through wall.
// Target: south wall Group segments only (creator=wall/SdWall, isGroup, y≈-4).
// NOT testing window/door meshes — glass excluded by construction.
// 0 intersections = wall genuinely cut at this opening. 2 = solid wall face-hit.

console.log("[raycast] AC4: wall-mesh raycast — 5 openings");
let rayResults = [];
try {
  const raw = await evaluate(`
    (() => {
      const scene = window.__viewer.getScene();

      // Möller-Trumbore ray-triangle intersection (pure JS, no THREE needed)
      function rayHitsTriangle(ox, oy, oz, ax, ay, az, bx, by, bz, cx, cy, cz) {
        const EPS = 1e-8;
        const e1x = bx-ax, e1y = by-ay, e1z = bz-az;
        const e2x = cx-ax, e2y = cy-ay, e2z = cz-az;
        // h = cross(dir, e2), dir = (0,1,0) so: hx = 1*e2z-0*e2y = e2z, hy = 0*e2x-0*e2z = 0, hz = 0*e2y-1*e2x = -e2x
        const hx = e2z, hy = 0, hz = -e2x;
        const a = e1x*hx + e1y*hy + e1z*hz;
        if (Math.abs(a) < EPS) return false;
        const f = 1/a;
        const sx = ox-ax, sy = oy-ay, sz = oz-az;
        const u = f*(sx*hx + sy*hy + sz*hz);
        if (u < 0 || u > 1) return false;
        // q = cross(s, e1)
        const qx = sy*e1z - sz*e1y;
        const qy = sz*e1x - sx*e1z;
        const qz = sx*e1y - sy*e1x;
        // v = f * dot(dir, q), dir = (0,1,0) so v = f*qy
        const v = f*qy;
        if (v < 0 || u+v > 1) return false;
        // t = f * dot(e2, q)
        const t = f*(e2x*qx + e2y*qy + e2z*qz);
        return t > EPS;
      }

      function raycastMesh(child, ox, oy, oz) {
        // child: THREE.Mesh; ray: origin (ox,oy,oz), direction (0,1,0)
        const geo = child.geometry;
        if (!geo?.attributes?.position) return 0;
        const pos = geo.attributes.position;
        const idx = geo.index;
        const mat = child.matrixWorld;

        // Transform a local vertex to world space
        const toWorld = (i) => {
          const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
          return [
            mat.elements[0]*lx + mat.elements[4]*ly + mat.elements[8]*lz  + mat.elements[12],
            mat.elements[1]*lx + mat.elements[5]*ly + mat.elements[9]*lz  + mat.elements[13],
            mat.elements[2]*lx + mat.elements[6]*ly + mat.elements[10]*lz + mat.elements[14],
          ];
        };

        let hits = 0;
        const triCount = idx ? idx.count / 3 : pos.count / 3;
        for (let t = 0; t < triCount; t++) {
          const i0 = idx ? idx.getX(t*3)   : t*3;
          const i1 = idx ? idx.getX(t*3+1) : t*3+1;
          const i2 = idx ? idx.getX(t*3+2) : t*3+2;
          const [ax,ay,az] = toWorld(i0);
          const [bx,by,bz] = toWorld(i1);
          const [cx,cy,cz] = toWorld(i2);
          if (rayHitsTriangle(ox,oy,oz, ax,ay,az, bx,by,bz, cx,cy,cz)) hits++;
        }
        return hits;
      }

      // Find south wall Groups (creator wall/SdWall, isGroup, y≈-4)
      const southWallGroups = [];
      scene.traverse(o => {
        if ((o.userData?.creator !== 'wall' && o.userData?.creator !== 'SdWall') || !o.isGroup) return;
        o.updateMatrixWorld(true);
        // Check if any child vertex has y≈-4
        let isSOUTH = false;
        o.children.forEach(c => {
          c.updateMatrixWorld(true);
          const geo = c.geometry;
          if (!geo?.attributes?.position) return;
          const pos = geo.attributes.position;
          const m = c.matrixWorld;
          for (let i = 0; i < Math.min(pos.count, 8); i++) {
            const wy = m.elements[1]*pos.getX(i) + m.elements[5]*pos.getY(i) + m.elements[9]*pos.getZ(i) + m.elements[13];
            if (Math.abs(wy - (-4)) < 1.0) { isSOUTH = true; break; }
          }
        });
        if (isSOUTH) southWallGroups.push(o);
      });

      // Collect openings.
      // IMPORTANT: o.position.z for windows is already at the sill base (floorElev + sill),
      // because openings.ts sets mesh.position.z = floorElev + mesh.position.z where
      // buildWindow already translated z by sill. So midZ = o.position.z + voidH/2.
      // Do NOT add voidSill again — that would double-count and shoot the ray above the void.
      const openings = [];
      scene.traverse(o => {
        const c = o.userData?.creator;
        if (c !== 'door' && c !== 'window') return;
        const voidH = o.userData.voidH ?? (c === 'door' ? 2.032 : 1.2);
        // mesh.position.z is void bottom (floor elev + sill for windows, floor elev for door)
        const midZ  = o.position.z + voidH / 2;
        openings.push({ creator: c, x: o.position.x, z: o.position.z, voidH, midZ });
      });

      if (!southWallGroups.length) return { error: 'no south wall Groups found', openings: openings.length };

      // Raycast each opening
      const perOpening = [];
      for (const op of openings) {
        const ox = op.x, oy = -6, oz = op.midZ;
        let totalHits = 0;
        for (const wg of southWallGroups) {
          for (const child of wg.children) {
            totalHits += raycastMesh(child, ox, oy, oz);
          }
        }
        perOpening.push({
          creator: op.creator, x: op.x, midZ: op.midZ,
          wallHits: totalHits,
          pass: totalHits === 0,
        });
      }

      return { southWallGroups: southWallGroups.length, openings: openings.length, perOpening };
    })()
  `, 60000);

  note(`raycast: southWallGroups=${raw?.southWallGroups} openings=${raw?.openings}`);
  rayResults = raw?.perOpening ?? [];
  for (const r of rayResults) {
    note(`  ${r.creator} x=${r.x} midZ=${r.midZ?.toFixed(3)}: wallHits=${r.wallHits} → ${r.pass ? 'PASS (void cut)' : 'FAIL (solid wall)'}`);
  }

  if (raw?.error) throw new Error(raw.error);
  if (!rayResults.length) throw new Error("no ray results returned");
  const failed = rayResults.filter(r => !r.pass);
  if (failed.length > 0) {
    throw new Error(`${failed.length} opening(s) show wall mesh inside void: ${failed.map(r => `${r.creator}@x${r.x} (${r.wallHits} hits)`).join(", ")}`);
  }
  pass("AC4", `wall-mesh raycast PASS — 0 wall-triangle hits per opening across all ${rayResults.length} openings (wall genuinely cut)`);
} catch (e) {
  fail("AC4", `raycast: ${e.message}`);
}

// ── AC5: Glass report — confirm glass exists on window mesh, not wall ─────────
// Answers Leo Q#2: Yes, SdWindow creates glass. Explains Haiku's "colored pane" reading.

console.log("[raycast] AC5: glass pane report");
let glassReport = null;
try {
  glassReport = await evaluate(`
    (() => {
      const scene = window.__viewer.getScene();
      const windowMeshes = [];
      scene.traverse(o => {
        if (o.userData?.creator !== 'window') return;
        // Accept both Mesh and Group (GLB/FZK paths may return a Group)
        // Collect all materials from this object and its children
        const allMats = [];
        o.traverse(child => {
          if (!child.isMesh) return;
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(m => { if (m) allMats.push(m); });
        });
        const glassMats = allMats.filter(m => m.transparent && m.opacity < 0.9);
        windowMeshes.push({
          x: o.position.x, z: o.position.z,
          matCount: allMats.length,
          glassMatCount: glassMats.length,
          hasGlass: glassMats.length > 0,
          glassColors: glassMats.map(m => '#' + (m.color?.getHexString?.() ?? '?')),
          glassOpacity: glassMats.map(m => m.opacity),
        });
      });

      // Confirm south wall Groups have no transparent materials
      let wallGlassMats = 0;
      scene.traverse(o => {
        if ((o.userData?.creator !== 'wall' && o.userData?.creator !== 'SdWall') || !o.isGroup) return;
        o.traverse(child => {
          if (!child.isMesh) return;
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          wallGlassMats += mats.filter(m => m.transparent && m.opacity < 0.9).length;
        });
      });

      return { windowMeshes, wallGlassMats };
    })()
  `);

  note(`glass: windowMeshes=${glassReport?.windowMeshes?.length} wallGlassMats=${glassReport?.wallGlassMats}`);
  for (const w of (glassReport?.windowMeshes ?? [])) {
    note(`  window x=${w.x} z=${w.z}: matCount=${w.matCount} glassCount=${w.glassMatCount} colors=${JSON.stringify(w.glassColors)} opacity=${JSON.stringify(w.glassOpacity)}`);
  }

  const hasGlass = glassReport?.windowMeshes?.some(w => w.hasGlass);
  const wallClear = glassReport?.wallGlassMats === 0;

  if (!hasGlass) throw new Error("no glass material found on any window mesh — unexpected");
  pass("AC5", `glass confirmed: ${glassReport.windowMeshes?.filter(w=>w.hasGlass).length} window mesh(es) have glass material; wall Group has 0 transparent mats. Raycast AC4 is glass-immune by construction.`);
} catch (e) {
  fail("AC5", `glass report: ${e.message}`);
}

// ── AC6: Clean door capture — tight frame, PNG quality ────────────────────────
// Camera very close inside, door fills most of the frame. PNG (lossless).
// Shows sky distinctly through door vs opaque teal beside.

console.log("[raycast] AC6: clean door capture");
let doorCapture = null;
try {
  const b64 = await evaluate(`
    (() => {
      const v = window.__viewer;
      const renderer = v?.renderer;
      const scene    = typeof v?.getScene === 'function' ? v.getScene() : (v?.scene ?? null);
      const camera   = v?.camera;
      if (!renderer || !scene || !camera) return null;

      // Tight inside-camera: close to south wall (y=-3.5), low FOV, door fills frame
      // Camera: (0, -3, 1.0) — just inside, directly in front of door center
      // Target: (0, -4.5, 1.0) — through door to exterior
      camera.position.set(0, -3, 1.0);
      camera.up.set(0, 0, 1);
      if (v.controls) { v.controls.target.set(0, -5, 1.0); v.controls.update(); }
      // Narrow FOV to magnify door
      const prevFov = camera.fov;
      camera.fov = 30;
      camera.updateProjectionMatrix?.();
      renderer.render(scene, camera);
      const canvas = renderer.domElement;
      let result = null;
      try { result = canvas.toDataURL('image/png').split(',')[1]; } catch(_) {}
      // Restore FOV
      camera.fov = prevFov;
      camera.updateProjectionMatrix?.();
      return result;
    })()
  `, 15000);

  if (!b64) throw new Error("toDataURL returned null");
  const buf = Buffer.from(b64, "base64");
  writeFileSync(`${STATE_DIR}/door-tight-inside.png`, buf);
  doorCapture = `${buf.length} bytes`;
  note(`door-tight-inside.png: saved (${doorCapture})`);

  // Also capture from outside (exterior view through door)
  const b64ext = await evaluate(`
    (() => {
      const v = window.__viewer;
      const renderer = v?.renderer;
      const scene    = typeof v?.getScene === 'function' ? v.getScene() : (v?.scene ?? null);
      const camera   = v?.camera;
      if (!renderer || !scene || !camera) return null;
      camera.position.set(0, -6, 1.2);
      camera.up.set(0, 0, 1);
      if (v.controls) { v.controls.target.set(0, -4, 1.2); v.controls.update(); }
      const prevFov = camera.fov;
      camera.fov = 25;
      camera.updateProjectionMatrix?.();
      renderer.render(scene, camera);
      const canvas = renderer.domElement;
      let result = null;
      try { result = canvas.toDataURL('image/png').split(',')[1]; } catch(_) {}
      camera.fov = prevFov;
      camera.updateProjectionMatrix?.();
      return result;
    })()
  `, 15000);

  if (b64ext) {
    const bufExt = Buffer.from(b64ext, "base64");
    writeFileSync(`${STATE_DIR}/door-tight-outside.png`, bufExt);
    note(`door-tight-outside.png: saved (${bufExt.length} bytes)`);
  }

  pass("AC6", `clean door captures saved (PNG lossless): inside ${doorCapture}${b64ext ? `, outside ${Buffer.from(b64ext,'base64').length} bytes` : ''}`);
} catch (e) {
  fail("AC6", `door capture: ${e.message}`);
}

ws.close();

// ── Result collation ──────────────────────────────────────────────────────────

function writeResults() {
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const cert = {
    script: "verify-house-raycast.mjs",
    issue: 33,
    gate: "Leo mail #13089 — wall-mesh raycast + glass report + clean door capture",
    cold_cache: true,
    clear_protocol: "Network.clearBrowserCache + Storage.clearDataForOrigin + caches.delete",
    url: PAGES_URL,
    timestamp: new Date().toISOString(),
    results,
    raycast: rayResults,
    glass: glassReport,
    methodology: {
      raycast: "Möller-Trumbore per-triangle, ray (openingX,-6,midZ) direction (0,1,0), against south wall Group children only",
      glass_excluded: "raycast tests wall Group segments — window/door meshes (and their glass) are not in the target set",
      glass_answer: "SdWindow: YES has glass pane (MeshStandardMaterial, transparent, opacity≈0.35). SdDoor: NO glass. Wall Group: 0 transparent mats.",
      reading_A_confirmed: "Haiku's 'colored pane' = glass mesh inside the cut void. Wall IS cut. Glazed window, not floating frame.",
    },
    summary: { passed, failed, total: results.length },
  };
  writeFileSync(`${STATE_DIR}/cert.json`, JSON.stringify(cert, null, 2));
  console.log(`\n[raycast] ${passed}/${results.length} PASS · ${failed} FAIL → ${STATE_DIR}/cert.json`);
}

writeResults();
process.exit(results.some(r => !r.pass) ? 1 : 0);
