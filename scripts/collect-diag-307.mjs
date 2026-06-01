#!/usr/bin/env bun
// collect-diag-307.mjs — run cold-cache Pages session until WASM-align trap fires,
// capture align-diag-307 diagnostic payload, write to state/diag-307-<sha>.json.
//
// #307: WASM heap fragmentation → dlmalloc returns 4-byte-aligned address for i64
// staging buffer → ORT trap "operation does not support unaligned accesses".
// ~1/28 turns stochastic. This script drives repeated turns until the trap fires.
//
// Usage:
//   bun scripts/collect-diag-307.mjs [--max-turns N] [--opfs-warm]
//
//   --max-turns N   stop after N turns without a trap (default: 30)
//   --opfs-warm     skip Storage.clearDataForOrigin (OPFS already populated)
//
// Requires: shared browser at :9222.

import { WebSocket } from "ws";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { CDP_PORT } from "./ports.mjs";

const PAGES_URL     = "https://wordingone.github.io/WEB-CAD/";
const BOOT_TIMEOUT  = 1_200_000; // 20 min — cold-cache 4GB download
const TURN_TIMEOUT  = 2_700_000; // 45 min per turn — Gemma 4 thinking trace ~20-30 min observed
const MAX_TURNS     = parseInt(process.argv.find((_,i,a) => a[i-1]==="--max-turns") ?? "30");
const OPFS_WARM     = process.argv.includes("--opfs-warm");
// --no-nav: skip Page.navigate + boot wait; attach to existing live session.
// Use when model is already running (e.g. mid-generation from a prior script run).
const NO_NAV        = process.argv.includes("--no-nav");

const SHA = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
mkdirSync("state/diag-307", { recursive: true });

// ── Single-instance lockfile guard ───────────────────────────────────────────
const LOCKFILE = "state/diag-307/.lock";
if (existsSync(LOCKFILE)) {
  const lockData = readFileSync(LOCKFILE, "utf8");
  const lockTs = parseInt(lockData.split(":")[2] ?? "0");
  const lockAge = Date.now() - lockTs;
  if (lockAge < 10 * 60_000) {
    console.error(`[307] another instance is running (lockfile age ${Math.round(lockAge/1000)}s). Abort.`);
    process.exit(1);
  }
  console.warn(`[307] stale lockfile found (age ${Math.round(lockAge/60000)}min) — clearing`);
}
writeFileSync(LOCKFILE, `pid:${process.pid}:${Date.now()}`);
const clearLock = () => { try { unlinkSync(LOCKFILE); } catch {} };
process.on("exit", clearLock);
process.on("SIGINT", () => { clearLock(); process.exit(0); });
process.on("SIGTERM", () => { clearLock(); process.exit(0); });

