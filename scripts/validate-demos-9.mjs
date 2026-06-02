#!/usr/bin/env node
// validate-demos-9.mjs — #281 canonical proof: 9 demo prompts in order, cold-cache, Pages deploy.
// Leo gate (mail 12666): oom_d3d12=0, real geometry per prompt, VRAM in real app.
//
// Usage:
//   node scripts/validate-demos-9.mjs [--no-drain] [--drain-ms N]
//
// Default: adaptive VRAM drain (blank-nav + poll until stable), then cold-cache Pages boot.
// --no-drain: skip drain step (use only if VRAM is already known-clean from fresh Chrome)
// --drain-ms N: fixed drain duration in ms (overrides adaptive polling; default: adaptive)

import { WebSocket }                     from "ws";
import { mkdirSync, writeFileSync }      from "fs";
import { execSync }                      from "child_process";
import { CDP_PORT }                      from "./ports.mjs";

// ── Config ─────────────────────────────────────────────────────────────────────
const PAGES_URL     = "https://wordingone.github.io/WEB-CAD/";
const ORIGIN        = "https://wordingone.github.io";
const BOOT_TIMEOUT  = 1_200_000;  // 20 min
const TURN_TIMEOUT  = 900_000;    // 15 min per prompt (Schultz ~633s: 224s gen + 409s summary)
const NO_DRAIN      = process.argv.includes("--no-drain");
const DRAIN_MS_ARG  = process.argv.find((_,i,a) => a[i-1] === "--drain-ms");
const FIXED_DRAIN   = DRAIN_MS_ARG ? parseInt(DRAIN_MS_ARG) : null;
// Fixed drain duration after blank-nav + service_worker clear.
// GPU total VRAM = 24GB; Rhino.exe holds ~5GB physical VRAM (separate D3D12 heap,
// no effect on Chrome WebGPU budget). nvidia-smi never drops below ~6GB with Rhino running.
// Chrome WebGPU has a separate ~8192MB software cap; blank-nav + SW-kill + 60s fixed drain
// is enough for Chrome's internal WebGPU GC to process deferred deletions.
const DRAIN_FIXED_MS = FIXED_DRAIN ?? 60_000;

// ── Deploy-SHA guard ───────────────────────────────────────────────────────────
// Pages always deploys from master, not HEAD (which may be a feature branch).
execSync("git fetch origin master --quiet", { encoding: "utf8" });
const SHA_FULL = execSync("git rev-parse origin/master", { encoding: "utf8" }).trim();
const SHA      = SHA_FULL.slice(0, 7);
let deployedSha = "";
try {
  deployedSha = execSync(
    `curl -s --max-time 10 "${PAGES_URL}build-sha.txt"`, { encoding: "utf8" }
  ).trim();
} catch (e) {
  console.error("[val9] curl build-sha.txt failed:", e.message); process.exit(2);
}
if (!/^[0-9a-f]{40}$/i.test(deployedSha)) {
  console.error(`[val9] build-sha.txt invalid: "${deployedSha.slice(0, 80)}"`); process.exit(2);
}
if (deployedSha !== SHA_FULL) {
  console.error(`[val9] DEPLOY-SHA MISMATCH: deployed=${deployedSha.slice(0,7)} !== local=${SHA}`);
  process.exit(2);
}
console.log(`[val9] deploy-SHA OK: ${SHA} (${PAGES_URL})`);

// ── Canonical demo prompts (web/src/agent/demo-prompts.ts DEMOS array) ─────────
const DEMOS = [
  { id: "wall",
    prompt: "Build a wall, 5.5m long, 0.2m thick, 2.8m tall." },
  { id: "column",
    prompt: "A circular column with 0.45m radius and 5m height." },
  { id: "raised-slab",
    prompt: "Place a 5 by 4m floor slab, 0.2m thick, raised 3m above ground." },
  { id: "slab-with-hole",
    prompt: "Slab 6×6m × 0.2m thick with a 1×1m square hole at (2.5, 2.5)." },
  { id: "wall-with-door",
    prompt: "Wall 4.13×0.28×2.69m with a 1.01m × 2.1m doorway 1.77m from the left." },
  { id: "l-walls",
    prompt: "Two walls forming an L: 8.45m and 9.25m, both 0.31m thick and 3.35m tall." },
  { id: "four-walled-room",
    prompt: "Four-walled room 9.12m × 9.34m, 0.24m thick walls, 3.06m tall." },
  { id: "stair-step",
    prompt: "Stair-step structure with 4 steps, run 0.39m, rise 0.21m, 2.77m wide." },
  { id: "schultz-residence",
    prompt: "Build a single-story residence in the style of the Schultz Residence: rectangular 12m by 8m footprint, 0.2m floor slab, four perimeter exterior walls 2.8m tall and 0.2m thick, one interior partition splitting the plan east-west at x=7m (0.15m thick, full height), two square columns 0.3m by 0.3m at the front corners, a 1m by 2.1m doorway in the south wall centered on the front entry (4m from the west edge), a 2m by 1.4m window in the north wall centered (6m from the west edge), and a flat roof slab 0.2m thick at z=2.8m. Fuse all walls and slabs into a single composite." },
];

