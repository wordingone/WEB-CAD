#!/usr/bin/env node
// verify-500-501.mjs — cert for #500 (SdColumn face_m/depth_m/height_m) and
// #501 (SdCurtainWall height_m/elevation_m) on deployed Pages cold-cache.
//
// ACs:
//  AC1: SdColumn{face_m:0.203,depth_m:0.210,height_m:4.543} → bbox 0.203×0.210×4.543 (±TOL)
//  AC2: SdColumn{} (no params) → bbox 0.3×0.3×4.0 (backward-compat)
//  AC3: SdCurtainWall{start:[0,0],end:[8,0],height_m:2.743,elevation_m:1.600}
//       → shell height=2.743, position.z=1.600, glazing Z=[1.600,4.343]
//  AC4: SdCurtainWall{start:[0,2],end:[8,2]} (no params) → shell height=3, position.z=0
//  AC5: zero JS exceptions across all dispatches

import { WebSocket } from "ws";
import { mkdirSync, writeFileSync } from "fs";
import { execSync }                from "child_process";
import { fileURLToPath }           from "url";

const CDP_PORT  = 9222;
const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const TOL       = 1e-3;
const OUT_DIR   = fileURLToPath(new URL("../state/cert-500-501", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

// ── CDP boilerplate ────────────────────────────────────────────────────────────
const targets = JSON.parse(execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" }));
const target  = targets.find(t => t.type === "page" && !t.url.startsWith("devtools://"));
if (!target) { console.error("No page tab at :9222"); process.exit(1); }
console.log(`[v500] tab: ${target.url}`);

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
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: awaitP });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval error");
  return r.result?.value;
};
const delay = ms => new Promise(r => setTimeout(r, ms));

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

// ── Cold-cache reload (OPFS preserved) ────────────────────────────────────────
console.log("[v500] cold-cache reload (OPFS preserved)...");
await send("Network.clearBrowserCache");
await send("Storage.clearDataForOrigin", { origin: "https://wordingone.github.io", storageTypes: "cookies,cache_storage,service_workers,local_storage,shader_cache,indexeddb" });
await evaluate(`(async()=>{ const r=await navigator.serviceWorker?.getRegistrations()||[]; await Promise.all(r.map(x=>x.unregister())); })()`, true).catch(()=>{});
const lp = new Promise(res => onEvent("Page.loadEventFired", res));
await send("Page.navigate", { url: PAGES_URL });
await lp;

// ── Collect JS exceptions ──────────────────────────────────────────────────────
const exceptions = [];
onEvent("Runtime.exceptionThrown", p => {
  const desc = p.exceptionDetails?.exception?.description ?? "";
  if (!desc.includes("AbortError") && !desc.includes("NetworkError") && !desc.includes("Failed to fetch")) {
    exceptions.push(desc);
  }
});

// ── Wait for boot-screen removal ───────────────────────────────────────────────
console.log("[v500] waiting for boot-screen removal...");
let bootGone = false;
for (let t = 0; t < 300; t++) {
  await delay(1000);
  const gone = await evaluate(`!document.getElementById('boot-screen')`).catch(() => true);
  if (gone) { bootGone = true; console.log(`[v500] boot-screen gone at ~${t+1}s`); break; }
  if (t % 10 === 9) {
    const phase = await evaluate(`document.getElementById('boot-phase-label')?.textContent?.trim() ?? '?'`).catch(() => '?');
    console.log(`[v500]   boot-screen still active (~${t+1}s): "${phase}"`);
  }
}
if (!bootGone) { console.error("[v500] FAIL: boot-screen timeout"); ws.close(); process.exit(1); }
await delay(400);

// ── Helper: canvas JPEG capture ────────────────────────────────────────────────
const canvasRect = await evaluate(`(() => { const c = document.getElementById('viewer-canvas') || document.querySelector('canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`).catch(() => null);

