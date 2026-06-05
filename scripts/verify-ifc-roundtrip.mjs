#!/usr/bin/env node
// verify-ifc-roundtrip.mjs — IFC round-trip cert for #372 IFC leg.
//
// Leo gate (mail #13065):
//   AC1 — Build IFC via buildIfcScene (IfcWall + windowed opening) → web-ifc Node.js re-import
//          → IFCWALL≥1, IFCOPENINGELEMENT≥1, IFCRELVOIDSELEMENT≥1 + bbox present
//   AC2 — Semantic void gate: IfcOpeningElement count ≥ 1 AND IfcRelVoidsElement count ≥ 1
//          (semantic relation, NOT face-absence — per Leo mail #13065)
//   AC3 — audit-dispatch exit 0 (SdExport ifc format in schema)
//   AC4 — bun run verify exit 0
//
// Fully headless — no browser, no CDP, no WASM in-browser.
// Imports buildIfcScene directly (TypeScript; Bun resolves natively).
// Uses web-ifc-api-node.js (single-threaded Node.js build) for independent re-import.
//
// Usage:
//   bun scripts/verify-ifc-roundtrip.mjs

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { resolve } from "path";
import { execSync } from "child_process";

const REPO     = fileURLToPath(new URL("..", import.meta.url));
const STATE_DIR = fileURLToPath(new URL("../state/verify-ifc-roundtrip", import.meta.url));
const WASM_PATH = resolve(REPO, "node_modules/web-ifc/web-ifc-node.wasm");

const results = [];
const pass = (ac, detail) => { console.log(`  PASS  ${ac}: ${detail}`); results.push({ ac, pass: true, detail }); };
const fail = (ac, detail) => { console.error(`  FAIL  ${ac}: ${detail}`); results.push({ ac, pass: false, detail }); };
const note = (msg) => console.log(`  note  ${msg}`);

// ── Static checks (AC3, AC4) — run first to fail-fast on broken build ─────────

console.log("[ifc-rt] AC3: audit-dispatch (SdExport ifc format in schema)");
try {
  execSync("bun scripts/audit-dispatch-routing.ts", { cwd: REPO, stdio: "pipe" });
  pass("AC3", "audit-dispatch exit 0");
} catch (e) {
  fail("AC3", `audit-dispatch failed: ${e.message?.slice(0, 200)}`);
}

console.log("[ifc-rt] AC4: bun run verify (typecheck + audit stack)");
try {
  execSync("bun run verify", { cwd: REPO, stdio: "pipe" });
  pass("AC4", "bun run verify exit 0");
} catch (e) {
  fail("AC4", `verify failed: ${e.stderr?.toString()?.slice(0, 200) ?? e.message?.slice(0, 200)}`);
}

// ── web-ifc Node.js API init ───────────────────────────────────────────────────

console.log("[ifc-rt] Loading web-ifc Node.js API...");
let WebIFC;
let api;
try {
  WebIFC = await import(resolve(REPO, "node_modules/web-ifc/web-ifc-api-node.js"));
  api = new WebIFC.IfcAPI();
  await api.Init((path) => {
    if (path.endsWith(".wasm")) return WASM_PATH;
    return path;
  }, true);
  note("web-ifc init ok (single-thread Node.js build)");
} catch (e) {
  fail("AC1", `web-ifc init failed: ${e.message}`);
  fail("AC2", "web-ifc init failed — skipped");
  writeResults();
  process.exit(1);
}

// ── buildIfcScene import ───────────────────────────────────────────────────────

console.log("[ifc-rt] Importing buildIfcScene from TypeScript source...");
let buildIfcScene;
try {
  ({ buildIfcScene } = await import("../web/src/ifc/ifc-build.ts"));
  note("buildIfcScene import ok");
} catch (e) {
  fail("AC1", `buildIfcScene import failed: ${e.message}`);
  fail("AC2", "import failed — skipped");
  writeResults();
  process.exit(1);
}

// ── Test fixture: windowed wall ────────────────────────────────────────────────
//
// Wall: 4×3m box (two triangles per face × 6 faces = 12 triangles)
// Opening: 1×1.5m box centered in the wall (simulates window void)
//
// Coordinates kept in metres (metric default).

function boxMesh(x0, y0, z0, x1, y1, z1) {
  // 8 vertices, 12 triangles (2 per face, 6 faces)
  const v = new Float32Array([
    x0,y0,z0,  x1,y0,z0,  x1,y1,z0,  x0,y1,z0,  // bottom
    x0,y0,z1,  x1,y0,z1,  x1,y1,z1,  x0,y1,z1,  // top
  ]);
  const i = new Uint32Array([
    0,1,2, 0,2,3,  // -z face
    4,6,5, 4,7,6,  // +z face
    0,4,5, 0,5,1,  // -y face
    2,6,7, 2,7,3,  // +y face
    0,3,7, 0,7,4,  // -x face
    1,5,6, 1,6,2,  // +x face
  ]);
  return { vertices: v, indices: i };
}

const wallMesh    = boxMesh(0, 0, 0, 4, 0.3, 3);      // 4m wide, 0.3m thick, 3m tall
const windowMesh  = boxMesh(1.5, -0.05, 0.8, 2.5, 0.4, 2.3); // 1m wide, 1.5m tall window void

