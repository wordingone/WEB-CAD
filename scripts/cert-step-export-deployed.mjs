#!/usr/bin/env bun
// IFC STEP export — deployed-Pages end-to-end cert (Leo #13386)
//
// Connects to shared CDP browser at :9222, navigates to deployed Pages,
// builds the 2-storey house via __wcDispatch, triggers SdExport({ format: "step" }),
// captures window.__lastStepExport.bytes, and asserts via ISO 10303-21 text parsing:
//   AC1. Output is valid ISO-10303-21 with AUTOMOTIVE_DESIGN (AP214) schema
//   AC2. PRODUCT count == EXTRUDED_AREA_SOLID count == 14 (house element count)
//   AC3. RECTANGLE_PROFILE_DEF count == 14
//   AC4. No zero-dimension solid (all 14 must survive AABB extraction)
//   AC5. audit-dispatch exit 0
//   AC6. bun run verify exit 0

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const CDP_BASE  = "http://localhost:9222";

function sha() {
  try { return execSync("git -C B:/M/WEB-CAD-archie rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

function countEntity(text, entity) {
  return (text.match(new RegExp(`=${entity}\\(`, "g")) ?? []).length;
}

// ── Static checks (no browser) ───────────────────────────────────────────────

const REPO = "B:/M/WEB-CAD-archie";
const results = { sha: sha(), PAGES_URL, assertions: [] };

function assert(label, actual, expected, op = "===") {
  const pass = op === ">=" ? actual >= expected : actual === expected;
  results.assertions.push({ label, actual, expected, op, pass });
  const icon = pass ? "✓" : "✗";
  console.log(`  ${icon}  ${label}: ${actual} ${op} ${expected}`);
  return pass;
}

let allPass = true;

console.log("[step-cert] AC5: audit-dispatch");
try {
  execSync("bun scripts/audit-dispatch-routing.ts", { cwd: REPO, stdio: "pipe" });
  allPass = assert("AC5: audit-dispatch exit 0", 1, 1) && allPass;
} catch (e) {
  allPass = assert("AC5: audit-dispatch exit 0", 0, 1) && allPass;
  console.error("  audit-dispatch:", e.stderr?.toString().slice(0, 200) ?? e.message);
}

console.log("[step-cert] AC6: bun run verify");
try {
  execSync("bun run verify", { cwd: REPO, stdio: "pipe" });
  allPass = assert("AC6: bun run verify exit 0", 1, 1) && allPass;
} catch (e) {
  allPass = assert("AC6: bun run verify exit 0", 0, 1) && allPass;
  console.error("  verify:", e.stderr?.toString().slice(0, 200) ?? e.message);
}

// ── CDP setup ─────────────────────────────────────────────────────────────────

const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) {
  console.error("ERROR: Cannot reach CDP at :9222 — is the shared browser running?");
  process.exit(1);
}
const pageTarget = targets.find(t => t.type === "page");
if (!pageTarget) {
  console.error("ERROR: no page tab found in shared browser");
  process.exit(1);
}
console.log(`Attaching to tab: ${pageTarget.url}`);

const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();

ws.onmessage = m => {
  const x = JSON.parse(m.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
  if (x.method === "Page.javascriptDialogOpening") {
    send("Page.handleJavaScriptDialog", { accept: true });
  }
};
await new Promise(r => ws.addEventListener("open", r));

function send(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    throw new Error(`CDP eval error: ${r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails)}`);
  }
  return r.result?.result?.value ?? null;
}

async function dispatch(verb, args) {
  const result = await evaluate(`window.__wcDispatch(${JSON.stringify(verb)}, ${JSON.stringify(args)})`);
  if (typeof result === "string") {
    const parsed = JSON.parse(result);
    if (parsed.error) throw new Error(`${verb} error: ${parsed.error}`);
    return parsed;
  }
  return result;
}

// ── Navigate to deployed Pages ────────────────────────────────────────────────

await send("Page.enable", {});
console.log(`\nNavigating to ${PAGES_URL}...`);
await send("Page.navigate", { url: PAGES_URL });

for (let i = 0; i < 60; i++) {
  const ready = await evaluate("typeof window.__wcDispatch === 'function'");
  if (ready) { console.log("App ready (__wcDispatch available)"); break; }
  if (i === 59) { console.error("ERROR: App did not become ready in 60s"); process.exit(1); }
  await new Promise(r => setTimeout(r, 1000));
}

// ── Build the 2-storey house ──────────────────────────────────────────────────

const GF_H = 2.8, UF_H = 2.6, T = 0.25, FP_W = 11, FP_D = 8.5;

await dispatch("SdClearScene", {});
console.log("Scene cleared");

const gfLvl = await dispatch("SdLevel", { name: "Ground Floor", elevation: 0,    height: GF_H });
const ufLvl = await dispatch("SdLevel", { name: "Upper Floor",  elevation: GF_H, height: UF_H });
const GF_LVL = gfLvl.result?.levelId ?? "level/0";
const UF_LVL = ufLvl.result?.levelId ?? "level/1";
console.log(`Levels: GF=${GF_LVL} UF=${UF_LVL}`);

await dispatch("setActiveLevel", { id: GF_LVL });

await dispatch("SdSlab",   { width: FP_W, depth: FP_D, thickness: 0.2 });
await dispatch("SdWall",   { start: [0, 0, 0],    end: [FP_W, 0, 0],    height: GF_H, thickness: T });
await dispatch("SdWall",   { start: [0, FP_D, 0], end: [FP_W, FP_D, 0], height: GF_H, thickness: T });
await dispatch("SdWall",   { start: [0, 0, 0],    end: [0, FP_D, 0],    height: GF_H, thickness: T });
await dispatch("SdWall",   { start: [FP_W, 0, 0], end: [FP_W, FP_D, 0], height: GF_H, thickness: T });
await dispatch("SdDoor",   { position: [4.925, 0, 0], doorType: "front" });
await dispatch("SdWindow", { position: [1.9, 0, 0.8], windowType: "eg" });
console.log("GF elements created");

await dispatch("setActiveLevel", { id: UF_LVL });

await dispatch("SdSlab",   { width: FP_W, depth: FP_D, thickness: 0.2 });
await dispatch("SdWall",   { start: [0, 0, 0],    end: [FP_W, 0, 0],    height: UF_H, thickness: T });
await dispatch("SdWall",   { start: [0, FP_D, 0], end: [FP_W, FP_D, 0], height: UF_H, thickness: T });
await dispatch("SdWall",   { start: [0, 0, 0],    end: [0, FP_D, 0],    height: UF_H, thickness: T });
await dispatch("SdWall",   { start: [FP_W, 0, 0], end: [FP_W, FP_D, 0], height: UF_H, thickness: T });
await dispatch("SdWindow", { position: [3.5, 0, GF_H + 0.9], windowType: "og" });
await dispatch("SdWindow", { position: [7.5, 0, GF_H + 0.9], windowType: "og" });
console.log("UF elements created");

// ── SdExport format=step ──────────────────────────────────────────────────────

await evaluate("delete window.__lastStepExport");
await dispatch("SdExport", { format: "step" });
console.log("SdExport dispatched, waiting for __lastStepExport...");

let b64 = null;
for (let i = 0; i < 30; i++) {
  b64 = await evaluate(`(function() {
    const exp = window.__lastStepExport;
    if (!exp?.bytes?.length) return null;
    const bytes = exp.bytes;
    const chunks = [];
    for (let j = 0; j < bytes.length; j += 4096) {
      chunks.push(String.fromCharCode(...bytes.subarray(j, j + 4096)));
    }
    return btoa(chunks.join(''));
  })()`);
  if (b64) { console.log(`STEP export ready — ${b64.length} base64 chars`); break; }
  if (i === 29) { console.error("ERROR: __lastStepExport not available after 30s"); process.exit(1); }
  await new Promise(r => setTimeout(r, 1000));
}

ws.close();

// ── Decode + assert via ISO 10303-21 text parsing ────────────────────────────

const stepBytes = new Uint8Array(Buffer.from(b64, "base64"));
const stepText  = new TextDecoder().decode(stepBytes);
console.log(`STEP bytes: ${stepBytes.byteLength} bytes`);
results.byteSize = stepBytes.byteLength;

// Persist raw STEP for independent verification
mkdirSync("state", { recursive: true });
const stepFilePath = `state/cert-step-export-deployed-${results.sha}.step`;
writeFileSync(stepFilePath, stepBytes);
console.log(`STEP file saved: ${stepFilePath}`);

console.log("\n── Assertions ──────────────────────────────────────────────────");

// AC1 — well-formed STEP-21
allPass = assert("AC1: ISO-10303-21 header present",       stepText.includes("ISO-10303-21;") ? 1 : 0, 1) && allPass;
allPass = assert("AC1: END-ISO-10303-21 footer present",   stepText.includes("END-ISO-10303-21;") ? 1 : 0, 1) && allPass;
allPass = assert("AC1: AP214 schema in FILE_SCHEMA",       /FILE_SCHEMA\(\('AUTOMOTIVE_DESIGN/.test(stepText) ? 1 : 0, 1) && allPass;

// AC2 — entity counts
const prodCount  = countEntity(stepText, "PRODUCT");
const solidCount = countEntity(stepText, "EXTRUDED_AREA_SOLID");
const EXPECTED = 14; // 8 walls + 2 slabs + 1 door + 3 windows
allPass = assert("AC2: PRODUCT count == 14",              prodCount,  EXPECTED) && allPass;
allPass = assert("AC2: EXTRUDED_AREA_SOLID count == 14",  solidCount, EXPECTED) && allPass;

// AC3 — profile count
const profCount = countEntity(stepText, "RECTANGLE_PROFILE_DEF");
allPass = assert("AC3: RECTANGLE_PROFILE_DEF count == 14", profCount, EXPECTED) && allPass;

// AC4 — all 14 solids survived (no skip due to zero dimension)
allPass = assert("AC4: all 14 elements have valid AABB (none skipped)", solidCount, EXPECTED) && allPass;

// ── Save cert ─────────────────────────────────────────────────────────────────

results.allPass = allPass;
results.timestamp = new Date().toISOString();
results.cold_cache = false;
results.counts = { product: prodCount, extruded_area_solid: solidCount, rectangle_profile_def: profCount };

const certPath = `state/cert-step-export-deployed-${results.sha}.json`;
writeFileSync(certPath, JSON.stringify(results, null, 2));
console.log(`\n── ${allPass ? "ALL PASS" : "FAIL"} — cert saved: ${certPath}`);

if (!allPass) process.exit(1);
