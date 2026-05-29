#!/usr/bin/env node
// verify-211-gable-cap-coherence.mjs — AC receipt for #211 (LIVE gate — Kai landed geometry).
//
// Kai mail 11583 (2026-05-29): closed-solid gable-cap geometry landed on
// kai/brep-canonical-migration at commit 5050e822. Derivation string: "parametric-gable-cap-solid".
//
// Acceptance criteria (#211) — closed-solid target (now GREEN on /dev):
//   AC1 — Zero roof canonical records have isClosed=false (no open panels)
//   AC2 — Gable-cap records: derivation "parametric-gable-cap-solid", isClosed=true, faceCount=5
//   AC3 — Zero "planarized-command-mesh" derivation (no mesh fallback)
//   AC4 — At least 2 gable-cap-solid records (one per gable end)
//   AC5 — No "parametric-planar-panel" derivation remaining
//   AC6 — Exact topology per cap: faceCount=5, edgeCount=9, closedEdgeCount=9, vertexCount=6, all NURBS faces

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
  { timeout: 30_000, label: "__dispatchSync" });
console.log("[#211] dispatch ready");
await delay(500);

const results = {};

// Clear scene
await evaluate(`
  (() => {
    const s = window.__viewer?.scene;
    if (!s) return;
    s.children.filter(c => c.userData?.creator || c.userData?.kind).forEach(c => s.remove(c));
  })()`).catch(() => {});

// ── Create gable roof via SdRoof ───────────────────────────────────────────

console.log("[#211] dispatching SdRoof (gable type)");
const roofResult = await evaluate(`
  (() => {
    try {
      const r = window.__dispatchSync("SdRoof", {
        points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }],
        type: "gable", height: 2, eaveHeight: 0
      });
      return r ? "ok" : "null-result";
    } catch (e) { return "error:" + e.message; }
  })()`);
results.sdroof_result = roofResult;
console.log(`  SdRoof: ${roofResult}`);
await delay(500);

// ── Inspect canonical store ────────────────────────────────────────────────

const canonicalSummary = await evaluate(`
  (() => {
    const store = window.__viewer?.getCanonicalGeometryStore?.();
    if (!store) return null;
    const allRecords = store.exportRecords();
    const roofRecords = allRecords.filter(r =>
      r.createdBy === "SdRoof" ||
      r.metadata?.parentCreator === "SdRoof" ||
      r.metadata?.operation?.startsWith("create-roof")
    );
    const derivations = {};
    const shellStats = [];
    for (const r of roofRecords) {
      const d = r.metadata?.derivation ?? "unknown";
      derivations[d] = (derivations[d] ?? 0) + 1;
      const shell = r.brep?.shells?.[0];
      const edges = shell?.edges ?? [];
      const verts = shell?.vertices ?? [];
      const faces = shell?.faces ?? [];
      const allFacesNurbs = faces.every(f => f.surface?.kind === "nurbs" || f.geometry?.kind === "nurbs");
      shellStats.push({
        derivation: d,
        isClosed: shell?.isClosed ?? null,
        faceCount: faces.length,
        edgeCount: edges.length,
        closedEdgeCount: edges.filter(e => e.faceIndex2 !== null && e.faceIndex2 !== undefined).length,
        nakedEdges: edges.filter(e => e.faceIndex2 === null || e.faceIndex2 === undefined).length,
        vertexCount: verts.length,
        allFacesNurbs,
        conversion: r.metadata?.conversion ?? null,
        createdBy: r.createdBy ?? null,
      });
    }
    return {
      totalRoofRecords: roofRecords.length,
      derivations,
      shellStats,
      openShells: shellStats.filter(s => s.isClosed === false).length,
      closedShells: shellStats.filter(s => s.isClosed === true).length,
    };
  })()`);

