#!/usr/bin/env node
// verify-389-kern.mjs — Cold-cache CDP verify for PR#389 kern.wasm rebuild.
//
// Tests (against /dev deployed bundle):
//   T1 — Boolean union regression (#382 topology round-trip)
//   T2 — Fillet watertight (#357 seam-sew)
//   T3 — SSI curved-pair no capHit (#358 maxLeaves=200)
//   T4 — kernResultToBrep topology preserved after union-difference
//
// Deployment identity:
//   D1 — /dev COMMIT.txt = expected SHA (bundle-identity guard)
//   D2 — /dev kern.wasm: 200 OK, correct byte count, application/wasm
//
// Usage:
//   bun scripts/verify-389-kern.mjs [--cdp]
//
// Without --cdp: runs D1/D2 only (HTTP checks). No :9222 needed.
// With --cdp:    cold-cache browser navigate + full T1-T4 functional tests.

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";

const DEV_BASE      = "https://wordingone.github.io/WEB-CAD/dev";
const EXPECTED_SHA  = "8c8640cf7ffe4958ef9a62f74e56944531581e5a";
const WASM_SIZE_EXP = 400435;
const STATE_DIR     = `${fileURLToPath(new URL("../state", import.meta.url))}`;
const CDP_BASE      = "http://localhost:9222";
const USE_CDP       = process.argv.includes("--cdp");

const results = [];
const pass = (name, detail) => { console.log(`  PASS  ${name}: ${detail}`); results.push({ pass: true, name, detail }); };
const fail = (name, detail) => { console.error(`  FAIL  ${name}: ${detail}`); results.push({ pass: false, name, detail }); };

// ── D1 — COMMIT.txt identity ──────────────────────────────────────────────────
console.log("[verify-389] D1: /dev COMMIT.txt identity");
{
  const txt = await fetch(`${DEV_BASE}/COMMIT.txt`).then(r => r.text()).catch(() => "FETCH_FAILED");
  const sha = txt.trim();
  if (sha.startsWith(EXPECTED_SHA.slice(0, 8))) pass("D1", `COMMIT.txt = ${sha.slice(0, 40)}`);
  else fail("D1", `COMMIT.txt mismatch — expected ${EXPECTED_SHA.slice(0,8)}, got ${sha.slice(0,40)}`);
}

// ── D2 — kern.wasm asset ──────────────────────────────────────────────────────
console.log("[verify-389] D2: /dev kern.wasm");
{
  // Request without compression so Content-Length reflects raw file size (CDN gzip-compresses WASM).
  const head = await fetch(`${DEV_BASE}/kern.wasm`, {
    method: "HEAD", headers: { "Accept-Encoding": "identity" },
  }).catch(() => null);
  if (!head?.ok) fail("D2", `fetch failed: ${head?.status ?? "network error"}`);
  else {
    const ct   = head.headers.get("content-type") ?? "";
    const size = Number(head.headers.get("content-length") ?? "0");
    if (!ct.includes("wasm")) fail("D2", `wrong content-type: ${ct}`);
    else if (size !== WASM_SIZE_EXP) fail("D2", `size mismatch — expected ${WASM_SIZE_EXP}, got ${size} (gzip-compressed?)`);
    else pass("D2", `200 OK, ${size} bytes uncompressed, ${ct}`);
  }
}

if (!USE_CDP) {
  const allPass = results.every(r => r.pass);
  console.log(`\n[verify-389] D1/D2 only (no --cdp). ${results.filter(r=>r.pass).length}/${results.length} passed.`);
  console.log("[verify-389] Re-run with --cdp for full T1-T4 functional tests (requires :9222).");
  if (!allPass) process.exit(1);
  process.exit(0);
}

// ── CDP setup ─────────────────────────────────────────────────────────────────
console.log("[verify-389] Connecting to CDP :9222");
const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) { fail("CDP", `Cannot reach ${CDP_BASE}`); process.exit(1); }
const tab = targets.find(t => t.type === "page");
if (!tab) { fail("CDP", "No page tab in CDP"); process.exit(1); }
console.log(`[verify-389] Using tab: ${tab.url}`);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let mid = 1;
const pending = new Map();
const msgListeners = [];
ws.onmessage = event => {
  const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  for (const fn of msgListeners) fn(msg);
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
    new Promise((_, rej) => setTimeout(() => rej(new Error("CDP evaluate timeout")), timeoutMs)),
  ]);
  return res?.result?.result?.value ?? null;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");

