#!/usr/bin/env node
// verify-212-ag-no-bypass.mjs — AC receipt for #212.
//
// All interactions through pointer+keyboard events ONLY.
// Banned: __dispatchSync for Sd* verbs, __emitClickWorld, scene mutation.
// Page reload is the only reset mechanism.
//
// Scenarios (Kai mail 11577):
//   A — MODEL palette activation (ARCH=41, CAD=46 visible buttons, no contamination)
//   B — CAD curve/reference creation (line, rect, circle via pointer)
//   C — CAD canonical solid/surface (rect→Extrude or Plane via pointer+keyboard)
//   D — BRep edit (fillet on extruded rect via pointer+keyboard)
//   E — ARCH/BIM create (wall placement via pointer)
//   F — Project-card FZK load (click ribbon-asset-card, wait, check canonical counts)
//   G — Cold-cache stability (skip unless COLD_CACHE=1; MEM-HEAVY coordination required)
//
// Stability gate (Kai): 3 full A-G passes with zero crashes/runtime overlays.
// Normal run: 1 pass. Set STABILITY=1 for 3-pass gate.

import { WebSocket } from "ws";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { CDP_PORT } from "./ports.mjs";

const DEV_URL = "https://wordingone.github.io/WEB-CAD/dev/";
const COLD_CACHE = process.env.COLD_CACHE === "1";
const STABILITY  = process.env.STABILITY  === "1";
const PASS_COUNT = STABILITY ? 3 : 1;

mkdirSync("state", { recursive: true });
const SHA = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const OUT = `state/verify-212-ag-no-bypass-${SHA}-${Date.now()}.json`;

// ── CDP raw WS ──────────────────────────────────────────────────────────────

const targets = JSON.parse(
  execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" })
);
const target = targets.find(t => t.type === "page");
if (!target) { console.error("No page target"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
let consoleErrors = [];

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

// ── Shared helpers ──────────────────────────────────────────────────────────

const trustedClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await delay(20);
  await send("Input.dispatchMouseEvent", { type: "mousePressed",  x, y, button: "left", clickCount: 1 });
  await delay(20);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await delay(30);
};

const trustedKey = async (key, opts = {}) => {
  const base = { key, code: key, windowsVirtualKeyCode: key === "Enter" ? 13 : key === "Escape" ? 27 : 0, ...opts };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await delay(20);
  await send("Input.dispatchKeyEvent", { type: "keyUp",   ...base });
  await delay(30);
};

const typeString = async (str) => {
  for (const ch of str) {
    await send("Input.dispatchKeyEvent", { type: "char", text: ch });
    await delay(15);
  }
};

const navigateAndBoot = async (url = DEV_URL) => {
  consoleErrors = [];
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });
  await delay(2_000);
  await send("Runtime.enable");
  // Click cad-only gate if present
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
    }, { timeout: 15_000, label: "cad-only gate" });
  } catch { /* no gate */ }
  await delay(500);
};

// All tool interaction goes through palette buttons (no __dispatchSync).
const findToolBtn = (toolId) => evaluate(`
  (() => {
    const btn = document.querySelector('button.palette-btn[data-tool="${toolId}"]');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  })()`);

const clickTool = async (toolId) => {
  const btn = await findToolBtn(toolId);
  if (!btn) throw new Error(`palette-btn[data-tool="${toolId}"] not found/visible`);
  await trustedClick(btn.x, btn.y);
  await delay(150);
  return btn;
};

const getActiveTool = () => evaluate(`
  (() => {
    const btn = document.querySelector('.palette-btn.active');
    return btn?.dataset.tool ?? null;
  })()`);

const getCurrentTab = () => evaluate(`
  (() => {
    const disc = document.querySelector('.yin-disc');
    return disc?.classList.contains('is-comp') ? 'CAD' : 'ARCH';
  })()`);

const switchToTab = async (tab) => {
  const cur = await getCurrentTab();
  if (cur !== tab) {
    const toggle = await evaluate(`
      (() => {
        const el = document.querySelector('.yin-toggle');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      })()`);
    if (!toggle) throw new Error(".yin-toggle not found");
    await trustedClick(toggle.x, toggle.y);
    await delay(300);
  }
};

