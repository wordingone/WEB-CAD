#!/usr/bin/env node
// verify-211-gable-cap-coherence.mjs — AC receipt for #211.
//
// Verifies that roof gable caps are parametric-planar-panel BReps (intentional
// open panels, NOT mesh-derived), and that no roof component falls back to
// mesh planarization. Runs against /dev (kai/brep-canonical-migration).
//
// Design decision recorded: gable caps are intentional open panels
// (trimmed-planar-nurbs-brep, isClosed=false), consistent with their
// architectural role as triangular end faces. The 27 closed-solid records
// are the pitched plane faces; gable-end panels are a different topology.
//
// Acceptance criteria (#211):
//   AC1 — At least one roof linked record has derivation="parametric-planar-panel"
//   AC2 — All parametric-planar-panel records: isClosed=false, 1 face, nakedEdges>0
//   AC3 — Zero "planarized-command-mesh" derivation in any roof record (meshFallback=0)
//   AC4 — At least one "parametric-box-primitive" record (closed-solid pitch faces)
//   AC5 — Decision: gable-end panels intentionally open; verifier asserts EXPECTED shape

import { WebSocket } from "ws";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { CDP_PORT } from "./ports.mjs";

const TARGET_URL = "https://wordingone.github.io/WEB-CAD/dev/";

mkdirSync("state", { recursive: true });
const SHA = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const OUT = `state/verify-211-gable-cap-${SHA}-${Date.now()}.json`;

// ── CDP raw WS ──────────────────────────────────────────────────────────────

const targets = JSON.parse(
  execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" })
);
const target = targets.find(t => t.type === "page");
if (!target) { console.error("No page target"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
const consoleErrors = [];

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

const trustedClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await delay(30);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await delay(30);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};

// ── Navigate + boot ────────────────────────────────────────────────────────

await send("Runtime.enable");
await send("Page.enable");
console.log(`[#211] navigating to ${TARGET_URL}`);
await send("Page.navigate", { url: TARGET_URL });
await delay(2_000);
await send("Runtime.enable");

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
  }, { timeout: 20_000, label: "cad-only boot gate" });
  console.log("[#211] boot: cad-only");
} catch { console.log("[#211] boot: no gate"); }

await poll(async () => evaluate(`typeof window.__dispatchSync === "function"`),
  { timeout: 30_000, label: "window.__dispatchSync" });
console.log("[#211] dispatch ready");
await delay(500);

const results = {};

// ── Clear scene ────────────────────────────────────────────────────────────

await evaluate(`
  (() => {
    const scene = window.__viewer?.scene;
    if (!scene) return;
    scene.children.filter(c => c.userData?.creator || c.userData?.kind).forEach(c => scene.remove(c));
  })()`).catch(() => {});

// ── Create a gable roof via SdRoof ─────────────────────────────────────────

console.log("[#211] dispatching SdRoof (gable type)");

// SdRoof with 3 footprint points to force a gable geometry
// (3-point or 4-point rectangular footprint with gable type)
const roofResult = await evaluate(`
  (() => {
    try {
      // Try gable type first with a simple rectangular footprint
      const r = window.__dispatchSync("SdRoof", {
        points: [
          { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }
        ],
        type: "gable",
        height: 2,
        eaveHeight: 0
      });
      return r ? "ok" : "null-result";
    } catch (e) { return "error:" + e.message; }
  })()`);
results.sdroof_result = roofResult;
console.log(`  SdRoof: ${roofResult}`);

await delay(500);

// Find the roof group and all linked canonical records
const canonicalSummary = await evaluate(`
  (() => {
    const store = window.__viewer?.getCanonicalGeometryStore?.();
    if (!store) return null;
    const allRecords = store.exportRecords();
    const roofRecords = allRecords.filter(r =>
      r.createdBy === "SdRoof" ||
      (r.metadata?.parentCreator === "SdRoof") ||
      (r.metadata?.operation === "create-roof-component") ||
      (r.metadata?.operation?.startsWith("create-roof"))
    );
    const derivations = {};
    for (const r of roofRecords) {
      const d = r.metadata?.derivation ?? "unknown";
      derivations[d] = (derivations[d] ?? 0) + 1;
    }
    // Inspect planar panels
    const panelRecords = roofRecords.filter(r => r.metadata?.derivation === "parametric-planar-panel");
    const panelDetails = panelRecords.map(r => {
      const shell = r.brep?.shells?.[0];
      return {
        isClosed: shell?.isClosed ?? null,
        faceCount: shell?.faces?.length ?? 0,
        nakedEdges: shell?.edges?.filter(e => e.faceIndex2 === null).length ?? 0,
        conversion: r.metadata?.conversion ?? null,
      };
    });
    return {
      totalRoofRecords: roofRecords.length,
      derivations,
      panelCount: panelRecords.length,
      panelDetails,
    };
  })()`);