// ── Cold-cache clear ──────────────────────────────────────────────────────────
console.log("[verify-389] Clearing caches (cold-cache)");
await send("Network.clearBrowserCache");
await send("Network.clearBrowserCookies");
await evaluate(`(async () => {
  const keys = await caches.keys();
  for (const k of keys) await caches.delete(k);
  const dbs = await (indexedDB.databases?.() ?? Promise.resolve([]));
  for (const { name } of dbs) if (name) await new Promise(r => {
    const rq = indexedDB.deleteDatabase(name);
    rq.onsuccess = rq.onerror = rq.onblocked = r;
  });
  const regs = await navigator.serviceWorker?.getRegistrations() ?? [];
  for (const reg of regs) await reg.unregister();
})()`);

// ── Navigate to /dev ──────────────────────────────────────────────────────────
console.log(`[verify-389] Navigating to ${DEV_BASE}/`);
const loadProm = new Promise(r => {
  const handler = msg => {
    if (msg.method === "Page.loadEventFired") {
      const idx = msgListeners.indexOf(handler);
      if (idx !== -1) msgListeners.splice(idx, 1);
      r();
    }
  };
  msgListeners.push(handler);
});
await send("Page.navigate", { url: `${DEV_BASE}/` });
await Promise.race([loadProm, new Promise(r => setTimeout(r, 30000))]);
await new Promise(r => setTimeout(r, 4000));

// ── C1 — COMMIT.txt in browser context ───────────────────────────────────────
{
  const commitInPage = await evaluate(`fetch('./COMMIT.txt').then(r=>r.text()).catch(e=>'ERR:'+e.message)`);
  const sha = String(commitInPage ?? "").trim();
  if (sha.startsWith(EXPECTED_SHA.slice(0, 8))) pass("C1", `Browser COMMIT.txt = ${sha.slice(0,40)}`);
  else fail("C1", `Browser COMMIT.txt mismatch: ${sha.slice(0,40)}`);
}

