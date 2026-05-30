#!/usr/bin/env node
// verify-232-boot-block.mjs — AC receipt for #232.
//
// Verifies fix 5050e82 ("Let CAD remain usable when model download is skipped"):
//   AC1 — consent-cancel (Not now) removes the boot-screen and exposes CAD
//   AC2 — window.__agentModelStatus.state === 'skipped' after cancel
//   AC3 — CAD is operable (dispatch + scene mutation works, no crash)
//   AC4 — state holds across ≥3 cold-cache runs (SW+cache+cookies cleared each run)
//
// Targets GH Pages stable: https://wordingone.github.io/WEB-CAD/
// Run with COLD_CACHE=1 to enable cold-cache pre-clearing (required for AC4).

import { WebSocket } from "ws";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { CDP_PORT } from "./ports.mjs";

mkdirSync("state", { recursive: true });
const SHA = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const COLD = !!process.env.COLD_CACHE;
const STABLE_URL = "https://wordingone.github.io/WEB-CAD/";
const PASS_TARGET = COLD ? 3 : 1;

const targets = JSON.parse(
  execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" })
);
const target = targets.find(t => t.type === "page");
if (!target) { console.error("No page target"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();

await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
ws.on("message", raw => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result ?? {});
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
const poll = async (fn, { timeout = 20_000, interval = 300, label = "?" } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await delay(interval);
  }
  throw new Error(`Timeout: ${label}`);
};

const clearStorage = async () => {
  await send("Storage.clearDataForOrigin", {
    origin: "https://wordingone.github.io",
    storageTypes: "service_workers,cache_storage,cookies,local_storage",
  });
};

const trustedClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await delay(30);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await delay(30);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};

