#!/usr/bin/env bun
// validate-281-session-refresh.mjs — 25-turn validation for #281 session-refresh revert.
//
// Leo acceptance gate (mail 12300):
//  1. Ghost-turn detection ACTIVE — each turn's real/ghost status reported.
//  2. ≥20 REAL generation turns — model produced an AI response, not a silent skip.
//  3. 0 OOM and 0 alignment-FATAL across real turns.
//  4. GPU VRAM trend — nvidia-smi per turn (NOT JS heap); ghost=0 is OOM-gone proxy.
//
// Usage:
//   bun scripts/validate-281-session-refresh.mjs [--max-turns N]
//
// Default: 25 turns, warm-OPFS (OPFS preserved; only cookies+localStorage cleared).
// Pass --cold-cache to also clear cache_storage + service_workers (forces re-download of
// deployed JS from Pages, verifying the run is against actual deployed code).

import { WebSocket } from "ws";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, rmSync } from "fs";
import { execSync } from "child_process";
import { CDP_PORT } from "./ports.mjs";

const PAGES_URL    = "https://wordingone.github.io/WEB-CAD/";
const BOOT_TIMEOUT = 1_200_000; // 20 min
const TURN_TIMEOUT = 2_700_000; // 45 min
const MAX_TURNS    = parseInt(process.argv.find((_,i,a) => a[i-1]==="--max-turns") ?? "25");
const COLD_CACHE   = process.argv.includes("--cold-cache");

const SHA = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
mkdirSync("state/diag-307", { recursive: true });
const PARTIAL_PATH = `state/diag-307/validate-281-${SHA}-partial.json`;

const LOCKFILE = "state/diag-307/.lock";
if (existsSync(LOCKFILE)) {
  const lockData = readFileSync(LOCKFILE, "utf8");
  const lockTs = parseInt(lockData.split(":")[2] ?? "0");
  if (Date.now() - lockTs < 10 * 60_000) {
    console.error("[281-val] another diag instance running (lockfile fresh). Abort.");
    process.exit(1);
  }
  console.warn("[281-val] stale lockfile — clearing");
}
writeFileSync(LOCKFILE, `pid:${process.pid}:${Date.now()}`);
const clearLock = () => { try { unlinkSync(LOCKFILE); } catch {} };
process.on("exit", clearLock);
process.on("SIGINT", () => { clearLock(); process.exit(0); });
process.on("SIGTERM", () => { clearLock(); process.exit(0); });

const targets = JSON.parse(
  execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" })
);
const target = targets.find(t => t.type === "page");
if (!target) throw new Error(`No page target at :${CDP_PORT}`);

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
const nextLoadEvent = () => new Promise(res => {
  const h = raw => {
    const m = JSON.parse(raw);
    if (m.method === "Page.loadEventFired") { ws.off("message", h); res(); }
  };
  ws.on("message", h);
});

await send("Runtime.enable");
await send("Page.enable");

// ── Navigate + warm-OPFS clear ────────────────────────────────────────────────
const curUrlResult = await send("Runtime.evaluate", { expression: `window.location.href`, returnByValue: true });
const curUrl = curUrlResult.result?.value ?? "";
const startingAtBlank = !curUrl.startsWith("https://wordingone.github.io");

if (startingAtBlank) {
  console.log("[281-val] navigating to Pages for IDB frame context…");
  const ctxLoaded = Promise.race([nextLoadEvent(), delay(10_000)]);
  await send("Page.navigate", { url: PAGES_URL });
  await ctxLoaded;
  await delay(300);
}

// Clear IDB
console.log("[281-val] clearing IDB…");
try { await send("IndexedDB.enable"); } catch {}
let idbDbs = [];
try {
  const r = await send("IndexedDB.requestDatabaseNames", { securityOrigin: "https://wordingone.github.io" });
  idbDbs = r.databaseNames ?? [];
} catch {}
for (const name of idbDbs) {
  try { await send("IndexedDB.deleteDatabase", { securityOrigin: "https://wordingone.github.io", databaseName: name }); } catch {}
}

// Blank-nav to kill app JS
const blankLoaded = Promise.race([nextLoadEvent(), delay(5_000)]);
await send("Page.navigate", { url: "about:blank" });
await blankLoaded;
await delay(500);

// Clear storage: warm-OPFS preserves cache_storage+service_workers; cold-cache clears them too.
// In both modes file_systems (OPFS model weights) is preserved to avoid multi-hour re-download.
const storageTypes = COLD_CACHE
  ? "cookies,local_storage,cache_storage,service_workers"
  : "cookies,local_storage";
await send("Storage.clearDataForOrigin", {
  origin: "https://wordingone.github.io",
  storageTypes,
});
const modeLabel = COLD_CACHE ? "cold-cache: cookies+localStorage+cache+SW cleared; OPFS preserved" : "warm-OPFS: cookies+localStorage cleared; OPFS+cache preserved";
console.log(`[281-val] ${modeLabel}`);