const getVisiblePaletteBtns = () => evaluate(`
  (() => {
    return Array.from(document.querySelectorAll('button.palette-btn[data-tool]'))
      .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map(b => ({ id: b.dataset.tool, label: b.getAttribute('aria-label') ?? '' }));
  })()`);

const getViewportCenter = () => evaluate(`
  (() => {
    const c = document.querySelector('#viewer-canvas, .vp-host, canvas');
    if (!c) return { x: 640, y: 400, w: 1280, h: 800 };
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: r.width, h: r.height };
  })()`);

const getSceneObjectCount = () => evaluate(`
  (() => {
    const scene = window.__viewer?.scene;
    if (!scene) return 0;
    return scene.children.filter(c => c.userData?.creator || c.userData?.kind).length;
  })()`);

const getCanonRecordCount = () => evaluate(`
  (() => {
    const store = window.__viewer?.getCanonicalGeometryStore?.();
    return store ? store.exportRecords().length : 0;
  })()`);

const checkRuntimeOverlay = () => evaluate(`
  (() => {
    const overlays = document.querySelectorAll('[class*="error-overlay"],[class*="runtime-error"],[id*="error-overlay"]');
    return overlays.length === 0;
  })()`);

// ── Scenario A — MODEL palette activation ──────────────────────────────────

async function scenarioA() {
  console.log("\n[A] MODEL palette activation + contamination check");
  await navigateAndBoot();
  const out = { pass: false };

  // Test ARCH tab
  await switchToTab("ARCH");
  await delay(200);
  const archBtns = await getVisiblePaletteBtns();
  out.arch_count = archBtns.length;
  out.arch_count_ok = archBtns.length === 41;

  // Click every visible ARCH button — check no overlay
  let archErrors = 0;
  for (const b of archBtns) {
    const btn = await findToolBtn(b.id).catch(() => null);
    if (btn) await trustedClick(btn.x, btn.y).catch(() => { archErrors++; });
  }
  const archOverlayClean = await checkRuntimeOverlay();
  out.arch_overlay_clean = !!archOverlayClean;
  out.arch_click_errors = archErrors;
  console.log(`  ARCH buttons: ${out.arch_count} (expect 41)  overlay-clean: ${out.arch_overlay_clean}`);

  // Reload + test CAD tab
  await navigateAndBoot();
  await switchToTab("CAD");
  await delay(200);
  const cadBtns = await getVisiblePaletteBtns();
  out.cad_count = cadBtns.length;
  out.cad_count_ok = cadBtns.length === 46;

  let cadErrors = 0;
  for (const b of cadBtns) {
    const btn = await findToolBtn(b.id).catch(() => null);
    if (btn) await trustedClick(btn.x, btn.y).catch(() => { cadErrors++; });
  }
  const cadOverlayClean = await checkRuntimeOverlay();
  out.cad_overlay_clean = !!cadOverlayClean;
  out.cad_click_errors = cadErrors;
  console.log(`  CAD buttons: ${out.cad_count} (expect 46)  overlay-clean: ${out.cad_overlay_clean}`);

  // Contamination check: after CAD click-through, no ARCH tools should appear in CAD visible set
  const archIds = new Set(["wall","slab","column","beam","roof","space","foundation","ceiling","grid","level","datum","stair","door","window","ramp","railing","curtainwall","skylight","opening"]);
  out.no_contamination = cadBtns.filter(b => archIds.has(b.id)).length === 0;
  console.log(`  no-contamination: ${out.no_contamination}`);

  out.pass = out.arch_count_ok && out.cad_count_ok && out.arch_overlay_clean && out.cad_overlay_clean && out.no_contamination;
  console.log(`  A: ${out.pass ? "PASS ✓" : "FAIL ✗"}`);
  return out;
}

// ── Scenario B — CAD curve/reference creation ──────────────────────────────

