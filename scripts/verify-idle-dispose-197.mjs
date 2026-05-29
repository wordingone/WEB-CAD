#!/usr/bin/env bun
// verify-idle-dispose-197.mjs — CDP evidence for #197 agent-idle VRAM dispose mechanism.
//
// Confirms:
//   1. Idle timer fires on VISIBLE tab (not visibility path) after AGENT_IDLE_DISPOSE_DELAY_MS.
//   2. runAgentTurn reinit guard resolves on session-refresh-complete, NOT the 180s timeout.
//
// Requires:
//   - PR #199 + PR #200 deployed to Pages (?agent_idle_ms URL param must be live).
//   - Shared browser at :9222 with OPFS cache warm (model previously booted).
//   - Browser lock acquired before running.
//
// Usage:
//   bun scripts/verify-idle-dispose-197.mjs

import { WebSocket } from "ws";
import { mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { CDP_PORT } from "./ports.mjs";

const PAGES_URL   = "https://wordingone.github.io/WEB-CAD/?agent_idle_ms=5000";
const IDLE_PARAM  = 5000;       // must match ?agent_idle_ms value
const IDLE_WAIT   = 8_000;      // wait 8s; timer fires at 5s
const BOOT_TIMEOUT  = 300_000;  // 5 min — cold-cache boot
const REINIT_TIMEOUT = 150_000; // 2.5 min — OPFS warm reinit should complete in ~60s

const SHA = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
mkdirSync("state", { recursive: true });
const OUT = `state/verify-idle-dispose-197-${SHA}-${Date.now()}.json`;

// ── Connect to :9222 ──────────────────────────────────────────────────────────
const targets = JSON.parse(
  execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" })
);
const target = targets.find(t => t.type === "page");
if (!target) throw new Error(`No page target at :${CDP_PORT} — is the shared browser running?`);

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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "Runtime error");
  return r.result?.value;
};
const delay = ms => new Promise(r => setTimeout(r, ms));

await send("Runtime.enable");
await send("Page.enable");

// ── Navigate to Pages with short idle param ───────────────────────────────────
console.log(`[evidence] navigating → ${PAGES_URL}`);
await send("Page.navigate", { url: PAGES_URL });
await delay(4_000); // wait for initial load before injecting globals

// ── Inject evidence globals BEFORE boot-complete ─────────────────────────────
await evaluate(`
  window.__idleEv = { suspended: false, hiddenAtSuspend: null, suspendedAt: null,
                      resumed: false, resumedAt: null, bootDone: false };
  window.addEventListener("agentmodel:boot-complete", () => { window.__idleEv.bootDone = true; });
  window.addEventListener("agentmodel:session-suspended", e => {
    if (e.detail.suspended) {
      window.__idleEv.suspended    = true;
      window.__idleEv.hiddenAtSuspend = document.hidden;
      window.__idleEv.suspendedAt  = Date.now();
      console.info("[EVIDENCE] idle-dispose fired: hidden=" + document.hidden + " ts=" + Date.now());
    } else {
      window.__idleEv.resumed    = true;
      window.__idleEv.resumedAt  = Date.now();
      console.info("[EVIDENCE] idle-reinit complete ts=" + Date.now());
    }
  });
  true
`);
console.log("[evidence] globals injected");

// ── Wait for boot-complete ────────────────────────────────────────────────────
console.log(`[evidence] waiting for boot-complete (up to ${BOOT_TIMEOUT/60000}min)...`);
const bootStart = Date.now();
let booted = false;
while (Date.now() - bootStart < BOOT_TIMEOUT) {
  const ev = await evaluate(`JSON.parse(JSON.stringify(window.__idleEv))`);
  if (ev.bootDone) { booted = true; break; }
  // fallback: badge text contains READY
  const badge = await evaluate(`document.getElementById("ai-model-badge")?.textContent ?? ""`);
  if (badge.includes("READY")) { booted = true; break; }
  await delay(3_000);
}
const bootMs = Date.now() - bootStart;
if (!booted) {
  console.error(`[evidence] boot-complete not received after ${BOOT_TIMEOUT/60000}min`);
  ws.close(); process.exit(1);
}
console.log(`[evidence] booted in ${Math.round(bootMs/1000)}s`);

