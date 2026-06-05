#!/usr/bin/env node
// verify-step-export.mjs — Cold-cache CDP cert for SdStepWrite round-trip.
//
// Leo gate AC (mail #13039 + #13045):
//   AC1 — kern-wasm brep (SdBox → chain → OCCT): bbox + solid-count + volume ≤tol
//   AC2 — nurbs-ts replicadJs solid: bbox + solid-count + volume ≤tol (OCCT round-trip)
//   AC3 — nurbs-ts surface (Path C, exportNurbsToStep pure-TS): OCCT independent-importer
//          cross-check — re-import via OCCT worker (not a TS inverse), bbox match
//   AC4 — SdStepWrite audit-dispatch green (kernel:nurbs-ts, not stub)
//   AC5 — bun run verify exit 0
//   NOTE — headless feasibility: round-trip uses browser OCCT-wasm (not headless-eligible)
//
// Usage:
//   bun scripts/verify-step-export.mjs          # AC4/AC5 only (no browser)
//   bun scripts/verify-step-export.mjs --cdp    # full AC1-AC5 on deployed Pages cold-cache

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const CDP_BASE  = "http://localhost:9222";
const USE_CDP   = process.argv.includes("--cdp");
const STATE_DIR = fileURLToPath(new URL("../state/verify-step-export", import.meta.url));
const TOL_BBOX  = 0.05; // bbox dimension tolerance (metres)
const TOL_VOL   = 0.05; // volume relative tolerance (5%)

const results = [];
const pass = (ac, detail) => { console.log(`  PASS  ${ac}: ${detail}`); results.push({ ac, pass: true, detail }); };
const fail = (ac, detail) => { console.error(`  FAIL  ${ac}: ${detail}`); results.push({ ac, pass: false, detail }); };
const note = (msg) => console.log(`  note  ${msg}`);

// window.__runWorkerJs and window.__loadStepBytes are hooks into the browser-hosted
// replicad-opencascadejs OCCT-wasm worker (dom-events.ts). The OCCT worker loads as
// a Wasm module in the browser and is not available in Node/bun headless. Therefore
// the full round-trip (export → OCCT re-import → compare) requires a running browser
// and can only be verified post-merge on deployed Pages — it is NOT CI-pre-merge eligible.
// AC4/AC5 (static audit-dispatch + typecheck) are CI-eligible and run without --cdp.
const HEADLESS_NOTE = "round-trip requires browser OCCT-wasm — headless NOT feasible; post-merge cold-cache Pages only";

// ── AC4/AC5 — static checks ───────────────────────────────────────────────────
const REPO = fileURLToPath(new URL("..", import.meta.url));

console.log("[step-export] AC4: audit-dispatch (SdStepWrite kernel:nurbs-ts)");
try {
  execSync("bun scripts/audit-dispatch-routing.ts", { cwd: REPO, stdio: "pipe" });
  pass("AC4", "audit-dispatch exit 0 — SdStepWrite annotated nurbs-ts");
} catch (e) {
  fail("AC4", `audit-dispatch failed: ${e.message?.slice(0, 200)}`);
}

console.log("[step-export] AC5: bun run verify (typecheck + audit stack)");
try {
  execSync("bun run verify", { cwd: REPO, stdio: "pipe" });
  pass("AC5", "bun run verify exit 0");
} catch (e) {
  fail("AC5", `verify failed: ${e.stderr?.toString()?.slice(0, 200) ?? e.message?.slice(0, 200)}`);
}

if (!USE_CDP) {
  const allPass = results.every(r => r.pass);
  console.log(`\n[step-export] AC4/AC5 only (no --cdp). ${results.filter(r=>r.pass).length}/${results.length} passed.`);
  console.log("[step-export] Re-run with --cdp on deployed Pages for AC1-AC3 browser round-trip.");
  console.log(`[step-export] ${HEADLESS_NOTE}`);
  if (!allPass) process.exit(1);
  process.exit(0);
}

// ── CDP setup ─────────────────────────────────────────────────────────────────
console.log("[step-export] Connecting to CDP :9222");
const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) { fail("CDP", `Cannot reach ${CDP_BASE}`); process.exit(1); }
const tab = targets.find(t => t.type === "page");
if (!tab) { fail("CDP", "No page tab found"); process.exit(1); }

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

async function evaluate(expr, timeoutMs = 60000) {
  const res = await Promise.race([
    send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("CDP evaluate timeout")), timeoutMs)),
  ]);
  if (res?.result?.result?.subtype === "error") {
    throw new Error(res.result.result.description ?? "CDP evaluation error");
  }
  return res?.result?.result?.value ?? null;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");

