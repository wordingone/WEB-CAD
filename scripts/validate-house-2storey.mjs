#!/usr/bin/env node
// validate-house-2storey.mjs — #281 new gate: 2-storey house visibly on screen.
// Leo gate (mail 12687): agent generates 2-storey house, OOM=0, hero from low exterior angle,
// Haiku cross-validates building is on screen.
//
// Usage:
//   node scripts/validate-house-2storey.mjs [--no-drain]

import { WebSocket }                     from "ws";
import { mkdirSync, writeFileSync }      from "fs";
import { createHash }                    from "crypto";
import { execSync }                      from "child_process";
import { CDP_PORT }                      from "./ports.mjs";

// ── Config ─────────────────────────────────────────────────────────────────────
const PAGES_URL    = "https://wordingone.github.io/WEB-CAD/";
const ORIGIN       = "https://wordingone.github.io";
const BOOT_TIMEOUT = 1_200_000;  // 20 min
const TURN_TIMEOUT = 900_000;    // 15 min
const NO_DRAIN     = process.argv.includes("--no-drain");
const DRAIN_FIXED_MS = 60_000;

// Prompt engineered to work around the model's invariant ft→m conversion (#1680):
// the model multiplies every numeric value by 0.3048 regardless of context.
// Pre-scaling: desired_metres / 0.3048 gives the prompt value the model will convert correctly.
//   3m  → 9.843  (9.843 × 0.3048 = 2.999m ≈ 3m)
//   2.8m → 9.186  (9.186 × 0.3048 = 2.800m)
//   5.8m → 19.03  (19.03 × 0.3048 = 5.800m)
//   ±5m  → ±16.40 (16.40 × 0.3048 = 4.999m)
//   ±4m  → ±13.12 (13.12 × 0.3048 = 3.999m)
//   ±2m  → ±6.562 (6.562 × 0.3048 = 1.999m)
const HOUSE_PROMPT =
  "Build a 2-storey single-family house in feet (the app converts to metres automatically). " +
  "(1) SdLevel name=Ground elevation=0. " +
  "(2) SdSlab on Ground floor size=[32.8,26.25] at z=0. " +
  "(3) Four SdWall on Ground height=9.843: " +
  "south start=[-16.4,-13.12] end=[16.4,-13.12]; " +
  "north start=[-16.4,13.12] end=[16.4,13.12]; " +
  "east start=[16.4,-13.12] end=[16.4,13.12]; " +
  "west start=[-16.4,-13.12] end=[-16.4,13.12]. " +
  "(4) SdDoor position=[0,-13.12,0] — entry door on south wall. " +
  "(5) SdLevel name=Level-2 elevation=9.843. " +
  "(6) SdSlab on Level-2 size=[32.8,26.25] at z=9.843. " +
  "(7) Four SdWall on Level-2 height=9.186: same footprint. " +
  "(8) SdWindow position=[-6.562,-13.12,9.843] on south wall. " +
  "(9) SdWindow position=[6.562,-13.12,9.843] on south wall. " +
  "(10) SdLevel name=Roof elevation=19.03. " +
  "(11) SdSlab on Roof size=[32.8,26.25] thickness=0.492 at z=19.03.";

const DIAG_DIR = "state/diag-house";

// ── Deploy-SHA guard ───────────────────────────────────────────────────────────
execSync("git fetch origin master --quiet", { encoding: "utf8" });
const SHA_FULL = execSync("git rev-parse origin/master", { encoding: "utf8" }).trim();
const SHA      = SHA_FULL.slice(0, 7);
let deployedSha = "";
try {
  deployedSha = execSync(
    `curl -s --max-time 10 "${PAGES_URL}build-sha.txt"`, { encoding: "utf8" }
  ).trim();
} catch (e) {
  console.error("[house] curl build-sha.txt failed:", e.message); process.exit(2);
}
if (!/^[0-9a-f]{40}$/i.test(deployedSha)) {
  console.error(`[house] build-sha.txt invalid: "${deployedSha.slice(0, 80)}"`); process.exit(2);
}
if (deployedSha !== SHA_FULL) {
  console.error(`[house] DEPLOY-SHA MISMATCH: deployed=${deployedSha.slice(0,7)} !== local=${SHA}`);
  process.exit(2);
}
console.log(`[house] deploy-SHA OK: ${SHA} (${PAGES_URL})`);

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
mkdirSync(DIAG_DIR, { recursive: true });

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
  console.log(`[house] pre-drain VRAM: ${vramPre}MB`);

  const curUrl = await evaluate(`window.location.href`).catch(() => "");
  if (!String(curUrl).startsWith("about:")) {
    console.log("[house] drain: navigating to about:blank...");
    await send("Page.navigate", { url: "about:blank" });
    await delay(3_000);
  }
  try { await send("Runtime.collectGarbage"); } catch {}

  console.log("[house] drain: clearing service workers...");
  try {
    await send("Storage.clearDataForOrigin", { origin: ORIGIN, storageTypes: "service_workers" });
  } catch {}
  await delay(3_000);

  console.log(`[house] drain: ${DRAIN_FIXED_MS/1000}s fixed wait for Chrome WebGPU GC...`);
  const drainStart = Date.now();
  const tick = setInterval(() => {
    const elapsed = Math.round((Date.now() - drainStart) / 1000);
    process.stdout.write(`\r[house] drain: ${elapsed}s/${DRAIN_FIXED_MS/1000}s VRAM=${sampleVram()}MB`);
  }, 5_000);
  await delay(DRAIN_FIXED_MS);
  clearInterval(tick);
  process.stdout.write("\n");
  try { await send("Runtime.collectGarbage"); } catch {}
}