// Navigate to Pages for the run
console.log(`[281-val] navigating → ${PAGES_URL}`);
const pagesLoaded = Promise.race([nextLoadEvent(), delay(15_000)]);
await send("Page.navigate", { url: PAGES_URL });
await pagesLoaded;
await delay(2_000);

// ── Inject event listeners ────────────────────────────────────────────────────
const injectListeners = async () => {
  await evaluate(`
    window.__val281OomCount    = 0;
    window.__val281AlignCount  = 0;
    window.addEventListener("agentmodel:worker-recycled", e => {
      if (e.detail?.reason === "d3d12-oom")          window.__val281OomCount   = (window.__val281OomCount   ?? 0) + 1;
      if (e.detail?.reason === "wasm-align-recycle") window.__val281AlignCount = (window.__val281AlignCount ?? 0) + 1;
    });
    true
  `);
};
await injectListeners();
console.log("[281-val] listeners installed");

// ── GPU VRAM sample helper (nvidia-smi, not JS heap) ─────────────────────────
// performance.memory.usedJSHeapSize is JS heap, invisible to D3D12 GPU buffers.
// nvidia-smi reports actual GPU memory used (MB), which is the OOM surface.
const sampleVram = () => {
  try {
    const out = execSync("nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits", { encoding: "utf8" });
    return parseInt(out.trim(), 10);
  } catch {
    return null;
  }
};

// ── Wait for boot ─────────────────────────────────────────────────────────────
const bootStart = Date.now();
console.log("[281-val] waiting for boot-complete…");
let booted = false;
while (Date.now() - bootStart < BOOT_TIMEOUT) {
  const badge = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? ''`);
  const dis   = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
  const txt   = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
  if (String(badge).includes("READY") && !dis && String(txt).includes("SEND")) { booted = true; break; }
  if (String(txt) === '…' && Boolean(dis) && String(badge).includes('READY')) {
    await evaluate(`{const _b=document.querySelector('.chat-send-btn');if(_b&&_b.textContent==='…'){_b.disabled=false;_b.textContent='SEND';}}`);
  }
  process.stdout.write(".");
  await delay(5_000);
}
console.log();
if (!booted) { console.error("[281-val] boot timeout"); ws.close(); process.exit(1); }
console.log(`[281-val] booted in ${Math.round((Date.now()-bootStart)/1000)}s`);

// ── Turn loop ─────────────────────────────────────────────────────────────────
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
  "Name a common household tool.",
  "What is the boiling point of water?",
  "Name a continent.",
  "How many hours in a day?",
  "What is the chemical symbol for gold?",
  "Name a type of tree.",
  "What is 3 cubed?",
  "What color is grass?",
  "Name a musical instrument.",
  "How many months in a year?",
  "What is the square root of 16?",
  "Name a fruit.",
  "What is 100 divided by 4?",
  "Name a primary color.",
  "What is the largest ocean?",
  "How many legs does a spider have?",
];

/**
 * @typedef {{ turn: number, prompt: string, outcome: string, gpu_vram_mb_start: number|null, gpu_vram_mb_end: number|null, elapsed_s: number, ai_msgs_delta: number }} TurnRecord
 */
/** @type {TurnRecord[]} */
const turns = [];
let realSuccessCount = 0;
let ghostCount       = 0;
let oomCount         = 0;
let alignCount       = 0;
let lastOomCount     = 0;
let lastAlignCount   = 0;

/** Write current state to partial artifact after each turn so a mid-run crash doesn't lose data. */
const persistArtifact = (final = false) => {
  const gpuSamples = turns.map(t => t.gpu_vram_mb_end).filter(v => v !== null);
  const gpuVramMin  = gpuSamples.length ? Math.min(...gpuSamples) : null;
  const gpuVramMax  = gpuSamples.length ? Math.max(...gpuSamples) : null;
  const gpuVramDiff = (gpuVramMin !== null && gpuVramMax !== null) ? gpuVramMax - gpuVramMin : null;
  const art = {
    sha: SHA, max_turns: MAX_TURNS, turns_total: turns.length,
    real_success: realSuccessCount, ghost: ghostCount,
    oom_d3d12: oomCount, align_recycle: alignCount,
    gpu_vram_min_mb: gpuVramMin, gpu_vram_max_mb: gpuVramMax, gpu_vram_range_mb: gpuVramDiff,
    gate_pass: realSuccessCount >= 20 && ghostCount === 0 && oomCount === 0 && alignCount === 0,
    partial: !final,
    turn_log: turns,
  };
  if (final) {
    const finalPath = `state/diag-307/validate-281-${SHA}-${Date.now()}.json`;
    writeFileSync(finalPath, JSON.stringify(art, null, 2));
    try { rmSync(PARTIAL_PATH); } catch {}
    return finalPath;
  } else {
    writeFileSync(PARTIAL_PATH, JSON.stringify(art, null, 2));
    return PARTIAL_PATH;
  }
};

const reloadAndReboot = async (reason) => {
  console.warn(`\n[281-val] reload triggered: ${reason}`);
  const bl = Promise.race([nextLoadEvent(), delay(5_000)]);
  await send("Page.navigate", { url: "about:blank" });
  await bl; await delay(500);
  const pg = Promise.race([nextLoadEvent(), delay(15_000)]);
  await send("Page.navigate", { url: PAGES_URL });
  await pg; await delay(2_000);
  await injectListeners();
  lastOomCount = 0; lastAlignCount = 0;
  let ok = false; const bs = Date.now();
  while (Date.now() - bs < BOOT_TIMEOUT) {
    const badge = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? ''`);
    const dis   = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
    const txt   = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
    if (String(badge).includes("READY") && !dis && String(txt).includes("SEND")) { ok = true; break; }
    if (String(txt) === '…' && Boolean(dis) && String(badge).includes('READY')) {
      await evaluate(`{const _b=document.querySelector('.chat-send-btn');if(_b&&_b.textContent==='…'){_b.disabled=false;_b.textContent='SEND';}}`);
    }
    process.stdout.write("R"); await delay(5_000);
  }
  console.log();
  return ok;
};