// ── Cold-cache clear ──────────────────────────────────────────────────────────
console.log("[step-export] Clearing caches (cold-cache)");
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

// ── Navigate ──────────────────────────────────────────────────────────────────
console.log(`[step-export] Navigating to ${PAGES_URL}`);
const loadProm = new Promise(r => {
  const h = msg => { if (msg.method === "Page.loadEventFired") { msgListeners.splice(msgListeners.indexOf(h),1); r(); } };
  msgListeners.push(h);
});
await send("Page.navigate", { url: PAGES_URL });
await Promise.race([loadProm, new Promise(r => setTimeout(r, 30000))]);
await new Promise(r => setTimeout(r, 5000));

// ── Wait for OCCT worker ready ─────────────────────────────────────────────────
console.log("[step-export] Waiting for OCCT worker ready");
const ocReady = await evaluate(`
  new Promise(resolve => {
    if (typeof window.__runWorkerJs === 'function') { resolve(true); return; }
    const t = setInterval(() => {
      if (typeof window.__runWorkerJs === 'function') { clearInterval(t); resolve(true); }
    }, 500);
    setTimeout(() => { clearInterval(t); resolve(false); }, 25000);
  })
`, 30000);
if (!ocReady) { fail("AC1", "__runWorkerJs hook not ready after 25s"); process.exit(1); }
note("OCCT worker ready — hooks: __runWorkerJs, __loadStepBytes");

// ── Helper: OCCT round-trip ───────────────────────────────────────────────────
async function occtRoundTrip() {
  const raw = await evaluate(`(async () => {
    const exp = window.__lastStepExport;
    if (!exp?.bytes?.byteLength) return JSON.stringify({ error: "no __lastStepExport bytes" });
    try {
      const r = await window.__loadStepBytes(exp.bytes, 'step');
      return JSON.stringify({ byteLength: exp.bytes.byteLength, bounds: r.bounds, triangles: r.triangles });
    } catch(e) { return JSON.stringify({ error: e.message }); }
  })()`, 60000);
  return raw ? JSON.parse(raw) : { error: "null response" };
}

function bboxDims(bounds) {
  return {
    dx: bounds.max[0] - bounds.min[0],
    dy: bounds.max[1] - bounds.min[1],
    dz: bounds.max[2] - bounds.min[2],
  };
}

function assertBbox(ac, r, expected) {
  const { dx, dy, dz } = bboxDims(r.bounds);
  note(`${ac} OCCT bbox: dx=${dx.toFixed(3)} dy=${dy.toFixed(3)} dz=${dz.toFixed(3)}`);
  const errs = [];
  if (Math.abs(dx - expected.dx) > TOL_BBOX) errs.push(`dx ${dx.toFixed(3)} ≠ ${expected.dx} (tol=${TOL_BBOX})`);
  if (Math.abs(dy - expected.dy) > TOL_BBOX) errs.push(`dy ${dy.toFixed(3)} ≠ ${expected.dy} (tol=${TOL_BBOX})`);
  if (Math.abs(dz - expected.dz) > TOL_BBOX) errs.push(`dz ${dz.toFixed(3)} ≠ ${expected.dz} (tol=${TOL_BBOX})`);
  return errs;
}

function assertSolidCount(ac, r, min = 1) {
  if ((r.triangles ?? 0) < min) return [`triangles ${r.triangles} < ${min} — OCCT produced no geometry`];
  note(`${ac} OCCT triangles: ${r.triangles} (solid-count proxy ≥1)`);
  return [];
}

function assertVolume(ac, r, expectedVol) {
  const { dx, dy, dz } = bboxDims(r.bounds);
  const vol = dx * dy * dz;
  const relErr = Math.abs(vol - expectedVol) / expectedVol;
  note(`${ac} bbox-derived volume: ${vol.toFixed(4)} (expected ${expectedVol}, relErr=${(relErr*100).toFixed(1)}%)`);
  if (relErr > TOL_VOL) return [`volume ${vol.toFixed(4)} vs expected ${expectedVol} (relErr=${(relErr*100).toFixed(1)}% > ${TOL_VOL*100}%)`];
  return [];
}