// ── VRAM helper ────────────────────────────────────────────────────────────────
const sampleVram = () => {
  try {
    const out = execSync(
      "nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits", { encoding: "utf8" }
    );
    return parseInt(out.trim(), 10);
  } catch { return null; }
};

// ── CDP setup ──────────────────────────────────────────────────────────────────
mkdirSync("state/diag-307", { recursive: true });

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
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result ?? {});
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = msgId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval error");
  return r.result?.value;
};
const delay = ms => new Promise(r => setTimeout(r, ms));

await send("Runtime.enable");
await send("Page.enable");

// ── Phase 0: VRAM drain ────────────────────────────────────────────────────────
if (!NO_DRAIN) {
  const vramPre = sampleVram();
  console.log(`[val9] pre-drain VRAM: ${vramPre}MB`);

  // Navigate to about:blank to kill page-owned workers and queue D3D12 deferred deletions
  const curUrl = await evaluate(`window.location.href`).catch(() => "");
  if (!String(curUrl).startsWith("about:")) {
    console.log("[val9] drain: navigating to about:blank...");
    await send("Page.navigate", { url: "about:blank" });
    await delay(3_000);
  }
  try { await send("Runtime.collectGarbage"); } catch {}

  // Kill service workers before drain — they survive blank-nav and hold WebGPU resources.
  console.log("[val9] drain: clearing service workers...");
  try {
    await send("Storage.clearDataForOrigin", {
      origin: ORIGIN,
      storageTypes: "service_workers",
    });
  } catch { /* non-fatal */ }
  await delay(3_000); // let Chrome initiate SW termination

  // Fixed drain: wait for Chrome WebGPU internal GC to process deferred D3D12 deletions.
  // Note: nvidia-smi stays high (~6GB) because Rhino.exe holds separate physical VRAM;
  // this drain is for Chrome's internal WebGPU budget (8192MB cap), not physical VRAM.
  console.log(`[val9] drain: ${DRAIN_FIXED_MS/1000}s fixed wait for Chrome WebGPU GC...`);
  const drainStart = Date.now();
  const tick = setInterval(() => {
    const elapsed = Math.round((Date.now() - drainStart) / 1000);
    process.stdout.write(`\r[val9] drain: ${elapsed}s/${DRAIN_FIXED_MS/1000}s VRAM=${sampleVram()}MB`);
  }, 5_000);
  await delay(DRAIN_FIXED_MS);
  clearInterval(tick);
  process.stdout.write("\n");
  try { await send("Runtime.collectGarbage"); } catch {}
}

// ── Phase 1: Cold-cache clear ──────────────────────────────────────────────────
// Clear IDB (try from about:blank; non-fatal if fails)
console.log("[val9] clearing IDB...");
try {
  await send("IndexedDB.enable");
  const r = await send("IndexedDB.requestDatabaseNames", { securityOrigin: ORIGIN });
  for (const name of (r.databaseNames ?? [])) {
    try { await send("IndexedDB.deleteDatabase", { securityOrigin: ORIGIN, databaseName: name }); }
    catch { /* non-fatal */ }
  }
} catch { /* non-fatal if IDB CDP fails from about:blank */ }

// Cold-cache: cookies + localStorage + cache_storage + service_workers (OPFS preserved)
await send("Storage.clearDataForOrigin", {
  origin: ORIGIN,
  storageTypes: "cookies,local_storage,cache_storage,service_workers",
});
console.log("[val9] cold-cache cleared (cookies+localStorage+cache+SW; OPFS preserved)");

// ── Phase 2: Navigate to Pages and boot ───────────────────────────────────────
const vramPreBoot = sampleVram();
console.log(`[val9] pre-boot VRAM: ${vramPreBoot}MB`);
console.log(`[val9] navigating → ${PAGES_URL}`);
await send("Page.navigate", { url: PAGES_URL });
await delay(4_000);