async function snapCanvas(tag) {
  if (!canvasRect?.width) return null;
  const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 75, clip: { x: canvasRect.x, y: canvasRect.y, width: canvasRect.width, height: canvasRect.height, scale: 0.5 } });
  writeFileSync(`${OUT_DIR}/${tag}.jpg`, Buffer.from(shot.data, "base64"));
  return shot.data;
}

async function canvasDiff(preB64, postB64) {
  if (!preB64 || !postB64) return null;
  await send("Runtime.evaluate", { expression: `window._pre="${preB64}"; window._post="${postB64}";` });
  return evaluate(`
    (async () => {
      const decode = s => new Promise(res => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); res(ctx.getImageData(0, 0, img.width, img.height)); }; img.src = 'data:image/jpeg;base64,' + s; });
      const [a, b] = await Promise.all([decode(window._pre), decode(window._post)]);
      let changed = 0;
      for (let i = 0; i < a.data.length; i += 4) { if (Math.max(Math.abs(a.data[i]-b.data[i]), Math.abs(a.data[i+1]-b.data[i+1]), Math.abs(a.data[i+2]-b.data[i+2])) > 20) changed++; }
      return { changed, hasDiff: changed > 15 };
    })()
  `, true).catch(e => ({ error: String(e?.message) }));
}

// ── AC1: SdColumn Farnsworth params ───────────────────────────────────────────
console.log("[v500] AC1: SdColumn face_m=0.203 depth_m=0.210 height_m=4.543...");
const pre1 = await snapCanvas("ac1-pre");
const ac1 = await evaluate(`
  (async () => {
    const TOL = ${TOL};
    await window.__dispatch("SdColumn", { position: [2, 2], face_m: 0.203, depth_m: 0.210, height_m: 4.543 });
    await new Promise(r => setTimeout(r, 300));
    let col = null;
    window.__viewer.scene.traverse(obj => {
      if (obj.userData?.creator === "column" && obj.isMesh && !col) col = obj;
    });
    if (!col) return { ok: false, error: "column mesh not found in scene" };
    const geom = col.geometry;
    const p = geom.parameters;
    const errors = [];
    if (Math.abs(p.width  - 0.203) > TOL) errors.push("face(width)=" + p.width.toFixed(4) + " want 0.203");
    if (Math.abs(p.height - 0.210) > TOL) errors.push("depth(height)=" + p.height.toFixed(4) + " want 0.210");
    if (Math.abs(p.depth  - 4.543) > TOL) errors.push("height(depth)=" + p.depth.toFixed(4) + " want 4.543");
    return { ok: errors.length === 0, dims: { face: p.width, depth: p.height, height: p.depth }, errors };
  })()
`, true);
await delay(300);
const post1 = await snapCanvas("ac1-post");
const diff1 = await canvasDiff(pre1, post1);
console.log(`[v500] AC1 result: ok=${ac1?.ok} dims=${JSON.stringify(ac1?.dims)} diff=${diff1?.changed}`);

// ── AC2: SdColumn backward-compat (no params) ─────────────────────────────────
console.log("[v500] AC2: SdColumn backward-compat (no face_m/depth_m/height_m)...");
const pre2 = await snapCanvas("ac2-pre");
const ac2 = await evaluate(`
  (async () => {
    const TOL = ${TOL};
    const before = [];
    window.__viewer.scene.traverse(obj => { if (obj.userData?.creator === "column" && obj.isMesh) before.push(obj.uuid); });
    await window.__dispatch("SdColumn", { position: [4, 2] });
    await new Promise(r => setTimeout(r, 300));
    let col = null;
    window.__viewer.scene.traverse(obj => {
      if (obj.userData?.creator === "column" && obj.isMesh && !before.includes(obj.uuid)) col = obj;
    });
    if (!col) return { ok: false, error: "new column not found" };
    const p = col.geometry.parameters;
    const errors = [];
    if (Math.abs(p.width  - 0.3) > TOL) errors.push("face(width)=" + p.width.toFixed(4) + " want 0.3");
    if (Math.abs(p.height - 0.3) > TOL) errors.push("depth(height)=" + p.height.toFixed(4) + " want 0.3");
    if (Math.abs(p.depth  - 4.0) > TOL) errors.push("height(depth)=" + p.depth.toFixed(4) + " want 4.0");
    return { ok: errors.length === 0, dims: { face: p.width, depth: p.height, height: p.depth }, errors };
  })()
`, true);
await delay(300);
const post2 = await snapCanvas("ac2-post");
const diff2 = await canvasDiff(pre2, post2);
console.log(`[v500] AC2 result: ok=${ac2?.ok} dims=${JSON.stringify(ac2?.dims)} diff=${diff2?.changed}`);