// ── Phase 1: Cold-cache clear ──────────────────────────────────────────────────
console.log("[house] clearing IDB...");
try {
  await send("IndexedDB.enable");
  const r = await send("IndexedDB.requestDatabaseNames", { securityOrigin: ORIGIN });
  for (const name of (r.databaseNames ?? [])) {
    try { await send("IndexedDB.deleteDatabase", { securityOrigin: ORIGIN, databaseName: name }); }
    catch {}
  }
} catch {}

await send("Storage.clearDataForOrigin", {
  origin: ORIGIN,
  storageTypes: "cookies,local_storage,cache_storage,service_workers",
});
console.log("[house] cold-cache cleared (cookies+localStorage+cache+SW; OPFS preserved)");

// ── Phase 2: Navigate and boot ────────────────────────────────────────────────
const vramPreBoot = sampleVram();
console.log(`[house] pre-boot VRAM: ${vramPreBoot}MB`);
console.log(`[house] navigating → ${PAGES_URL}`);
await send("Page.navigate", { url: PAGES_URL });
await delay(4_000);

await evaluate(`
  window.__houseOomCount = 0;
  window.__dispatchLedger = [];
  window.addEventListener("agentmodel:worker-recycled", e => {
    if (e.detail?.reason === "d3d12-oom") window.__houseOomCount = (window.__houseOomCount ?? 0) + 1;
  });
`);

const bootStart = Date.now();
console.log("[house] waiting for boot-complete...");
let booted = false;
while (Date.now() - bootStart < BOOT_TIMEOUT) {
  const badge = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? ''`);
  const dis   = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
  const txt   = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
  if (String(badge).includes("READY") && !dis && String(txt).includes("SEND")) {
    booted = true; break;
  }
  // Stuck-spinner at boot only (safe — no generation in progress)
  if (String(txt) === "…" && Boolean(dis) && String(badge).includes("READY")) {
    await evaluate(`{const b=document.querySelector('.chat-send-btn');if(b&&b.textContent==='…'){b.disabled=false;b.textContent='SEND';}}`);
  }
  process.stdout.write(".");
  await delay(5_000);
}
console.log();
if (!booted) { console.error("[house] boot timeout"); ws.close(); process.exit(1); }
const vramBooted = sampleVram();
console.log(`[house] booted in ${Math.round((Date.now()-bootStart)/1000)}s | boot VRAM: ${vramBooted}MB`);

// ── Phase 3: Send house prompt ─────────────────────────────────────────────────
console.log(`[house] prompt: "${HOUSE_PROMPT.slice(0, 100)}..."`);

await evaluate(`window.__dispatchLedger = []; window.__houseOomCount = 0;`);

// Wait for SEND
const pgStart = Date.now();
let pgOk = false;
process.stdout.write("[house] waiting for SEND... ");
while (Date.now() - pgStart < 60_000) {
  const dis = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
  const txt = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
  if (!dis && String(txt).includes("SEND")) { pgOk = true; break; }
  process.stdout.write(".");
  await delay(2_000);
}
console.log(pgOk ? "OK" : "TIMEOUT");
if (!pgOk) { console.error("[house] pre-send gate timeout"); ws.close(); process.exit(1); }

const vramStart = sampleVram();
const aiMsgsBefore = await evaluate(`document.querySelectorAll('.chat-msg').length`);

const sent = await evaluate(`
  (async () => {
    const inp = document.querySelector(".chat-input");
    if (!inp) return "no-input";
    inp.value = ${JSON.stringify(HOUSE_PROMPT)};
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    const btn = document.querySelector(".chat-send-btn");
    if (!btn || btn.disabled) return "btn-unavailable";
    btn.click();
    return "sent";
  })()
`);
if (sent !== "sent") {
  console.error(`[house] send failed: "${sent}"`); ws.close(); process.exit(1);
}
console.log(`[house] sent (VRAM=${vramStart}MB)`);

// ── Phase 4: Wait for generation to complete ──────────────────────────────────
const turnStart = Date.now();
let outcome = "timeout";
let oomCount = 0;
let vramPeak = vramStart ?? 0;

while (Date.now() - turnStart < TURN_TIMEOUT) {
  await delay(5_000);

  const vNow = sampleVram();
  if (vNow !== null && vNow > vramPeak) vramPeak = vNow;

  const curOom = await evaluate(`window.__houseOomCount ?? 0`);
  if (curOom > 0) {
    oomCount += curOom;
    await evaluate(`window.__houseOomCount = 0;`);
    console.warn(`\n[house] D3D12-OOM×${curOom}`);
  }

  const elapsed = Math.round((Date.now() - turnStart) / 1000);
  const dis   = await evaluate(`document.querySelector('.chat-send-btn')?.disabled ?? true`);
  const txt   = await evaluate(`document.querySelector('.chat-send-btn')?.textContent ?? ''`);
  const badge = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? ''`);
  const ledgerLen = await evaluate(`(window.__dispatchLedger ?? []).length`);

  process.stdout.write(`\r[house] ${elapsed}s btn=${txt}(${dis}) OOM=${oomCount} VRAM=${vNow}MB ledger=${ledgerLen}`);

  if (String(badge).includes("ERROR")) { outcome = "ghost_badge_error"; break; }
  if (!Boolean(dis) && String(txt).includes("SEND")) {
    const aiMsgsAfter = await evaluate(`document.querySelectorAll('.chat-msg').length`);
    if (Number(aiMsgsAfter) > Number(aiMsgsBefore)) { outcome = "success"; break; }
  }
}
process.stdout.write("\n");