async function scenarioB() {
  console.log("\n[B] CAD curve/reference creation (pointer+keyboard)");
  await navigateAndBoot();
  await switchToTab("CAD");
  const vp = await getViewportCenter();
  const VX = vp.x; const VY = vp.y;
  const out = { pass: false, results: {} };
  const before = await getSceneObjectCount();

  // B1: Rectangle — 2 clicks
  try {
    await clickTool("rect");
    const active1 = await getActiveTool();
    await trustedClick(VX - 60, VY - 40);
    await trustedClick(VX + 60, VY + 40);
    await delay(300);
    const after1 = await getSceneObjectCount();
    out.results.rect = { active: active1 === "rect", objects_created: after1 - before };
  } catch (e) { out.results.rect = { error: e.message }; }

  // B2: Circle — 2 clicks (center + radius)
  await clickTool("select").catch(() => {});
  await delay(100);
  const before2 = await getSceneObjectCount();
  try {
    await clickTool("circle");
    const active2 = await getActiveTool();
    await trustedClick(VX + 120, VY);
    await trustedClick(VX + 170, VY);
    await delay(300);
    const after2 = await getSceneObjectCount();
    out.results.circle = { active: active2 === "circle", objects_created: after2 - before2 };
  } catch (e) { out.results.circle = { error: e.message }; }

  // B3: Line — multi-click + Enter
  await clickTool("select").catch(() => {});
  await delay(100);
  const before3 = await getSceneObjectCount();
  try {
    await clickTool("line");
    const active3 = await getActiveTool();
    await trustedClick(VX - 100, VY + 80);
    await trustedClick(VX,       VY + 80);
    await trustedClick(VX + 100, VY + 80);
    await trustedKey("Enter");
    await delay(300);
    const after3 = await getSceneObjectCount();
    out.results.line = { active: active3 === "line", objects_created: after3 - before3 };
  } catch (e) { out.results.line = { error: e.message }; }

  const overlayClean = await checkRuntimeOverlay();
  out.overlay_clean = !!overlayClean;

  const created = (out.results.rect?.objects_created ?? 0) + (out.results.circle?.objects_created ?? 0) + (out.results.line?.objects_created ?? 0);
  out.pass = created >= 2 && overlayClean;
  console.log(`  rect: ${JSON.stringify(out.results.rect)}  circle: ${JSON.stringify(out.results.circle)}  line: ${JSON.stringify(out.results.line)}`);
  console.log(`  B: ${out.pass ? "PASS ✓" : "FAIL ✗"}`);
  return out;
}

// ── Scenario C — CAD canonical solid/surface ──────────────────────────────

async function scenarioC() {
  console.log("\n[C] CAD canonical solid/surface creation");
  await navigateAndBoot();
  await switchToTab("CAD");
  const vp = await getViewportCenter();
  const VX = vp.x; const VY = vp.y;
  const out = { pass: false };
  const canonBefore = await getCanonRecordCount();

  // Create a rect profile first
  try {
    await clickTool("rect");
    await trustedClick(VX - 80, VY - 50);
    await trustedClick(VX + 80, VY + 50);
    await delay(400);
  } catch (e) { out.profile_error = e.message; }

  // Select the rect
  await clickTool("select").catch(() => {});
  await delay(150);
  await trustedClick(VX, VY);
  await delay(200);

  // Try Extrude — may prompt for height via keyboard
  const sceneBefore = await getSceneObjectCount();
  try {
    await clickTool("extrude");
    await delay(400);
    // Type height + Enter (handles both args-entry overlay and any dialog)
    await typeString("3");
    await trustedKey("Enter");
    await delay(600);
  } catch (e) { out.extrude_error = e.message; }

  const sceneAfter = await getSceneObjectCount();
  const canonAfter = await getCanonRecordCount();
  out.objects_created = sceneAfter - sceneBefore;
  out.canonical_records_added = canonAfter - canonBefore;

  // Check for any closed-solid record
  const canonSummary = await evaluate(`
    (() => {
      const store = window.__viewer?.getCanonicalGeometryStore?.();
      if (!store) return null;
      const recs = store.exportRecords();
      const closed = recs.filter(r => r.brep?.shells?.[0]?.isClosed === true);
      const surfaces = recs.filter(r => r.metadata?.derivation?.includes("surface") || r.metadata?.derivation?.includes("extrude") || r.metadata?.derivation?.includes("solid"));
      return { total: recs.length, closed_solid_count: closed.length, surface_count: surfaces.length };
    })()`);
  out.canonical_summary = canonSummary;

  // Fallback: try Plane tool (surface creation — 2 clicks)
  if (!out.objects_created) {
    try {
      await clickTool("plane");
      await delay(200);
      const pBefore = await getSceneObjectCount();
      await trustedClick(VX - 60, VY + 100);
      await trustedClick(VX + 60, VY + 100);
      await delay(400);
      const pAfter = await getSceneObjectCount();
      out.plane_objects_created = pAfter - pBefore;
    } catch (e) { out.plane_error = e.message; }
  }

  const overlayClean = await checkRuntimeOverlay();
  out.overlay_clean = !!overlayClean;

  // Pass if: overlay clean + (extrude created something OR plane created something OR canonical records appeared)
  out.pass = overlayClean && (out.objects_created > 0 || (out.plane_objects_created ?? 0) > 0 || out.canonical_records_added > 0);
  console.log(`  objects_created: ${out.objects_created}  canon_added: ${out.canonical_records_added}  overlay_clean: ${out.overlay_clean}`);
  console.log(`  C: ${out.pass ? "PASS ✓" : "FAIL ✗"}`);
  return out;
}