// ── AC1 — kern-wasm brep: SdBox → userData.chain → OCCT → STEP → round-trip ──
console.log("[step-export] AC1: kern-wasm brep — SdBox → SdStepWrite(id) → OCCT round-trip");
{
  const disp = await evaluate(`(async () => {
    const r = await window.__dispatch("SdBox", { width: 2, depth: 1, height: 1 });
    return JSON.stringify(r);
  })()`, 20000);
  const boxResult = JSON.parse(disp ?? "null");
  if (!boxResult?.result?.created) {
    fail("AC1", `SdBox dispatch failed: ${JSON.stringify(boxResult)}`);
  } else {
    const uuid = boxResult.result.created;
    note(`SdBox: uuid=${uuid}`);
    const stepDisp = await evaluate(`(async () => {
      const r = await window.__dispatch("SdStepWrite", { id: ${JSON.stringify(uuid)}, filename: "box.step" });
      return JSON.stringify(r);
    })()`, 60000);
    const sr = JSON.parse(stepDisp ?? "null");
    const via = sr?.result?.via ?? "";
    if (!sr?.result?.written || !via.includes("replicad-opencascadejs")) {
      fail("AC1", `SdStepWrite failed or wrong path: ${JSON.stringify(sr)}`);
    } else {
      note(`AC1 export: via=${via} bytes=${sr.result.bytes}`);
      const r = await occtRoundTrip();
      if (r.error) {
        fail("AC1", `OCCT re-import: ${r.error}`);
      } else {
        // SdBox(2,1,1) → drawRectangle(2,1).extrude(1): dx=2 dy=1 dz=1 vol=2
        const errs = [
          ...assertBbox("AC1", r, { dx: 2, dy: 1, dz: 1 }),
          ...assertSolidCount("AC1", r),
          ...assertVolume("AC1", r, 2),
        ];
        if (errs.length) fail("AC1", errs.join("; "));
        else pass("AC1", `kern-wasm/chain round-trip PASS via=${via} tri=${r.triangles} vol≈2`);
      }
    }
  }
}

// ── AC2 — nurbs-ts/replicadJs solid → OCCT round-trip ─────────────────────────
console.log("[step-export] AC2: nurbs-ts/replicadJs — extrusion → OCCT round-trip");
{
  const replicadJs = `const shape = drawRectangle(1, 0.5).sketchOnPlane("XY").extrude(2);`;
  const stepDisp = await evaluate(`(async () => {
    const r = await window.__dispatch("SdStepWrite", { replicadJs: ${JSON.stringify(replicadJs)}, filename: "solid.step" });
    return JSON.stringify(r);
  })()`, 60000);
  const sr = JSON.parse(stepDisp ?? "null");
  const via = sr?.result?.via ?? "";
  if (!sr?.result?.written || !via.includes("replicad-opencascadejs")) {
    fail("AC2", `SdStepWrite(replicadJs) failed: ${JSON.stringify(sr)}`);
  } else {
    note(`AC2 export: via=${via} bytes=${sr.result.bytes}`);
    const r = await occtRoundTrip();
    if (r.error) {
      fail("AC2", `OCCT re-import: ${r.error}`);
    } else {
      // drawRectangle(1,0.5).extrude(2): dx=1 dy=0.5 dz=2 vol=1
      const errs = [
        ...assertBbox("AC2", r, { dx: 1, dy: 0.5, dz: 2 }),
        ...assertSolidCount("AC2", r),
        ...assertVolume("AC2", r, 1),
      ];
      if (errs.length) fail("AC2", errs.join("; "));
      else pass("AC2", `nurbs-ts/replicadJs round-trip PASS via=${via} tri=${r.triangles} vol≈1`);
    }
  }
}

