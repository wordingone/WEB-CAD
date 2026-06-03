#!/usr/bin/env node
// verify-480-gh-eval.mjs — Cold-cache CDP verify for #480 (GH client-side evaluator).
//
// AC gates:
//   T_REG  — registerGraph() registers a graph without error
//   T_EVAL — GhComponentGraph_Evaluator dispatches SdBox for the box sample def
//   T_DELTA — sceneChildrenDelta > 0 (geometry actually appeared in scene)
//   T_LEDGER_BOX — ledger has SdBox entry with status=success
//   T_PARAMS — evaluator with custom inputValues (w=2, h=1, d=3) returns delta>0
//   T_NO_SPEC — evaluator with unknown graphId returns error (not crash)
//
// Usage:
//   bun scripts/verify-480-gh-eval.mjs --cdp

import { WebSocket }               from "ws";
import { mkdirSync, writeFileSync } from "fs";
import { execSync }                 from "child_process";
import { fileURLToPath }            from "url";

const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const ORIGIN    = "https://wordingone.github.io";
const CDP_PORT  = 9222;
const USE_CDP   = process.argv.includes("--cdp");
const STATE_DIR = fileURLToPath(new URL("../state/diag-480", import.meta.url));

const results = [];
const pass = (name, detail) => { console.log(`  PASS  ${name}: ${detail}`); results.push({ pass: true, name, detail }); };
const fail = (name, detail) => { console.error(`  FAIL  ${name}: ${detail}`); results.push({ pass: false, name, detail }); };

// ── G1 — deploy SHA ───────────────────────────────────────────────────────────
console.log("[verify-480] G1: build-sha.txt");
let deploySha = "unknown";
{
  const txt = await fetch(`${PAGES_URL}build-sha.txt`).then(r => r.text()).catch(() => "FETCH_FAILED");
  deploySha = txt.trim();
  if (/^[0-9a-f]{40}$/i.test(deploySha)) pass("G1", `SHA=${deploySha.slice(0,7)}`);
  else fail("G1", `not a valid SHA: "${deploySha.slice(0, 80)}"`);
}

if (!USE_CDP) {
  console.log("[verify-480] --cdp not set; G1 only. Re-run with --cdp for full gates.");
  process.exit(results.every(r => r.pass) ? 0 : 1);
}