// ── Functional tests (T1-T4) via kern.js dynamic import ──────────────────────
console.log("[verify-389] Loading kern.js and running T1-T4");
const testScript = `(async () => {
  // ── Helpers ──────────────────────────────────────────────────────────────
  function lineCurve(p0, p1) {
    return { degree: 1, cvCount: 2, knots: [0,0,1,1], cvs: [p0[0],p0[1],p0[2],1, p1[0],p1[1],p1[2],1] };
  }
  function bilinearSurf(p00, p01, p10, p11) {
    return {
      degreeU: 1, degreeV: 1, cvCountU: 2, cvCountV: 2,
      knotsU: [0,0,1,1], knotsV: [0,0,1,1],
      // row-major: u=0,v=0; u=0,v=1; u=1,v=0; u=1,v=1 — 4 CVs × xyzw
      cvs: [...p00, 1, ...p01, 1, ...p10, 1, ...p11, 1],
    };
  }
  // Build a kern-format box brep. outerLoop.edges = [] (kern accepts stub loops).
  function boxBrepJson(x0, x1, y0, y1, z0, z1) {
    const v = [
      [x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],
      [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1],
    ];
    const tol = 1e-6;
    const stubLoop = { edges: [], isOuter: true };
    const face = (surf, ori=true) => ({
      surface: surf, outerLoop: stubLoop, innerLoops: [], orientation: ori, tolerance: tol
    });
    const faces = [
      // F0 -Z: u=x, v=y
      face(bilinearSurf(v[0],v[3],v[1],v[2]), false),
      // F1 +Z: u=x, v=y
      face(bilinearSurf(v[4],v[7],v[5],v[6])),
      // F2 -Y: u=x, v=z
      face(bilinearSurf(v[0],v[4],v[1],v[5]), false),
      // F3 +Y: u=x, v=z
      face(bilinearSurf(v[3],v[7],v[2],v[6])),
      // F4 -X: u=y, v=z
      face(bilinearSurf(v[0],v[4],v[3],v[7]), false),
      // F5 +X: u=y, v=z
      face(bilinearSurf(v[1],v[5],v[2],v[6])),
    ];
    // 12 edges: [from, to, faceIndex1, faceIndex2]
    const edgeDef = [
      [0,1,0,2],[1,2,0,5],[2,3,0,3],[3,0,0,4],   // bottom
      [4,5,1,2],[5,6,1,5],[6,7,1,3],[7,4,1,4],   // top
      [0,4,2,4],[1,5,2,5],[2,6,3,5],[3,7,3,4],   // vertical
    ];
    const vertEdges = Array.from({length:8}, () => []);
    const edges = edgeDef.map(([fi, ti, f1, f2], i) => {
      vertEdges[fi].push(i); vertEdges[ti].push(i);
      return { curve: lineCurve(v[fi], v[ti]), faceIndex1: f1, faceIndex2: f2, tolerance: tol };
    });
    const vertices = v.map((pt, i) => ({ point: pt, edgeIndices: vertEdges[i], tolerance: tol }));
    return JSON.stringify({ shells: [{ faces, edges, vertices, isClosed: true }] });
  }

  // ── Load kern.js ────────────────────────────────────────────────────────
  let mod;
  try {
    const factory = (await import('./kern.js')).default;
    mod = await factory({ locateFile: n => n === 'kern.wasm' ? './kern.wasm' : n });
  } catch(e) {
    return { error: 'kern load failed: ' + e.message };
  }
  const exports = Object.keys(mod).filter(k => k.startsWith('kern_') || ['boolUnion','boolDifference','boolIntersection'].includes(k));

  // ── T1 — Boolean union (#382 regression) ────────────────────────────────
  let t1 = { name: 'T1', pass: false, detail: '' };
  try {
    const a = JSON.parse(boxBrepJson(-0.5, 0.5, -0.5, 0.5, -0.5, 0.5));
    const b = JSON.parse(boxBrepJson(0.25, 1.25, -0.5, 0.5, -0.5, 0.5));
    const resp = JSON.parse(mod.kern_boolean(JSON.stringify({ op: 'union', a, b })));
    if (!resp.ok) { t1.detail = 'kern_boolean ok:false — ' + JSON.stringify(resp.error); }
    else {
      const sh = resp.result?.shells?.[0];
      if (!sh?.edges?.length) t1.detail = 'result has no edges (topology stripped)';
      else if (!sh?.vertices?.length) t1.detail = 'result has no vertices';
      else { t1.pass = true; t1.detail = 'union ok — shells:' + resp.result.shells.length + ' edges:' + sh.edges.length + ' vertices:' + sh.vertices.length; }
    }
  } catch(e) { t1.detail = 'exception: ' + e.message; }

  // ── T2 — Fillet watertight (#357 seam-sew) ──────────────────────────────
  let t2 = { name: 'T2', pass: false, detail: '' };
  try {
    const brep = JSON.parse(boxBrepJson(-0.5, 0.5, -0.5, 0.5, -0.5, 0.5));
    const resp = JSON.parse(mod.kern_fillet(JSON.stringify({ brep, radius: 0.05, edges: [0] })));
    if (!resp.ok) { t2.detail = 'kern_fillet ok:false — ' + JSON.stringify(resp.error); }
    else {
      const sh = resp.result?.shells?.[0];
      const isClosed = sh?.isClosed === true;
      const allManifold = sh?.edges?.every(e => e.faceIndex2 !== undefined && e.faceIndex2 !== -1) ?? false;
      if (!isClosed) t2.detail = 'isClosed:false';
      else if (!allManifold) {
        const naked = sh.edges.filter(e => e.faceIndex2 === undefined || e.faceIndex2 === -1).length;
        t2.detail = naked + ' naked edges (not watertight)';
      } else { t2.pass = true; t2.detail = 'fillet ok — isClosed:true, edges:' + sh.edges.length + ' all manifold'; }
    }
  } catch(e) { t2.detail = 'exception: ' + e.message; }

  // ── T3 — SSI curved-pair no capHit (#358 maxLeaves=200) ─────────────────
  let t3 = { name: 'T3', pass: false, detail: '' };
  try {
    const w = Math.sqrt(2) / 2;  // rational weight for quarter-circle
    // Quarter-cylinder (degree-2 in u, rational): arc from (1,0,z) to (0,1,z), z in [0,1]
    const surfA = {
      degreeU: 2, degreeV: 1, cvCountU: 3, cvCountV: 2,
      knotsU: [0,0,0,1,1,1], knotsV: [0,0,1,1],
      cvs: [1,0,0,1, 1,0,1,1, w,w,0,w, w,w,1,w, 0,1,0,1, 0,1,1,1],
    };
    // Tilted bilinear plane z = 0.5*x + 0.25, x,y in [-0.2, 1.2]
    const zAt = x => 0.5*x + 0.25;
    const surfB = {
      degreeU: 1, degreeV: 1, cvCountU: 2, cvCountV: 2,
      knotsU: [0,0,1,1], knotsV: [0,0,1,1],
      cvs: [-0.2,-0.2,zAt(-0.2),1, -0.2,1.2,zAt(-0.2),1, 1.2,-0.2,zAt(1.2),1, 1.2,1.2,zAt(1.2),1],
    };
    const resp = JSON.parse(mod.kern_ssi(JSON.stringify({
      surfA, surfB,
      options: { tolerance: 1e-4, maxDepth: 8, maxIter: 50, marchStep: 0.01, maxSteps: 1000 },
    })));
    if (!resp.ok) {
      const msg = resp.error?.message ?? JSON.stringify(resp.error) ?? '';
      if (msg.includes('capHit') || msg.includes('budget exhausted'))
        t3.detail = 'CAPHT BUDGET EXHAUSTED — maxLeaves=200 not effective: ' + msg;
      else t3.detail = 'SSI ok:false: ' + msg;
    } else { t3.pass = true; t3.detail = 'SSI ok — curves:' + (resp.curves?.length ?? 0) + ' (no capHit)'; }
  } catch(e) { t3.detail = 'exception: ' + e.message; }

  // ── T4 — Topology round-trip (#382) ─────────────────────────────────────
  let t4 = { name: 'T4', pass: false, detail: '' };
  try {
    const a = JSON.parse(boxBrepJson(-0.5, 0.5, -0.5, 0.5, -0.5, 0.5));
    const b = JSON.parse(boxBrepJson(0.4, 1.4, -0.5, 0.5, -0.5, 0.5));
    const resp = JSON.parse(mod.kern_boolean(JSON.stringify({ op: 'difference', a, b })));
    if (!resp.ok) { t4.detail = 'kern_boolean ok:false: ' + JSON.stringify(resp.error); }
    else {
      const sh = resp.result?.shells?.[0];
      const hasEdges = (sh?.edges?.length ?? 0) > 0;
      const hasVerts = (sh?.vertices?.length ?? 0) > 0;
      const hasFaces = (sh?.faces?.length ?? 0) > 0;
      const edgesOk = sh?.edges?.every(e => typeof e.faceIndex1 === 'number') ?? false;
      if (!hasEdges || !hasVerts || !hasFaces) t4.detail = 'topology stripped — faces:' + sh?.faces?.length + ' edges:' + sh?.edges?.length + ' vertices:' + sh?.vertices?.length;
      else if (!edgesOk) t4.detail = 'some edges missing faceIndex1';
      else { t4.pass = true; t4.detail = 'round-trip ok — faces:' + sh.faces.length + ' edges:' + sh.edges.length + ' vertices:' + sh.vertices.length; }
    }
  } catch(e) { t4.detail = 'exception: ' + e.message; }

  return { exports, tests: [t1, t2, t3, t4] };
})()`;