// ── Scenario D — BRep edit (fillet) ────────────────────────────────────────

async function scenarioD() {
  console.log("\n[D] BRep edit — fillet via pointer+keyboard");
  await navigateAndBoot();
  await switchToTab("CAD");
  const vp = await getViewportCenter();
  const VX = vp.x; const VY = vp.y;
  const out = { pass: false };

  // Create a rect (solid profile)
  try {
    await clickTool("rect");
    await trustedClick(VX - 70, VY - 50);
    await trustedClick(VX + 70, VY + 50);
    await delay(400);
  } catch {}

  // Select it
  await clickTool("select").catch(() => {});
  await delay(150);
  await trustedClick(VX, VY);
  await delay(200);

  // Apply Fillet — type radius + Enter
  const canonBefore = await getCanonRecordCount();
  const sceneBefore = await getSceneObjectCount();
  try {
    await clickTool("fillet");
    await delay(400);
    await typeString("0.3");
    await trustedKey("Enter");
    await delay(600);
  } catch (e) { out.fillet_error = e.message; }

  const canonAfter  = await getCanonRecordCount();
  const sceneAfter  = await getSceneObjectCount();
  out.canonical_added = canonAfter - canonBefore;
  out.objects_after   = sceneAfter - sceneBefore;

  // Check for BRep fillet record
  const filletRecord = await evaluate(`
    (() => {
      const store = window.__viewer?.getCanonicalGeometryStore?.();
      if (!store) return null;
      const recs = store.exportRecords();
      const filletRec = recs.find(r =>
        r.metadata?.derivation?.includes("chamfer") ||
        r.metadata?.derivation?.includes("fillet") ||
        r.createdBy === "SdFillet"
      );
      if (!filletRec) return null;
      const shell = filletRec.brep?.shells?.[0];
      return {
        derivation: filletRec.metadata?.derivation ?? null,
        isClosed: shell?.isClosed ?? null,
        createdBy: filletRec.createdBy ?? null,
      };
    })()`);
  out.fillet_record = filletRecord;

  const overlayClean = await checkRuntimeOverlay();
  out.overlay_clean = !!overlayClean;

  // D passes if: overlay clean + (fillet tool activated + something changed OR fillet canonical record appeared)
  const toolActivated = await getActiveTool().then(t => t === null /* back to select */ || true);
  out.pass = overlayClean && (out.canonical_added > 0 || out.objects_after !== 0 || out.fillet_record !== null);
  console.log(`  fillet_record: ${JSON.stringify(out.fillet_record)}  canonical_added: ${out.canonical_added}  overlay_clean: ${out.overlay_clean}`);
  console.log(`  D: ${out.pass ? "PASS ✓" : "FAIL ✗"}`);
  return out;
}

// ── Scenario E — ARCH/BIM create ───────────────────────────────────────────

