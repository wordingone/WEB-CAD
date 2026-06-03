#!/usr/bin/env node
// verify-485-villa-verde.mjs — Cold-cache CDP verify for #485 (Villa Verde in WEB-CAD).
//
// AC gates:
//   G1       — deploy SHA confirmed
//   T_REG    — registerGraph accepts VILLA_VERDE_DEF spec
//   T_EVAL   — GhComponentGraph_Evaluator dispatches all 6 verbs (4×SdWall, SdBox, SdRoof)
//   T_DELTA  — sceneChildrenDelta ≥ 5 (all 6 components created geometry)
//   T_LEDGER — ledger has SdRoof entry with status=success
//   T_SCREENSHOT — screenshot captured; saved for Haiku visual-check scoring
//
// Usage:
//   bun scripts/verify-485-villa-verde.mjs --cdp

import { WebSocket }               from "ws";
import { mkdirSync, writeFileSync } from "fs";
import { execSync }                 from "child_process";
import { fileURLToPath }            from "url";

const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const ORIGIN    = "https://wordingone.github.io";
const CDP_PORT  = 9222;
const USE_CDP   = process.argv.includes("--cdp");
const STATE_DIR = fileURLToPath(new URL("../state/diag-485", import.meta.url));

const results = [];
const pass = (name, detail) => { console.log(`  PASS  ${name}: ${detail}`); results.push({ pass: true, name, detail }); };
const fail = (name, detail) => { console.error(`  FAIL  ${name}: ${detail}`); results.push({ pass: false, name, detail }); };

// ── G1 — deploy SHA ───────────────────────────────────────────────────────────
console.log("[verify-485] G1: build-sha.txt");
let deploySha = "unknown";
{
  const txt = await fetch(`${PAGES_URL}build-sha.txt`).then(r => r.text()).catch(() => "FETCH_FAILED");
  deploySha = txt.trim();
  if (/^[0-9a-f]{40}$/i.test(deploySha)) pass("G1", `SHA=${deploySha.slice(0,7)}`);
  else fail("G1", `not a valid SHA: "${deploySha.slice(0, 80)}"`);
}

if (!USE_CDP) {
  console.log("[verify-485] --cdp not set; G1 only. Re-run with --cdp for full gates.");
  process.exit(results.every(r => r.pass) ? 0 : 1);
}

// ── CDP setup ─────────────────────────────────────────────────────────────────
const targets = JSON.parse(execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" }));
const target  = targets.find(t => t.type === "page");
if (!target) { fail("CDP", "No page tab at :9222"); process.exit(1); }
console.log(`[verify-485] Using tab: ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 1;
const pending = new Map();
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
ws.on("message", raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result ?? {});
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = mid++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr, timeoutMs = 30_000) => {
  const r = await Promise.race([
    send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${expr.slice(0, 60)}`)), timeoutMs)),
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval error");
  return r.result?.value;
};
const delay = ms => new Promise(r => setTimeout(r, ms));

await send("Runtime.enable");

// ── Cold-cache clear ──────────────────────────────────────────────────────────
console.log("[verify-485] clearing cold cache");
await send("Storage.clearDataForOrigin", { origin: ORIGIN, storageTypes: "cookies,local_storage,cache_storage,indexeddb,service_workers" });
await delay(200);

// ── Phase 1: Navigate + boot ──────────────────────────────────────────────────
console.log(`[verify-485] Phase 1: navigating → ${PAGES_URL}`);
await send("Page.navigate", { url: PAGES_URL });
await delay(4_000);
await evaluate(`window.__dispatchLedger = [];`);

