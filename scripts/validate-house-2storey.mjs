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
// §Leo-gate-req3: pitched (gable) roof — SdRoof roofType=pitched replaces flat SdSlab.
// Active level when SdRoof fires: Level-2. Handler infers eave from Level-2 walls (height=2.8m),
// places roof at activeLevelElev + eaveOffset = 3m + 2.8m = 5.8m (top of Level-2 walls). ✓
// No separate Roof level needed — caller stays on Level-2.
// ft pre-scaling unchanged (×0.3048 model conversion):
//   footprint corners [-16.4,-13.12]→[16.4,13.12] = ±5m×±4m after conversion.
const HOUSE_PROMPT =
  "Build a 2-storey single-family house. All numbers are in feet; the app converts to metres. " +
  "Execute exactly these 18 steps in order, then stop immediately. Do NOT add any more commands after step 18: " +
  "(1) SdLevel name=Ground elevation=0. " +
  "(2) SdSlab on Ground size=[32.8,26.25] at z=0. " +
  "(3) SdWall on Ground height=9.843 start=[-16.4,-13.12] end=[16.4,-13.12]. " +
  "(4) SdWall on Ground height=9.843 start=[-16.4,13.12] end=[16.4,13.12]. " +
  "(5) SdWall on Ground height=9.843 start=[16.4,-13.12] end=[16.4,13.12]. " +
  "(6) SdWall on Ground height=9.843 start=[-16.4,-13.12] end=[-16.4,13.12]. " +
  "(7) SdDoor position=[0,-13.12,0] on south wall. " +
  "(8) SdWindow position=[-6.562,-13.12,0] on south wall Ground. " +
  "(9) SdWindow position=[6.562,-13.12,0] on south wall Ground. " +
  "(10) SdLevel name=Level-2 elevation=9.843. " +
  "(11) SdSlab on Level-2 size=[32.8,26.25] at z=9.843. " +
  "(12) SdWall on Level-2 height=9.186 start=[-16.4,-13.12] end=[16.4,-13.12]. " +
  "(13) SdWall on Level-2 height=9.186 start=[-16.4,13.12] end=[16.4,13.12]. " +
  "(14) SdWall on Level-2 height=9.186 start=[16.4,-13.12] end=[16.4,13.12]. " +
  "(15) SdWall on Level-2 height=9.186 start=[-16.4,-13.12] end=[-16.4,13.12]. " +
  "(16) SdWindow position=[-6.562,-13.12,9.843] on south wall Level-2. " +
  "(17) SdWindow position=[6.562,-13.12,9.843] on south wall Level-2. " +
  "(18) SdRoof roofType=pitched pitchDeg=30 footprint=[[-16.4,-13.12],[16.4,-13.12],[16.4,13.12],[-16.4,13.12]].";

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
// §runtime-binding: instant callback from browser when 16-geom gate fires.
// Resolves houseGatePromise with { geom, voidInfo } payload.
let _houseGateResolve = null;
const houseGatePromise = new Promise(r => { _houseGateResolve = r; });