for (let i = 0; i < MAX_TURNS; i++) {
  const turnNum = i + 1;
  const prompt  = PROMPTS[i % PROMPTS.length];

  // ── Pre-turn gate ────────────────────────────────────────────────────────────
  const pgStart = Date.now();
  let pgOk = false;
  process.stdout.write(`[281-val] T${turnNum} pre-gate…`);
  while (Date.now() - pgStart < TURN_TIMEOUT) {
    const dis = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
    const txt = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
    if (!dis && String(txt).includes("SEND")) { pgOk = true; break; }
    process.stdout.write("w"); await delay(5_000);
  }
  console.log();
  if (!pgOk) { console.warn(`[281-val] T${turnNum}: pre-gate timeout — aborting`); break; }

  // ── Pre-click ghost check ────────────────────────────────────────────────────
  const preBadge = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? ''`);
  if (String(preBadge).includes("ERROR")) {
    console.warn(`[281-val] T${turnNum}: badge ERROR before send — ghost detected, reloading`);
    ghostCount++;
    turns.push({ turn: turnNum, prompt, outcome: "ghost_pre_badge", gpu_vram_mb_start: null, gpu_vram_mb_end: null, elapsed_s: 0, ai_msgs_delta: 0 });
    const ok = await reloadAndReboot("ghost pre-badge ERROR");
    if (!ok) { console.error("[281-val] recovery boot timeout — aborting"); break; }
    continue;
  }

  // ── GPU VRAM sample via nvidia-smi (before turn) ─────────────────────────────
  const vramStart = await sampleVram();

  // ── Count AI messages before send ────────────────────────────────────────────
  const aiMsgsBefore = await evaluate(`document.querySelectorAll('.chat-msg').length`);

  console.log(`[281-val] T${turnNum}/${MAX_TURNS}: "${prompt}" | gpu_vram_start=${vramStart}MB`);
  const turnStart = Date.now();

  // ── Send message ─────────────────────────────────────────────────────────────
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
    console.warn(`[281-val] T${turnNum}: send returned "${sent}" — skipping`);
    turns.push({ turn: turnNum, prompt, outcome: "send_fail", gpu_vram_mb_start: vramStart, gpu_vram_mb_end: null, elapsed_s: 0, ai_msgs_delta: 0 });
    continue;
  }

  // Verify user message appeared (ghost-early-return detection)
  let userMsgAppeared = false;
  const uvStart = Date.now();
  while (Date.now() - uvStart < 10_000) {
    await delay(1_000);
    const msgsAfter = await evaluate(`document.querySelectorAll('.chat-msg').length`);
    if (msgsAfter > aiMsgsBefore) { userMsgAppeared = true; break; }
  }
  if (!userMsgAppeared) {
    console.warn(`[281-val] T${turnNum}: no user message in DOM — early silent return (ghost)`);
    ghostCount++;
    turns.push({ turn: turnNum, prompt, outcome: "ghost_no_user_msg", gpu_vram_mb_start: vramStart, gpu_vram_mb_end: null, elapsed_s: 0, ai_msgs_delta: 0 });
    continue;
  }

  // ── Wait for generation complete ─────────────────────────────────────────────
  let outcome = "timeout";
  let turnErrorMs = 0;
  let turnStuckMs = 0;
  let aiMsgsDelta = 0;

  while (Date.now() - turnStart < TURN_TIMEOUT) {
    await delay(5_000);

    // OOM or align-recycle detection
    const curOom   = await evaluate(`window.__val281OomCount   ?? 0`);
    const curAlign = await evaluate(`window.__val281AlignCount ?? 0`);
    if (curAlign > lastAlignCount) {
      lastAlignCount = curAlign; alignCount++;
      console.log(`\n[281-val] T${turnNum}: ALIGN-RECYCLE`);
      outcome = "align_recycle"; break;
    }

    const dis = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
    const txt = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
    if (!dis && String(txt).includes("SEND")) {
      // Check if AI response appeared (distinguishes real success from ghost-SEND)
      const msgsAfter = await evaluate(`document.querySelectorAll('.chat-msg').length`);
      aiMsgsDelta = msgsAfter - aiMsgsBefore - 1; // subtract the user message we sent
      if (aiMsgsDelta >= 1) {
        outcome = "real_success";
      } else {
        // Button returned to SEND but no AI response → ghost (silent _send() early return)
        outcome = "ghost_no_ai_response";
        ghostCount++;
      }
      break;
    }

    if (String(txt) === '…' && Boolean(dis)) {
      const badge = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? ''`);
      if (String(badge).includes("ERROR")) {
        turnErrorMs += 5_000; turnStuckMs = 0;
        if (turnErrorMs >= 120_000) {
          if (curOom > lastOomCount) {
            lastOomCount = curOom; oomCount++;
            outcome = "oom_d3d12";
          } else {
            outcome = "oom_d3d12";
          }
          console.warn(`\n[281-val] T${turnNum}: D3D12-OOM → reload`);
          const ok = await reloadAndReboot(`T${turnNum} D3D12-OOM`);
          if (!ok) { outcome = "oom_boot_fail"; }
          break;
        }
      } else if (String(badge).includes("READY")) {
        turnStuckMs += 5_000; turnErrorMs = 0;
        if (turnStuckMs >= 60_000) {
          console.warn(`\n[281-val] T${turnNum}: stuck "…"+READY — reset button`);
          await evaluate(`{const _b=document.querySelector('.chat-send-btn');if(_b&&_b.textContent==='…'){_b.disabled=false;_b.textContent='SEND';}}`);
          turnStuckMs = 0;
        }
      } else { turnStuckMs = 0; turnErrorMs = 0; }
    } else { turnStuckMs = 0; turnErrorMs = 0; }

    process.stdout.write("·");
  }
  console.log();

  const elapsed = Math.round((Date.now() - turnStart) / 1000);
  const vramEnd = await sampleVram();

  if (outcome === "real_success") {
    realSuccessCount++;
    console.log(`[281-val] T${turnNum}: REAL_SUCCESS in ${elapsed}s | gpu_vram_end=${vramEnd}MB | ai_msgs+=${aiMsgsDelta}`);
  } else {
    console.log(`[281-val] T${turnNum}: ${outcome.toUpperCase()} in ${elapsed}s | gpu_vram_end=${vramEnd}MB`);
  }

  turns.push({
    turn:         turnNum,
    prompt,
    outcome,
    gpu_vram_mb_start: vramStart,
    gpu_vram_mb_end:   vramEnd,
    elapsed_s:    elapsed,
    ai_msgs_delta: aiMsgsDelta,
  });
  persistArtifact(false); // incremental write — preserves data if script dies mid-run

  // 2s settle between turns
  await delay(2_000);
}