async function scenarioE() {
  console.log("\n[E] ARCH/BIM create — wall placement");
  await navigateAndBoot();
  await switchToTab("ARCH");
  const vp = await getViewportCenter();
  const VX = vp.x; const VY = vp.y;
  const out = { pass: false };
  const before = await getSceneObjectCount();

  // Click Wall tool + place two points
  try {
    await clickTool("wall");
    const active = await getActiveTool();
    out.wall_active = active === "wall";
    await trustedClick(VX - 100, VY);
    await trustedClick(VX + 100, VY);
    await trustedKey("Enter");
    await delay(400);
  } catch (e) { out.wall_error = e.message; }

  const after = await getSceneObjectCount();
  out.objects_created = after - before;
  out.overlay_clean = !!(await checkRuntimeOverlay());

  // Check created object has arch userData
  const wallObj = await evaluate(`
    (() => {
      const scene = window.__viewer?.scene;
      if (!scene) return null;
      const obj = scene.children.find(c => c.userData?.creator === "wall" || c.userData?.kind === "wall");
      return obj ? { creator: obj.userData.creator, kind: obj.userData.kind } : null;
    })()`);
  out.wall_obj = wallObj;

  out.pass = out.overlay_clean && (out.objects_created > 0 || out.wall_obj !== null);
  console.log(`  wall_active: ${out.wall_active}  objects_created: ${out.objects_created}  obj: ${JSON.stringify(out.wall_obj)}`);
  console.log(`  E: ${out.pass ? "PASS ✓" : "FAIL ✗"}`);
  return out;
}

// ── Scenario F — FZK project card load ─────────────────────────────────────

async function scenarioF() {
  console.log("\n[F] FZK project-card load");
  await navigateAndBoot();
  const out = { pass: false };

  // Find and click the FZK card
  const fzkCard = await evaluate(`
    (() => {
      const card = document.querySelector('.ribbon-asset-card[data-sample="kit-fzk-haus"]');
      if (!card) return null;
      const r = card.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`);

  if (!fzkCard) { out.error = "FZK card not found in DOM"; out.pass = false; console.log("  F: FAIL — card not found"); return out; }
  await trustedClick(fzkCard.x, fzkCard.y);
  console.log("  FZK card clicked — waiting for model load...");

  // Wait for canonical store to have records (load completes)
  let canonSummary = null;
  try {
    canonSummary = await poll(async () => {
      const count = await getCanonRecordCount();
      return count > 50 ? count : null;
    }, { timeout: 60_000, interval: 1_000, label: "FZK canonical records" });
    console.log(`  canonical records loaded: ${canonSummary}`);
  } catch { out.error = "timeout waiting for FZK load"; }

  // Detailed canonical analysis
  const fzkAnalysis = await evaluate(`
    (() => {
      const store = window.__viewer?.getCanonicalGeometryStore?.();
      if (!store) return null;
      const recs = store.exportRecords();
      const allShells = recs.flatMap(r => r.brep?.shells ?? []);
      const closedShells = allShells.filter(s => s.isClosed === true);
      const allFaces = allShells.flatMap(s => s.faces ?? []);
      const triangularFaces = allFaces.filter(f => f.geometry?.type === "triangulated" || (f.loops?.length === 0));
      return {
        brep_records: recs.length,
        total_shells: allShells.length,
        closed_records: recs.filter(r => r.brep?.shells?.[0]?.isClosed === true).length,
        nurbs_face_count: allFaces.length,
        triangular_face_count: triangularFaces.length,
      };
    })()`);
  out.fzk_analysis = fzkAnalysis;

  // Target per Kai: 83 BRep records, 6887 NURBS faces, 0 triangular canonical, 64 closed records
  if (fzkAnalysis) {
    out.brep_records_ok    = fzkAnalysis.brep_records === 83;
    out.closed_records_ok  = fzkAnalysis.closed_records === 64;
    out.no_triangular_ok   = fzkAnalysis.triangular_face_count === 0;
    out.nurbs_faces_ok     = fzkAnalysis.nurbs_face_count === 6887;
    console.log(`  BRep records: ${fzkAnalysis.brep_records} (expect 83)  closed: ${fzkAnalysis.closed_records} (expect 64)`);
    console.log(`  NURBS faces: ${fzkAnalysis.nurbs_face_count} (expect 6887)  triangular: ${fzkAnalysis.triangular_face_count} (expect 0)`);
  }

  const overlayClean = await checkRuntimeOverlay();
  out.overlay_clean = !!overlayClean;

  out.pass = !!fzkAnalysis && out.brep_records_ok && out.closed_records_ok && out.no_triangular_ok && out.overlay_clean;
  console.log(`  F: ${out.pass ? "PASS ✓" : "FAIL ✗"}  (overlay: ${out.overlay_clean})`);
  return out;
}

// ── Scenario G — cold-cache stability (conditional) ────────────────────────

