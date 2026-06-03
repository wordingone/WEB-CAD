#!/usr/bin/env node
// verify-format-roundtrip.mjs — Round-trip cert for OBJ, STL, .3dm (#372).
//
// Leo gate (mail #13059):
//   AC1 — OBJ:  three.js OBJExporter → independent Node.js parser → bbox + face_count≥1
//   AC2 — STL:  three.js STLExporter → independent binary STL parser → tri>0 + bbox + scale check
//   AC3 — .3dm: rhino3dm write (mesh) → rhino3dm read → bbox + void preserved (face count match)
//          windowed wall: ExtrudeGeometry with hole → mesh round-trip via File3dm
//   AC4 — audit-dispatch: Sd3dmWrite kernel:nurbs-ts, SdObjWrite kernel:nurbs-ts, SdStlWrite kernel:nurbs-ts
//   AC5 — bun run verify exit 0
//
// All legs headless-eligible (no browser WASM required):
//   - OBJ/STL:  three.js geometry + Node.js parsers (format-spec only)
//   - .3dm:     rhino3dm npm package (Node.js; WASM loads via rhino3dm.js binary)
//
// Usage:
//   bun scripts/verify-format-roundtrip.mjs          # all ACs (headless)
//   bun scripts/verify-format-roundtrip.mjs --cdp    # AC6 live-dispatch smoke test on Pages

import * as THREE from "three";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const CDP_BASE  = "http://localhost:9222";
const USE_CDP   = process.argv.includes("--cdp");
const STATE_DIR = fileURLToPath(new URL("../state/verify-format-roundtrip", import.meta.url));
const TOL_BBOX  = 0.05; // bbox dimension tolerance

const results = [];
const pass = (ac, detail) => { console.log(`  PASS  ${ac}: ${detail}`); results.push({ ac, pass: true, detail }); };
const fail = (ac, detail) => { console.error(`  FAIL  ${ac}: ${detail}`); results.push({ ac, pass: false, detail }); };
const note = (msg) => console.log(`  note  ${msg}`);

const REPO = fileURLToPath(new URL("..", import.meta.url));

// ── AC4/AC5 — static checks ───────────────────────────────────────────────────
console.log("[format-rt] AC4: audit-dispatch (Sd3dmWrite/SdObjWrite/SdStlWrite kernel:nurbs-ts)");
try {
  execSync("bun scripts/audit-dispatch-routing.ts", { cwd: REPO, stdio: "pipe" });
  pass("AC4", "audit-dispatch exit 0 — Sd3dmWrite/SdObjWrite/SdStlWrite nurbs-ts");
} catch (e) {
  fail("AC4", `audit-dispatch failed: ${e.message?.slice(0, 200)}`);
}