// ── Write final artifact ──────────────────────────────────────────────────────
const outPath = persistArtifact(true);
const gatePass = realSuccessCount >= 20 && ghostCount === 0 && oomCount === 0 && alignCount === 0;

const gpuSamples   = turns.map(t => t.gpu_vram_mb_end).filter(v => v !== null);
const gpuVramMin   = gpuSamples.length ? Math.min(...gpuSamples) : null;
const gpuVramMax   = gpuSamples.length ? Math.max(...gpuSamples) : null;
const gpuVramDiff  = (gpuVramMin !== null && gpuVramMax !== null) ? gpuVramMax - gpuVramMin : null;

console.log(`\n[281-val] ── VALIDATION COMPLETE ─────────────────────────────────────`);
console.log(`  SHA:          ${SHA}`);
console.log(`  Turns total:  ${turns.length}`);
console.log(`  Real success: ${realSuccessCount}`);
console.log(`  Ghost:        ${ghostCount}`);
console.log(`  D3D12-OOM:    ${oomCount}`);
console.log(`  Align-recycle:${alignCount}`);
console.log(`  GPU VRAM:     ${gpuVramMin}–${gpuVramMax} MB (delta=${gpuVramDiff}) [nvidia-smi]`);
console.log(`  Gate PASS:    ${gatePass}`);
console.log(`  Artifact:     ${outPath}`);

ws.close();
process.exit(gatePass ? 0 : 1);
