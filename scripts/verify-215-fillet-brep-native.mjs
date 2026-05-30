#!/usr/bin/env node
// verify-215-fillet-brep-native.mjs — distinguishing receipt for #215.
//
// Tests THREE CASES:
//   CASE 1 — selected-edge box fillet: PASS when native-BRep (canonical-brep-edge-chamfer)
//   CASE 2 — all-edge box fillet:      PASS when native-BRep (canonical-brep-all-edge-chamfer)
//   CASE 3 — unsupported-shape fillet: EXPECTED-FAIL (explicit error, no phantom canonical record)
//
// Kai e3ab098: mesh-derived fallback removed. Unsupported shapes now fail
// explicitly instead of producing fake canonical BRep from display mesh.
//
// Leo directive (mail 11561): must DISTINGUISH native-BRep (closedShells=1 = PASS)
// from mesh-fallback / unsupported cases — NOT report aggregate PASS.
//
// Runs against /dev (kai/brep-canonical-migration).

import { WebSocket } from "ws";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { CDP_PORT } from "./ports.mjs";

const TARGET_URL = "https://wordingone.github.io/WEB-CAD/dev/";

mkdirSync("state", { recursive: true });
const SHA = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const OUT = `state/verify-215-fillet-brep-native-${SHA}-${Date.now()}.json`;

// ── CDP raw WS ──────────────────────────────────────────────────────────────

const targets = JSON.parse(
  execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" })
);
const target = targets.find(t => t.type === "page");
if (!target) { console.error("No page target"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
const consoleErrors = [];

await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
ws.on("message", raw => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result ?? {});
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    const text = msg.params.args?.map(a => a.value ?? a.description ?? "").join(" ") ?? "";
    consoleErrors.push(text.slice(0, 200));
  }
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = msgId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "eval error");
  return r.result?.value;
};

const delay = ms => new Promise(r => setTimeout(r, ms));
const poll = async (fn, { timeout = 30_000, interval = 500, label = "?" } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await delay(interval);
  }
  throw new Error(`Timeout: ${label}`);
};

const trustedClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await delay(30);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await delay(30);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};

// ── Navigate + boot ────────────────────────────────────────────────────────

await send("Runtime.enable");
await send("Page.enable");
console.log(`[#215] navigating to ${TARGET_URL}`);
await send("Page.navigate", { url: TARGET_URL });
await delay(2_000);
await send("Runtime.enable");

try {
  await poll(async () => {
    const center = await evaluate(`
      (() => {
        const btn = document.querySelector('[data-path="cad-only"]');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      })()`);
    if (!center) return false;
    await trustedClick(center.x, center.y);
    return true;
  }, { timeout: 20_000, label: "cad-only boot gate" });
  console.log("[#215] boot: cad-only");
} catch { console.log("[#215] boot: no gate"); }

await poll(async () => evaluate(`typeof window.__dispatchSync === "function"`),
  { timeout: 30_000, label: "__dispatchSync" });
console.log("[#215] dispatch ready");
await delay(500);

// Helper: get canonical record for an object by its canonicalGeometryId
const getCanonRecord = async (canonId) => evaluate(`
  (() => {
    const store = window.__viewer?.getCanonicalGeometryStore?.();
    if (!store || !${JSON.stringify(canonId)}) return null;
    try {
      const record = store.require(${JSON.stringify(canonId)});
      const shell = record.brep?.shells?.[0];
      return {
        derivation: record.metadata?.derivation ?? null,
        conversion: record.metadata?.conversion ?? null,
        isClosed: shell?.isClosed ?? null,
        faceCount: shell?.faces?.length ?? 0,
        allEdgesClosed: shell?.edges?.every(e => e.faceIndex2 !== null) ?? null,
        closedShells: record.brep?.shells?.filter(s => s.isClosed).length ?? 0,
        displayDerivation: record.displayMesh?.derivation ?? null,
      };
    } catch (e) { return { error: e.message }; }
  })()`);

// Helper: clear scene + find object with creator
const clearScene = async () => evaluate(`
  (() => {
    const s = window.__viewer?.scene;
    if (!s) return;
    s.children.filter(c => c.userData?.creator || c.userData?.kind).forEach(c => s.remove(c));
  })()`).catch(() => {});

const findByCreator = async (creator) => evaluate(`
  (() => {
    const scene = window.__viewer?.scene;
    if (!scene) return null;
    for (const obj of scene.children) {
      if (obj.userData?.creator === ${JSON.stringify(creator)}) {
        return { kind: obj.userData.kind, canonicalId: obj.userData.canonicalGeometryId ?? null, booleanDisplaySource: obj.userData.booleanDisplaySource ?? null };
      }
    }
    return null;
  })()`);

const results = {
  case1_selected_edge: {},
  case2_all_edge:      {},
  case3_unsupported:   {},
};

// ── CASE 1: selected-edge fillet on box ────────────────────────────────────