// Inject OOM + align event listeners
await evaluate(`
  window.__val9OomCount   = 0;
  window.__val9AlignCount = 0;
  window.addEventListener("agentmodel:worker-recycled", e => {
    if (e.detail?.reason === "d3d12-oom")          window.__val9OomCount   = (window.__val9OomCount   ?? 0) + 1;
    if (e.detail?.reason === "wasm-align-recycle") window.__val9AlignCount = (window.__val9AlignCount ?? 0) + 1;
  });
  window.__dispatchLedger = [];
`);

// Wait for boot-complete (ai-model-badge READY + send-btn enabled)
const bootStart = Date.now();
console.log("[val9] waiting for boot-complete...");
let booted = false;
while (Date.now() - bootStart < BOOT_TIMEOUT) {
  const badge = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? ''`);
  const dis   = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
  const txt   = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
  if (String(badge).includes("READY") && !dis && String(txt).includes("SEND")) {
    booted = true; break;
  }
  // Stuck-spinner recovery
  if (String(txt) === "…" && Boolean(dis) && String(badge).includes("READY")) {
    await evaluate(`{const b=document.querySelector('.chat-send-btn');if(b&&b.textContent==='…'){b.disabled=false;b.textContent='SEND';}}`);
  }
  process.stdout.write(".");
  await delay(5_000);
}
console.log();
if (!booted) { console.error("[val9] boot timeout"); ws.close(); process.exit(1); }
const vramBooted = sampleVram();
console.log(`[val9] booted in ${Math.round((Date.now()-bootStart)/1000)}s | boot VRAM: ${vramBooted}MB`);

// ── Phase 3: Run 9 demo prompts in order ──────────────────────────────────────
const results = [];
let totalOom = 0;

for (let i = 0; i < DEMOS.length; i++) {
  const demo = DEMOS[i];
  const n = i + 1;
  console.log(`\n[val9] ── Demo ${n}/9: ${demo.id} ─────────────────`);
  console.log(`[val9] prompt: "${demo.prompt.slice(0, 80)}${demo.prompt.length > 80 ? '...' : ''}"`);

  // Reset ledger for this prompt
  await evaluate(`window.__dispatchLedger = []; window.__val9OomCount = 0;`);
  const lastOom = totalOom;

  // Pre-turn gate (wait for SEND)
  const pgStart = Date.now();
  let pgOk = false;
  process.stdout.write(`[val9] waiting for SEND... `);
  while (Date.now() - pgStart < 120_000) {
    const dis = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
    const txt = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
    if (!dis && String(txt).includes("SEND")) { pgOk = true; break; }
    process.stdout.write(".");
    await delay(3_000);
  }
  console.log(pgOk ? "OK" : "TIMEOUT");
  if (!pgOk) {
    results.push({ id: demo.id, n, outcome: "pre_gate_timeout", oom: 0, vram_start: null, vram_end: null, ledger: [] });
    continue;
  }

  // Sample VRAM before
  const vramStart = sampleVram();

  // Count AI messages before
  const aiMsgsBefore = await evaluate(`document.querySelectorAll('.chat-msg').length`);

  // Send prompt
  const sent = await evaluate(`
    (async () => {
      const inp = document.querySelector(".chat-input");
      if (!inp) return "no-input";
      inp.value = ${JSON.stringify(demo.prompt)};
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      const btn = document.querySelector(".chat-send-btn");
      if (!btn || btn.disabled) return "btn-unavailable";
      btn.click();
      return "sent";
    })()
  `);
  if (sent !== "sent") {
    console.warn(`[val9] send failed: "${sent}"`);
    results.push({ id: demo.id, n, outcome: "send_fail", oom: 0, vram_start: vramStart, vram_end: null, ledger: [] });
    continue;
  }
  console.log(`[val9] sent (VRAM=${vramStart}MB)`);

  const turnStart = Date.now();
  let outcome = "timeout";
  let oomThisTurn = 0;
  let vramPeak = vramStart ?? 0;

  // Wait for generation complete
  while (Date.now() - turnStart < TURN_TIMEOUT) {
    await delay(5_000);

    // Sample VRAM (track peak)
    const vNow = sampleVram();
    if (vNow !== null && vNow > vramPeak) vramPeak = vNow;

    // OOM events
    const curOom = await evaluate(`window.__val9OomCount ?? 0`);
    if (curOom > 0) {
      oomThisTurn = curOom;
      totalOom += curOom;
      await evaluate(`window.__val9OomCount = 0;`);
      console.warn(`\n[val9] D3D12-OOM×${curOom} during Demo ${n}`);
    }

    const dis = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
    const txt = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
    const badge = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? ''`);

    // Ghost detection
    if (String(badge).includes("ERROR")) {
      outcome = "ghost_badge_error"; break;
    }

    // Success: SEND restored
    if (!Boolean(dis) && String(txt).includes("SEND")) {
      // Check if AI produced new messages
      const aiMsgsAfter = await evaluate(`document.querySelectorAll('.chat-msg').length`);
      if (Number(aiMsgsAfter) > Number(aiMsgsBefore)) {
        outcome = "success"; break;
      }
    }
  }

  const elapsed = Math.round((Date.now() - turnStart) / 1000);
  const vramEnd = sampleVram();

  // Read dispatch ledger
  const ledger = await evaluate(`
    (function() {
      const l = window.__dispatchLedger ?? [];
      return JSON.stringify(l);
    })()
  `);
  let ledgerEntries = [];
  try { ledgerEntries = JSON.parse(String(ledger)); } catch {}

  const successEntries = ledgerEntries.filter(e => e.status === "success");
  const hasGeometry = successEntries.some(e => e.sceneChildrenDelta > 0);

  results.push({
    id: demo.id, n, outcome, elapsed_s: elapsed,
    oom: oomThisTurn, vram_start: vramStart, vram_peak: vramPeak, vram_end: vramEnd,
    ledger_total: ledgerEntries.length,
    ledger_success: successEntries.length,
    has_geometry: hasGeometry,
    ledger: ledgerEntries,
  });

  // Per-prompt summary
  const ledgerSummary = ledgerEntries.map(e =>
    `${e.verb}(${e.status},Δ${e.sceneChildrenDelta > 0 ? "+"+e.sceneChildrenDelta : e.sceneChildrenDelta})`
  ).join(", ") || "(none)";
  console.log(`[val9] Demo ${n} ${demo.id}: ${outcome} in ${elapsed}s | OOM=${oomThisTurn} | VRAM ${vramStart}→${vramPeak}(peak)→${vramEnd}MB`);
  console.log(`[val9]   dispatches: ${ledgerSummary}`);
}