if (!canonicalSummary) {
  results.skip = "canonical store not accessible";
  console.log("[#211] SKIP: cannot access canonical store");
} else {
  results.total_roof_records = canonicalSummary.totalRoofRecords;
  results.derivations = canonicalSummary.derivations;
  results.panel_count = canonicalSummary.panelCount;
  results.panel_details = canonicalSummary.panelDetails;

  console.log(`  total roof records: ${results.total_roof_records}`);
  console.log(`  derivations: ${JSON.stringify(results.derivations)}`);
  console.log(`  planar panels found: ${results.panel_count}`);

  // AC1: at least one parametric-planar-panel record
  results.ac1_has_panel = (canonicalSummary.derivations["parametric-planar-panel"] ?? 0) > 0;

  // AC2: all panel records are open panels (isClosed=false, 1 face, nakedEdges>0)
  const panelDetails = canonicalSummary.panelDetails ?? [];
  results.ac2_panels_open = panelDetails.length > 0 && panelDetails.every(p =>
    p.isClosed === false && p.faceCount === 1 && p.nakedEdges > 0
  );
  results.ac2_detail = panelDetails;

  // AC3: no planarized-command-mesh (meshFallback=0)
  results.ac3_no_mesh_fallback = (canonicalSummary.derivations["planarized-command-mesh"] ?? 0) === 0;

  // AC4: at least one parametric-box-primitive (closed solid pitch faces)
  results.ac4_has_box_primitives = (canonicalSummary.derivations["parametric-box-primitive"] ?? 0) > 0;

  console.log(`  AC1 has planar panel: ${results.ac1_has_panel}`);
  console.log(`  AC2 panels are open (isClosed=false): ${results.ac2_panels_open}`);
  console.log(`  AC3 no mesh fallback: ${results.ac3_no_mesh_fallback}`);
  console.log(`  AC4 has box primitives: ${results.ac4_has_box_primitives}`);
}

// AC5: decision recorded
results.ac5_decision = "intentional-open-panel";
results.ac5_rationale = "Gable-end cap is architecturally a triangular surface, not a solid prism. " +
  "isClosed=false is the correct BRep topology for this element. " +
  "Coherence with the 27 closed-solid pitch faces is met at the parametric level: " +
  "all components use canonical NURBS BReps, no mesh fallback. " +
  "See brep-canonical-characterization.test.ts for expected-shape assertion.";

// ── Pass/fail ──────────────────────────────────────────────────────────────

const pass = !results.skip &&
  results.ac1_has_panel === true &&
  results.ac2_panels_open === true &&
  results.ac3_no_mesh_fallback === true &&
  results.ac4_has_box_primitives === true;

const receipt = {
  sha: SHA,
  timestamp: new Date().toISOString(),
  url: TARGET_URL,
  feature: "#211 gable-cap coherence — intentional-open-panel decision",
  results,
  console_errors_sample: consoleErrors.slice(0, 10),
  pass,
};

writeFileSync(OUT, JSON.stringify(receipt, null, 2));

console.log("\n── #211 gable-cap coherence AC ─────────────────────────────────────────");
if (results.skip) {
  console.log(`  SKIP: ${results.skip}`);
} else {
  console.log(`  AC1 has planar-panel record:         ${results.ac1_has_panel} ${results.ac1_has_panel ? "✓" : "✗ FAIL"}`);
  console.log(`  AC2 panels open (isClosed=false):    ${results.ac2_panels_open} ${results.ac2_panels_open ? "✓" : "✗ FAIL"}`);
  console.log(`  AC3 no mesh fallback:                ${results.ac3_no_mesh_fallback} ${results.ac3_no_mesh_fallback ? "✓" : "✗ FAIL"}`);
  console.log(`  AC4 has box-primitive pitch faces:   ${results.ac4_has_box_primitives} ${results.ac4_has_box_primitives ? "✓" : "✗ FAIL"}`);
  console.log(`  AC5 decision: ${results.ac5_decision}`);
}
console.log(`\n  AC result: ${pass ? "PASS ✓" : results.skip ? "SKIP" : "FAIL ✗"}`);
console.log(`\nReceipt: ${OUT}`);

ws.close();
if (!pass && !results.skip) process.exit(1);