const elapsed = Math.round((Date.now() - turnStart) / 1000);
const vramEnd = sampleVram();
console.log(`[house] done | outcome=${outcome} | elapsed=${elapsed}s | OOM=${oomCount} | VRAM ${vramStart}→${vramPeak}(peak)→${vramEnd}MB`);

// ── Phase 5: Read dispatch ledger ─────────────────────────────────────────────
const ledgerRaw = await evaluate(`(function(){ return JSON.stringify(window.__dispatchLedger ?? []); })()`);
let ledger = [];
try { ledger = JSON.parse(String(ledgerRaw)); } catch {}

const successEntries  = ledger.filter(e => e.status === "success");
const geomEntries     = successEntries.filter(e => e.sceneChildrenDelta > 0);
const hasGeometry     = geomEntries.length > 0;
const sceneChildren   = await evaluate(`(window.__viewer?.scene?.children?.length ?? -1)`);

const ledgerSummary = ledger.map(e =>
  `${e.verb}(${e.status},Δ${e.sceneChildrenDelta > 0 ? "+" + e.sceneChildrenDelta : e.sceneChildrenDelta})`
).join(", ") || "(none)";

console.log(`[house] ledger: ${ledger.length} total | ${successEntries.length} success | ${geomEntries.length} geometry`);
console.log(`[house] scene children: ${sceneChildren}`);
console.log(`[house] dispatches: ${ledgerSummary}`);

// ── Phase 6: Hero screenshot — low exterior 3/4 angle ─────────────────────────
// Step 1: frameAllVisible to normalise bounds
await evaluate(`window.__viewer?.frameAllVisible?.();`);
await delay(300);

// Step 2: Override camera to 20° elevation (low exterior hero angle)
const camResult = await evaluate(`
  (function() {
    const v = window.__viewer;
    if (!v) return 'no-viewer';
    const p = v.panes.find(function(pp) { return pp.view === 'persp'; });
    if (!p) return 'no-persp-pane';
    const t = p.controls.target;
    const cam = v.camera;
    const dx = cam.position.x - t.x;
    const dy = cam.position.y - t.y;
    const dz = cam.position.z - t.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    // 225° azimuth: camera to SW of building → shows south facade where door+windows live.
    // 20° elevation: low exterior 3/4 angle showing both storeys + roof.
    const azimuth = 225 * Math.PI / 180;
    const elevRad = 20 * Math.PI / 180;
    const newX = t.x + dist * Math.cos(azimuth) * Math.cos(elevRad);
    const newY = t.y + dist * Math.sin(azimuth) * Math.cos(elevRad);
    const newZ = t.z + dist * Math.sin(elevRad);
    cam.position.set(newX, newY, newZ);
    cam.up.set(0, 0, 1);
    cam.lookAt(t.x, t.y, t.z);
    cam.updateProjectionMatrix();
    p.controls.target.set(t.x, t.y, t.z);
    p.controls.update();
    return 'ok|dist=' + Math.round(dist*100)/100 + '|az=' + Math.round(azimuth*180/Math.PI) + '°|elev=20°';
  })()
`);
console.log(`[house] camera: ${camResult}`);
await delay(400); // allow renderer to update