// ── AC3 — nurbs-ts surface Path C → OCCT independent-importer cross-check ─────
// Per Leo #13045: Path C (exportNurbsToStep, pure-TS) MUST be re-imported via OCCT
// (independent consumer), NOT a TS inverse. __loadStepBytes routes through the
// replicad-opencascadejs OCCT-wasm worker — that IS the independent importer.
// A surface has no volume; assert bbox + triangles > 0 (OCCT parsed the face geometry).
console.log("[step-export] AC3: nurbs-ts Path C (exportNurbsToStep) → OCCT independent importer");
{
  let ac3done = false;

  // Attempt SdLoft to get a nurbs-ts surface record in the canonical store
  const loftDisp = await evaluate(`(async () => {
    try {
      const r = await window.__dispatch("SdLoft", {
        curves: [
          { points: [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,0]] },
          { points: [[0,0,2],[1,0,2],[1,1,2],[0,1,2],[0,0,2]] }
        ]
      });
      return JSON.stringify(r);
    } catch(e) { return JSON.stringify({ loft_error: e.message }); }
  })()`, 25000);
  const loftResult = JSON.parse(loftDisp ?? "null");
  note(`SdLoft result: ${JSON.stringify(loftResult)?.slice(0, 120)}`);

  if (loftResult?.result?.created) {
    const uuid = loftResult.result.created;
    const stepDisp = await evaluate(`(async () => {
      const r = await window.__dispatch("SdStepWrite", { id: ${JSON.stringify(uuid)}, filename: "surface.step" });
      return JSON.stringify(r);
    })()`, 30000);
    const sr = JSON.parse(stepDisp ?? "null");
    const via = sr?.result?.via ?? "";
    note(`AC3 SdStepWrite: via=${via} bytes=${sr?.result?.bytes}`);

    if (!sr?.result?.written) {
      fail("AC3", `SdStepWrite on loft failed: ${JSON.stringify(sr)}`);
      ac3done = true;
    } else if (via === "nurbs-ts/exportNurbsToStep") {
      // Path C fired — OCCT independent-importer cross-check
      const r = await occtRoundTrip();
      if (r.error) {
        fail("AC3", `Path C STEP rejected by OCCT independent importer: ${r.error}`);
      } else {
        const { dx, dy, dz } = bboxDims(r.bounds);
        note(`AC3 OCCT surface bbox: dx=${dx.toFixed(3)} dy=${dy.toFixed(3)} dz=${dz.toFixed(3)} tri=${r.triangles}`);
        const errs = assertSolidCount("AC3", r); // surfaces have no volume; tri>0 confirms OCCT parsed geometry
        if (errs.length) fail("AC3", `OCCT parsed Path-C STEP but no geometry: ${errs.join("; ")}`);
        else pass("AC3", `nurbs-ts/exportNurbsToStep → OCCT independent-importer PASS tri=${r.triangles} bbox=${dx.toFixed(2)}×${dy.toFixed(2)}×${dz.toFixed(2)}`);
      }
      ac3done = true;
    } else {
      // Loft took path A or B (chain/replicadJs) — not Path C
      note(`AC3: SdLoft produced via=${via}, not Path C. Object has userData.chain; OCCT worker handled it.`);
      note("AC3: Path C requires a pure nurbs-ts NurbsSurface without chain. Deferring to follow-on.");
    }
  }

  if (!ac3done) {
    // Path C could not be exercised via SdLoft in this build.
    // Document why and what's needed for follow-on.
    fail("AC3", [
      "DEFERRED — SdLoft did not produce a nurbs-ts canonical NurbsSurface in this build.",
      "Path C (exportNurbsToStep) fires only when viewer.getCanonicalGeometryStore().resolveObjectOrAncestor(obj).kind==='surface'.",
      "Follow-on: add a nurbs-ts-only dispatch path (e.g. SdNurbsSurface) that stores a KernelNurbsSurface without userData.chain.",
      "Until then, AC3 OCCT independent-importer cross-check is an open gate item per Leo #13045."
    ].join(" "));
  }
}

// ── Cert write ─────────────────────────────────────────────────────────────────
mkdirSync(STATE_DIR, { recursive: true });
const cert = {
  script: "verify-step-export.mjs",
  cold_cache: true,
  clear_protocol: "Network.clearBrowserCache + Storage.clearDataForOrigin",
  url: PAGES_URL,
  timestamp: new Date().toISOString(),
  headless_feasibility: HEADLESS_NOTE,
  paths: {
    AC1: "kern-wasm brep → userData.chain → replicad-opencascadejs OCCT → STEP → OCCT re-import",
    AC2: "nurbs-ts/replicadJs → replicad-opencascadejs OCCT → STEP → OCCT re-import",
    AC3: "nurbs-ts NurbsSurface → exportNurbsToStep (pure TS, ISO 10303-21) → OCCT independent-importer",
  },
  tolerances: { bbox_m: TOL_BBOX, volume_rel: TOL_VOL },
  proxy_scope: {
    volume: "bbox-derived (dx*dy*dz) — EQUALS true volume only for axis-aligned rectangular solids; NOT a general curved-solid fidelity check",
    solid_count: "triangles>0 from OCCT re-import — PRESENCE proxy (OCCT accepted+tessellated geometry), not shape-count or fidelity; bbox match is the load-bearing assertion",
    fold_forward: "curved-brep test solid + OCCT BRepGProp true-volume + face-count = next rigor increment (Leo #13050)",
  },
  results,
  totalPass: results.filter(r => r.pass).length,
  totalFail: results.filter(r => !r.pass).length,
};
writeFileSync(`${STATE_DIR}/cert.json`, JSON.stringify(cert, null, 2));
console.log(`\n[step-export] ${cert.totalPass}/${results.length} PASS · ${cert.totalFail} FAIL → ${STATE_DIR}/cert.json`);
if (cert.totalFail > 0) process.exit(1);