ws.on("message", raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result ?? {});
  }
  // Runtime.bindingCalled fires synchronously when browser calls window.houseGeomGate(...)
  if (m.method === "Runtime.bindingCalled" && m.params?.name === "houseGeomGate") {
    let payload = { geom: 0, voidInfo: [] };
    try { payload = JSON.parse(m.params.payload ?? "{}"); } catch {}
    if (_houseGateResolve) { _houseGateResolve(payload); _houseGateResolve = null; }
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
// Register binding BEFORE navigation so it's available in the page
await send("Runtime.addBinding", { name: "houseGeomGate" });

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

// Install scene add/remove spy to track what object 6f11bebd (or any host uuid) actually is
await evaluate(`(function(){
  var viewer=window.__viewer;
  if(!viewer) return;
  var scene=viewer.scene||(viewer.getScene&&viewer.getScene());
  if(!scene) return;
  window.__sceneSpy=[];
  var origAdd=scene.add.bind(scene);
  scene.add=function(){
    for(var i=0;i<arguments.length;i++){
      var o=arguments[i];
      if(o&&o.uuid){
        window.__sceneSpy.push({op:'add',uuid:o.uuid,creator:(o.userData&&o.userData.creator)||'',levelId:(o.userData&&o.userData.levelId)||'',isGroup:!!o.isGroup,expressID:(o.userData&&o.userData.expressID)||''});
      }
    }
    return origAdd.apply(scene,arguments);
  };
  var origRemove=scene.remove.bind(scene);
  scene.remove=function(){
    for(var i=0;i<arguments.length;i++){
      var o=arguments[i];
      if(o&&o.uuid){
        window.__sceneSpy.push({op:'remove',uuid:o.uuid,creator:(o.userData&&o.userData.creator)||'',levelId:(o.userData&&o.userData.levelId)||'',isGroup:!!o.isGroup,expressID:(o.userData&&o.userData.expressID)||''});
      }
    }
    return origRemove.apply(scene,arguments);
  };
})()`);

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

// §runtime-binding: inject ledger watcher using Object.defineProperty so ANY future assignment
// to window.__dispatchLedger immediately patches the new array.
// §voidCut: at gate fire, collect userData.creator+hostExpressID for door/window objects.
// §SdClearScene-timing: SdClearScene is the FIRST tool call in each batch (resets prev session
// geometry). All 18 geometry calls follow synchronously. By the time geom=18 fires, all calls
// are complete and SdClearScene has ALREADY run — scene is fully populated, no pending clear.
// §force-render: force THREE.js to write the current scene to the WebGL framebuffer so
// Page.captureScreenshot captures the house even if requestAnimationFrame hasn't ticked.
await evaluate(`
  (function installGeomGateWatcher() {
    var _ledgerInner = window.__dispatchLedger || null;

    function patchLedger(arr) {
      if (!arr || arr._geomGatePatched) return;
      arr._geomGatePatched = true;
      var orig = Array.prototype.push;
      arr.push = function() {
        var r = orig.apply(this, arguments);
        var geom = 0;
        for (var i = 0; i < this.length; i++) {
          if (this[i].sceneChildrenDelta > 0) geom++;
        }
        if (geom >= 18 && !window.__houseGeomGateFired) {
          window.__houseGeomGateFired = true;
          // Collect voidCut info from scene before any potential re-render
          var voidInfo = [];
          try {
            var v0 = window.__viewer;
            var sc0 = v0 && (v0.scene || (v0.getScene && v0.getScene()));
            if (sc0) {
              sc0.traverse(function(obj) {
                var ud = obj && obj.userData;
                if (!ud) return;
                var c = ud.creator;
                if (c === 'door' || c === 'window' || c === 'opening') {
                  voidInfo.push({
                    creator: c,
                    voidCut: Boolean(ud.hostExpressID || ud.hostUuid)
                  });
                }
              });
            }
          } catch(ev) {}
          // §force-render: freeze current scene into framebuffer with better-framed hero camera.
          // Node.js will re-render with the same angles after receiving binding, but this
          // prevents a stale/blank framebuffer if rAF fires before the Node.js evaluate arrives.
          // Camera: dist=26, az=225°, elev=30°, target=(0,0,4) — frames full 8m house.
          try {
            var v = window.__viewer;
            if (v) {
              var cam = v.camera;
              var tx = 0, ty = 0, tz = 4, dist = 26;
              var az = 225 * Math.PI / 180, elev = 30 * Math.PI / 180;
              cam.position.set(
                tx + dist * Math.cos(az) * Math.cos(elev),
                ty + dist * Math.sin(az) * Math.cos(elev),
                tz + dist * Math.sin(elev)
              );
              cam.up.set(0, 0, 1);
              cam.lookAt(tx, ty, tz);
              cam.updateProjectionMatrix();
              var scene = v.scene || (v.getScene && v.getScene());
              if (scene && v.renderer) { v.renderer.render(scene, cam); }
            }
          } catch(e2) {}
          // Signal Node.js with JSON payload including voidInfo
          try { window.houseGeomGate(JSON.stringify({ geom: geom, voidInfo: voidInfo })); } catch(e) {}
        }
        return r;
      };
    }

    // Patch current ledger (if it exists)
    patchLedger(_ledgerInner);

    // Intercept all future assignments — catches SdClearScene replacing the array
    try {
      Object.defineProperty(window, '__dispatchLedger', {
        configurable: true,
        enumerable: true,
        get: function() { return _ledgerInner; },
        set: function(v) { _ledgerInner = v; patchLedger(v); }
      });
    } catch(e) {
      // defineProperty failed — fall back to 50ms poll
      var _iv = setInterval(function() {
        var cur = window['__dispatchLedger'];
        if (cur && !cur._geomGatePatched) patchLedger(cur);
      }, 50);
      setTimeout(function() { clearInterval(_iv); }, 1200000);
    }
  })()
`);

// ── Phase 4: Wait for generation to complete ──────────────────────────────────
// §runtime-binding-race: houseGatePromise resolves the instant browser calls window.houseGeomGate()
// (injected ledger watcher fires synchronously on 17th geometry push — no poll delay).
// Poll loop still runs for OOM, badge-error, and success detection; but the gate drives the hero.
// §18-step-prompt: 18 geometry dispatches (SdLevel×2 + SdSlab×2 + SdWall×8 + SdDoor + SdWindow×4 + SdRoof).
const EARLY_STOP_GEOM = 18;
const turnStart = Date.now();
let outcome = "timeout";
let oomCount = 0;
let vramPeak = vramStart ?? 0;
let earlyStopped = false;
let earlyHeroBuf = null;
let earlyHeroSha256Short = "";
let earlyHeroPathSaved = "";
let earlyAerialBuf = null;
let earlyAerialSha256Short = "";
let earlyAerialPathSaved = "";
let earlySideBuf = null;
let earlySideSha256Short = "";
let earlySidePathSaved = "";
let earlyCloseupBuf = null;
let earlyCloseupSha256Short = "";
let earlyCloseupPathSaved = "";
let bindingVoidInfo = [];  // voidCut info collected by browser watcher at gate time

// Track gate resolution via side-effect flag so Promise.race() can be called each iteration.
let houseGateFired = false;
let houseGatePayload = null;
houseGatePromise.then((payload) => { houseGateFired = true; houseGatePayload = payload; });

// §capture-framing: compute TRUE fit-to-scene-bbox camera at capture time.
// §controls-bypass: NO pp.controls.update() — OrbitControls.update() recomputes camera position
// from stored spherical coords and OVERRIDES the cam.position we just set. Render directly.
// §canvas-clip: screenshot clips to #viewer-canvas bounding rect (offset 82,146 in 1689×1325 page).
// §aerial-at-binding: capture aerial top-down in same call — scene still fully populated.
async function captureHeroAndAerial(label) {
  // Compute world bbox + set hero camera (NO controls.update) + get canvas rect for clip
  const camLogRaw = await evaluate(`
    (function() {
      var v = window.__viewer;
      if (!v) return JSON.stringify({err:'no-viewer'});
      var cam = v.camera;
      var scene = v.scene || (v.getScene && v.getScene());
      if (!scene) return JSON.stringify({err:'no-scene'});

      // Compute world-space bbox from USER geometry only (userData.kind || userData.creator).
      // Excludes system objects: GridHelper, AxesHelper, lights, and unnamed meshes — some of
      // which span 60km+ and would blow out the fit-to-bbox camera to 200km distance.
      var bmin = [Infinity,Infinity,Infinity], bmax = [-Infinity,-Infinity,-Infinity];
      scene.traverse(function(obj) {
        if (!obj.isMesh || !obj.geometry) return;
        if (!obj.userData || (!obj.userData.kind && !obj.userData.creator)) return;
        obj.geometry.computeBoundingBox();
        var bb = obj.geometry.boundingBox;
        if (!bb) return;
        obj.updateMatrixWorld(true);
        var mat = obj.matrixWorld;
        var lmin = bb.min, lmax = bb.max;
        var xs = [lmin.x, lmax.x], ys = [lmin.y, lmax.y], zs = [lmin.z, lmax.z];
        for (var xi=0;xi<2;xi++) for (var yi=0;yi<2;yi++) for (var zi=0;zi<2;zi++) {
          var c = lmin.clone().set(xs[xi],ys[yi],zs[zi]).applyMatrix4(mat);
          if(c.x<bmin[0])bmin[0]=c.x; if(c.x>bmax[0])bmax[0]=c.x;
          if(c.y<bmin[1])bmin[1]=c.y; if(c.y>bmax[1])bmax[1]=c.y;
          if(c.z<bmin[2])bmin[2]=c.z; if(c.z>bmax[2])bmax[2]=c.z;
        }
      });

      // Camera target = scene center; dist = span * 1.8 (frames with ~30° half-angle margin)
      var cx=0, cy=0, cz=2, dist=18;
      var hasBbox = isFinite(bmin[0]);
      if (hasBbox) {
        cx=(bmin[0]+bmax[0])/2; cy=(bmin[1]+bmax[1])/2; cz=(bmin[2]+bmax[2])/2;
        var span = Math.max(bmax[0]-bmin[0], bmax[1]-bmin[1], bmax[2]-bmin[2], 2);
        dist = span * 1.8;
      }

      var az = 225*Math.PI/180, el = 30*Math.PI/180;
      cam.position.set(cx+dist*Math.cos(az)*Math.cos(el), cy+dist*Math.sin(az)*Math.cos(el), cz+dist*Math.sin(el));
      cam.up.set(0,0,1);
      cam.lookAt(cx,cy,cz);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      // NO pp.controls.update() — renders directly to preserve camera
      if (v.renderer) { v.renderer.render(scene, cam); }

      // Canvas rect for clipped screenshot
      var canvas = document.getElementById('viewer-canvas');
      var rect = canvas ? canvas.getBoundingClientRect() : null;

      return JSON.stringify({
        ok: true, hasBbox: hasBbox,
        bbox: hasBbox ? {
          min:[Math.round(bmin[0]*100)/100,Math.round(bmin[1]*100)/100,Math.round(bmin[2]*100)/100],
          max:[Math.round(bmax[0]*100)/100,Math.round(bmax[1]*100)/100,Math.round(bmax[2]*100)/100]
        } : null,
        center:[Math.round(cx*100)/100,Math.round(cy*100)/100,Math.round(cz*100)/100],
        dist: Math.round(dist*100)/100,
        canvasRect: rect ? {x:Math.round(rect.left),y:Math.round(rect.top),w:Math.round(rect.width),h:Math.round(rect.height)} : null
      });
    })()
  `);

  let camData = { ok: false };
  try { camData = JSON.parse(String(camLogRaw)); } catch {}
  const canvasRect = camData.canvasRect;
  const camSummary = camData.ok
    ? `bbox=${JSON.stringify(camData.bbox)} center=[${camData.center}] dist=${camData.dist}`
    : String(camLogRaw);

  // Clip screenshot to canvas element rect (bypass full-page capture)
  const heroShotParams = { format: "png" };
  if (canvasRect && canvasRect.w > 0 && canvasRect.h > 0) {
    heroShotParams.clip = { x: canvasRect.x, y: canvasRect.y, width: canvasRect.w, height: canvasRect.h, scale: 1 };
  }
  const heroResult = await send("Page.captureScreenshot", heroShotParams);
  const heroBuf = heroResult.data ? Buffer.from(heroResult.data, "base64") : null;
  if (heroBuf) {
    const earlyTs = Date.now();
    const earlyHeroPath = `${DIAG_DIR}/house-hero-${earlyTs}.png`;
    writeFileSync(earlyHeroPath, heroBuf);
    const sha = createHash("sha256").update(heroBuf).digest("hex").slice(0, 12);
    process.stdout.write(`[house] ${label} hero saved: ${earlyHeroPath} sha256[:12]=${sha} cam=${camSummary}\n`);
    earlyHeroBuf = heroBuf;
    earlyHeroSha256Short = sha;
    earlyHeroPathSaved = earlyHeroPath;
  } else {
    process.stdout.write(`[house] ${label} hero EMPTY\n`);
  }

  // Side/gable-on elevation: camera pointing straight west→east at gable end.
  // Pitched roof shows unmistakable triangle above wall; flat roof shows rectangle.
  // Captured BEFORE aerial: SdClearScene (second-turn auto-clear) fires ~1s after gate;
  // side capture at ~0.3s (before aerial) beats the race window.
  // Bbox baked from hero camData — no scene traversal needed (immune to clear race).
  // sideDist=30m (closer than 80m to stay within app camera far-plane limits).
  // canvas.toDataURL() inline: captures immediately after render(), before RAF re-renders.
  const sbbMin = (camData.ok && camData.bbox) ? camData.bbox.min : [-5, -4, -0.2];
  const sbbMax = (camData.ok && camData.bbox) ? camData.bbox.max : [5, 4, 8.6];
  const sbCx = (sbbMin[0] + sbbMax[0]) / 2;
  const sbCy = (sbbMin[1] + sbbMax[1]) / 2;
  const sbCz = (sbbMin[2] + sbbMax[2]) / 2;
  const sideCapRaw = await evaluate(`
    (function() {
      var v = window.__viewer;
      if (!v) return JSON.stringify({err:'no-viewer'});
      var cam = v.camera;
      var scene = v.scene || (v.getScene && v.getScene());
      if (!scene) return JSON.stringify({err:'no-scene'});
      // Pre-computed bbox — immune to second-turn SdClearScene race
      var bmin = [${sbbMin[0]}, ${sbbMin[1]}, ${sbbMin[2]}];
      var bmax = [${sbbMax[0]}, ${sbbMax[1]}, ${sbbMax[2]}];
      var cy = ${sbCy.toFixed(4)}, cz = ${sbCz.toFixed(4)};
      var sy = bmax[1]-bmin[1], sz = bmax[2]-bmin[2];
      var sideDist = 30;
      cam.fov = 30;
      cam.position.set(bmin[0] - sideDist, cy, cz);
      cam.up.set(0,0,1);
      cam.lookAt(${sbCx.toFixed(4)}, cy, cz);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      if(v.renderer){ v.renderer.render(scene,cam); }
      var children = scene.children ? scene.children.length : -1;
      var log = 'ok|side-west|fov=30|dist='+sideDist+'|cy='+Math.round(cy*10)/10+'|cz='+Math.round(cz*10)/10+'|near='+Math.round(cam.near*100)/100+'|far='+cam.far+'|children='+children;
      // Inline canvas capture — synchronous, before RAF can re-render cleared scene
      var png = null;
      try { png = v.renderer.domElement.toDataURL('image/png'); } catch(e) {}
      return JSON.stringify({log:log, png:png});
    })()
  `);

  let sideLogStr = 'eval-failed';
  let sideBuf = null;
  try {
    const sideCapData = JSON.parse(String(sideCapRaw));
    if (sideCapData.err) {
      sideLogStr = 'err:' + sideCapData.err;
    } else {
      sideLogStr = sideCapData.log;
      if (sideCapData.png && sideCapData.png.length > 200) {
        const b64 = sideCapData.png.replace(/^data:image\/png;base64,/, '');
        const decoded = Buffer.from(b64, 'base64');
        // Only use inline capture if it's non-trivial (> 10KB; blank PNG = ~1KB)
        if (decoded.length > 10000) { sideBuf = decoded; }
      }
    }
  } catch(e) { sideLogStr = 'parse-err'; }

  // Fallback: Page.captureScreenshot if inline capture didn't work
  // (happens when preserveDrawingBuffer=false on the WebGL renderer)
  if (!sideBuf) {
    const sideShotParams = { format: "png" };
    if (canvasRect && canvasRect.w > 0 && canvasRect.h > 0) {
      sideShotParams.clip = { x: canvasRect.x, y: canvasRect.y, width: canvasRect.w, height: canvasRect.h, scale: 1 };
    }
    const sideFbResult = await send("Page.captureScreenshot", sideShotParams);
    if (sideFbResult.data) sideBuf = Buffer.from(sideFbResult.data, "base64");
  }

  if (sideBuf) {
    const sideTs = Date.now();
    const sidePath = `${DIAG_DIR}/house-side-${sideTs}.png`;
    writeFileSync(sidePath, sideBuf);
    const sideSha = createHash("sha256").update(sideBuf).digest("hex").slice(0, 12);
    process.stdout.write(`[house] ${label} side saved: ${sidePath} sha256[:12]=${sideSha} cam=${sideLogStr} bytes=${sideBuf.length}\n`);
    earlySideBuf = sideBuf;
    earlySideSha256Short = sideSha;
    earlySidePathSaved = sidePath;
  } else {
    process.stdout.write(`[house] ${label} side EMPTY cam=${sideLogStr}\n`);
  }

  // Front elevation: full south facade — void-cut vs flat-panel discriminator.
  // Near-orthographic (FOV=30°, standoff=16m): door + both Level-2 windows in one frame.
  // canvas.toDataURL (synchronous) — immune to SdClearScene RAF race.
  const closeupCapRaw = await evaluate(`
    (function() {
      var v = window.__viewer;
      if (!v) return JSON.stringify({err:'no-viewer'});
      var cam = v.camera;
      var scene = v.scene || (v.getScene && v.getScene());
      if (!scene) return JSON.stringify({err:'no-scene'});
      var bmin = [${sbbMin[0]}, ${sbbMin[1]}, ${sbbMin[2]}];
      var bmax = [${sbbMax[0]}, ${sbbMax[1]}, ${sbbMax[2]}];
      // Center X, mid-height of Level-1+Level-2 walls (0–5.8m), 16m standoff south of bbox
      var cx = (bmin[0]+bmax[0])/2;
      var wallMidZ = 2.9;
      var standoff = 16;
      cam.fov = 30;
      cam.position.set(cx, bmin[1] - standoff, wallMidZ);
      cam.up.set(0,0,1);
      cam.lookAt(cx, bmin[1], wallMidZ);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      if(v.renderer){ v.renderer.render(scene,cam); }
      var log = 'front-elev|fov=30|standoff='+standoff+'|cx='+Math.round(cx*10)/10+'|cz='+wallMidZ;
      var png = null;
      try { png = v.renderer.domElement.toDataURL('image/png'); } catch(e) {}
      return JSON.stringify({log:log, png:png});
    })()
  `);

  let closeupLogStr = 'eval-failed';
  let closeupBuf = null;
  try {
    const closeupCapData = JSON.parse(String(closeupCapRaw));
    if (closeupCapData.err) {
      closeupLogStr = 'err:' + closeupCapData.err;
    } else {
      closeupLogStr = closeupCapData.log;
      if (closeupCapData.png && closeupCapData.png.length > 200) {
        const b64 = closeupCapData.png.replace(/^data:image\/png;base64,/, '');
        const decoded = Buffer.from(b64, 'base64');
        if (decoded.length > 10000) { closeupBuf = decoded; }
      }
    }
  } catch(e) { closeupLogStr = 'parse-err'; }

  if (closeupBuf) {
    const closeupTs = Date.now();
    const closeupPath = `${DIAG_DIR}/house-front-${closeupTs}.png`;
    writeFileSync(closeupPath, closeupBuf);
    const closeupSha = createHash("sha256").update(closeupBuf).digest("hex").slice(0, 12);
    process.stdout.write(`[house] ${label} front saved: ${closeupPath} sha256[:12]=${closeupSha} cam=${closeupLogStr} bytes=${closeupBuf.length}\n`);
    earlyCloseupBuf = closeupBuf;
    earlyCloseupSha256Short = closeupSha;
    earlyCloseupPathSaved = closeupPath;
  } else {
    process.stdout.write(`[house] ${label} front EMPTY cam=${closeupLogStr}\n`);
  }

  // Aerial: top-down, fit bbox horizontally, NO controls.update
  const aerialLogRaw = await evaluate(`
    (function() {
      var v = window.__viewer;
      if (!v) return 'no-viewer';
      var cam = v.camera;
      var scene = v.scene || (v.getScene && v.getScene());
      if (!scene) return 'no-scene';
      var bmin=[Infinity,Infinity,Infinity], bmax=[-Infinity,-Infinity,-Infinity];
      scene.traverse(function(obj) {
        if (!obj.isMesh || !obj.geometry) return;
        if (!obj.userData || (!obj.userData.kind && !obj.userData.creator)) return;
        obj.geometry.computeBoundingBox();
        var bb = obj.geometry.boundingBox;
        if (!bb) return;
        obj.updateMatrixWorld(true);
        var mat = obj.matrixWorld;
        var lmin=bb.min, lmax=bb.max;
        var xs=[lmin.x,lmax.x], ys=[lmin.y,lmax.y], zs=[lmin.z,lmax.z];
        for(var xi=0;xi<2;xi++) for(var yi=0;yi<2;yi++) for(var zi=0;zi<2;zi++){
          var c=lmin.clone().set(xs[xi],ys[yi],zs[zi]).applyMatrix4(mat);
          if(c.x<bmin[0])bmin[0]=c.x; if(c.x>bmax[0])bmax[0]=c.x;
          if(c.y<bmin[1])bmin[1]=c.y; if(c.y>bmax[1])bmax[1]=c.y;
          if(c.z<bmin[2])bmin[2]=c.z; if(c.z>bmax[2])bmax[2]=c.z;
        }
      });
      var cx=0, cy=0, maxZ=10, h=20;
      if(isFinite(bmin[0])){
        cx=(bmin[0]+bmax[0])/2; cy=(bmin[1]+bmax[1])/2; maxZ=bmax[2];
        var span=Math.max(bmax[0]-bmin[0],bmax[1]-bmin[1],2);
        h=span*1.5;
      }
      cam.fov = 60; cam.updateProjectionMatrix(); // reset from side capture's 30° FOV
      cam.position.set(cx, cy, maxZ+h);
      cam.up.set(0,1,0);
      cam.lookAt(cx,cy,maxZ);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      // NO pp.controls.update()
      if(v.renderer){ v.renderer.render(scene,cam); }
      return 'ok|top-down|cx='+Math.round(cx*10)/10+'|cy='+Math.round(cy*10)/10+'|h='+Math.round(h*10)/10;
    })()
  `);

  const aerialShotParams = { format: "png" };
  if (canvasRect && canvasRect.w > 0 && canvasRect.h > 0) {
    aerialShotParams.clip = { x: canvasRect.x, y: canvasRect.y, width: canvasRect.w, height: canvasRect.h, scale: 1 };
  }
  const aerialResult = await send("Page.captureScreenshot", aerialShotParams);
  const aerialBuf = aerialResult.data ? Buffer.from(aerialResult.data, "base64") : null;
  if (aerialBuf) {
    const aerialTs = Date.now();
    const aerialPath = `${DIAG_DIR}/house-aerial-${aerialTs}.png`;
    writeFileSync(aerialPath, aerialBuf);
    const aerialSha = createHash("sha256").update(aerialBuf).digest("hex").slice(0, 12);
    process.stdout.write(`[house] ${label} aerial saved: ${aerialPath} sha256[:12]=${aerialSha} cam=${String(aerialLogRaw)}\n`);
    earlyAerialBuf = aerialBuf;
    earlyAerialSha256Short = aerialSha;
    earlyAerialPathSaved = aerialPath;
  } else {
    process.stdout.write(`[house] ${label} aerial EMPTY\n`);
  }
}

while (Date.now() - turnStart < TURN_TIMEOUT) {
  // §race: wake immediately when gate fires, otherwise poll every 5s for OOM/badge/success
  await Promise.race([delay(5_000), houseGatePromise]);

  // Gate check FIRST — houseGateFired is set by the .then() above when binding fires
  if (houseGateFired && !earlyStopped) {
    process.stdout.write(`\n[house] houseGeomGate binding fired — hero+aerial capture NOW\n`);
    bindingVoidInfo = (houseGatePayload && Array.isArray(houseGatePayload.voidInfo))
      ? houseGatePayload.voidInfo : [];
    // Inline scene diagnostic: capture wall group + window positions BEFORE screenshot
    // (scene is cleared after validate exits — must query here)
    const _diagRaw = await evaluate(`(function(){
      var v=window.__viewer;
      if(!v) return 'no-viewer';
      var s=v.scene||(v.getScene&&v.getScene());
      if(!s) return 'no-scene';
      var out=[];
      var seen=new Set();
      s.traverse(function(o){
        if(!o||!o.userData||seen.has(o.uuid)) return;
        seen.add(o.uuid);
        var c=o.userData.creator;
        if((c==='wall'||c==='SdWall')&&o.isGroup===true){
          var hist=o.userData.cutHistory||[];
          var dims=o.userData.originalWallDims||{};
          var wglvl=o.userData.levelId||'?';
          out.push('WG|lpos=('+o.position.x.toFixed(2)+','+o.position.y.toFixed(2)+','+o.position.z.toFixed(2)+')|uuid='+o.uuid.slice(0,8)+'|lvl='+wglvl+'|kids='+o.children.length+'|cuts='+hist.length+'|h='+((dims.h||0).toFixed(2))+'|zMin='+((dims.zMin||0).toFixed(2)));
        }
        if((c==='wall'||c==='SdWall')&&!o.isGroup){
          var lvl=o.userData.levelId||'?';
          out.push('WM|lpos=('+o.position.x.toFixed(2)+','+o.position.y.toFixed(2)+','+o.position.z.toFixed(2)+')|lvl='+lvl+'|uuid='+o.uuid.slice(0,8)+'|vis='+o.visible);
        }
        if(c==='window'){
          var wx=o.matrixWorld.elements[12], wy=o.matrixWorld.elements[13], wz=o.matrixWorld.elements[14];
          var side=-1;
          o.traverse(function(m){if(m.isMesh&&m.material&&side===-1){var mat=Array.isArray(m.material)?m.material[0]:m.material;if(mat)side=mat.side;}});
          var hostId=o.userData.hostExpressID||'none';
          out.push('WIN|lpos=('+o.position.x.toFixed(2)+','+o.position.y.toFixed(2)+','+o.position.z.toFixed(2)+')|wpos=('+wx.toFixed(2)+','+wy.toFixed(2)+','+wz.toFixed(2)+')|vis='+o.visible+'|side='+side+'|host='+hostId.slice(0,8));
        }
        if(c==='door'){
          var dx=o.matrixWorld.elements[12], dy=o.matrixWorld.elements[13], dz=o.matrixWorld.elements[14];
          out.push('DOOR|lpos=('+o.position.x.toFixed(2)+','+o.position.y.toFixed(2)+','+o.position.z.toFixed(2)+')|wpos=('+dx.toFixed(2)+','+dy.toFixed(2)+','+dz.toFixed(2)+')|vis='+o.visible);
        }
        // Catch any Group with originalWallDims (void-cut wall) regardless of creator tag
        if(o.isGroup===true&&o.userData.originalWallDims&&!(c==='wall'||c==='SdWall')){
          var hist2=o.userData.cutHistory||[];
          out.push('WG-ALIEN|creator='+c+'|lpos=('+o.position.x.toFixed(2)+','+o.position.y.toFixed(2)+','+o.position.z.toFixed(2)+')|cuts='+hist2.length);
        }
      });
      out.push('SCENE_KIDS='+s.children.length);
      return out.join('\\n');
    })()`);
    process.stdout.write(`\n[house] SCENE-DIAG:\n${_diagRaw}\n`);

    // Dump scene spy: wall/window/door add+remove events to track host uuid provenance
    const _spyRaw = await evaluate(`(function(){
      var spy=window.__sceneSpy||[];
      return spy
        .filter(function(e){return e.creator==='wall'||e.creator==='SdWall'||e.creator==='window'||e.creator==='door';})
        .map(function(e){return e.op+'|uuid='+e.uuid.slice(0,8)+'|cr='+e.creator+'|lvl='+e.levelId+'|grp='+e.isGroup+'|xid='+e.expressID.slice(0,8);})
        .join('\\n');
    })()`);
    process.stdout.write(`\n[house] SCENE-SPY (wall/window/door adds+removes):\n${_spyRaw}\n`);

    // Re-render with correct framing + capture hero + aerial (scene still fully populated)
    await captureHeroAndAerial("gate-binding");
    earlyStopped = true;
    outcome = "early-stop-19geom";
    break;
  }

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
  const geomLen = await evaluate(`(window.__dispatchLedger ?? []).filter(e => e.sceneChildrenDelta > 0).length`);

  process.stdout.write(`\r[house] ${elapsed}s btn=${txt}(${dis}) OOM=${oomCount} VRAM=${vNow}MB ledger=${ledgerLen} geom=${geomLen}`);

  if (String(badge).includes("ERROR")) { outcome = "ghost_badge_error"; break; }

  // Fallback poll-based gate — catches case where binding wasn't installed before dispatches began
  if (!earlyStopped && Number(geomLen) >= EARLY_STOP_GEOM) {
    process.stdout.write(`\n[house] fallback-poll early-stop: geom=${geomLen} >= ${EARLY_STOP_GEOM}\n`);
    await captureHeroAndAerial("fallback-poll");
    earlyStopped = true;
    outcome = "early-stop-19geom";
    break;
  }

  if (!Boolean(dis) && String(txt).includes("SEND")) {
    const aiMsgsAfter = await evaluate(`document.querySelectorAll('.chat-msg').length`);
    if (Number(aiMsgsAfter) > Number(aiMsgsBefore)) { outcome = "success"; break; }
  }
}
process.stdout.write("\n");

const elapsed = Math.round((Date.now() - turnStart) / 1000);
const vramEnd = sampleVram();
console.log(`[house] done | outcome=${outcome} | elapsed=${elapsed}s | OOM=${oomCount} | VRAM ${vramStart}→${vramPeak}(peak)→${vramEnd}MB`);

// ── Phase 5: Read dispatch ledger + merge voidCut ────────────────────────────
const ledgerRaw = await evaluate(`(function(){ return JSON.stringify(window.__dispatchLedger ?? []); })()`);
let ledger = [];
try { ledger = JSON.parse(String(ledgerRaw)); } catch {}

// §voidCut-merge: binding payload collected voidInfo from scene at gate time.
// Match in order: first door entry ← first bindingVoidInfo door, etc.
{
  let doorIdx = 0, winIdx = 0;
  const doorVoids = bindingVoidInfo.filter(v => v.creator === "door");
  const winVoids  = bindingVoidInfo.filter(v => v.creator === "window" || v.creator === "opening");
  for (const e of ledger) {
    if (e.verb === "SdDoor") {
      e.voidCut = doorIdx < doorVoids.length ? doorVoids[doorIdx++].voidCut : null;
    } else if (e.verb === "SdWindow" || e.verb === "SdOpening") {
      e.voidCut = winIdx < winVoids.length ? winVoids[winIdx++].voidCut : null;
    }
  }
}

const successEntries  = ledger.filter(e => e.status === "success");
const geomEntries     = successEntries.filter(e => e.sceneChildrenDelta > 0);
const hasGeometry     = geomEntries.length > 0;
const sceneChildren   = await evaluate(`(window.__viewer?.scene?.children?.length ?? -1)`);

const ledgerSummary = ledger.map(e => {
  const voidStr = (e.voidCut !== undefined && e.voidCut !== null) ? `,voidCut=${e.voidCut}` : "";
  return `${e.verb}(${e.status},Δ${e.sceneChildrenDelta > 0 ? "+" + e.sceneChildrenDelta : e.sceneChildrenDelta}${voidStr})`;
}).join(", ") || "(none)";

console.log(`[house] ledger: ${ledger.length} total | ${successEntries.length} success | ${geomEntries.length} geometry`);
console.log(`[house] scene children: ${sceneChildren}`);
console.log(`[house] dispatches: ${ledgerSummary}`);

// ── Phase 6: Screenshots — use binding-time captures if available ─────────────
// §binding-time-capture: hero+aerial taken at gate moment (scene populated).
// Success-path fallback: model finished cleanly, capture now with same framing.
let heroBuf, heroPath, heroSha256Short;
const ts = Date.now();
if (earlyHeroBuf) {
  heroBuf = earlyHeroBuf;
  heroPath = earlyHeroPathSaved;
  heroSha256Short = earlyHeroSha256Short;
  console.log(`[house] camera: fit-to-bbox az=225° elev=30° (captured at gate)`);
} else {
  // success-path: model finished cleanly; capture with correct framing
  await captureHeroAndAerial("success-path");
  heroBuf = earlyHeroBuf;
  heroPath = earlyHeroPathSaved;
  heroSha256Short = earlyHeroSha256Short;
  console.log(`[house] camera: fit-to-bbox az=225° elev=30° (captured success-path)`);
}
console.log(`[house] hero saved: ${heroPath}`);
console.log(`[house] hero sha256[:12]: ${heroSha256Short} | bytes: ${heroBuf?.length ?? 0}`);

// Aerial — use binding-time capture (populated scene) or fallback to now
let aerialBuf, aerialPath, aerialSha256Short;
if (earlyAerialBuf) {
  aerialBuf = earlyAerialBuf;
  aerialPath = earlyAerialPathSaved;
  aerialSha256Short = earlyAerialSha256Short;
} else {
  // Fallback: scene may be empty now, but try anyway
  const aerialResult = await send("Page.captureScreenshot", { format: "png" });
  aerialBuf = aerialResult.data ? Buffer.from(aerialResult.data, "base64") : Buffer.alloc(0);
  aerialPath = `${DIAG_DIR}/house-aerial-${ts}.png`;
  if (aerialBuf.length) writeFileSync(aerialPath, aerialBuf);
  aerialSha256Short = aerialBuf.length
    ? createHash("sha256").update(aerialBuf).digest("hex").slice(0, 12) : "empty";
}
console.log(`[house] aerial saved: ${aerialPath}`);
console.log(`[house] aerial sha256[:12]: ${aerialSha256Short} | bytes: ${aerialBuf.length}`);

// Side elevation — use binding-time capture or fallback
let sideBuf, sidePath, sideSha256Short;
if (earlySideBuf) {
  sideBuf = earlySideBuf;
  sidePath = earlySidePathSaved;
  sideSha256Short = earlySideSha256Short;
} else {
  const sideResult = await send("Page.captureScreenshot", { format: "png" });
  sideBuf = sideResult.data ? Buffer.from(sideResult.data, "base64") : Buffer.alloc(0);
  sidePath = `${DIAG_DIR}/house-side-${ts}.png`;
  if (sideBuf.length) writeFileSync(sidePath, sideBuf);
  sideSha256Short = sideBuf.length
    ? createHash("sha256").update(sideBuf).digest("hex").slice(0, 12) : "empty";
}
console.log(`[house] side saved: ${sidePath}`);
console.log(`[house] side sha256[:12]: ${sideSha256Short} | bytes: ${sideBuf?.length ?? 0}`);

// Close-up — use binding-time capture or fallback
let closeupBuf, closeupPath, closeupSha256Short;
if (earlyCloseupBuf) {
  closeupBuf = earlyCloseupBuf;
  closeupPath = earlyCloseupPathSaved;
  closeupSha256Short = earlyCloseupSha256Short;
} else {
  const closeupResult = await send("Page.captureScreenshot", { format: "png" });
  closeupBuf = closeupResult.data ? Buffer.from(closeupResult.data, "base64") : Buffer.alloc(0);
  closeupPath = `${DIAG_DIR}/house-front-${ts}.png`;
  if (closeupBuf.length) writeFileSync(closeupPath, closeupBuf);
  closeupSha256Short = closeupBuf.length
    ? createHash("sha256").update(closeupBuf).digest("hex").slice(0, 12) : "empty";
}
console.log(`[house] front saved: ${closeupPath}`);
console.log(`[house] front sha256[:12]: ${closeupSha256Short} | bytes: ${closeupBuf?.length ?? 0}`);

// ── Phase 7: Summary + artifact ───────────────────────────────────────────────
const gatePass = oomCount === 0 && (outcome === "success" || outcome === "early-stop-19geom") && hasGeometry;

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
console.log(`[house] Side:          ${sidePath} sha256[:12]=${sideSha256Short}`);
console.log(`[house] Front:         ${closeupPath} sha256[:12]=${closeupSha256Short}`);
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
    hero:    { path: heroPath,    sha256: heroSha256Short,    bytes: heroBuf?.length ?? 0 },
    aerial:  { path: aerialPath,  sha256: aerialSha256Short,  bytes: aerialBuf?.length ?? 0 },
    side:    { path: sidePath,    sha256: sideSha256Short,    bytes: sideBuf?.length ?? 0 },
    front:   { path: closeupPath, sha256: closeupSha256Short, bytes: closeupBuf?.length ?? 0 },
  },
  gate_pass: gatePass,
};
const artifactPath = `${DIAG_DIR}/house-receipt-${SHA}-${ts}.json`;
writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
console.log(`\n[house] Receipt: ${artifactPath}`);

ws.close();
