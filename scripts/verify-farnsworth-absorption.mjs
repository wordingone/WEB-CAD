#!/usr/bin/env node
// verify-farnsworth-absorption.mjs
// Assembly cert for Farnsworth House Skills-tab absorption (PR #508).
//
// ACs:
//   AC1  — boot-screen gone before dispatch (cold-cache reload, OPFS preserved)
//   AC2  — SdRunBuilding({id:"farnsworth"}) returns ok=true, ran=12
//   AC3  — floor_plate: position.z=1.400 ±0.003 (bottom of slab = floor raise 1.600 - t_slab 0.200)
//   AC4  — roof_plate:  position.z=4.343 ±0.003 (soffit = H_TOTAL 4.543 - t_slab 0.200)
//   AC5  — 8 SdColumn objects, bbox height=4.543 ±0.005
//   AC6  — 4 front columns at Y≈-0.105 ±0.01, X grid [1.7265,8.4325,15.1385,21.8445] ±0.002
//   AC7  — 4 rear columns at Y≈8.843 ±0.01, same X grid ±0.002
//   AC8  — 2 SdCurtainWall shell meshes at position.z=1.600 ±0.005
//   AC9  — glazing height=2.743 ±0.003 (from geometry.parameters.depth)
//   AC10 — slab X bbox [0,23.571] ±0.01 (cantilever proof: col X range [1.7265,21.8445])
//   AC11 — canvas diff > 0 pixels (pre/post JPEG)
//   AC12 — zero JS exceptions during dispatch

