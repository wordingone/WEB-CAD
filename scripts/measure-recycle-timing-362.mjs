#!/usr/bin/env bun
// measure-recycle-timing-362.mjs — measure agentmodel:worker-recycled → boot-complete wall-clock.
// Uses a planned recycle (via arc._doPlannedRecycle proxy) as the timing proxy for align-recycle.
// Both paths call initWorkerIfNeeded() after worker.terminate(); timing is equivalent.
//
// Usage: bun scripts/measure-recycle-timing-362.mjs
//   Requires: shared browser at :9222 with app loaded + model booted (OPFS warm).

import { WebSocket } from "ws";
import { execSync } from "child_process";
import { CDP_PORT } from "./ports.mjs";

const targets = JSON.parse(execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" }));
const target = targets.find(t => t.type === "page" && t.url.includes("WEB-CAD"));
if (!target) throw new Error(`No WEB-CAD page at :${CDP_PORT}`);

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
const evaluate = (expr, opts = {}) => send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, ...opts });
const delay = ms => new Promise(r => setTimeout(r, ms));

await send("Runtime.enable");

// Check model is booted first.
const { result: bootCheck } = await evaluate("window.__gemmaSession?.startTs ? 'booted' : 'not-booted'");
console.log("Model state:", bootCheck?.value);
if (bootCheck?.value !== "booted") {
  console.error("Model not booted — boot the model first then rerun.");
  process.exit(1);
}

// Inject timing listener BEFORE triggering recycle.
await evaluate(`
  window.__recycleTimings = window.__recycleTimings ?? [];
  window.__recycleStart = null;
  window.addEventListener("agentmodel:worker-recycled", e => {
    window.__recycleStart = performance.now();
    console.log('[measure-362] worker-recycled fired, reason=' + (e.detail?.reason ?? 'unknown'));
  });
  window.addEventListener("agentmodel:boot-complete", () => {
    if (window.__recycleStart != null) {
      const elapsed = performance.now() - window.__recycleStart;
      window.__recycleTimings.push(elapsed);
      window.__recycleStart = null;
      console.log('[measure-362] boot-complete elapsed=' + elapsed.toFixed(0) + 'ms');
    }
  });
  'listeners-installed'
`);

console.log("Timing listeners installed. Triggering a planned recycle via turn-count override…");
console.log("(Sets _arc.turnCount to MODEL_WORKER_RECYCLE_AFTER via __runDesignLoop bypass — NO actual inference)");

// Force a planned recycle by setting turnCount to the threshold.
// recycleModelWorkerIfNeeded() is called by runAgentTurn; bypass via direct ARC manipulation.
// Since _arc is module-scoped (not on window), we trigger via the idle-dispose path instead:
// manually fire the "agent-idle" event that triggers session-dispose → reinit.
// This reuses the same initWorkerIfNeeded() path and is a valid timing proxy.
await evaluate(`
  // Force-fire the agent:idle event which triggers the #197 idle-dispose→reinit path.
  // This terminates + reinits the worker (same code path as align-recycle's initWorkerIfNeeded).
  window.dispatchEvent(new CustomEvent("agent:idle", { detail: { reason: "measure-362-timing-probe" } }));
  'triggered'
`);

// Wait up to 5 minutes for boot-complete to fire.
const WAIT_MS = 300_000;
const start = Date.now();
let elapsed = null;
while (Date.now() - start < WAIT_MS) {
  await delay(2000);
  const { result } = await evaluate("window.__recycleTimings.at(-1) ?? null");
  if (result?.value != null) {
    elapsed = result.value;
    break;
  }
  process.stdout.write(".");
}
console.log();

if (elapsed == null) {
  console.error("TIMEOUT — boot-complete did not fire within 5 minutes.");
  console.error("(Is model OPFS warm? Cold-cache requires 4GB download first.)");
  process.exit(1);
}

console.log(`\nRecycle wall-clock (worker-recycled → boot-complete): ${Math.round(elapsed)}ms = ${(elapsed/1000).toFixed(1)}s`);
console.log("Interpretation:");
if (elapsed < 15000) console.log("  FAST (<15s) — OPFS warm; pure WebGPU-init + OrtSession reload.");
else if (elapsed < 60000) console.log("  MODERATE (15-60s) — OPFS partial or warm GPU init overhead.");
else console.log("  SLOW (>60s) — likely OPFS cold; 4GB network fetch in progress.");

ws.close();