// ── CDP plumbing ──────────────────────────────────────────────────────────────
const targets = JSON.parse(
  execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" })
);
const target = targets.find(t => t.type === "page");
if (!target) throw new Error(`No page target at :${CDP_PORT} — is shared browser running?`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
const consoleMessages = [];

await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

ws.on("message", raw => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result ?? {});
  }
  // Capture console.warn for [align-diag-307] lines
  if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "warning") {
    const text = msg.params.args?.map(a => a.value ?? a.description ?? "").join(" ") ?? "";
    if (text.includes("align-diag-307")) {
      consoleMessages.push(text);
      console.log("[console.warn]", text.slice(0, 300));
    }
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

// ── Navigate (or skip if --no-nav) ───────────────────────────────────────────
// blank-nav BEFORE storage clear: kills app JS so it cannot race-write to
// IndexedDB between clearDataForOrigin and the subsequent page reload.
// Without this, app JS writes activeTurnId+chat history to IDB *after* the clear,
// which persists across the reload and causes the restored session to auto-retry
// an interrupted turn → button stays "…" indefinitely at boot.
const nextLoadEvent = () => new Promise(res => {
  const h = raw => {
    const m = JSON.parse(raw);
    if (m.method === "Page.loadEventFired") { ws.off("message", h); res(); }
  };
  ws.on("message", h);
});

let bootMs = 0;
if (NO_NAV) {
  console.log("[307] --no-nav: skipping navigation, attaching to live session");
} else {
  // Step 1: blank-nav to kill app JS (prevents IDB write race)
  console.log("[307] blank-nav → about:blank (kill app JS before storage clear)…");
  const blankLoaded = Promise.race([nextLoadEvent(), delay(5_000)]);
  await send("Page.navigate", { url: "about:blank" });
  await blankLoaded;
  await delay(500); // ensure JS context fully destroyed

  // Step 2: clear storage (app JS is dead, no race possible)
  if (OPFS_WARM) {
    console.log("[307] clearing app state (keeping OPFS model weights)…");
    await send("Storage.clearDataForOrigin", {
      origin: "https://wordingone.github.io",
      // Model weights are in OPFS (file_systems), NOT in IndexedDB — safe to clear IDB.
      storageTypes: "cookies,local_storage,indexeddb",
    });
    console.log("[307] app state cleared (OPFS preserved)");
  } else {
    console.log("[307] clearing all storage (cold-cache)…");
    await send("Storage.clearDataForOrigin", {
      origin: "https://wordingone.github.io",
      storageTypes: "all",
    });
    console.log("[307] storage cleared");
  }

  // Step 3: navigate to Pages URL with clean storage
  console.log(`[307] navigating → ${PAGES_URL}`);
  const pagesLoaded = Promise.race([nextLoadEvent(), delay(15_000)]);
  await send("Page.navigate", { url: PAGES_URL });
  await pagesLoaded;
  await delay(2_000); // settle after load
}

// ── Inject diagnostic listeners ───────────────────────────────────────────────
await evaluate(`
  window.__diag307Captured = null;
  window.__alignRecycleCount = 0;
  window.__alignSamples307 = [];
  window.addEventListener("agentmodel:align-diag-307", e => {
    window.__diag307Captured = e.detail;
    console.warn("[align-diag-307]", JSON.stringify(e.detail));
  });
  window.addEventListener("agentmodel:align-sample-307", e => {
    window.__alignSamples307.push(e.detail);
  });
  window.addEventListener("agentmodel:worker-recycled", e => {
    if (e.detail?.reason === "wasm-align-recycle") {
      window.__alignRecycleCount = (window.__alignRecycleCount ?? 0) + 1;
      console.warn("[307] align-recycle #" + window.__alignRecycleCount + " fired");
    }
  });
  true
`);
console.log("[307] diagnostic listeners installed");

// ── Wait for boot-complete (skip if --no-nav: pre-turn gate handles the wait) ─
// Require BOTH badge contains "READY" (JS-driven, not initial HTML) AND button is
// SEND+enabled. Skip this step with --no-nav — the pre-turn gate already waits for
// SEND before each click, handling any in-flight generation from prior sessions.
const bootStart = Date.now();
let booted = NO_NAV; // --no-nav: assume already booted, pre-gate will wait
if (!NO_NAV) {
  console.log(`[307] waiting for boot-complete (badge READY + btn SEND, up to ${BOOT_TIMEOUT/60000}min)…`);
  let bootStuckMs = 0;
  while (Date.now() - bootStart < BOOT_TIMEOUT) {
    const badgeText   = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? ''`);
    const btnDisabled = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
    const btnText     = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
    if (String(badgeText).includes("READY") && !btnDisabled && String(btnText).includes("SEND")) {
      booted = true; break;
    }
    // §#307-recovery: if badge READY but button stuck "…" at boot, same orphaned-_send() issue.
    if (String(btnText) === '…' && Boolean(btnDisabled) && String(badgeText).includes('READY')) {
      bootStuckMs += 5_000;
      if (bootStuckMs >= 60_000) {
        console.warn(`\n[307] boot: stuck "…"+READY for 60s — resetting button to SEND`);
        await evaluate(`{const _b=document.querySelector('.chat-send-btn');if(_b&&_b.textContent==='…'){_b.disabled=false;_b.textContent='SEND';}}`);
        bootStuckMs = 0;
      }
    } else { bootStuckMs = 0; }
    process.stdout.write(".");
    await delay(5_000);
  }
  console.log();
}
bootMs = Date.now() - bootStart;
if (!booted) {
  console.error(`[307] never reached READY+SEND after ${BOOT_TIMEOUT/60000}min`);
  ws.close(); process.exit(1);
}
if (!NO_NAV) console.log(`[307] booted in ${Math.round(bootMs/1000)}s`);

// ── Send turns until align-trap fires ────────────────────────────────────────
// Short prompts for faster decode cycles (shorter ORT runs = faster heap growth).
const PROMPTS = [
  "What is 2+2?",
  "Name a color.",
  "What is the capital of France?",
  "How many sides does a triangle have?",
  "What is water made of?",
  "Name a planet.",
  "What is 5×5?",
  "What color is the sky?",
  "How many days in a week?",
  "What is the speed of light approximately?",
];

let turnCount = 0;
let diagCaptured = null;
let lastRecycleCount = 0;

console.log(`[307] starting turn loop (max ${MAX_TURNS} turns, ${TURN_TIMEOUT/60000}min each)…`);

for (let i = 0; i < MAX_TURNS; i++) {
  turnCount = i + 1;
  const prompt = PROMPTS[i % PROMPTS.length];

  // ── Pre-turn gate: wait for button SEND+enabled (serializes turns) ──────────
  // If the previous turn timed out while model was still generating, this waits
  // for that generation to finish before we send the next turn.
  // §#307-recovery: if badge READY but button "…" for ≥60s, the _send() Promise was orphaned
  // by a D3D12-OOM recycle (worker died, Promise never resolved). Reset button to SEND.
  const preGateStart = Date.now();
  let preGateOk = false;
  let preGateStuckMs = 0;
  process.stdout.write(`[307] turn ${turnCount}/${MAX_TURNS} pre-gate…`);
  while (Date.now() - preGateStart < TURN_TIMEOUT) {
    const btnDisabled = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
    const btnText    = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
    if (!btnDisabled && String(btnText).includes("SEND")) { preGateOk = true; break; }
    if (String(btnText) === '…' && Boolean(btnDisabled)) {
      const badgeText = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? ''`);
      if (String(badgeText).includes('READY')) {
        preGateStuckMs += 5_000;
        if (preGateStuckMs >= 60_000) {
          console.warn(`\n[307] pre-gate: stuck "…"+READY for 60s — orphaned _send() after OOM, resetting button`);
          await evaluate(`{const _b=document.querySelector('.chat-send-btn');if(_b&&_b.textContent==='…'){_b.disabled=false;_b.textContent='SEND';}}`);
          preGateStuckMs = 0;
        }
      } else { preGateStuckMs = 0; }
    } else { preGateStuckMs = 0; }
    process.stdout.write("w");
    await delay(5_000);
  }
  console.log();
  if (!preGateOk) {
    console.warn(`[307] turn ${turnCount}: pre-gate timeout (button never SEND) — aborting`);
    break;
  }

  console.log(`[307] turn ${turnCount}/${MAX_TURNS}: "${prompt}"`);

  // ── Get current message count for post-click verification ─────────────────
  const msgsBefore = await evaluate(`document.querySelectorAll('.chat-msg').length`);

  // ── Type into chat input and submit ───────────────────────────────────────
  const sent = await evaluate(`
    (async () => {
      const inp = document.querySelector(".chat-input");
      if (!inp) return "no-input";
      inp.value = ${JSON.stringify(prompt)};
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      const btn = document.querySelector(".chat-send-btn");
      if (!btn || btn.disabled) return "btn-unavailable";
      btn.click();
      return "sent";
    })()
  `);

  if (sent !== "sent") {
    console.warn(`[307] turn ${turnCount}: send returned "${sent}" — skipping`);
    await delay(2_000);
    continue;
  }

  // ── Verify user message appeared in DOM (within 10s) ──────────────────────
  // If _send() silently returned (chatInputEnabled=false), no message is pushed.
  // Class is "chat-msg" (not "chat-message") per chat-panel.ts line 962.
  const verifyStart = Date.now();
  let msgAppeared = false;
  while (Date.now() - verifyStart < 10_000) {
    await delay(1_000);
    const msgsAfter = await evaluate(`document.querySelectorAll('.chat-msg').length`);
    if (msgsAfter > msgsBefore) { msgAppeared = true; break; }
  }
  if (!msgAppeared) {
    console.warn(`[307] turn ${turnCount}: no user message appeared in DOM after click — ARC not ready? skipping`);
    continue;
  }
  process.stdout.write("G");

  // ── Wait for generation complete: button SEND+enabled or align-recycle ─────
  // §#307-recovery: same orphaned-_send() guard as pre-gate — if badge READY but button
  // "…" for ≥60s mid-turn, reset the button so the loop exits and the next turn starts.
  const turnStart = Date.now();
  let turnDone = false;
  let recycled = false;
  let turnStuckMs = 0;
  while (Date.now() - turnStart < TURN_TIMEOUT) {
    await delay(5_000);

    // Check for align-recycle first
    const rc = await evaluate(`window.__alignRecycleCount ?? 0`);
    if (rc > (lastRecycleCount ?? 0)) {
      recycled = true;
      console.log(`\n[307] ALIGN-RECYCLE detected after turn ${turnCount}! Waiting for diag payload…`);
      await delay(3_000);
      diagCaptured = await evaluate(`window.__diag307Captured ? JSON.parse(JSON.stringify(window.__diag307Captured)) : null`);
      break;
    }

    const btnDisabled = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
    const btnText    = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
    if (!btnDisabled && String(btnText).includes("SEND")) { turnDone = true; break; }

    if (String(btnText) === '…' && Boolean(btnDisabled)) {
      const badgeText = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? ''`);
      if (String(badgeText).includes('READY')) {
        turnStuckMs += 5_000;
        if (turnStuckMs >= 60_000) {
          console.warn(`\n[307] turn ${turnCount}: stuck "…"+READY for 60s — orphaned _send() after OOM, resetting button`);
          await evaluate(`{const _b=document.querySelector('.chat-send-btn');if(_b&&_b.textContent==='…'){_b.disabled=false;_b.textContent='SEND';}}`);
          turnStuckMs = 0;
        }
      } else { turnStuckMs = 0; }
    } else { turnStuckMs = 0; }

    process.stdout.write("·");
  }
  console.log();

  if (recycled) break;
  if (!turnDone) {
    const elapsedMin = Math.round((Date.now() - turnStart) / 60000);
    console.log(`[307] turn ${turnCount} timed out after ${elapsedMin}min — pre-gate will wait for completion`);
  } else {
    const elapsedSec = Math.round((Date.now() - turnStart) / 1000);
    console.log(`[307] turn ${turnCount} complete in ${elapsedSec}s`);
  }

  lastRecycleCount = await evaluate(`window.__alignRecycleCount ?? 0`);
  await delay(500);
}

// ── Report ────────────────────────────────────────────────────────────────────
const totalRecycles = await evaluate(`window.__alignRecycleCount ?? 0`);
console.log(`\n[307] loop complete: ${turnCount} turns, align-recycle=${totalRecycles > 0 || diagCaptured ? "YES" : "NO"}`);

// ── Per-turn alignment distribution ──────────────────────────────────────────
const alignSamples = await evaluate(
  `window.__alignSamples307 ? JSON.parse(JSON.stringify(window.__alignSamples307)) : []`
);
if (Array.isArray(alignSamples) && alignSamples.length > 0) {
  const mod8Dist = {};
  for (const s of alignSamples) {
    const k = String(s.mod8 ?? 'unknown');
    mod8Dist[k] = (mod8Dist[k] ?? 0) + 1;
  }
  console.log(`[307] alignment samples: ${alignSamples.length} — mod8 distribution: ${JSON.stringify(mod8Dist)}`);
  const distPath = `state/diag-307/align-dist-${SHA}-${Date.now()}.json`;
  writeFileSync(distPath, JSON.stringify({ sha: SHA, turnCount, samples: alignSamples, mod8Distribution: mod8Dist }, null, 2));
  console.log(`[307] distribution saved → ${distPath}`);
} else {
  console.log(`[307] alignment samples: 0 (build may not have per-turn logging; needs deploy)`);
}

if (diagCaptured) {
  const outPath = `state/diag-307/diag-307-${SHA}-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify({ sha: SHA, turnCount, bootMs, diagCaptured }, null, 2));
  console.log(`[307] diagnostic saved → ${outPath}`);
  console.log("[307] payload:", JSON.stringify(diagCaptured, null, 2));
} else {
  console.log(`[307] align-trap did NOT fire in ${turnCount} turns.`);
  console.log(`      Turns completed: ${turnCount}. Stochastic rate ~1/28.`);
  const outPath = `state/diag-307/diag-307-no-trap-${SHA}-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify({ sha: SHA, turnCount, bootMs, diagCaptured: null }, null, 2));
}

ws.close();
process.exit(diagCaptured ? 0 : 2);