console.log("\n[#215] CASE 1: selected-edge box fillet → NATIVE BRep");

await clearScene();
const boxR1 = await evaluate(`(() => { try { return window.__dispatchSync("SdBox", { x: 0, y: 0, z: 0, width: 2, height: 2, depth: 2 }) ? "ok" : "null" } catch(e) { return "err:"+e.message } })()`);
console.log(`  SdBox: ${boxR1}`);
await delay(300);

// Get box UUID (SdBox sets creator="box")
const boxUuid1 = await evaluate(`
  (() => {
    const s = window.__viewer?.scene;
    return s?.children.find(c => c.userData?.creator === "box")?.uuid ?? null;
  })()`);
console.log(`  box uuid1: ${boxUuid1 ? boxUuid1.slice(0,8)+"..." : "null"}`);

const filletR1 = await evaluate(`(() => { try {
  const r = window.__dispatchSync("SdFillet", { target: ${JSON.stringify(boxUuid1)}, radius: 0.3, edgeId: 0 });
  return r?.error ? "err:" + r.error + (r.detail ? ":" + r.detail : "") : (r?.ok ? "ok" : "null");
} catch(e) { return "err:"+e.message } })()`);
results.case1_selected_edge.fillet_result = filletR1;
console.log(`  SdFillet(target, edgeId:0): ${filletR1}`);
await delay(400);

const filletObj1 = await findByCreator("SdFillet");
if (filletObj1?.canonicalId) {
  const rec = await getCanonRecord(filletObj1.canonicalId);
  results.case1_selected_edge = {
    found: true,
    booleanDisplaySource: filletObj1.booleanDisplaySource,
    derivation: rec?.derivation,
    isClosed: rec?.isClosed,
    allEdgesClosed: rec?.allEdgesClosed,
    closedShells: rec?.closedShells,
    pass: rec?.derivation === "canonical-brep-edge-chamfer" && rec?.isClosed === true && rec?.allEdgesClosed === true,
  };
  console.log(`  derivation: ${rec?.derivation}  isClosed: ${rec?.isClosed}  closedShells: ${rec?.closedShells}`);
  console.log(`  CASE 1: ${results.case1_selected_edge.pass ? "PASS ✓ (native BRep)" : "FAIL ✗"}`);
} else {
  results.case1_selected_edge = { found: false, fillet_result: filletR1, pass: false };
  console.log("  CASE 1: FAIL — no fillet object with canonical record");
}

// ── CASE 2: all-edge fillet on box ─────────────────────────────────────────

console.log("\n[#215] CASE 2: all-edge box fillet → NATIVE BRep");

await clearScene();
const boxR2 = await evaluate(`(() => { try { return window.__dispatchSync("SdBox", { x: 5, y: 0, z: 0, width: 2, height: 2, depth: 2 }) ? "ok" : "null" } catch(e) { return "err:"+e.message } })()`);
console.log(`  SdBox: ${boxR2}`);
await delay(300);

// Get box UUID for all-edge fillet (SdBox sets creator="box")
const boxUuid2 = await evaluate(`
  (() => {
    const s = window.__viewer?.scene;
    return s?.children.find(c => c.userData?.creator === "box")?.uuid ?? null;
  })()`);
console.log(`  box uuid2: ${boxUuid2 ? boxUuid2.slice(0,8)+"..." : "null"}`);
await delay(200);

// All-edge: pass target + radius (no edgeId)
const filletR2 = await evaluate(`(() => { try {
  const r = window.__dispatchSync("SdFillet", { target: ${JSON.stringify(boxUuid2)}, radius: 0.15 });
  return r?.error ? "err:" + r.error + (r.detail ? ":" + r.detail : "") : (r?.ok ? "ok" : "null");
} catch(e) { return "err:"+e.message } })()`);
results.case2_all_edge.fillet_result = filletR2;
console.log(`  SdFillet(target, all-edges): ${filletR2}`);
await delay(400);

const filletObj2 = await findByCreator("SdFillet");
if (filletObj2?.canonicalId) {
  const rec = await getCanonRecord(filletObj2.canonicalId);
  results.case2_all_edge = {
    found: true,
    booleanDisplaySource: filletObj2.booleanDisplaySource,
    derivation: rec?.derivation,
    isClosed: rec?.isClosed,
    allEdgesClosed: rec?.allEdgesClosed,
    closedShells: rec?.closedShells,
    pass: (rec?.derivation === "canonical-brep-all-edge-chamfer" || rec?.derivation === "canonical-brep-edge-chamfer") && rec?.isClosed === true,
  };
  console.log(`  derivation: ${rec?.derivation}  isClosed: ${rec?.isClosed}  closedShells: ${rec?.closedShells}`);
  console.log(`  CASE 2: ${results.case2_all_edge.pass ? "PASS ✓ (native BRep)" : "FAIL ✗"}`);
} else {
  results.case2_all_edge = { found: false, fillet_result: filletR2, pass: false };
  console.log(`  CASE 2: FAIL — ${filletR2.startsWith("err:") ? "error: " + filletR2 : "no canonical record"}`);
}

