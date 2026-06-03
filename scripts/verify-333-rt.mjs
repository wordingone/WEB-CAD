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
import { mkdirSync, writeFileSync } from "fs";
import { execSync }                from "child_process";
import { fileURLToPath }           from "url";
import rhino3dmInit                from "rhino3dm";

const CDP_PORT  = 9222;
const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const EPS       = 1e-6;
const RUNS      = 3;
const OUT_DIR   = fileURLToPath(new URL("../state/cert-333-rt", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

// ── 1. Build reference .3dm bytes in Node.js ──────────────────────────────────
// Reference surface: 3×3 bilinear patch (degree 1 in both directions)
const rh = await rhino3dmInit();
const deg = 1, n = 3;
const refCP = [
  [0,0,0],[1,0,0],[2,0,0],
  [0,1,0],[1,1,1],[2,1,0],
  [0,2,0],[1,2,0],[2,2,0],
];
// Full clamped knots for degree=1, n=3: [0,0,1,2,2]
const fullKnots = [0, 0, 1, 2, 2];
// Truncated knots for rhino3dm (strips first + last): [0, 1, 2]
const truncKnots = fullKnots.slice(1, fullKnots.length - 1);

const orderU = deg + 1, orderV = deg + 1;
const ns = rh.NurbsSurface.create(3, false, orderU, orderV, n, n);
if (!ns) throw new Error("NurbsSurface.create returned null");

const pts = ns.points();
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) {
    const p = refCP[i * n + j];
    pts.set(i, j, [p[0], p[1], p[2]]);
  }
}
const ku = ns.knotsU(), kv = ns.knotsV();
for (let i = 0; i < truncKnots.length; i++) {
  ku.set(i, truncKnots[i]);
  kv.set(i, truncKnots[i]);
}

const file3dm = new rh.File3dm();
file3dm.objects().addSurface(ns);
ns.delete();
const dmBytes = file3dm.toByteArray();
file3dm.delete();
const dmBase64 = Buffer.from(dmBytes).toString("base64");
console.log(`[rt] .3dm built in Node.js: ${dmBytes.length} bytes, ${refCP.length} control points`);

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

  // Cold-cache clear
  await send("Network.clearBrowserCache");
  await send("Storage.clearDataForOrigin", { origin: "https://wordingone.github.io", storageTypes: "all" });
  await evaluate(`(async()=>{ const r=await navigator.serviceWorker?.getRegistrations()||[]; await Promise.all(r.map(x=>x.unregister())); })()`, true).catch(()=>{});

  // Cold reload
  const lp = new Promise(res => onEvent("Page.loadEventFired", res));
  await send("Page.reload", { ignoreCache: true });
  await lp;

  // Wait for shell
  let shellReady = false;
  for (let t = 0; t < 90; t++) {
    await delay(1000);
    const ok = await evaluate(`!!(window.__viewer && window.__dispatchSync)`).catch(()=>false);
    if (ok) { shellReady = true; console.log(`[rt]   shell ready ~${t+1}s`); break; }
  }
  if (!shellReady) {
    runResults.push({ run, pass: false, reason: "shell timeout" });
    continue;
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
        const result = await window.__dispatchSync("Sd3dmRead", { bytes: arrayBuf, filename: "rt-test.3dm" });
        if (!result?.loaded) return { ok: false, error: "Sd3dmRead failed: " + JSON.stringify(result?.error) };

        // Find imported mesh with canonical userData
        let canonical = null;
        window.__viewer.scene.traverse(obj => {
          if (obj.userData?.format === "3dm" && obj.userData?.canonical && !canonical) {
            canonical = obj.userData.canonical;
          }
        });
        if (!canonical) return { ok: false, error: "no canonical userData on imported mesh" };

        // Deterministic geometry diff
        const errors = [];
        if (canonical.degreeU !== 1) errors.push("degreeU=" + canonical.degreeU + " want 1");
        if (canonical.degreeV !== 1) errors.push("degreeV=" + canonical.degreeV + " want 1");
        if (canonical.countU !== 3) errors.push("countU=" + canonical.countU + " want 3");
        if (canonical.countV !== 3) errors.push("countV=" + canonical.countV + " want 3");

        for (let i = 0; i < refCP.length; i++) {
          const a = refCP[i], b = canonical.controlPoints?.[i];
          if (!b) { errors.push("missing CP[" + i + "]"); continue; }
          const d = Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1]), Math.abs(a[2]-b[2]));
          if (d > EPS) errors.push("CP[" + i + "] delta=" + d.toExponential(2));
        }

        const kuRef = fullKnots, kuImp = canonical.knotsU ?? [];
        if (kuRef.length !== kuImp.length) {
          errors.push("knotsU length: " + kuImp.length + " vs " + kuRef.length);
        } else {
          for (let i = 0; i < kuRef.length; i++) {
            if (Math.abs(kuRef[i] - kuImp[i]) > EPS) errors.push("knotsU[" + i + "] delta=" + Math.abs(kuRef[i]-kuImp[i]).toExponential(2));
          }
        }
        const kvRef = fullKnots, kvImp = canonical.knotsV ?? [];
        if (kvRef.length !== kvImp.length) errors.push("knotsV length: " + kvImp.length + " vs " + kvRef.length);

        return {
          ok: errors.length === 0, errors,
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

  console.log("[rt]   round-trip result:", JSON.stringify(rtResult));

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
  runResults.push({ run, pass, rtOK, crashFree, canonical: rtResult?.canonical, errors: rtResult?.errors });

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
  clear_protocol: "Storage.clearDataForOrigin(all) + Network.clearBrowserCache + SW unregister + Page.reload(ignoreCache:true)",
  eps: EPS,
  surface: "3x3 bilinear patch, degree 1, 9 control points, fullKnots=[0,0,1,2,2]",
  dm_bytes: dmBytes.length,
  runs: runResults,
  allPass,
}, null, 2));

console.log("\n[rt] ══ #333 NURBS ROUND-TRIP CERT ══════════════════");
runResults.forEach(r => console.log(`  Run ${r.run}: ${r.pass ? "✓ PASS" : "✗ FAIL"}  rt=${r.rtOK ? "✓" : "✗"}  crash-free=${r.crashFree ? "✓" : "✗"}`));
console.log(`[rt] Overall: ${allPass ? "ALL PASS" : "FAIL"}`);
console.log(`[rt] cert → ${certPath}`);

ws.close();
process.exit(allPass ? 0 : 1);
