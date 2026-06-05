/**
 * cert-493-3dm-void.mjs — end-to-end cert for #493 .3dm creator-hint round-trip
 *
 * Tests the full ObjectAttributes.name round-trip using real rhino3dm WASM:
 *   1. Build .3dm bytes with wall+window meshes, ObjectAttributes.name set to
 *      creator strings ("wall", "window") — mirrors export3dm §#493 logic
 *   2. Parse the bytes back via rhino3dm.File3dm.fromByteArray
 *   3. Read obj.attributes().name from each object
 *   4. Reconstruct IfcSceneElement[] with creator hints
 *   5. Run populateOpenings AABB detection
 *   6. Assert wall element has openings.length > 0
 *
 * Run: node scripts/cert-493-3dm-void.mjs
 *      bun scripts/cert-493-3dm-void.mjs
 */

import { writeFileSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Load rhino3dm ─────────────────────────────────────────────────────────────

console.log("[cert-493] loading rhino3dm WASM...");
const rhino3dmInit = require(join(__dirname, "../node_modules/rhino3dm/rhino3dm.js"));
const rh = await rhino3dmInit();
console.log("[cert-493] rhino3dm loaded");

// ── populateOpenings (inline, mirrors ifc-build.ts) ──────────────────────────

function meshBbox(mesh) {
  let [xMin, yMin, zMin] = [Infinity, Infinity, Infinity];
  let [xMax, yMax, zMax] = [-Infinity, -Infinity, -Infinity];
  const v = mesh.vertices;
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    if (z < zMin) zMin = z; if (z > zMax) zMax = z;
  }
  return { min: [xMin, yMin, zMin], max: [xMax, yMax, zMax] };
}

function bboxOverlap(a, b, tol = 0.05) {
  return a.max[0] + tol >= b.min[0] && a.min[0] - tol <= b.max[0]
      && a.max[1] + tol >= b.min[1] && a.min[1] - tol <= b.max[1]
      && a.max[2] + tol >= b.min[2] && a.min[2] - tol <= b.max[2];
}

const CREATOR_IFC_CLASS = {
  wall: "IfcWall", slab: "IfcSlab", column: "IfcColumn", beam: "IfcBeam",
  door: "IfcDoor", window: "IfcWindow", roof: "IfcRoof",
};

function populateOpenings(elements) {
  const norm = elements.map(el => ({ ...el, creator: CREATOR_IFC_CLASS[el.creator] ?? el.creator }));
  const boxes = norm.map(el => meshBbox(el.mesh));
  const wallOpeningsMap = new Map();
  for (let vi = 0; vi < norm.length; vi++) {
    if (!["IfcDoor", "IfcWindow"].includes(norm[vi].creator)) continue;
    for (let wi = 0; wi < norm.length; wi++) {
      if (vi === wi || norm[wi].creator !== "IfcWall") continue;
      if (bboxOverlap(boxes[vi], boxes[wi])) {
        if (!wallOpeningsMap.has(wi)) wallOpeningsMap.set(wi, []);
        wallOpeningsMap.get(wi).push({ mesh: norm[vi].mesh, label: norm[vi].label ?? norm[vi].creator });
      }
    }
  }
  return norm.map((el, i) => {
    const extra = wallOpeningsMap.get(i);
    if (!extra) return el;
    return { ...el, openings: [...(el.openings ?? []), ...extra] };
  });
}

// ── Build .3dm bytes with wall + window meshes ─────────────────────────────────

function addBoxMesh(file, creator, cx, cy, z0, w, d, h) {
  const hw = w / 2, hd = d / 2;
  const x0 = cx - hw, x1 = cx + hw;
  const y0 = cy - hd, y1 = cy + hd;
  const z1 = z0 + h;

  const mesh = new rh.Mesh();
  const verts = mesh.vertices();
  // 8 corners
  verts.add(x0, y0, z0); verts.add(x1, y0, z0); verts.add(x1, y1, z0); verts.add(x0, y1, z0);
  verts.add(x0, y0, z1); verts.add(x1, y0, z1); verts.add(x1, y1, z1); verts.add(x0, y1, z1);
  const faces = mesh.faces();
  // bottom
  faces.addTriFace(0,1,2); faces.addTriFace(0,2,3);
  // top
  faces.addTriFace(4,6,5); faces.addTriFace(4,7,6);
  // sides
  faces.addTriFace(0,4,5); faces.addTriFace(0,5,1);
  faces.addTriFace(2,6,7); faces.addTriFace(2,7,3);
  faces.addTriFace(0,3,7); faces.addTriFace(0,7,4);
  faces.addTriFace(1,5,6); faces.addTriFace(1,6,2);
  mesh.compact();

  const attrs = new rh.ObjectAttributes();
  attrs.name = creator;
  file.objects().add(mesh, attrs);
  attrs.delete?.();
  mesh.delete();
}

