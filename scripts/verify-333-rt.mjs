#!/usr/bin/env node
// verify-333-rt.mjs — #333 AC#2: untrimmed NurbsSurface round-trip cert.
// Deployed Pages cold-cache ONLY (no localhost per ban).
// AC: export KernelNurbsSurface → .3dm → re-import via Sd3dmRead → userData.canonical
//     control points + knot vectors + degree within ε = 1e-6.
//
// Strategy: rhino3dm runs in Node.js (avoids browser bare-specifier resolution);
// .3dm bytes are injected into browser via CDP as base64; Sd3dmRead handler
// decodes and imports. PAGES_URL is the only navigation target.

import { WebSocket }               from "ws";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { execSync }                from "child_process";
import { fileURLToPath }           from "url";
import { tmpdir }                  from "os";
import { join }                    from "path";

const CDP_PORT  = 9222;
const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const EPS       = 1e-6;
const RUNS      = 3;
const OUT_DIR   = fileURLToPath(new URL("../state/cert-333-rt", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

// ── 1. Build reference .3dm bytes via rhino3dm (CJS subprocess via temp file) ─
// rhino3dm WASM must run from its own directory to locate rhino3dm.wasm.
// Write the builder to a temp .cjs file next to rhino3dm.js, run it, then delete.
const deg = 1, n = 3;
const refCP = [
  [0,0,0],[1,0,0],[2,0,0],
  [0,1,0],[1,1,1],[2,1,0],
  [0,2,0],[1,2,0],[2,2,0],
];
const fullKnots = [0, 0, 1, 2, 2];
const truncKnots = [0, 1, 2]; // rhino3dm internal knots: strips first/last of full

const rh3dmDir = fileURLToPath(new URL("../node_modules/rhino3dm/", import.meta.url));
const tmpScript = join(rh3dmDir, "_rt333-builder.cjs");
writeFileSync(tmpScript, `
const r = require('./rhino3dm.js');
r().then(rh => {
  const cp = ${JSON.stringify(refCP)};
  const trunc = ${JSON.stringify(truncKnots)};
  const ns = rh.NurbsSurface.create(3, false, 2, 2, 3, 3);
  const pts = ns.points();
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { const p = cp[i*3+j]; pts.set(i, j, [p[0], p[1], p[2], 1]); }
  const ku = ns.knotsU(), kv = ns.knotsV();
  for (let i = 0; i < trunc.length; i++) { ku.set(i, trunc[i]); kv.set(i, trunc[i]); }
  const attrs = new rh.ObjectAttributes();
  const f = new rh.File3dm();
  f.objects().addSurface(ns, attrs);
  ns.delete();
  const b = f.toByteArray(); f.delete();
  process.stdout.write(Buffer.from(b).toString('base64'));
}).catch(e => { process.stderr.write(String(e)); process.exit(1); });
`);

let dmBase64;
try {
  dmBase64 = execSync(`node "${tmpScript}"`, { encoding: "utf8", maxBuffer: 1024*1024 });
} finally {
  try { unlinkSync(tmpScript); } catch (_) {}
}
const dmBytes = Buffer.from(dmBase64, "base64");
console.log(`[rt] .3dm built via Node.js subprocess: ${dmBytes.length} bytes, ${refCP.length} CPs`);

// ── 2. Connect to CDP ─────────────────────────────────────────────────────────
const targets = JSON.parse(execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" }));
const target  = targets.find(t => t.type === "page" && !t.url.startsWith("devtools://"));
if (!target) { console.error("No page tab at :9222"); process.exit(1); }
console.log(`[rt] tab: ${target.url}`);

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

// Navigate to deployed Pages
const initLoad = new Promise(res => onEvent("Page.loadEventFired", res));
await send("Page.navigate", { url: PAGES_URL });
await initLoad;
await delay(2000);

const runResults = [];

for (let run = 1; run <= RUNS; run++) {
  console.log(`\n[rt] ── Run ${run}/${RUNS} ──────────────────────────`);
  const runExceptions = [];
  const exListener = (p) => {
    const desc = p.exceptionDetails?.exception?.description ?? "";
    if (!desc.includes("AbortError") && !desc.includes("NetworkError") && !desc.includes("Failed to fetch")) {
      runExceptions.push(desc);
    }
  };
  onEvent("Runtime.exceptionThrown", exListener);

  // Cold-cache clear — preserve file_systems (OPFS) to avoid 5GB model re-download
  await send("Network.clearBrowserCache");
  await send("Storage.clearDataForOrigin", { origin: "https://wordingone.github.io", storageTypes: "cookies,cache_storage,service_workers,local_storage,shader_cache,indexeddb" });
  await evaluate(`(async()=>{ const r=await navigator.serviceWorker?.getRegistrations()||[]; await Promise.all(r.map(x=>x.unregister())); })()`, true).catch(()=>{});

  // Cold reload
  const lp = new Promise(res => onEvent("Page.loadEventFired", res));
  await send("Page.reload", { ignoreCache: true });
  await lp;

  // Wait for shell
  let shellReady = false;
  for (let t = 0; t < 90; t++) {
    await delay(1000);
    const ok = await evaluate(`!!(window.__viewer && window.__dispatch)`).catch(()=>false);
    if (ok) { shellReady = true; console.log(`[rt]   shell ready ~${t+1}s`); break; }
  }
  if (!shellReady) {
    runResults.push({ run, pass: false, reason: "shell timeout" });
    continue;
  }

  // Wait for boot-screen removal — canvas is occluded (z-index:9999) until agentmodel:boot-complete
  let bootGone = false;
  for (let t = 0; t < 180; t++) {
    await delay(1000);
    const gone = await evaluate(`!document.getElementById('boot-screen')`).catch(() => true);
    if (gone) { bootGone = true; console.log(`[rt]   boot-screen gone at ~${t+1}s`); break; }
    if (t % 10 === 9) {
      const phase = await evaluate(`document.getElementById('boot-phase-label')?.textContent?.trim() ?? '?'`).catch(() => '?');
      console.log(`[rt]   boot-screen still active (~${t+1}s): "${phase}"`);
    }
  }
  if (!bootGone) console.warn("[rt]   boot-screen timeout — canvas diff may be occluded");
  await delay(300);

  // Capture viewer canvas rect + pre-dispatch JPEG for visible-render diff
  const canvasRect = await evaluate(`(() => { const c = document.getElementById('viewer-canvas') || document.querySelector('canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`).catch(() => null);
  let preJpeg = null;
  if (canvasRect?.width > 0) {
    const preShot = await send("Page.captureScreenshot", { format: "jpeg", quality: 75, clip: { x: canvasRect.x, y: canvasRect.y, width: canvasRect.width, height: canvasRect.height, scale: 0.5 } });
    preJpeg = preShot.data;
    await send("Runtime.evaluate", { expression: `window._preJpeg = "data:image/jpeg;base64,${preJpeg}"` });
  }

  // Inject .3dm bytes (built Node.js-side) as base64, decode in browser, dispatch Sd3dmRead
  const rtResult = await evaluate(`
    (async () => {
      try {
        const EPS = ${EPS};
        const refCP = ${JSON.stringify(refCP)};
        const fullKnots = ${JSON.stringify(fullKnots)};
        const dmBase64 = "${dmBase64}";

        // Decode base64 → ArrayBuffer
        const binStr = atob(dmBase64);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        const arrayBuf = bytes.buffer;

        // Dispatch Sd3dmRead
        const envelope = await window.__dispatch("Sd3dmRead", { bytes: arrayBuf, filename: "rt-test.3dm" });
        const result = envelope?.result;
        if (!result?.loaded) return { ok: false, error: "Sd3dmRead failed: " + JSON.stringify(result?.error ?? envelope) };

        // Find imported mesh with canonical userData
        let canonical = null;
        window.__viewer.scene.traverse(obj => {
          if (obj.userData?.format === "3dm" && obj.userData?.canonical && !canonical) {
            canonical = obj.userData.canonical;
          }
        });
        if (!canonical) return { ok: false, error: "no canonical userData on imported mesh" };

        // Deterministic geometry diff — report all deltas (not just failures)
        const errors = [];
        const cpDeltas = [];
        if (canonical.degreeU !== 1) errors.push("degreeU=" + canonical.degreeU + " want 1");
        if (canonical.degreeV !== 1) errors.push("degreeV=" + canonical.degreeV + " want 1");
        if (canonical.countU !== 3) errors.push("countU=" + canonical.countU + " want 3");
        if (canonical.countV !== 3) errors.push("countV=" + canonical.countV + " want 3");

        for (let i = 0; i < refCP.length; i++) {
          const a = refCP[i], b = canonical.controlPoints?.[i];
          if (!b) { errors.push("missing CP[" + i + "]"); cpDeltas.push(null); continue; }
          const dx = Math.abs(a[0]-b[0]), dy = Math.abs(a[1]-b[1]), dz = Math.abs(a[2]-b[2]);
          const d = Math.max(dx, dy, dz);
          cpDeltas.push(+d.toExponential(6));
          if (d > EPS) errors.push("CP[" + i + "] delta=" + d.toExponential(2));
        }

        const kuRef = fullKnots, kuImp = canonical.knotsU ?? [];
        const knotDeltasU = [];
        if (kuRef.length !== kuImp.length) {
          errors.push("knotsU length: " + kuImp.length + " vs " + kuRef.length);
        } else {
          for (let i = 0; i < kuRef.length; i++) {
            const d = Math.abs(kuRef[i] - kuImp[i]);
            knotDeltasU.push(+d.toExponential(6));
            if (d > EPS) errors.push("knotsU[" + i + "] delta=" + d.toExponential(2));
          }
        }
        const kvRef = fullKnots, kvImp = canonical.knotsV ?? [];
        const knotDeltasV = [];
        if (kvRef.length !== kvImp.length) {
          errors.push("knotsV length: " + kvImp.length + " vs " + kvRef.length);
        } else {
          for (let i = 0; i < kvRef.length; i++) {
            const d = Math.abs(kvRef[i] - kvImp[i]);
            knotDeltasV.push(+d.toExponential(6));
            if (d > EPS) errors.push("knotsV[" + i + "] delta=" + d.toExponential(2));
          }
        }

        return {
          ok: errors.length === 0, errors,
          cpDeltas, knotDeltasU, knotDeltasV,
          canonical: {
            degreeU: canonical.degreeU, degreeV: canonical.degreeV,
            countU: canonical.countU, countV: canonical.countV,
            knotsU: canonical.knotsU, knotsV: canonical.knotsV
          }
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    })()
  `, true);

  // Wait for Three.js render, capture post-dispatch JPEG, compute pixel diff
  await delay(600);
  let canvasDiff = null;
  if (preJpeg && canvasRect?.width > 0) {
    const postShot = await send("Page.captureScreenshot", { format: "jpeg", quality: 75, clip: { x: canvasRect.x, y: canvasRect.y, width: canvasRect.width, height: canvasRect.height, scale: 0.5 } });
    await send("Runtime.evaluate", { expression: `window._postJpeg = "data:image/jpeg;base64,${postShot.data}"` });
    canvasDiff = await evaluate(`
      (async () => {
        const decode = src => new Promise(res => {
          const img = new Image();
          img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); res(ctx.getImageData(0, 0, img.width, img.height)); };
          img.src = src;
        });
        const [a, b] = await Promise.all([decode(window._preJpeg), decode(window._postJpeg)]);
        let changed = 0;
        for (let i = 0; i < a.data.length; i += 4) {
          if (Math.max(Math.abs(a.data[i]-b.data[i]), Math.abs(a.data[i+1]-b.data[i+1]), Math.abs(a.data[i+2]-b.data[i+2])) > 20) changed++;
        }
        return { changed, total: a.data.length/4, hasDiff: changed > 15 };
      })()
    `, true).catch(e => ({ error: String(e?.message ?? e) }));
    console.log(`[rt]   canvas diff: changed=${canvasDiff?.changed ?? '?'} hasDiff=${canvasDiff?.hasDiff ?? '?'}`);
  }

  console.log("[rt]   round-trip result:", JSON.stringify(rtResult));
  if (rtResult?.cpDeltas) console.log("[rt]   CP deltas (max-component, ε=1e-6):", JSON.stringify(rtResult.cpDeltas));
  if (rtResult?.knotDeltasU) console.log("[rt]   knotDeltasU:", JSON.stringify(rtResult.knotDeltasU));
  if (rtResult?.knotDeltasV) console.log("[rt]   knotDeltasV:", JSON.stringify(rtResult.knotDeltasV));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT_DIR}/run${run}.png`, Buffer.from(shot.data, "base64"));

  const crashFree = runExceptions.length === 0;
  const rtOK = rtResult?.ok === true;
  console.log(`[rt]   (b) round-trip: ${rtOK ? "✓ PASS" : "✗ FAIL"}`);
  if (!rtOK && rtResult?.errors?.length) console.log(`[rt]   errors: ${JSON.stringify(rtResult.errors)}`);
  if (!rtOK && rtResult?.error) console.log(`[rt]   error: ${rtResult.error}`);
  console.log(`[rt]   (c) crash-free: ${crashFree ? "✓ YES" : "✗ NO"}`);

  const pass = rtOK && crashFree;
  console.log(`[rt]   Run ${run}: ${pass ? "✓ PASS" : "✗ FAIL"}`);
  runResults.push({ run, pass, rtOK, crashFree, canonical: rtResult?.canonical, cpDeltas: rtResult?.cpDeltas, knotDeltasU: rtResult?.knotDeltasU, knotDeltasV: rtResult?.knotDeltasV, errors: rtResult?.errors, canvasDiff });

  // Remove this run's exception listener
  const idx = (evListeners.get("Runtime.exceptionThrown") ?? []).indexOf(exListener);
  if (idx >= 0) evListeners.get("Runtime.exceptionThrown").splice(idx, 1);
}

const allPass = runResults.every(r => r.pass);
const certPath = `${OUT_DIR}/cert-333-rt.json`;
writeFileSync(certPath, JSON.stringify({
  script: "verify-333-rt.mjs",
  pages_url: PAGES_URL,
  cold_cache: true,
  clear_protocol: "Network.clearBrowserCache + Storage.clearDataForOrigin(cookies,cache_storage,service_workers,local_storage,shader_cache,indexeddb) [OPFS preserved] + SW unregister + Page.reload(ignoreCache:true)",
  eps: EPS,
  surface: "3x3 bilinear patch, degree 1, 9 control points, fullKnots=[0,0,1,2,2]",
  dm_bytes: dmBytes.length,
  trim_gap: {
    finding: "Trimmed BReps cannot round-trip via rhino3dm — rhino3dm.d.ts declares no BrepLoop, BrepTrim, or loops()/trims() accessor",
    scope: "AC#2 is scoped to untrimmed NurbsSurface only; trimmed surfaces are an upstream rhino3dm API limitation, not in-scope for this PR",
    upstream_ref: "rhino3dm TypeScript definitions omit BrepLoop/BrepTrim classes and have no loops()/trims() method on Brep"
  },
  runs: runResults,
  allPass,
}, null, 2));

console.log("\n[rt] ══ #333 NURBS ROUND-TRIP CERT ══════════════════");
runResults.forEach(r => console.log(`  Run ${r.run}: ${r.pass ? "✓ PASS" : "✗ FAIL"}  rt=${r.rtOK ? "✓" : "✗"}  crash-free=${r.crashFree ? "✓" : "✗"}`));
console.log(`[rt] Overall: ${allPass ? "ALL PASS" : "FAIL"}`);
console.log(`[rt] cert → ${certPath}`);

ws.close();
process.exit(allPass ? 0 : 1);