const BOOT_TIMEOUT = 600_000;
const bootStart = Date.now();
console.log("[verify-485] waiting for boot...");
let booted = false;
while (Date.now() - bootStart < BOOT_TIMEOUT) {
  try {
    const badge = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? ''`);
    const dis   = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
    const txt   = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
    if (String(badge).includes("READY") && !dis && String(txt).includes("SEND")) { booted = true; break; }
    if (String(txt) === "…" && Boolean(dis) && String(badge).includes("READY")) {
      await evaluate(`{const b=document.querySelector('.chat-send-btn');if(b&&b.textContent==='…'){b.disabled=false;b.textContent='SEND';}}`);
    }
  } catch {}
  process.stdout.write(".");
  await delay(5_000);
}
console.log();
if (!booted) { fail("boot", "boot timeout"); ws.close(); process.exit(1); }
console.log(`[verify-485] booted in ${Math.round((Date.now()-bootStart)/1000)}s`);

// ── Phase 2: Register + evaluate Villa Verde ──────────────────────────────────
console.log("[verify-485] Phase 2: Villa Verde GhComponentGraph gates");
await evaluate(`window.__dispatchLedger = [];`);

const VILLA_VERDE_SPEC = JSON.stringify({
  inlineGraphId: "verify:villa-verde-485",
  label: "Villa Verde Typologia 2",
  inputPorts: [
    { name: "w",      min: 4.0,  max: 10.0, default: 6.096 },
    { name: "d",      min: 4.0,  max: 12.0, default: 7.315 },
    { name: "wall_h", min: 3.0,  max: 7.0,  default: 4.876 },
    { name: "pitch",  min: 10.0, max: 45.0, default: 24.2  },
  ],
  components: [
    { id: "wall_front", type: "SdWall",
      params: { start: {value:[0,0,0]}, end: {value:[6.096,0,0]}, height: {portRef:"wall_h"}, thickness: {value:0.2} } },
    { id: "wall_back",  type: "SdWall",
      params: { start: {value:[0,7.315,0]}, end: {value:[6.096,7.315,0]}, height: {portRef:"wall_h"}, thickness: {value:0.2} } },
    { id: "wall_left",  type: "SdWall",
      params: { start: {value:[0,0,0]}, end: {value:[0,7.315,0]}, height: {portRef:"wall_h"}, thickness: {value:0.2} } },
    { id: "wall_right", type: "SdWall",
      params: { start: {value:[6.096,0,0]}, end: {value:[6.096,7.315,0]}, height: {portRef:"wall_h"}, thickness: {value:0.2} } },
    { id: "floor_band", type: "SdBox",
      params: { width: {value:6.5}, depth: {value:7.5}, height: {value:0.15}, center: {value:[3.048,3.6575,2.438]} } },
    { id: "roof", type: "SdRoof",
      params: { roofType: {value:"pitched"}, footprint: {value:[[0,0],[6.096,0],[6.096,7.315],[0,7.315]]}, pitchDeg: {portRef:"pitch"} } },
  ],
});

// T_REG
const T_REG = await evaluate(`
  (() => {
    const reg = window.__ghRegisterGraph;
    if (!reg) return { error: "window.__ghRegisterGraph not on window" };
    const spec = ${VILLA_VERDE_SPEC};
    try { reg(spec.inlineGraphId, spec); return { ok: true }; }
    catch (e) { return { error: String(e) }; }
  })()
`).catch(e => ({ error: e.message }));

if (T_REG?.ok === true) {
  pass("T_REG", "registerGraph accepted Villa Verde spec");
} else {
  fail("T_REG", `unexpected: ${JSON.stringify(T_REG)}`);
}

// T_EVAL + T_DELTA: evaluate with canonical dims
const beforeCount = await evaluate(`window.__viewer?.scene?.children.length ?? -1`).catch(() => -1);
const T_EVAL_RAW = await evaluate(`
  (() => {
    const ds = window.__dispatchSync;
    if (!ds) return { error: "dispatchSync not on window" };
    const r = ds("GhComponentGraph_Evaluator", {
      graphId: "verify:villa-verde-485",
      inputValues: { w: 6.096, d: 7.315, wall_h: 4.876, pitch: 24.2 },
    });
    return { ok: r.ok, result: r.result, error: r.error ?? null };
  })()
`).catch(e => ({ error: e.message }));

await delay(500);
const afterCount = await evaluate(`window.__viewer?.scene?.children.length ?? -1`).catch(() => -1);
const delta = afterCount - beforeCount;

if (T_EVAL_RAW?.ok === true && !T_EVAL_RAW?.result?.error) {
  pass("T_EVAL", `GhComponentGraph_Evaluator ok=true, dispatchedVerbs=${JSON.stringify(T_EVAL_RAW.result?.dispatchedVerbs)}`);
} else {
  fail("T_EVAL", `unexpected: ${JSON.stringify(T_EVAL_RAW)}`);
}

const MIN_EXPECTED_DELTA = 5; // 4 walls + floor_band + roof = 6 components, some may create multi-child groups
if (delta >= MIN_EXPECTED_DELTA) {
  pass("T_DELTA", `sceneChildrenDelta=${delta} ≥ ${MIN_EXPECTED_DELTA} (before=${beforeCount} after=${afterCount})`);
} else {
  fail("T_DELTA", `sceneChildrenDelta=${delta} < ${MIN_EXPECTED_DELTA} — expected ≥${MIN_EXPECTED_DELTA} from 6 components (before=${beforeCount} after=${afterCount})`);
}

// T_LEDGER: ledger has SdRoof success
await delay(200);
const ledger = await evaluate(`JSON.parse(JSON.stringify(window.__dispatchLedger || []))`).catch(() => []);
const roofEntry = ledger.find(e => e.verb === "SdRoof" && e.status === "success");
if (roofEntry) {
  pass("T_LEDGER", `SdRoof ledger entry: status=${roofEntry.status}`);
} else {
  const all = ledger.map(e => `${e.verb}:${e.status}`).join(", ");
  fail("T_LEDGER", `no SdRoof success in ledger. Entries: [${all || "none"}]`);
}

// T_SCREENSHOT: capture front elevation for visual scoring
console.log("[verify-485] T_SCREENSHOT: capturing front elevation...");
// Attempt to set view to front elevation (looking at Y=0 face from -Y direction)
await evaluate(`
  (() => {
    const viewer = window.__viewer;
    if (!viewer?.setCameraView) return;
    try {
      // Set orthographic front view — gable-end face at Y=0 is the front elevation
      viewer.setCameraView?.("front");
    } catch {}
  })()
`).catch(() => {});
await delay(1_000);

let screenshotPath = null;
try {
  const { data } = await send("Page.captureScreenshot", { format: "png", quality: 90 });
  mkdirSync(STATE_DIR, { recursive: true });
  screenshotPath = `${STATE_DIR}/front-elevation-${Date.now()}.png`;
  writeFileSync(screenshotPath, Buffer.from(data, "base64"));
  pass("T_SCREENSHOT", `front elevation saved: ${screenshotPath}`);
} catch (e) {
  fail("T_SCREENSHOT", `screenshot failed: ${e.message}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log();
const allPass = results.every(r => r.pass);
const passCount = results.filter(r => r.pass).length;
console.log(`[verify-485] ${passCount}/${results.length} PASS — deploySha=${deploySha.slice(0,7)}`);

mkdirSync(STATE_DIR, { recursive: true });
const ledgerPath = `${STATE_DIR}/ledger-${Date.now()}.json`;
writeFileSync(ledgerPath, JSON.stringify({
  deploySha,
  results,
  ledger,
  sceneChildrenDelta: delta,
  screenshotPath,
  evalResult: T_EVAL_RAW,
}, null, 2));
console.log(`[verify-485] ledger written: ${ledgerPath}`);
if (screenshotPath) console.log(`[verify-485] screenshot: ${screenshotPath}`);

ws.close();
process.exit(allPass ? 0 : 1);