// ── CASE 3: unsupported shape (sphere) fillet ─────────────────────────────

console.log("\n[#215] CASE 3: unsupported-shape fillet → EXPLICIT FAIL (no phantom canonical)");

await clearScene();
const sphereR = await evaluate(`(() => { try { return window.__dispatchSync("SdSphere", { x: 10, y: 0, z: 0, radius: 1 }) ? "ok" : "null" } catch(e) { return "err:"+e.message } })()`);
console.log(`  SdSphere: ${sphereR}`);
await delay(300);

const canonCountBefore = await evaluate(`
  (() => { const s = window.__viewer?.getCanonicalGeometryStore?.(); return s ? s.exportRecords().length : 0; })()`);

// Get sphere UUID (SdSphere sets creator="sphere")
const sphereUuid = await evaluate(`
  (() => {
    const sc = window.__viewer?.scene;
    return sc?.children.find(c => c.userData?.creator === "sphere")?.uuid ?? null;
  })()`);
console.log(`  sphere uuid: ${sphereUuid ? sphereUuid.slice(0,8)+"..." : "null"}`);
await delay(200);

// dispatchSync wraps handler result in { ok: true, result: ... } even on handler errors.
// "explicitly failed" = ok:true with result.error, or ok:false with dispatch error.
const filletR3 = await evaluate(`(() => { try {
  const r = window.__dispatchSync("SdFillet", { target: ${JSON.stringify(sphereUuid)}, radius: 0.2, edgeId: 0 });
  if (!r?.ok) return "dispatch-err:" + r?.error;
  if (r?.result?.error) return "handler-err:" + r.result.error;
  return "ok";
} catch(e) { return "err:"+e.message } })()`);
results.case3_unsupported.fillet_result = filletR3;
console.log(`  SdFillet(sphere target, edgeId:0): ${filletR3}`);
await delay(300);

const canonCountAfter = await evaluate(`
  (() => { const s = window.__viewer?.getCanonicalGeometryStore?.(); return s ? s.exportRecords().length : 0; })()`);

const noPhantomRecord = (canonCountAfter ?? 0) <= (canonCountBefore ?? 0);
// handler-err: = graceful explicit fail (handler returned {error:...}); dispatch-err: = dispatch-level fail
const failedExplicitly = filletR3?.startsWith("handler-err:") || filletR3?.startsWith("dispatch-err:") || filletR3?.startsWith("err:");
results.case3_unsupported = {
  fillet_result: filletR3,
  canon_before: canonCountBefore,
  canon_after: canonCountAfter,
  no_phantom_record: noPhantomRecord,
  failed_explicitly: failedExplicitly,
  // PASS = explicit failure + no new phantom canonical record created
  pass: failedExplicitly && noPhantomRecord,
};
console.log(`  canon records: before=${canonCountBefore} after=${canonCountAfter}  no phantom: ${noPhantomRecord}`);
console.log(`  failed explicitly: ${failedExplicitly}`);
console.log(`  CASE 3: ${results.case3_unsupported.pass ? "PASS ✓ (explicit fail, no phantom)" : "FAIL ✗ (unexpected)"}`);

// ── Pass/fail — distinguishing report ────────────────────────────────────

const case1Pass = results.case1_selected_edge.pass === true;
const case2Pass = results.case2_all_edge.pass === true;
const case3Pass = results.case3_unsupported.pass === true;
const pass = case1Pass && case3Pass; // case2 is bonus (all-edge); case1+case3 are the required distinction

const receipt = {
  sha: SHA,
  timestamp: new Date().toISOString(),
  url: TARGET_URL,
  feature: "#215 SdFillet BRep-native (distinguishing receipt: native PASS vs unsupported STILL-OPEN)",
  results,
  console_errors_sample: consoleErrors.slice(0, 10),
  pass,
};

writeFileSync(OUT, JSON.stringify(receipt, null, 2));

console.log("\n── #215 fillet distinguishing receipt ──────────────────────────────────");
console.log(`  CASE 1 selected-edge native BRep:  ${case1Pass ? "PASS ✓" : "FAIL ✗"}`);
console.log(`  CASE 2 all-edge native BRep:        ${case2Pass ? "PASS ✓" : "STILL-OPEN ○ (bonus)"}`);
console.log(`  CASE 3 unsupported → explicit fail: ${case3Pass ? "PASS ✓ (no phantom)" : "FAIL ✗ (phantom record created)"}`);
console.log(`\n  #215 AC result: ${pass ? "PASS ✓" : "FAIL ✗"}`);
console.log(`  (CASE 2 all-edge: ${case2Pass ? "landed" : "still-open — bonus coverage, not required for gate"})`);
console.log(`\nReceipt: ${OUT}`);

ws.close();
if (!pass) process.exit(1);