// ── Confirm tab is visible, then idle ────────────────────────────────────────
const hiddenNow = await evaluate(`document.hidden`);
console.log(`[evidence] document.hidden=${hiddenNow} (must be false — idle only fires on visible tab)`);

console.log(`[evidence] idle window open — waiting ${IDLE_WAIT}ms (timer fires at ${IDLE_PARAM}ms)...`);
await delay(IDLE_WAIT);

// ── Assert idle-dispose fired ─────────────────────────────────────────────────
const ev1 = await evaluate(`JSON.parse(JSON.stringify(window.__idleEv))`);
console.log("[evidence] post-idle state:", ev1);

const checks = [];
const record = (name, passed, evidence) => {
  checks.push({ name, passed: !!passed, evidence });
  console.log(`  ${passed ? "✓" : "✗"} ${name}`);
  if (!passed) console.log("    evidence:", JSON.stringify(evidence).slice(0, 300));
};

record("idle-disposed-fired",     ev1.suspended === true,      { suspended: ev1.suspended, suspendedAt: ev1.suspendedAt });
record("tab-visible-at-dispose",  ev1.hiddenAtSuspend === false, { hiddenAtSuspend: ev1.hiddenAtSuspend });

// ── Trigger reinit via chat submit ────────────────────────────────────────────
if (ev1.suspended) {
  console.log("[evidence] triggering reinit via .chat-send-btn click...");
  const submitted = await evaluate(`
    (() => {
      const input = document.querySelector(".chat-input");
      const btn   = document.querySelector(".chat-send-btn");
      if (!input || !btn) return { ok: false, reason: "selectors not found" };
      input.value = "idle-reinit evidence test";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      btn.click();
      return { ok: true };
    })()
  `);
  record("chat-submit-triggered", submitted?.ok === true, submitted);

  if (submitted?.ok) {
    console.log(`[evidence] waiting up to ${REINIT_TIMEOUT/1000}s for reinit-complete event...`);
    const reinitStart = Date.now();
    let reinitDone = false;
    while (Date.now() - reinitStart < REINIT_TIMEOUT) {
      const ev2 = await evaluate(`JSON.parse(JSON.stringify(window.__idleEv))`);
      if (ev2.resumed) {
        const reinitMs = ev2.resumedAt - ev1.suspendedAt;
        console.log(`[evidence] reinit completed in ${Math.round(reinitMs/1000)}s`);
        record("reinit-completed-on-session-refresh-complete", true,     { reinitMs });
        record("reinit-under-180s",                             reinitMs < 180_000, { reinitMs });
        reinitDone = true;
        break;
      }
      await delay(3_000);
    }
    if (!reinitDone) {
      const elapsed = Date.now() - reinitStart;
      record("reinit-completed-on-session-refresh-complete", false, { elapsed, note: "timed out" });
    }
  }
} else {
  console.warn("[evidence] idle-dispose did not fire — skipping reinit test");
}

ws.close();

// ── Write receipt ─────────────────────────────────────────────────────────────
const allPassed = checks.every(c => c.passed);
writeFileSync(OUT, JSON.stringify({
  sha: SHA, timestamp: new Date().toISOString(), url: PAGES_URL,
  boot_ms: bootMs, idle_param_ms: IDLE_PARAM, all_passed: allPassed, checks,
}, null, 2));

console.log("\n── Results ────────────────────────────────────────");
for (const c of checks) console.log(`  ${c.passed ? "PASS" : "FAIL"}  ${c.name}`);
console.log(`\nall_passed: ${allPassed}`);
console.log(`Receipt: ${OUT}`);
if (!allPassed) process.exit(1);