if (!canonicalSummary) {
  results.skip = "canonical store not accessible";
  console.log("[#211] SKIP: cannot access canonical store");
} else {
  results.total_roof_records = canonicalSummary.totalRoofRecords;
  results.derivations = canonicalSummary.derivations;
  results.open_shells = canonicalSummary.openShells;
  results.closed_shells = canonicalSummary.closedShells;
  results.shell_stats = canonicalSummary.shellStats;

  console.log(`  total roof records: ${results.total_roof_records}`);
  console.log(`  derivations: ${JSON.stringify(results.derivations)}`);
  console.log(`  open shells: ${results.open_shells}  closed shells: ${results.closed_shells}`);

  // AC1 — zero open-shell records (no isClosed=false)
  results.ac1_no_open_shells = results.open_shells === 0;

  // AC2 — gable-cap-solid records exist, all isClosed=true, faceCount=5
  const gableCapSolids = canonicalSummary.shellStats.filter(s => s.derivation === "parametric-gable-cap-solid");
  results.ac2_gable_cap_solid_count = gableCapSolids.length;
  results.ac2_all_closed = gableCapSolids.every(s => s.isClosed === true);
  results.ac2_face_count_ok = gableCapSolids.every(s => s.faceCount === 5);

  // AC3 — zero mesh fallback
  results.ac3_no_mesh_fallback = (canonicalSummary.derivations["planarized-command-mesh"] ?? 0) === 0;

  // AC4 — at least 2 gable-cap-solid records (one per gable end)
  results.ac4_min_two_caps = gableCapSolids.length >= 2;

  // AC5 — no "parametric-planar-panel" derivation (replaced by gable-cap-solid)
  results.ac5_no_open_panel_derivation = (canonicalSummary.derivations["parametric-planar-panel"] ?? 0) === 0;

  // AC6 — exact topology per cap: faceCount=5, edgeCount=9, closedEdgeCount=9, vertexCount=6, all NURBS faces
  const topoChecks = gableCapSolids.map(s => ({
    derivation: s.derivation,
    isClosed: s.isClosed,
    faceCount: s.faceCount,
    edgeCount: s.edgeCount,
    closedEdgeCount: s.closedEdgeCount,
    vertexCount: s.vertexCount,
    allFacesNurbs: s.allFacesNurbs,
    pass: s.faceCount === 5 && s.edgeCount === 9 && s.closedEdgeCount === 9 && s.vertexCount === 6 && s.allFacesNurbs === true,
  }));
  results.ac6_topo = topoChecks;
  results.ac6_all_topo_ok = topoChecks.length >= 2 && topoChecks.every(t => t.pass);

  console.log(`  AC1 no open shells:             ${results.ac1_no_open_shells} ${results.ac1_no_open_shells ? "✓" : "✗ FAIL"}`);
  console.log(`  AC2 gable-cap-solid (closed,f5): ${results.ac2_all_closed && results.ac2_face_count_ok} count=${results.ac2_gable_cap_solid_count} ${results.ac2_all_closed && results.ac2_face_count_ok ? "✓" : "✗ FAIL"}`);
  console.log(`  AC3 no mesh fallback:           ${results.ac3_no_mesh_fallback} ${results.ac3_no_mesh_fallback ? "✓" : "✗ FAIL"}`);
  console.log(`  AC4 at least 2 gable caps:      ${results.ac4_min_two_caps} count=${results.ac2_gable_cap_solid_count} ${results.ac4_min_two_caps ? "✓" : "✗ FAIL"}`);
  console.log(`  AC5 no open-panel derivation:   ${results.ac5_no_open_panel_derivation} ${results.ac5_no_open_panel_derivation ? "✓" : "✗ FAIL"}`);
  console.log(`  AC6 exact topology (5f/9e/6v/nurbs): ${results.ac6_all_topo_ok} ${results.ac6_all_topo_ok ? "✓" : "✗ FAIL"}`);
  if (topoChecks.length) console.log(`    sample: ${JSON.stringify(topoChecks[0])}`);
}

// ── Pass/fail ──────────────────────────────────────────────────────────────

const pass = !results.skip &&
  results.ac1_no_open_shells        === true &&
  results.ac2_all_closed            === true &&
  results.ac2_face_count_ok         === true &&
  results.ac3_no_mesh_fallback      === true &&
  results.ac4_min_two_caps          === true &&
  results.ac5_no_open_panel_derivation === true &&
  results.ac6_all_topo_ok           === true;

const receipt = {
  sha: SHA,
  timestamp: new Date().toISOString(),
  url: TARGET_URL,
  feature: "#211 gable-cap coherence — CLOSED-SOLID (parametric-gable-cap-solid, Kai commit 5050e822)",
  results,
  console_errors_sample: consoleErrors.slice(0, 10),
  pass,
};

writeFileSync(OUT, JSON.stringify(receipt, null, 2));

console.log("\n── #211 gable-cap closed-solid AC gate ────────────────────────────────");
if (results.skip) {
  console.log(`  SKIP: ${results.skip}`);
} else {
  console.log(`  AC1 no open shells:               ${results.ac1_no_open_shells} ${results.ac1_no_open_shells ? "✓" : "✗ FAIL"}`);
  console.log(`  AC2 gable-cap-solid (closed,f5):  ${results.ac2_all_closed && results.ac2_face_count_ok} count=${results.ac2_gable_cap_solid_count} ${results.ac2_all_closed && results.ac2_face_count_ok ? "✓" : "✗ FAIL"}`);
  console.log(`  AC3 no mesh fallback:             ${results.ac3_no_mesh_fallback} ${results.ac3_no_mesh_fallback ? "✓" : "✗ FAIL"}`);
  console.log(`  AC4 at least 2 caps:              ${results.ac4_min_two_caps} ${results.ac4_min_two_caps ? "✓" : "✗ FAIL"}`);
  console.log(`  AC5 no open-panel derivation:     ${results.ac5_no_open_panel_derivation} ${results.ac5_no_open_panel_derivation ? "✓" : "✗ FAIL"}`);
  console.log(`  AC6 exact topo (5f/9e/6v/nurbs):  ${results.ac6_all_topo_ok} ${results.ac6_all_topo_ok ? "✓" : "✗ FAIL"}`);
}
console.log(`\n  AC result: ${pass ? "PASS ✓" : "FAIL ✗"}`);
console.log(`\nReceipt: ${OUT}`);

ws.close();
if (!pass) process.exit(1);