const runPass = async (passNum) => {
  console.log(`\n[#232] Pass ${passNum}/${PASS_TARGET}`);

  if (COLD) {
    await clearStorage();
    console.log("  storage cleared");
  }

  const consoleErrors = [];
  await send("Runtime.enable");
  await send("Page.enable");

  // Listen for console errors
  ws.on("message", raw => {
    const msg = JSON.parse(raw);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      const text = msg.params.args?.map(a => a.value ?? a.description ?? "").join(" ") ?? "";
      consoleErrors.push(text.slice(0, 200));
    }
  });

  const t0 = Date.now();
  await send("Page.navigate", { url: STABLE_URL });
  await delay(2_000);
  await send("Runtime.enable");
  await delay(300);

  // Wait for consent dialog to appear
  let consentFound = false;
  try {
    await poll(async () => {
      const found = await evaluate(`!!document.getElementById('consent-cancel')`);
      return found;
    }, { timeout: 15_000, label: "consent-cancel button" });
    consentFound = true;
    console.log("  consent dialog appeared");
  } catch {
    console.log("  consent dialog not found — may have auto-dismissed");
  }

  // Click consent-cancel ("Not now") via trusted click
  let cancelClicked = false;
  if (consentFound) {
    const cancelCoords = await evaluate(`
      (() => {
        const btn = document.getElementById('consent-cancel');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      })()`);
    if (cancelCoords) {
      await trustedClick(cancelCoords.x, cancelCoords.y);
      cancelClicked = true;
      console.log(`  clicked consent-cancel at (${cancelCoords.x}, ${cancelCoords.y})`);
    }
  }
  await delay(500);

  // AC1: boot-screen removed
  const bootScreenGone = await evaluate(`
    (() => {
      const bs = document.getElementById('boot-screen');
      if (!bs) return true;
      const s = window.getComputedStyle(bs);
      return s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0' || bs.style.display === 'none';
    })()`);
  console.log(`  AC1 boot-screen gone: ${bootScreenGone}`);

  // Wait for viewer
  try {
    await poll(async () => evaluate(`!!(window.__viewer?.scene)`), { timeout: 15_000, label: "viewer.scene" });
  } catch {
    console.log("  viewer.scene timed out");
  }
  await delay(300);

  // AC2: __agentModelStatus.state === 'skipped'
  const agentStatus = await evaluate(`window.__agentModelStatus`);
  const stateSkipped = agentStatus?.state === "skipped";
  console.log(`  AC2 __agentModelStatus: ${JSON.stringify(agentStatus)}  skipped: ${stateSkipped}`);

  // AC3: CAD operable — dispatch SdBox
  let cadOperable = false;
  let dispatchResult = null;
  try {
    // Need dispatchSync
    await poll(async () => evaluate(`typeof window.__dispatchSync === 'function'`), { timeout: 10_000, label: "__dispatchSync" });
    dispatchResult = await evaluate(`window.__dispatchSync('SdBox', { x: 0, y: 0, z: 0, width: 1, depth: 1, height: 1 })`);
    cadOperable = !!(dispatchResult?.ok);
    console.log(`  AC3 SdBox dispatch: ok=${dispatchResult?.ok} canonical=${dispatchResult?.canonical}`);
  } catch (e) {
    console.log(`  AC3 dispatch error: ${e.message}`);
  }

  // Check geometry position for NaN (belt-and-suspenders for #206)
  let geomFinite = false;
  if (cadOperable) {
    const geomCheck = await evaluate(`
      (() => {
        const box = window.__viewer?.scene?.children.find(c => c.userData?.creator === 'box');
        if (!box?.geometry) return null;
        const pos = box.geometry.getAttribute('position');
        if (!pos) return null;
        for (let i=0;i<pos.count;i++) {
          if(isNaN(pos.getX(i))||isNaN(pos.getY(i))||isNaN(pos.getZ(i))) return false;
        }
        return true;
      })()`);
    geomFinite = geomCheck === true;
    console.log(`  geom finite: ${geomFinite}`);
  }

  // Overlay clean (no console errors that indicate crash)
  const noRuntimeErrors = consoleErrors.filter(e =>
    e.includes("TypeError") || e.includes("RangeError") || e.includes("Uncaught")
  ).length === 0;

  const boot_ms = Date.now() - t0;
  const pass = bootScreenGone && stateSkipped && cadOperable && geomFinite && noRuntimeErrors;

  console.log(`  boot_ms: ${boot_ms}  pass: ${pass ? "PASS ✓" : "FAIL ✗"}`);
  return {
    passNum,
    boot_ms,
    consent_found: consentFound,
    cancel_clicked: cancelClicked,
    ac1_boot_screen_gone: bootScreenGone,
    ac2_agent_status: agentStatus,
    ac2_state_skipped: stateSkipped,
    ac3_cad_operable: cadOperable,
    ac3_dispatch_result: dispatchResult,
    ac3_geom_finite: geomFinite,
    no_runtime_errors: noRuntimeErrors,
    console_errors_sample: consoleErrors.slice(0, 5),
    pass,
  };
};

// Run passes
const passes = [];
for (let i = 1; i <= PASS_TARGET; i++) {
  const result = await runPass(i);
  passes.push(result);
  if (!result.pass) {
    console.log(`\n  HALT: pass ${i} failed — stopping`);
    break;
  }
}

const allPass = passes.every(p => p.pass) && passes.length === PASS_TARGET;

const OUT = `state/verify-232-boot-block-${SHA}-${Date.now()}.json`;
const receipt = {
  sha: SHA,
  timestamp: new Date().toISOString(),
  url: STABLE_URL,
  cold_cache: COLD,
  pass_target: PASS_TARGET,
  feature: "#232 cold-cache boot-block coverage (5050e82 — CAD usable after model-skip)",
  passes,
  pass: allPass,
};
writeFileSync(OUT, JSON.stringify(receipt, null, 2));

console.log("\n── #232 boot-block AC summary ──────────────────────────────────────────");
for (const p of passes) {
  console.log(`  Pass ${p.passNum}: AC1=${p.ac1_boot_screen_gone} AC2=${p.ac2_state_skipped} AC3=${p.ac3_cad_operable} geom=${p.ac3_geom_finite}  ${p.pass ? "PASS ✓" : "FAIL ✗"}`);
}
console.log(`\n  Overall (${PASS_TARGET} passes required): ${allPass ? "PASS ✓" : "FAIL ✗"}`);
console.log(`\nReceipt: ${OUT}`);

ws.close();
if (!allPass) process.exit(1);