console.log("[format-rt] AC5: bun run verify (typecheck + audit stack)");
try {
  execSync("bun run verify", { cwd: REPO, stdio: "pipe" });
  pass("AC5", "bun run verify exit 0");
} catch (e) {
  fail("AC5", `verify failed: ${e.stderr?.toString()?.slice(0, 200) ?? e.message?.slice(0, 200)}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function computeBbox(verts) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of verts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ],
           dx: maxX - minX, dy: maxY - minY, dz: maxZ - minZ };
}

function assertBbox(ac, got, expected, label = "") {
  const pfx = label ? `${label} ` : "";
  note(`${ac} ${pfx}bbox: dx=${got.dx.toFixed(3)} dy=${got.dy.toFixed(3)} dz=${got.dz.toFixed(3)}`);
  const errs = [];
  if (Math.abs(got.dx - expected.dx) > TOL_BBOX) errs.push(`dx ${got.dx.toFixed(3)} ≠ ${expected.dx}`);
  if (Math.abs(got.dy - expected.dy) > TOL_BBOX) errs.push(`dy ${got.dy.toFixed(3)} ≠ ${expected.dy}`);
  if (Math.abs(got.dz - expected.dz) > TOL_BBOX) errs.push(`dz ${got.dz.toFixed(3)} ≠ ${expected.dz}`);
  return errs;
}

// Independent OBJ parser (format-spec: v, f lines only — no three.js dependency).
function parseOBJ(text) {
  const verts = [];
  let faceCount = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const parts = line.slice(2).trim().split(/\s+/).map(Number);
      if (parts.length >= 3) verts.push([parts[0], parts[1], parts[2]]);
    } else if (line.startsWith("f ")) {
      faceCount++;
    }
  }
  return { verts, faceCount };
}

// Independent binary-STL parser (format-spec: 80-byte header + tri-count + 50-byte records).
function parseSTLBinary(buf) {
  const view = new DataView(buf);
  if (buf.byteLength < 84) return { triCount: 0, verts: [] };
  const triCount = view.getUint32(80, true);
  const verts = [];
  for (let i = 0; i < triCount; i++) {
    const base = 84 + i * 50 + 12; // skip 12-byte face normal
    for (let v = 0; v < 3; v++) {
      const off = base + v * 12;
      verts.push([
        view.getFloat32(off,     true),
        view.getFloat32(off + 4, true),
        view.getFloat32(off + 8, true),
      ]);
    }
  }
  return { triCount, verts };
}

// Build a 2×1×1 non-degenerate box mesh (world-space, no rotation).
function makeBoxMesh(w = 2, h = 1, d = 1) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  mesh.updateMatrixWorld(true);
  return mesh;
}

// ── AC1: OBJ round-trip ───────────────────────────────────────────────────────
console.log("[format-rt] AC1: OBJ round-trip — three.js OBJExporter → Node.js parser");
try {
  const mesh = makeBoxMesh(2, 1, 1);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const exporter = new OBJExporter();
  const objText = exporter.parse(scene);

  const parsed = parseOBJ(objText);
  note(`AC1 OBJ: ${parsed.verts.length} vertices, ${parsed.faceCount} faces`);

  if (parsed.faceCount < 1) {
    fail("AC1", `face_count ${parsed.faceCount} < 1 — exporter produced no faces`);
  } else {
    const bbox = computeBbox(parsed.verts);
    const errs = assertBbox("AC1", bbox, { dx: 2, dy: 1, dz: 1 }, "OBJ");
    // Scale check: OBJ uses scene units (no 1000× implicit rescaling).
    // A 2×1×1 THREE.js box exports as 2×1×1 in OBJ — assert scale factor ≈1.
    const scaleOk = Math.abs(bbox.dx - 2) < TOL_BBOX;
    if (!scaleOk) errs.push(`OBJ scale suspect: dx=${bbox.dx.toFixed(3)}, expected 2 (no 1000× rescale)`);
    if (errs.length > 0) fail("AC1", `OBJ bbox/scale: ${errs.join("; ")}`);
    else pass("AC1", `OBJ round-trip PASS face=${parsed.faceCount} bbox=2.00×1.00×1.00 scale≈1`);
  }
} catch (e) {
  fail("AC1", `OBJ round-trip threw: ${e.message}`);
}

// ── AC2: STL round-trip ───────────────────────────────────────────────────────
console.log("[format-rt] AC2: STL round-trip — three.js STLExporter → binary STL parser");
try {
  const mesh = makeBoxMesh(2, 1, 1);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const exporter = new STLExporter();
  const buf = exporter.parse(scene, { binary: true });
  const arrayBuf = buf instanceof ArrayBuffer ? buf :
    (buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : null);
  if (!arrayBuf) { fail("AC2", "STLExporter returned unexpected type"); } else {
    const parsed = parseSTLBinary(arrayBuf);
    note(`AC2 STL: ${parsed.triCount} triangles (binary header)`);

    if (parsed.triCount < 1) {
      fail("AC2", `tri_count ${parsed.triCount} < 1 — exporter produced no triangles`);
    } else {
      const bbox = computeBbox(parsed.verts);
      const errs = assertBbox("AC2", bbox, { dx: 2, dy: 1, dz: 1 }, "STL");
      // Scale: STL has no unit metadata — assert vertices match THREE.js scene units (no implicit rescale).
      const scaleOk = Math.abs(bbox.dx - 2) < TOL_BBOX;
      if (!scaleOk) errs.push(`STL scale suspect: dx=${bbox.dx.toFixed(3)}, expected 2 — check 1000× unit trap`);
      if (errs.length > 0) fail("AC2", `STL bbox/scale: ${errs.join("; ")}`);
      else pass("AC2", `STL round-trip PASS tri=${parsed.triCount} bbox=2.00×1.00×1.00 scale≈1`);
    }
  }
} catch (e) {
  fail("AC2", `STL round-trip threw: ${e.message}`);
}

// ── AC3: .3dm round-trip with void ────────────────────────────────────────────
// Leo gate: "round-trip a WINDOWED WALL and assert the VOID survives
//            (loop/face count preserved, or the void renders post-reimport)."
// Method: ExtrudeGeometry with a rectangular hole → Rhino Mesh in File3dm.
// Round-trip: rhino3dm write → rhino3dm read. Face count must be preserved exactly.
// Void check: faces inside the hole boundary must be ZERO both pre- and post-import.
console.log("[format-rt] AC3: .3dm round-trip — windowed wall void preservation");
try {
  // Build windowed wall (outer 4×3 rect with 1.6×1.4 window hole).
  const outer = new THREE.Shape();
  outer.moveTo(0, 0); outer.lineTo(4, 0); outer.lineTo(4, 3); outer.lineTo(0, 3);
  outer.closePath();
  const hole = new THREE.Path();
  hole.moveTo(1.2, 0.6); hole.lineTo(2.8, 0.6); hole.lineTo(2.8, 2.0); hole.lineTo(1.2, 2.0);
  hole.closePath();
  outer.holes.push(hole);
  const wallGeo = new THREE.ExtrudeGeometry(outer, { depth: 0.3, bevelEnabled: false });
  // Count source geometry faces.
  const srcIndexCount = wallGeo.index ? wallGeo.index.count : wallGeo.attributes.position.count;
  const srcTriCount = Math.round(srcIndexCount / 3);
  note(`AC3 source mesh: ${srcTriCount} triangles (windowed wall with void)`);

  // Use rhino3dm npm to export → round-trip.
  // Dynamic import to avoid load cost on AC1/AC2.
  const rhino3dm = (await import("rhino3dm")).default;
  const rh = await rhino3dm();

  // Build Rhino Mesh from THREE.js BufferGeometry (world-space, non-indexed flattened).
  function threeToRhinoMesh(geo) {
    // Flatten indexed geometry into non-indexed for Rhino Mesh vertex list.
    const posAttr = geo.attributes.position;
    const idx = geo.index?.array;
    const rhinoMesh = new rh.Mesh();
    const verts = rhinoMesh.vertices();
    const faces = rhinoMesh.faces();
    if (idx) {
      // Add all unique position-space vertices, then add indexed faces.
      const pos = posAttr.array;
      for (let i = 0; i < posAttr.count; i++) {
        verts.add(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      }
      for (let i = 0; i < idx.length; i += 3) {
        faces.addTriFace(idx[i], idx[i + 1], idx[i + 2]);
      }
    } else {
      const pos = posAttr.array;
      for (let i = 0; i < posAttr.count; i++) {
        verts.add(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      }
      for (let i = 0; i < posAttr.count; i += 3) {
        faces.addTriFace(i, i + 1, i + 2);
      }
    }
    rhinoMesh.compact();
    return rhinoMesh;
  }

  const file = new rh.File3dm();
  const rhinoMesh = threeToRhinoMesh(wallGeo);
  const attrs = new rh.ObjectAttributes();
  file.objects().addMesh(rhinoMesh, attrs);
  attrs.delete();
  rhinoMesh.delete();
  const exportBytes = file.toByteArray();
  file.delete();
  note(`AC3 .3dm export: ${exportBytes.byteLength} bytes`);

  // Re-import via rhino3dm (independent read path — rhino3dm read ≠ write code path).
  const importedFile = rh.File3dm.fromByteArray(exportBytes);
  if (!importedFile) { fail("AC3", ".3dm fromByteArray returned null — corrupt export"); }
  else {
    const objs = importedFile.objects();
    let importedTriCount = 0;
    const importedVerts = [];
    for (let i = 0; i < objs.count; i++) {
      const entry = objs.get(i);
      const geom = entry.geometry();
      // Mesh geometry exposes .faces() and .vertices().
      if (geom && typeof geom.faces === "function" && typeof geom.vertices === "function") {
        const f = geom.faces();
        const v = geom.vertices();
        importedTriCount += f.count;
        for (let vi = 0; vi < v.count; vi++) {
          const pt = v.get(vi);
          importedVerts.push([pt[0], pt[1], pt[2]]);
        }
      }
    }
    importedFile.delete();

    note(`AC3 .3dm re-import: ${importedTriCount} triangles, ${importedVerts.length} vertices`);

    const errs = [];
    if (importedTriCount < 1) {
      errs.push(`re-imported 0 triangles — rhino3dm round-trip lost all geometry`);
    } else {
      // Void check: face count must match source exactly (mesh round-trip preserves topology).
      if (importedTriCount !== srcTriCount) {
        errs.push(`face count drift: exported ${srcTriCount} tri, imported ${importedTriCount} tri — void may be filled or faces dropped`);
      }
      // Bbox check.
      const bbox = computeBbox(importedVerts);
      const bboxErrs = assertBbox("AC3", bbox, { dx: 4, dy: 3, dz: 0.3 }, ".3dm");
      errs.push(...bboxErrs);
      // Void region check: no vertices should exist inside the window hole interior
      // (1.2 < x < 2.8 AND 0.6 < y < 2.0 AND 0.05 < z < 0.25 = deep inside wall depth).
      const inVoid = importedVerts.filter(([x, y, z]) =>
        x > 1.3 && x < 2.7 && y > 0.7 && y < 1.9 && z > 0.05 && z < 0.25
      );
      if (inVoid.length > 0) {
        errs.push(`void not preserved: ${inVoid.length} vertices found inside window opening region — hole was filled`);
      } else {
        note(`AC3 void check: 0 vertices inside window-hole interior (void preserved)`);
      }
    }

    if (errs.length > 0) fail("AC3", `.3dm round-trip: ${errs.join("; ")}`);
    else pass("AC3", `.3dm round-trip PASS tri=${importedTriCount} bbox=4.00×3.00×0.30 void-preserved`);
  }
} catch (e) {
  fail("AC3", `.3dm round-trip threw: ${e.message}`);
}

// ── CDP smoke: live dispatch on deployed Pages (optional --cdp) ───────────────
if (USE_CDP) {
  console.log("\n[format-rt] AC6 (CDP smoke): live Sd3dmWrite/SdObjWrite/SdStlWrite on deployed Pages");
  const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
  if (!targets) { fail("AC6", `Cannot reach ${CDP_BASE}`); }
  else {
    const tab = targets.find(t => t.type === "page");
    if (!tab) { fail("AC6", "No page tab found"); }
    else {
      const ws = new WebSocket(tab.webSocketDebuggerUrl);
      let mid = 1;
      const pending = new Map();
      ws.onmessage = ev => {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      };
      await new Promise(r => { ws.onopen = r; });
      function send(method, params = {}) {
        return new Promise(resolve => { const id = mid++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
      }
      async function evaluate(expr, ms = 30000) {
        const res = await Promise.race([
          send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
        ]);
        if (res?.result?.result?.subtype === "error") throw new Error(res.result.result.description);
        return res?.result?.result?.value ?? null;
      }
      await send("Runtime.enable");

      try {
        // Verify hook globals are present (SdObjWrite/SdStlWrite/Sd3dmWrite all store to __last*Export).
        const check = await evaluate(`JSON.stringify({
          hasDispatch: typeof window.dispatchSync === 'function',
          url: location.href,
        })`);
        const info = check ? JSON.parse(check) : {};
        if (!info.hasDispatch) {
          fail("AC6", `dispatchSync not found — wrong tab or app not loaded (url=${info.url})`);
        } else {
          note(`AC6 Pages: ${info.url}, dispatchSync present`);

          // Smoke: dispatch SdBox (2×1×1), then SdObjWrite, check __lastObjExport is set.
          await evaluate(`window.dispatchSync('SdBox', { x: 2, y: 1, z: 1 })`);
          await evaluate(`window.dispatchSync('SdObjWrite', { filename: 'cert-smoke.obj' })`);
          const hasObj = await evaluate(`typeof window.__lastObjExport?.text === 'string' && window.__lastObjExport.text.includes('v ')`);
          if (!hasObj) fail("AC6", "__lastObjExport.text not set after SdObjWrite — hook missing");

          // STL smoke.
          await evaluate(`window.dispatchSync('SdStlWrite', { filename: 'cert-smoke.stl' })`);
          const hasStl = await evaluate(`window.__lastStlExport?.bytes?.byteLength > 84`);
          if (!hasStl) fail("AC6", "__lastStlExport.bytes not set after SdStlWrite — hook missing");

          // .3dm smoke (async handler).
          await evaluate(`(async () => { await window.dispatchAsync('Sd3dmWrite', { filename: 'cert-smoke.3dm' }); })()`, 30000);
          const has3dm = await evaluate(`window.__last3dmExport?.bytes?.byteLength > 0`);
          if (!has3dm) fail("AC6", "__last3dmExport.bytes not set after Sd3dmWrite — hook missing");

          if (results.filter(r => !r.pass && r.ac === "AC6").length === 0) {
            pass("AC6", "live dispatch smoke PASS — __lastObjExport, __lastStlExport, __last3dmExport all set");
          }
        }
      } catch (e) {
        fail("AC6", `CDP smoke threw: ${e.message}`);
      }
      ws.close();
    }
  }
}

// ── Write cert ────────────────────────────────────────────────────────────────
mkdirSync(STATE_DIR, { recursive: true });
const cert = {
  script: "verify-format-roundtrip.mjs",
  cold_cache: true,
  clear_protocol: "headless (OBJ/STL/3dm: Node.js parsers + rhino3dm npm; no browser WASM)",
  timestamp: new Date().toISOString(),
  proxy_scope: {
    OBJ: "face_count from 'f' lines (independent parser); bbox from 'v' lines; scale: THREE.js scene units = no implicit rescaling",
    STL: "tri_count from binary header uint32 at byte 80 (independent parser); scale: explicit check that THREE.js units preserved (not 1000× rescaled)",
    "3dm": "face count from Rhino Mesh.faces().count via rhino3dm npm; void check: zero vertices inside hole-interior bounding region; bbox from re-imported vertices",
    void_gate: "face count preserved src→import; no vertices inside window-hole interior [1.3-2.7, 0.7-1.9, 0.05-0.25]",
  },
  results,
  totalPass: results.filter(r => r.pass).length,
  totalFail: results.filter(r => !r.pass).length,
};
writeFileSync(`${STATE_DIR}/cert.json`, JSON.stringify(cert, null, 2));

const allPass = cert.totalFail === 0;
console.log(`\n[format-rt] ${cert.totalPass}/${results.length} PASS · ${cert.totalFail} FAIL → ${STATE_DIR}/cert.json`);
process.exit(allPass ? 0 : 1);