const testResult = await evaluate(testScript, 60000);
if (!testResult) { fail("KERN", "Browser eval returned null — kern.js load or script error"); }
else if (testResult.error) { fail("KERN", testResult.error); }
else {
  console.log(`[verify-389] kern exports: ${(testResult.exports ?? []).join(', ')}`);
  for (const t of testResult.tests ?? []) {
    if (t.pass) pass(t.name, t.detail);
    else fail(t.name, t.detail);
  }
}

ws.close();

// ── Receipt ───────────────────────────────────────────────────────────────────
const allPass = results.every(r => r.pass);
const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const receipt = {
  pr: 389, sha: EXPECTED_SHA.slice(0, 8),
  timestamp: new Date().toISOString(),
  cold_cache: USE_CDP,
  dev_url: DEV_BASE,
  all_passed: allPass,
  results,
  summary: `${results.filter(r => r.pass).length}/${results.length} passed`,
};
mkdirSync(STATE_DIR, { recursive: true });
const outFile = `${STATE_DIR}/verify-389-${receipt.sha}-${ts}.json`;
writeFileSync(outFile, JSON.stringify(receipt, null, 2));
console.log(`\n[verify-389] ${receipt.summary} — ${allPass ? "ALL PASS" : "FAIL"}`);
console.log(`[verify-389] Receipt: ${outFile}`);
if (!allPass) process.exit(1);