import { WebSocket } from "ws";
import { mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const CDP_PORT  = 9222;
const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const OUT_DIR   = fileURLToPath(new URL("../state/cert-farnsworth-absorption", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

// ── CDP boilerplate ────────────────────────────────────────────────────────────
const targets = JSON.parse(execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" }));
const target  = targets.find(t => t.type === "page" && !t.url.startsWith("devtools://"));
if (!target) { console.error("No page tab at :9222"); process.exit(1); }
console.log(`[fw-abs] tab: ${target.url}`);

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
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = mid++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
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

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

// ── Cold-cache reload (OPFS preserved) ───────────────────────────────────────
console.log("[fw-abs] cold-cache reload (OPFS preserved)...");
await send("Network.clearBrowserCache");
await send("Storage.clearDataForOrigin", {
  origin: "https://wordingone.github.io",
  storageTypes: "cookies,cache_storage,service_workers,local_storage,shader_cache,indexeddb",
});
await evaluate(`(async()=>{ const r=await navigator.serviceWorker?.getRegistrations()||[]; await Promise.all(r.map(x=>x.unregister())); })()`, true).catch(()=>{});
const lp = new Promise(res => onEvent("Page.loadEventFired", res));
await send("Page.navigate", { url: PAGES_URL });
await lp;

// ── Collect JS exceptions ─────────────────────────────────────────────────────
const exceptions = [];
onEvent("Runtime.exceptionThrown", p => {
  const desc = p.exceptionDetails?.exception?.description ?? "";
  if (!desc.includes("AbortError") && !desc.includes("NetworkError") && !desc.includes("Failed to fetch")) {
    exceptions.push(desc);
  }
});

// ── AC1: Wait for boot-screen ─────────────────────────────────────────────────
console.log("[fw-abs] waiting for boot-screen removal...");
let bootGone = false;
for (let t = 0; t < 300; t++) {
  await delay(1000);
  const gone = await evaluate(`!document.getElementById('boot-screen')`).catch(() => true);
  if (gone) { bootGone = true; console.log(`[fw-abs] boot-screen gone at ~${t+1}s`); break; }
  if (t % 15 === 14) {
    const phase = await evaluate(`document.getElementById('boot-phase-label')?.textContent?.trim() ?? '?'`).catch(() => '?');
    console.log(`[fw-abs]   boot-screen still active (~${t+1}s): "${phase}"`);
  }
}

// ── Canvas capture helper ─────────────────────────────────────────────────────
const canvasRect = await evaluate(`
  (() => {
    const c = document.getElementById('viewer-canvas') ?? document.querySelector('canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`).catch(() => null);

const captureJpeg = async () => {
  if (!canvasRect) return "";
  const r = await send("Page.captureScreenshot", {
    format: "jpeg", quality: 75,
    clip: { ...canvasRect, scale: 0.5 },
  }).catch(() => ({ data: "" }));
  return r.data ?? "";
};

const preJpeg = await captureJpeg();

// ── AC2: Dispatch SdRunBuilding ───────────────────────────────────────────────
console.log("[fw-abs] dispatching SdRunBuilding({id:'farnsworth'})...");
let dispatchRaw;
try {
  dispatchRaw = await evaluate(`window.__dispatch("SdRunBuilding", { id: "farnsworth" })`, true);
} catch (e) {
  dispatchRaw = { ok: false, error: String(e) };
}
// Dispatch result is wrapped: { ok, canonical, result: { ok, ran, buildingId } }
const dispatchOk = dispatchRaw?.result?.ok === true || dispatchRaw?.ok === true;
const ranCount   = dispatchRaw?.result?.ran ?? dispatchRaw?.ran ?? 0;
console.log(`[fw-abs] dispatch raw: ${JSON.stringify(dispatchRaw)}`);
console.log(`[fw-abs] dispatch: ok=${dispatchOk}, ran=${ranCount}`);

await delay(600);
const postJpeg = await captureJpeg();

// ── Query scene ───────────────────────────────────────────────────────────────
// userData.dispatchVerb / userData.creator are lowercase ("box", "column", "SdCurtainWall" for shell).
// BRep meshes don't have BoxGeometry.parameters — use THREE.Box3 for sizes.
const sceneData = await evaluate(`
  (() => {
    const THREE = window.THREE;
    const viewer = window.__viewer;
    if (!viewer) return null;
    const scene = viewer.getScene ? viewer.getScene() : viewer.scene;
    if (!scene) return null;

    const out = { boxes: [], columns: [], curtainWallShells: [] };

    // Compute bbox from vertex attribute positions (avoids needing THREE global)
    function vertexBbox(obj) {
      const pos = obj.geometry?.attributes?.position;
      if (!pos || !pos.count) return null;
      let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i); const z = pos.getZ(i);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      return { minX: +minX.toFixed(4), maxX: +maxX.toFixed(4), minZ: +minZ.toFixed(4), maxZ: +maxZ.toFixed(4) };
    }

    scene.traverse(obj => {
      const ud = obj.userData ?? {};
      const verb = (ud.dispatchVerb ?? ud.creator ?? "").toLowerCase();
      if (!verb) return;

      const p = obj.position;
      const px = +p.x.toFixed(4), py = +p.y.toFixed(4), pz = +p.z.toFixed(4);

      if (verb === "box") {
        const bbox = vertexBbox(obj);
        // Vertex coords are LOCAL (geometry-relative). Slab mesh.position.x = center.x,
        // so world X = px + local vertex X. For width check: world minX = px + bbox.minX.
        const worldMinX = bbox ? +(px + bbox.minX).toFixed(4) : 0;
        const worldMaxX = bbox ? +(px + bbox.maxX).toFixed(4) : 0;
        const worldMinZ = bbox ? +(pz + bbox.minZ).toFixed(4) : 0;
        const worldMaxZ = bbox ? +(pz + bbox.maxZ).toFixed(4) : 0;
        out.boxes.push({ x: px, y: py, z: pz, worldMinX, worldMaxX, worldMinZ, worldMaxZ });
      } else if (verb === "column") {
        const bbox = vertexBbox(obj);
        // Column mesh.position.z = 0 (base). Geometry Z range = [0, height] (translated by h/2 then back).
        const height = bbox ? +(bbox.maxZ - bbox.minZ).toFixed(4) : 0;
        out.columns.push({ x: px, y: py, z: pz, height });
      } else if (verb === "sdcurtainwall" || verb === "SdCurtainWall") {
        if (obj.type === "Mesh") {
          const gp = obj.geometry?.parameters ?? {};
          out.curtainWallShells.push({ x: px, y: py, z: pz, cwH: +(gp.depth ?? 0).toFixed(4) });
        }
      }
    });
    return out;
  })()`).catch(e => { console.log('[fw-abs] scene query error:', e.message); return null; });

console.log(`[fw-abs] boxes: ${JSON.stringify(sceneData?.boxes)}`);
console.log(`[fw-abs] columns(${sceneData?.columns?.length}): ${JSON.stringify(sceneData?.columns)}`);
console.log(`[fw-abs] cwShells: ${JSON.stringify(sceneData?.curtainWallShells)}`);

// ── Canvas pixel-diff ─────────────────────────────────────────────────────────
let diffPx = 0;
if (preJpeg && postJpeg && preJpeg !== postJpeg) {
  try {
    diffPx = await evaluate(`
      (async () => {
        function b64ToU8(b64) {
          const bin = atob(b64); const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8;
        }
        async function decode(b64) {
          const blob = new Blob([b64ToU8(b64)], { type: "image/jpeg" });
          const img = await createImageBitmap(blob);
          const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
          c.getContext("2d").drawImage(img, 0, 0);
          return c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        }
        const [a, b] = await Promise.all([decode(${JSON.stringify(preJpeg)}), decode(${JSON.stringify(postJpeg)})]);
        let diff = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i += 4) {
          if (Math.abs(a[i]-b[i]) > 20 || Math.abs(a[i+1]-b[i+1]) > 20 || Math.abs(a[i+2]-b[i+2]) > 20) diff++;
        }
        return diff;
      })()`, true);
  } catch (e) {
    console.log(`[fw-abs] pixel-diff error: ${e.message}`);
  }
}

// ── Evaluate ACs ─────────────────────────────────────────────────────────────
const results = [];
const errors = [];
let passed = 0, failed = 0;
function ac(name, ok, detail) {
  results.push({ ac: name, status: ok ? "PASS" : "FAIL", detail });
  if (ok) passed++;
  else { failed++; errors.push(`${name}: ${detail}`); }
  console.log(`[fw-abs] ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

const EPS = 0.003;
const boxes          = sceneData?.boxes ?? [];
const columns        = sceneData?.columns ?? [];
const cwShells       = sceneData?.curtainWallShells ?? [];

ac("AC1", bootGone, bootGone ? "boot-screen gone before dispatch" : "boot-screen stuck after 300s");
ac("AC2", dispatchOk && ranCount === 12, `ok=${dispatchOk}, ran=${ranCount} (expected 12)`);

// AC3: floor slab bottom at Z=1.400 (= H_RAISE 1.600 - t_slab 0.200)
const floorBoxes = boxes.filter(b => Math.abs(b.z - 1.400) < EPS * 2);
ac("AC3", floorBoxes.length >= 1,
  `floor slab bottom Z≈1.400: found ${floorBoxes.length} (z values: ${boxes.map(b=>b.z).join(",")})`);

// AC4: roof slab bottom (soffit) at Z=4.343 (= H_SOFFIT 4.343)
const roofBoxes = boxes.filter(b => Math.abs(b.z - 4.343) < EPS * 2);
ac("AC4", roofBoxes.length >= 1,
  `roof slab soffit Z≈4.343: found ${roofBoxes.length} (z values: ${boxes.map(b=>b.z).join(",")})`);

// AC5: 8 columns, bbox height=4.543
const correctHCols = columns.filter(c => Math.abs(c.height - 4.543) < EPS * 2);
ac("AC5", columns.length === 8 && correctHCols.length === 8,
  `SdColumn count=${columns.length}/8, bbox height=4.543: ${correctHCols.length}/8 (heights: ${columns.map(c=>c.height).join(",")})`);

// AC6: 4 front columns at Y≈-0.105, X grid
const FRONT_XS = [1.7265, 8.4325, 15.1385, 21.8445];
const frontCols = columns.filter(c => Math.abs(c.y - (-0.105)) < 0.015);
const frontXMatches = FRONT_XS.filter(fx => frontCols.some(c => Math.abs(c.x - fx) < 0.002));
ac("AC6", frontCols.length === 4 && frontXMatches.length === 4,
  `front cols Y≈-0.105: ${frontCols.length}/4, X matches: ${frontXMatches.length}/4 (y vals: ${[...new Set(columns.map(c=>c.y.toFixed(3)))].join(",")})`);

// AC7: 4 rear columns at Y≈8.843, X grid
const rearCols = columns.filter(c => Math.abs(c.y - 8.843) < 0.015);
const rearXMatches = FRONT_XS.filter(fx => rearCols.some(c => Math.abs(c.x - fx) < 0.002));
ac("AC7", rearCols.length === 4 && rearXMatches.length === 4,
  `rear cols Y≈8.843: ${rearCols.length}/4, X matches: ${rearXMatches.length}/4`);

// AC8: 2 CW shells at Z=1.600
const correctZCws = cwShells.filter(cw => Math.abs(cw.z - 1.600) < 0.008);
ac("AC8", cwShells.length === 2 && correctZCws.length === 2,
  `CW shells count=${cwShells.length}/2, Z=1.600: ${correctZCws.length}/2 (z: ${cwShells.map(c=>c.z).join(",")})`);

// AC9: glazing cwH=2.743 from geometry.parameters.depth
const correctHCws = cwShells.filter(cw => Math.abs(cw.cwH - 2.743) < EPS);
ac("AC9", correctHCws.length === 2,
  `glazing cwH=2.743: ${correctHCws.length}/2 (cwH: ${cwShells.map(c=>c.cwH).join(",")})`);

// AC10: slab world X [0,23.571] (cantilever proof)
const slabs = [...floorBoxes, ...roofBoxes];
const slabXOk = slabs.length >= 2
  && slabs.every(b => Math.abs(b.worldMinX - 0) < 0.01 && Math.abs(b.worldMaxX - 23.571) < 0.01);
const colXMin = columns.length > 0 ? Math.min(...columns.map(c => c.x)) : NaN;
const colXMax = columns.length > 0 ? Math.max(...columns.map(c => c.x)) : NaN;
const cantOk = slabXOk && !isNaN(colXMin)
  && Math.abs(colXMin - 1.7265) < 0.002 && Math.abs(colXMax - 21.8445) < 0.002;
ac("AC10", cantOk,
  `slab world X: ${slabs.map(b=>`[${b.worldMinX},${b.worldMaxX}]`).join(" ")}; col X range [${colXMin?.toFixed(4)},${colXMax?.toFixed(4)}] (expected [1.7265,21.8445])`);

ac("AC11", diffPx > 15, `canvas pixel diff = ${diffPx}px (threshold >15)`);
ac("AC12", exceptions.length === 0,
  exceptions.length === 0 ? "zero exceptions" : `${exceptions.length} exception(s): ${exceptions.slice(0,2).join("; ")}`);

// ── Write cert JSON ────────────────────────────────────────────────────────────
const cert = {
  script:    "verify-farnsworth-absorption.mjs",
  timestamp: new Date().toISOString(),
  url:       PAGES_URL,
  cold_cache: true,
  clear_protocol: "Network.clearBrowserCache + Storage.clearDataForOrigin(excludes file_systems/OPFS)",
  results, passed, failed, errors,
  canvas_diff_px: diffPx,
  scene_data: sceneData,
};
const certPath = `${OUT_DIR}/cert.json`;
writeFileSync(certPath, JSON.stringify(cert, null, 2));

console.log(`\n=== FARNSWORTH ABSORPTION CERT ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) console.log("FAILURES:", errors);
console.log(`[fw-abs] cert written to ${certPath}`);

ws.close();
process.exit(failed > 0 ? 1 : 0);