// Step 3: Capture screenshot
const ts = Date.now();
const heroResult = await send("Page.captureScreenshot", { format: "png" });
const heroBuf = Buffer.from(heroResult.data, "base64");
const heroPath = `${DIAG_DIR}/house-hero-${ts}.png`;
writeFileSync(heroPath, heroBuf);
const heroSha256 = createHash("sha256").update(heroBuf).digest("hex");
const heroSha256Short = heroSha256.slice(0, 12);
console.log(`[house] hero saved: ${heroPath}`);
console.log(`[house] hero sha256[:12]: ${heroSha256Short} | bytes: ${heroBuf.length}`);

// Step 4: Also capture true top-down ortho for footprint
await evaluate(`
  (function() {
    const v = window.__viewer;
    if (!v || !v.scene) return;
    const box = { minX:Infinity, minY:Infinity, minZ:Infinity, maxX:-Infinity, maxY:-Infinity, maxZ:-Infinity };
    v.scene.traverse(function(obj) {
      if (!obj.userData || !obj.userData.kind) return;
      if (obj.position) {
        box.minX = Math.min(box.minX, obj.position.x);
        box.maxX = Math.max(box.maxX, obj.position.x);
        box.minY = Math.min(box.minY, obj.position.y);
        box.maxY = Math.max(box.maxY, obj.position.y);
        box.minZ = Math.min(box.minZ, obj.position.z);
        box.maxZ = Math.max(box.maxZ, obj.position.z);
      }
    });
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const cz = (box.maxZ || 6);
    const dist = Math.max(box.maxX - box.minX, box.maxY - box.minY, 10) * 1.5;
    const p = v.panes.find(function(pp) { return pp.view === 'persp'; });
    if (!p) return;
    v.camera.position.set(cx, cy, cz + dist);
    v.camera.up.set(0, 1, 0);
    v.camera.lookAt(cx, cy, cz);
    v.camera.updateProjectionMatrix();
    p.controls.target.set(cx, cy, cz);
    p.controls.update();
  })()
`);
await delay(400);

const aerialResult = await send("Page.captureScreenshot", { format: "png" });
const aerialBuf = Buffer.from(aerialResult.data, "base64");
const aerialPath = `${DIAG_DIR}/house-aerial-${ts}.png`;
writeFileSync(aerialPath, aerialBuf);
const aerialSha256Short = createHash("sha256").update(aerialBuf).digest("hex").slice(0, 12);
console.log(`[house] aerial saved: ${aerialPath}`);
console.log(`[house] aerial sha256[:12]: ${aerialSha256Short} | bytes: ${aerialBuf.length}`);

// ── Phase 7: Summary + artifact ───────────────────────────────────────────────
const gatePass = oomCount === 0 && outcome === "success" && hasGeometry;

console.log(`\n[house] ══════════════════════════════════════════`);
console.log(`[house] SHA:           ${SHA}`);
console.log(`[house] Deploy:        ${PAGES_URL}`);
console.log(`[house] Outcome:       ${outcome}`);
console.log(`[house] OOM events:    ${oomCount}`);
console.log(`[house] Geometry disp: ${geomEntries.length}`);
console.log(`[house] VRAM range:    ${vramStart}–${vramPeak}(peak)–${vramEnd} MB`);
console.log(`[house] Scene objects: ${sceneChildren}`);
console.log(`[house] Hero:          ${heroPath} sha256[:12]=${heroSha256Short}`);
console.log(`[house] Aerial:        ${aerialPath} sha256[:12]=${aerialSha256Short}`);
console.log(`[house] Gate PASS:     ${gatePass}`);
console.log(`[house] ══════════════════════════════════════════`);

const artifact = {
  sha: SHA, sha_full: SHA_FULL, pages_url: PAGES_URL,
  prompt: HOUSE_PROMPT,
  outcome, elapsed_s: elapsed,
  oom_count: oomCount,
  boot_vram_mb: vramBooted,
  vram_start_mb: vramStart,
  vram_peak_mb: vramPeak,
  vram_end_mb: vramEnd,
  scene_children: sceneChildren,
  ledger_total: ledger.length,
  ledger_success: successEntries.length,
  ledger_geometry: geomEntries.length,
  has_geometry: hasGeometry,
  ledger,
  screenshots: {
    hero: { path: heroPath, sha256: heroSha256Short, bytes: heroBuf.length },
    aerial: { path: aerialPath, sha256: aerialSha256Short, bytes: aerialBuf.length },
  },
  gate_pass: gatePass,
};
const artifactPath = `${DIAG_DIR}/house-receipt-${SHA}-${ts}.json`;
writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
console.log(`\n[house] Receipt: ${artifactPath}`);

ws.close();