// ── AC3: SdCurtainWall Farnsworth params ──────────────────────────────────────
console.log("[v500] AC3: SdCurtainWall height_m=2.743 elevation_m=1.600...");
const pre3 = await snapCanvas("ac3-pre");
const ac3 = await evaluate(`
  (async () => {
    const TOL = ${TOL};
    const before = [];
    window.__viewer.scene.traverse(obj => { if (obj.userData?.creator === "curtainwall") before.push(obj.uuid); });
    await window.__dispatch("SdCurtainWall", { start: [0, 0], end: [8, 0], height_m: 2.743, elevation_m: 1.600 });
    await new Promise(r => setTimeout(r, 300));
    let cw = null;
    window.__viewer.scene.traverse(obj => {
      if (obj.userData?.creator === "curtainwall" && !before.includes(obj.uuid) && obj.isGroup) cw = obj;
    });
    if (!cw) return { ok: false, error: "curtainwall group not found" };
    const shell = cw.userData?.joinableShell;
    const errors = [];
    // Check group Z = elevation_m (active level = 0)
    if (Math.abs(cw.position.z - 1.600) > TOL) errors.push("cw.position.z=" + cw.position.z.toFixed(4) + " want 1.600");
    // Check shell height = height_m
    if (shell?.geometry?.parameters) {
      const sh = shell.geometry.parameters.depth;
      if (Math.abs(sh - 2.743) > TOL) errors.push("shell.height(depth)=" + sh.toFixed(4) + " want 2.743");
      // Shell world z: shell.position.z = cw.position.z (set in handler)
      const shellZ = shell.position.z;
      const glazingZmin = shellZ;
      const glazingZmax = shellZ + sh;
      if (Math.abs(glazingZmin - 1.600) > TOL) errors.push("glazingZmin=" + glazingZmin.toFixed(4) + " want 1.600");
      if (Math.abs(glazingZmax - 4.343) > TOL) errors.push("glazingZmax=" + glazingZmax.toFixed(4) + " want 4.343");
    } else {
      errors.push("joinableShell geometry.parameters not accessible");
    }
    return {
      ok: errors.length === 0,
      cwPositionZ: cw.position.z,
      shellParams: shell?.geometry?.parameters ? { depth: shell.geometry.parameters.depth } : null,
      errors
    };
  })()
`, true);
await delay(300);
const post3 = await snapCanvas("ac3-post");
const diff3 = await canvasDiff(pre3, post3);
console.log(`[v500] AC3 result: ok=${ac3?.ok} cwZ=${ac3?.cwPositionZ} shellDims=${JSON.stringify(ac3?.shellParams)} diff=${diff3?.changed}`);