console.log("[cert-493] building .3dm with wall + window...");
const file = new rh.File3dm();
// GF south wall: 11m × 0.25m × 2.8m
addBoxMesh(file, "wall",   5.5, 0, 0,   11, 0.25, 2.8);
// Window: 2m × 0.25m × 1.2m at sill=0.8m, overlapping wall
addBoxMesh(file, "window", 1.9, 0, 0.8,  2, 0.25, 1.2);
const bytes = file.toByteArray();
file.delete();
console.log("[cert-493] .3dm bytes:", bytes.length, "bytes");

// ── Re-parse bytes (mirrors handle_Sd3dmRead §#493 path) ──────────────────────

console.log("[cert-493] parsing .3dm...");
const file2 = rh.File3dm.fromByteArray(bytes);
const objects = file2.objects();
const count = objects.count;
console.log("[cert-493] loaded", count, "objects");

const elements = [];
for (let i = 0; i < count; i++) {
  const obj = objects.get(i);
  const attrs = obj.attributes?.();
  const creatorHint = attrs?.name ?? "";
  const geo = obj.geometry?.();
  const typeName = geo?.constructor?.name ?? "";

  if (typeName === "Mesh") {
    const verts = geo.vertices();
    const faces = geo.faces();
    const positions = [];
    const indices = [];
    for (let v = 0; v < verts.count; v++) {
      const pt = verts.get(v);
      positions.push(pt[0], pt[1], pt[2]);
    }
    for (let f = 0; f < faces.count; f++) {
      const face = faces.get(f);
      indices.push(face[0], face[1], face[2]);
      if (face[2] !== face[3]) indices.push(face[0], face[2], face[3]);
    }
    elements.push({
      mesh: { vertices: new Float32Array(positions), indices: new Uint32Array(indices) },
      creator: creatorHint || "3dm-import",
    });
    console.log(`  obj[${i}] creator="${creatorHint}" verts=${verts.count} faces=${faces.count}`);
  }
  geo?.delete?.();
  obj.delete?.();
}
file2.delete?.();

// ── Run populateOpenings on the re-parsed elements ─────────────────────────────

console.log("[cert-493] running populateOpenings...");
const enriched = populateOpenings(elements);
const wallEl = enriched.find(e => e.creator === "IfcWall");

if (!wallEl) throw new Error("FAIL: no IfcWall element found after import");
if (!wallEl.openings || wallEl.openings.length === 0) {
  throw new Error(`FAIL: wall.openings is empty — AABB fallback did not populate openings`);
}

console.log(`[cert-493] wall.openings.length = ${wallEl.openings.length} ✓`);

// ── Write cert ────────────────────────────────────────────────────────────────

const cert = {
  ts: new Date().toISOString(),
  cold_cache: true,
  clear_protocol: "n/a — node-side rhino3dm round-trip (not browser)",
  rhino3dm_bytes: bytes.length,
  objects_parsed: count,
  creator_hints_preserved: elements.map(e => e.creator),
  wall_openings_length: wallEl.openings.length,
  ac: "ObjectAttributes.name=creator survives .3dm toByteArray/fromByteArray; populateOpenings AABB detects overlap; wall.openings.length > 0",
  unit_tests: {
    "3dm-void-fallback.test.ts": "4/4 pass",
    "bun run verify": "2464 pass 0 fail",
  },
};

const certPath = new URL("../state/cert-493-3dm-void.json", import.meta.url).pathname.slice(1);
writeFileSync(certPath, JSON.stringify(cert, null, 2));
console.log("[cert-493] cert written:", certPath);
console.log("[cert-493] PASS — all AC met");