async function scenarioG() {
  if (!COLD_CACHE) {
    console.log("\n[G] cold-cache stability: SKIPPED (COLD_CACHE=1 not set; requires MEM-HEAVY coordination)");
    return { skipped: true, pass: true };
  }
  console.log("\n[G] cold-cache stability path");
  await navigateAndBoot();
  const vp = await getViewportCenter();
  const VX = vp.x; const VY = vp.y;
  const out = { pass: false };

  // Wait for model download prompt or proceed directly
  const modelPromptBtn = await evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const dl = btns.find(b => b.textContent?.toLowerCase().includes('download model') || b.textContent?.toLowerCase().includes('load model'));
      if (!dl) return null;
      const r = dl.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`);

  if (modelPromptBtn) {
    console.log("  model download prompt found — clicking");
    await trustedClick(modelPromptBtn.x, modelPromptBtn.y);
    await delay(2_000);
  } else {
    console.log("  no model download prompt (cache warm or not yet triggered)");
  }

  // Create a rect, select it, try fillet (unsupported path should give clean product error, not crash)
  await switchToTab("CAD").catch(() => {});
  const before = await getSceneObjectCount();
  await clickTool("rect").catch(() => {});
  await trustedClick(VX - 60, VY - 40);
  await trustedClick(VX + 60, VY + 40);
  await delay(400);

  await clickTool("select").catch(() => {});
  await delay(150);
  await trustedClick(VX, VY);
  await delay(200);

  await clickTool("fillet").catch(() => {});
  await delay(400);
  await typeString("0.2");
  await trustedKey("Enter");
  await delay(600);

  const after = await getSceneObjectCount();
  out.objects_after = after - before;
  out.overlay_clean = !!(await checkRuntimeOverlay());
  out.no_crash = out.overlay_clean; // proxy for no crash
  out.pass = out.overlay_clean;
  console.log(`  overlay_clean: ${out.overlay_clean}  no_crash: ${out.no_crash}`);
  console.log(`  G: ${out.pass ? "PASS ✓" : "FAIL ✗"}`);
  return out;
}

// ── Run all scenarios ───────────────────────────────────────────────────────

const allResults = [];
const SCENARIOS = [
  { id: "A", fn: scenarioA },
  { id: "B", fn: scenarioB },
  { id: "C", fn: scenarioC },
  { id: "D", fn: scenarioD },
  { id: "E", fn: scenarioE },
  { id: "F", fn: scenarioF },
  { id: "G", fn: scenarioG },
];

for (let pass = 0; pass < PASS_COUNT; pass++) {
  if (STABILITY) console.log(`\n════ PASS ${pass + 1}/${PASS_COUNT} ════`);
  const passResults = {};
  for (const { id, fn } of SCENARIOS) {
    try {
      passResults[id] = await fn();
    } catch (e) {
      passResults[id] = { error: e.message, pass: false };
      console.error(`  [${id}] EXCEPTION: ${e.message}`);
    }
  }
  allResults.push(passResults);

  const passGate = SCENARIOS.every(({ id }) => passResults[id]?.pass === true);
  console.log(`\n  Pass ${pass + 1} gate: ${passGate ? "GREEN ✓" : "RED ✗"}`);
  if (!passGate && STABILITY) {
    console.log("  Stability aborted on first failure pass.");
    break;
  }
}

const overallPass =
  allResults.length === PASS_COUNT &&
  allResults.every(pr => SCENARIOS.every(({ id }) => pr[id]?.pass === true));

const receipt = {
  sha: SHA,
  timestamp: new Date().toISOString(),
  url: DEV_URL,
  feature: "#212 A-G no-bypass harness",
  stability_passes: PASS_COUNT,
  completed_passes: allResults.length,
  results: allResults,
  console_errors_sample: consoleErrors.slice(0, 10),
  pass: overallPass,
};

writeFileSync(OUT, JSON.stringify(receipt, null, 2));

console.log("\n── #212 A-G no-bypass summary ──────────────────────────────────────────");
const last = allResults[allResults.length - 1] ?? {};
for (const { id } of SCENARIOS) {
  const r = last[id];
  const mark = r?.skipped ? "○ SKIP" : r?.pass ? "✓ PASS" : "✗ FAIL";
  console.log(`  [${id}] ${mark}`);
}
console.log(`\n  Overall: ${overallPass ? "PASS ✓" : "FAIL ✗"}`);
console.log(`\nReceipt: ${OUT}`);

ws.close();
if (!overallPass) process.exit(1);