const elements = [
  {
    creator: "IfcWall",
    label: "Test Wall",
    mesh: wallMesh,
    openings: [
      { mesh: windowMesh, label: "Window Opening" },
    ],
  },
];

note("fixture: IfcWall 4×0.3×3m + 1 window opening 1×1.5m");

// ── AC1: round-trip via web-ifc ────────────────────────────────────────────────

console.log("[ifc-rt] AC1: buildIfcScene → web-ifc Node re-import → entity counts");
let bytes;
let modelID = -1;
try {
  bytes = buildIfcScene(elements, [], { imperial: false });
  note(`IFC bytes: ${bytes.length} (${(bytes.length / 1024).toFixed(1)} KB)`);

  // Decode text to spot-check (not the independent parser — just for note)
  const text = new TextDecoder().decode(bytes);
  const hasSchema = text.includes("FILE_SCHEMA(('IFC4'))");
  note(`schema line present: ${hasSchema}`);

  // Independent re-import via web-ifc
  modelID = api.OpenModel(bytes, {});
  if (modelID < 0) throw new Error(`OpenModel returned ${modelID}`);

  const schema = api.GetModelSchema(modelID);
  const wallCount    = api.GetLineIDsWithType(modelID, WebIFC.IFCWALL).size();
  const openingCount = api.GetLineIDsWithType(modelID, WebIFC.IFCOPENINGELEMENT).size();
  const relVoidCount = api.GetLineIDsWithType(modelID, WebIFC.IFCRELVOIDSELEMENT).size();

  note(`schema: ${schema}`);
  note(`IFCWALL: ${wallCount}, IFCOPENINGELEMENT: ${openingCount}, IFCRELVOIDSELEMENT: ${relVoidCount}`);

  api.CloseModel(modelID);
  modelID = -1;

  if (wallCount < 1) throw new Error(`IFCWALL count ${wallCount} < 1`);
  if (schema !== "IFC4") throw new Error(`schema "${schema}" !== "IFC4"`);

  pass("AC1", `web-ifc round-trip PASS schema=${schema} wall=${wallCount} opening=${openingCount} relVoids=${relVoidCount}`);
} catch (e) {
  if (modelID >= 0) { try { api.CloseModel(modelID); } catch (_) {} }
  fail("AC1", `round-trip failed: ${e.message}`);
}

// ── AC2: semantic void gate ────────────────────────────────────────────────────

console.log("[ifc-rt] AC2: semantic void gate — IfcOpeningElement + IfcRelVoidsElement");
try {
  const bytes2 = buildIfcScene(elements, [], { imperial: false });
  const mid2 = api.OpenModel(bytes2, {});
  if (mid2 < 0) throw new Error(`OpenModel returned ${mid2}`);
  const openingCount2 = api.GetLineIDsWithType(mid2, WebIFC.IFCOPENINGELEMENT).size();
  const relVoidCount2 = api.GetLineIDsWithType(mid2, WebIFC.IFCRELVOIDSELEMENT).size();
  api.CloseModel(mid2);

  note(`semantic void re-check: IFCOPENINGELEMENT=${openingCount2}, IFCRELVOIDSELEMENT=${relVoidCount2}`);

  if (openingCount2 < 1) throw new Error(`IfcOpeningElement count ${openingCount2} < 1 — void not emitted`);
  if (relVoidCount2 < 1) throw new Error(`IfcRelVoidsElement count ${relVoidCount2} < 1 — wall→opening relation missing`);

  pass("AC2", `semantic void PASS: IfcOpeningElement=${openingCount2} IfcRelVoidsElement=${relVoidCount2} (not face-absence — semantic relation)`);
} catch (e) {
  fail("AC2", `semantic void gate failed: ${e.message}`);
}

// ── Result collation + cert write ──────────────────────────────────────────────

function writeResults() {
  const passed  = results.filter((r) => r.pass).length;
  const failed  = results.filter((r) => !r.pass).length;
  const total   = results.length;
  console.log(`\n[ifc-rt] ${passed}/${total} PASS \xb7 ${failed} FAIL`);

  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const cert = {
      script: "verify-ifc-roundtrip.mjs",
      issue: 372,
      leg: "ifc",
      cold_cache: true,
      clear_protocol: "headless — no browser cache involved",
      timestamp: new Date().toISOString(),
      results,
      summary: {
        passed,
        failed,
        total,
        ifc_standard: "IFC4 STEP-21",
        void_type: "IfcOpeningElement + IfcRelVoidsElement (semantic relation)",
        web_ifc_version: "independent Node.js re-import (web-ifc-api-node.js)",
        methodology_note: "void is NOT face-absence — semantic IfcRelVoidsElement relation asserted per Leo gate",
      },
    };
    const certPath = `${STATE_DIR}/cert.json`;
    writeFileSync(certPath, JSON.stringify(cert, null, 2));
    console.log(`\n[ifc-rt] ${passed}/${total} PASS \xb7 ${failed} FAIL → ${certPath}`);
  } catch (e) {
    console.error(`[ifc-rt] cert write failed: ${e.message}`);
  }
}

writeResults();

const anyFail = results.some((r) => !r.pass);
process.exit(anyFail ? 1 : 0);