// ── AC4: SdCurtainWall backward-compat (no params) ────────────────────────────
console.log("[v500] AC4: SdCurtainWall backward-compat (no height_m/elevation_m)...");
const pre4 = await snapCanvas("ac4-pre");
const ac4 = await evaluate(`
  (async () => {
    const TOL = ${TOL};
    const before = [];
    window.__viewer.scene.traverse(obj => { if (obj.userData?.creator === "curtainwall") before.push(obj.uuid); });
    await window.__dispatch("SdCurtainWall", { start: [0, 2], end: [6, 2] });
    await new Promise(r => setTimeout(r, 300));
    let cw = null;
    window.__viewer.scene.traverse(obj => {
      if (obj.userData?.creator === "curtainwall" && !before.includes(obj.uuid) && obj.isGroup) cw = obj;
    });
    if (!cw) return { ok: false, error: "curtainwall group not found" };
    const shell = cw.userData?.joinableShell;
    const errors = [];
    if (Math.abs(cw.position.z - 0) > TOL) errors.push("cw.position.z=" + cw.position.z.toFixed(4) + " want 0");
    if (shell?.geometry?.parameters) {
      const sh = shell.geometry.parameters.depth;
      if (Math.abs(sh - 3.0) > TOL) errors.push("shell.height=" + sh.toFixed(4) + " want 3.0");
    } else {
      errors.push("joinableShell geometry.parameters not accessible");
    }
    return { ok: errors.length === 0, cwPositionZ: cw.position.z, shellHeight: shell?.geometry?.parameters?.depth, errors };
  })()
`, true);
await delay(300);
const post4 = await snapCanvas("ac4-post");
const diff4 = await canvasDiff(pre4, post4);
console.log(`[v500] AC4 result: ok=${ac4?.ok} cwZ=${ac4?.cwPositionZ} shellH=${ac4?.shellHeight} diff=${diff4?.changed}`);

// ── AC5: zero JS exceptions ────────────────────────────────────────────────────
const ac5Pass = exceptions.length === 0;
console.log(`[v500] AC5 exceptions: ${exceptions.length} (${ac5Pass ? "✓ PASS" : "✗ FAIL"})`);

// ── Full-page screenshot ───────────────────────────────────────────────────────
const finalShot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${OUT_DIR}/final.png`, Buffer.from(finalShot.data, "base64"));

// ── Summary ────────────────────────────────────────────────────────────────────
const results = {
  ac1: { pass: ac1?.ok === true, label: "SdColumn Farnsworth dims", dims: ac1?.dims, errors: ac1?.errors, canvasDiff: diff1 },
  ac2: { pass: ac2?.ok === true, label: "SdColumn backward-compat", dims: ac2?.dims, errors: ac2?.errors, canvasDiff: diff2 },
  ac3: { pass: ac3?.ok === true, label: "SdCurtainWall Farnsworth Z", cwZ: ac3?.cwPositionZ, shellParams: ac3?.shellParams, errors: ac3?.errors, canvasDiff: diff3 },
  ac4: { pass: ac4?.ok === true, label: "SdCurtainWall backward-compat", cwZ: ac4?.cwPositionZ, shellH: ac4?.shellHeight, errors: ac4?.errors, canvasDiff: diff4 },
  ac5: { pass: ac5Pass, label: "zero JS exceptions", count: exceptions.length },
};
const allPass = Object.values(results).every(r => r.pass);

const certPath = `${OUT_DIR}/cert-500-501.json`;
writeFileSync(certPath, JSON.stringify({
  script: "verify-500-501.mjs",
  pages_url: PAGES_URL,
  cold_cache: true,
  clear_protocol: "Network.clearBrowserCache + Storage.clearDataForOrigin(cookies,cache_storage,service_workers,local_storage,shader_cache,indexeddb) [OPFS preserved] + SW unregister + Page.navigate",
  tol: TOL,
  results,
  allPass,
}, null, 2));

console.log("\n[v500] ══ #500/#501 CERT ══════════════════════════════");
Object.entries(results).forEach(([k, r]) => console.log(`  ${k.toUpperCase()}: ${r.pass ? "✓ PASS" : "✗ FAIL"}  ${r.label}${r.errors?.length ? "  ERRORS: " + JSON.stringify(r.errors) : ""}`));
console.log(`[v500] Overall: ${allPass ? "ALL PASS" : "FAIL"}`);
console.log(`[v500] cert → ${certPath}`);

ws.close();
process.exit(allPass ? 0 : 1);