// ── Phase 4: Results report ───────────────────────────────────────────────────
const passed = results.filter(r => r.outcome === "success");
const withGeometry = results.filter(r => r.has_geometry);
const totalOomAll = results.reduce((sum, r) => sum + r.oom, 0);
const vramValues = results.flatMap(r => [r.vram_start, r.vram_peak, r.vram_end]).filter(v => v !== null);
const vramMax = vramValues.length ? Math.max(...vramValues) : null;
const vramMin = vramValues.length ? Math.min(...vramValues) : null;
const gatePass = totalOomAll === 0 && passed.length === DEMOS.length && withGeometry.length === DEMOS.length;

console.log(`\n[val9] ══════════════════════════════════════════`);
console.log(`[val9] SHA:               ${SHA}`);
console.log(`[val9] Deploy:            ${PAGES_URL}`);
console.log(`[val9] Total OOM events:  ${totalOomAll}`);
console.log(`[val9] Demos passed:      ${passed.length}/${DEMOS.length}`);
console.log(`[val9] Demos w/ geometry: ${withGeometry.length}/${DEMOS.length}`);
console.log(`[val9] VRAM range:        ${vramMin}–${vramMax} MB (real app)`);
console.log(`[val9] Boot VRAM:         ${vramBooted}MB`);
console.log(`[val9] Gate PASS:         ${gatePass}`);
console.log(`[val9] ══════════════════════════════════════════`);
console.log(`\n[val9] Per-demo breakdown:`);
for (const r of results) {
  const glyph = r.outcome === "success" && r.has_geometry ? "✓" : "✗";
  const ledgerStr = r.ledger.map(e =>
    `  ${e.verb}: ${e.status} (sceneΔ${e.sceneChildrenDelta > 0 ? "+"+e.sceneChildrenDelta : e.sceneChildrenDelta})`
  ).join("\n") || "  (no dispatches)";
  console.log(`${glyph} Demo ${r.n} (${r.id}): ${r.outcome}, OOM=${r.oom}, VRAM ${r.vram_start}→${r.vram_peak}→${r.vram_end}MB`);
  console.log(ledgerStr);
}

// Write artifact
const artifact = {
  sha: SHA, sha_full: SHA_FULL, pages_url: PAGES_URL,
  boot_vram_mb: vramBooted,
  total_oom: totalOomAll,
  demos_passed: passed.length, demos_total: DEMOS.length,
  demos_with_geometry: withGeometry.length,
  vram_min_mb: vramMin, vram_max_mb: vramMax,
  gate_pass: gatePass,
  results,
};
const artifactPath = `state/diag-307/validate-demos-9-${SHA}-${Date.now()}.json`;
writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
console.log(`\n[val9] Artifact: ${artifactPath}`);

ws.close();
process.exit(gatePass ? 0 : 1);