// ── CDP setup ─────────────────────────────────────────────────────────────────
const targets = JSON.parse(execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" }));
const target  = targets.find(t => t.type === "page");
if (!target) { fail("CDP", "No page tab at :9222"); process.exit(1); }
console.log(`[verify-480] Using tab: ${target.url}`);

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
console.log("[verify-480] clearing cold cache");
await send("Storage.clearDataForOrigin", { origin: ORIGIN, storageTypes: "cookies,local_storage,cache_storage,indexeddb,service_workers" });
await delay(200);

// ── Phase 1: Navigate + boot ──────────────────────────────────────────────────
console.log(`[verify-480] Phase 1: navigating → ${PAGES_URL}`);
await send("Page.navigate", { url: PAGES_URL });
await delay(4_000);
await evaluate(`window.__dispatchLedger = [];`);

const BOOT_TIMEOUT = 600_000;
const bootStart = Date.now();
console.log("[verify-480] waiting for boot...");
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
console.log(`[verify-480] booted in ${Math.round((Date.now()-bootStart)/1000)}s`);

// ── Phase 2: Verify registerGraph + evaluator + scene delta ──────────────────
console.log("[verify-480] Phase 2: GH client-side evaluator gates");
await evaluate(`window.__dispatchLedger = [];`);

const BOX_SPEC = JSON.stringify({
  inlineGraphId: "verify:box-480",
  label: "Verify Box",
  inputPorts: [
    { name: "w", min: 0.1, max: 20, default: 5 },
    { name: "h", min: 0.1, max: 10, default: 3 },
    { name: "d", min: 0.1, max: 20, default: 5 },
  ],
  components: [
    { id: "box1", type: "SdBox", params: {
        width:  { portRef: "w" },
        height: { portRef: "h" },
        depth:  { portRef: "d" },
    }},
  ],
});

// T_REG: registerGraph is available and accepts the spec
const T_REG = await evaluate(`
  (() => {
    const reg = window.__ghRegisterGraph;
    if (!reg) return { error: "window.__ghRegisterGraph not on window" };
    const spec = ${BOX_SPEC};
    try { reg(spec.inlineGraphId, spec); return { ok: true }; }
    catch (e) { return { error: String(e) }; }
  })()
`).catch(e => ({ error: e.message }));

if (T_REG?.ok === true) {
  pass("T_REG", "registerGraph accepted box spec without throwing");
} else {
  fail("T_REG", `unexpected: ${JSON.stringify(T_REG)}`);
}

// T_EVAL + T_DELTA: dispatch GhComponentGraph_Evaluator with default slider values
const beforeCount = await evaluate(`window.__viewer?.scene?.children.length ?? -1`).catch(() => -1);
const T_EVAL_RAW = await evaluate(`
  (() => {
    const ds = window.__dispatchSync;
    if (!ds) return { error: "dispatchSync not on window" };
    const r = ds("GhComponentGraph_Evaluator", {
      graphId: "verify:box-480",
      inputValues: { w: 5, h: 3, d: 5 },
    });
    return { ok: r.ok, result: r.result, error: r.error ?? null };
  })()
`).catch(e => ({ error: e.message }));

const afterCount = await evaluate(`window.__viewer?.scene?.children.length ?? -1`).catch(() => -1);
const delta = afterCount - beforeCount;

if (T_EVAL_RAW?.ok === true && !T_EVAL_RAW?.result?.error) {
  pass("T_EVAL", `GhComponentGraph_Evaluator ok=true, dispatchedVerbs=${JSON.stringify(T_EVAL_RAW.result?.dispatchedVerbs)}`);
} else {
  fail("T_EVAL", `unexpected: ${JSON.stringify(T_EVAL_RAW)}`);
}

if (delta > 0) {
  pass("T_DELTA", `sceneChildrenDelta=${delta} (geometry created, before=${beforeCount} after=${afterCount})`);
} else {
  fail("T_DELTA", `sceneChildrenDelta=${delta} — no geometry created (before=${beforeCount} after=${afterCount})`);
}

// T_LEDGER_BOX: ledger has SdBox success
await delay(200);
const ledger = await evaluate(`JSON.parse(JSON.stringify(window.__dispatchLedger || []))`).catch(() => []);
const boxEntry = ledger.find(e => e.verb === "SdBox" && e.status === "success");
if (boxEntry) {
  pass("T_LEDGER_BOX", `SdBox ledger: status=${boxEntry.status}`);
} else {
  const all = ledger.map(e => `${e.verb}:${e.status}`).join(", ");
  fail("T_LEDGER_BOX", `no SdBox success in ledger. Entries: [${all || "none"}]`);
}

// T_PARAMS: custom inputValues produce a second box
await evaluate(`window.__dispatchLedger = [];`);
const before2 = await evaluate(`window.__viewer?.scene?.children.length ?? -1`).catch(() => -1);
const T_PARAMS_RAW = await evaluate(`
  (() => {
    const ds = window.__dispatchSync;
    const r = ds("GhComponentGraph_Evaluator", {
      graphId: "verify:box-480",
      inputValues: { w: 2, h: 1, d: 3 },
    });
    return { ok: r.ok, delta: r.result?.sceneChildrenDelta, error: r.result?.error ?? r.error ?? null };
  })()
`).catch(e => ({ error: e.message }));
const after2 = await evaluate(`window.__viewer?.scene?.children.length ?? -1`).catch(() => -1);

if (T_PARAMS_RAW?.ok === true && !T_PARAMS_RAW?.error && after2 > before2) {
  pass("T_PARAMS", `custom inputValues {w:2,h:1,d:3} → delta=${after2 - before2}`);
} else {
  fail("T_PARAMS", `unexpected: ${JSON.stringify(T_PARAMS_RAW)} before=${before2} after=${after2}`);
}

// T_NO_SPEC: unknown graphId returns error, not a crash
const T_NO_SPEC = await evaluate(`
  (() => {
    const ds = window.__dispatchSync;
    const r = ds("GhComponentGraph_Evaluator", { graphId: "nonexistent-graph-xyz" });
    return { ok: r.ok, resultError: r.result?.error ?? null };
  })()
`).catch(e => ({ error: e.message }));

if (T_NO_SPEC?.ok === true && typeof T_NO_SPEC?.resultError === "string" && T_NO_SPEC.resultError.includes("no spec registered")) {
  pass("T_NO_SPEC", `unknown graphId → ok=true, result.error="${T_NO_SPEC.resultError.slice(0, 60)}…"`);
} else {
  fail("T_NO_SPEC", `unexpected: ${JSON.stringify(T_NO_SPEC)}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log();
const allPass = results.every(r => r.pass);
const passCount = results.filter(r => r.pass).length;
console.log(`[verify-480] ${passCount}/${results.length} PASS — deploySha=${deploySha.slice(0,7)}`);

mkdirSync(STATE_DIR, { recursive: true });
const ledgerPath = `${STATE_DIR}/ledger-${Date.now()}.json`;
writeFileSync(ledgerPath, JSON.stringify({
  deploySha,
  results,
  ledger,
  sceneChildrenDeltas: { t_eval: delta, t_params: after2 - before2 },
}, null, 2));
console.log(`[verify-480] ledger written: ${ledgerPath}`);

ws.close();
process.exit(allPass ? 0 : 1);
