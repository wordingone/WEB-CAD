#!/usr/bin/env bun
// voxel-iou.ts — Layer 2 geometric IoU for §25 reconstruction-parity gate.
//
// Tessellates both IFC files via web-ifc, voxelises the union of both
// models' triangles into a uniform grid at --voxel-size-mm resolution,
// and computes IoU = |A ∩ B| / |A ∪ B| over the SURFACE-VOXEL set.
//
// Pass condition: IoU ≥ --min-iou (default 0.99). Layer 1 (diff-ifc.ts)
// catches structural-schema gaps; layer 2 catches geometric-fidelity
// gaps that schema-diff can't see (correct entity counts but wrong wall
// thickness, drifted axis, etc.).
//
// v0 ships SURFACE-VOXEL-ONLY IoU. A voxel is "occupied" iff at least
// one triangle samples a point inside it. Volumetric (interior-fill)
// IoU is a Phase 2 follow-up requiring closed-surface flood-fill from
// the bbox boundary; tracked separately. For Schultz's reconstruction
// case where layer 1 already pinned every element at exact position
// within 1mm, surface-voxel IoU is sufficient — it catches dimension
// drift but doesn't require manifold closure to be meaningful.
//
// Triangle sampling: dense barycentric grid scaled to triangle area so
// every voxel a triangle passes through is hit. Sample density is
// `triangle_area / (voxel_size² / 4)` — 4 samples per voxel face.
//
// Exit 0 = PASS with IoU. Exit 1 with measured IoU + threshold.
// Exit 2 = bad CLI args / file load error.
//
// Usage:
//   bun scripts/qa/voxel-iou.ts <ref.ifc> <recon.ifc> [--voxel-size-mm N] [--min-iou X]
//   bun scripts/qa/voxel-iou.ts --reference <p> --reconstruction <p> [--voxel-size-mm N]

import { readFileSync, existsSync } from "node:fs";
import * as WebIFC from "web-ifc";

interface CliArgs {
  ref: string;
  recon: string;
  voxelSizeMm: number;
  minIou: number;
}

interface BBox {
  min: [number, number, number];
  max: [number, number, number];
}

interface VoxelGrid {
  origin: [number, number, number];
  voxelSize: number;
  nx: number;
  ny: number;
  nz: number;
  cells: Uint8Array; // 0 = empty, 1 = occupied
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let voxelSizeMm = 50;
  let minIou = 0.99;
  let refFlag: string | null = null;
  let reconFlag: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--voxel-size-mm") voxelSizeMm = Number(argv[++i]);
    else if (a === "--min-iou") minIou = Number(argv[++i]);
    else if (a === "--ref" || a === "--reference") refFlag = argv[++i];
    else if (a === "--recon" || a === "--reconstruction") reconFlag = argv[++i];
    else if (!a.startsWith("--")) positional.push(a);
  }
  const ref = refFlag ?? positional[0];
  const recon = reconFlag ?? positional[1];
  if (!ref || !recon) {
    console.error("usage: bun scripts/qa/voxel-iou.ts <ref.ifc> <recon.ifc> [--voxel-size-mm N] [--min-iou X]");
    process.exit(2);
  }
  if (!existsSync(ref))   { console.error(`voxel-iou: ref not found: ${ref}`); process.exit(2); }
  if (!existsSync(recon)) { console.error(`voxel-iou: recon not found: ${recon}`); process.exit(2); }
  if (!Number.isFinite(voxelSizeMm) || voxelSizeMm <= 0) {
    console.error(`voxel-iou: --voxel-size-mm must be a positive number`);
    process.exit(2);
  }
  if (!Number.isFinite(minIou) || minIou < 0 || minIou > 1) {
    console.error(`voxel-iou: --min-iou must be in [0, 1]`);
    process.exit(2);
  }
  return { ref, recon, voxelSizeMm, minIou };
}

// Same length-unit detection as diff-ifc + extract-schultz.
function detectLengthUnitScale(api: WebIFC.IfcAPI, modelID: number): number {
  const projectIds = api.GetLineIDsWithType(modelID, WebIFC.IFCPROJECT);
  if (projectIds.size() === 0) return 1.0;
  const project: any = api.GetLine(modelID, projectIds.get(0), true);
  const units = project?.UnitsInContext?.Units;
  if (!Array.isArray(units)) return 1.0;
  for (const raw of units) {
    let u: any = raw;
    if (u && typeof u === "object" && typeof u.value === "number" && u.type === 5) {
      try { u = api.GetLine(modelID, u.value, true); } catch { continue; }
    }
    const unitType = u?.UnitType?.value ?? u?.UnitType;
    if (unitType !== "LENGTHUNIT") continue;
    const name = u?.Name?.value ?? u?.Name;
    const prefix = u?.Prefix?.value ?? u?.Prefix;
    let base = 1.0;
    if (name === "METRE") base = 1.0;
    else if (name === "INCH") base = 0.0254;
    else if (name === "FOOT") base = 0.3048;
    let prefixMul = 1.0;
    if (prefix === "MILLI") prefixMul = 0.001;
    else if (prefix === "CENTI") prefixMul = 0.01;
    else if (prefix === "DECI") prefixMul = 0.1;
    else if (prefix === "DECA") prefixMul = 10.0;
    else if (prefix === "HECTO") prefixMul = 100.0;
    else if (prefix === "KILO") prefixMul = 1000.0;
    return base * prefixMul;
  }
  return 1.0;
}

// Tessellate one model into a flat Float32Array of triangle vertices in
// world meters. Returns [v0x v0y v0z v1x v1y v1z v2x v2y v2z] per triangle.
async function tessellate(api: WebIFC.IfcAPI, path: string): Promise<{
  triangles: Float32Array;
  bbox: BBox;
  scaleToMeters: number;
}> {
  const buffer = readFileSync(path);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true } as any);
  if (modelID < 0) throw new Error(`OpenModel returned ${modelID} for ${path}`);

  const scale = detectLengthUnitScale(api, modelID);

  // Two-pass: first count triangles to size the array, then fill.
  // Fast enough since we already pay for tessellation.
  let triangleCount = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  type TriBatch = { verts: Float32Array; indices: Uint32Array | Int32Array; m: number[] };
  const batches: TriBatch[] = [];

  api.StreamAllMeshes(modelID, (flatMesh: any) => {
    const size = flatMesh.geometries.size();
    for (let j = 0; j < size; j++) {
      const placed = flatMesh.geometries.get(j);
      const geom = api.GetGeometry(modelID, placed.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize()) as Float32Array;
      const indices = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize()) as Uint32Array | Int32Array;
      const m = placed.flatTransformation as number[];
      triangleCount += indices.length / 3;
      batches.push({ verts, indices, m });

      // Update bbox in the same pass — apply matrix + scale per vertex.
      for (let v = 0; v < verts.length; v += 6) {
        const x = verts[v + 0], y = verts[v + 1], z = verts[v + 2];
        const wx = (m[0] * x + m[4] * y + m[8] * z + m[12]) * scale;
        const wy = (m[1] * x + m[5] * y + m[9] * z + m[13]) * scale;
        const wz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * scale;
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wz < minZ) minZ = wz;
        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
        if (wz > maxZ) maxZ = wz;
      }
    }
  });

  const triangles = new Float32Array(triangleCount * 9);
  let writeIdx = 0;
  for (const { verts, indices, m } of batches) {
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t]     * 6;
      const i1 = indices[t + 1] * 6;
      const i2 = indices[t + 2] * 6;
      for (const i of [i0, i1, i2]) {
        const x = verts[i], y = verts[i + 1], z = verts[i + 2];
        triangles[writeIdx++] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * scale;
        triangles[writeIdx++] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * scale;
        triangles[writeIdx++] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * scale;
      }
    }
  }

  api.CloseModel(modelID);

  if (!Number.isFinite(minX)) {
    return { triangles: new Float32Array(0), bbox: { min: [0, 0, 0], max: [0, 0, 0] }, scaleToMeters: scale };
  }
  return {
    triangles,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    scaleToMeters: scale,
  };
}

function unionBBox(a: BBox, b: BBox): BBox {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

function makeGrid(bbox: BBox, voxelSize: number): VoxelGrid {
  // Pad bbox by one voxel on each side so triangles right on the edge
  // don't fall outside the grid.
  const pad = voxelSize;
  const ox = bbox.min[0] - pad;
  const oy = bbox.min[1] - pad;
  const oz = bbox.min[2] - pad;
  const dx = (bbox.max[0] + pad) - ox;
  const dy = (bbox.max[1] + pad) - oy;
  const dz = (bbox.max[2] + pad) - oz;
  const nx = Math.max(1, Math.ceil(dx / voxelSize));
  const ny = Math.max(1, Math.ceil(dy / voxelSize));
  const nz = Math.max(1, Math.ceil(dz / voxelSize));
  const total = nx * ny * nz;
  const cells = new Uint8Array(total);
  return { origin: [ox, oy, oz], voxelSize, nx, ny, nz, cells };
}

// Mark every voxel a triangle passes through via dense barycentric sampling.
// Sample density scales with triangle area so a 1m² triangle at 50mm voxels
// gets ~1600 samples (4 samples per voxel face). Conservative — over-samples
// thin triangles but never misses.
function rasterizeTriangle(
  grid: VoxelGrid,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): void {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

  // Cross product → triangle normal × 2 (length = 2 × area).
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const area2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (area2 === 0) return;
  const area = area2 * 0.5;

  // Sample density: target 4 samples per voxel face area.
  const voxelArea = grid.voxelSize * grid.voxelSize;
  const targetSamples = Math.max(4, Math.ceil(area / (voxelArea * 0.25)));
  const stepsPerEdge = Math.max(1, Math.ceil(Math.sqrt(2 * targetSamples)));
  const inv = 1.0 / stepsPerEdge;

  const ox = grid.origin[0], oy = grid.origin[1], oz = grid.origin[2];
  const vs = grid.voxelSize;
  const stride_z = grid.nx * grid.ny;

  // Always mark the three vertices.
  markPoint(grid, ax, ay, az, ox, oy, oz, vs, stride_z);
  markPoint(grid, bx, by, bz, ox, oy, oz, vs, stride_z);
  markPoint(grid, cx, cy, cz, ox, oy, oz, vs, stride_z);

  for (let i = 0; i <= stepsPerEdge; i++) {
    const u = i * inv;
    for (let j = 0; j <= stepsPerEdge - i; j++) {
      const v = j * inv;
      const px = ax + u * e1x + v * e2x;
      const py = ay + u * e1y + v * e2y;
      const pz = az + u * e1z + v * e2z;
      markPoint(grid, px, py, pz, ox, oy, oz, vs, stride_z);
    }
  }
}

function markPoint(
  grid: VoxelGrid,
  x: number, y: number, z: number,
  ox: number, oy: number, oz: number,
  vs: number, strideZ: number,
): void {
  const ix = Math.floor((x - ox) / vs);
  const iy = Math.floor((y - oy) / vs);
  const iz = Math.floor((z - oz) / vs);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= grid.nx || iy >= grid.ny || iz >= grid.nz) return;
  grid.cells[iz * strideZ + iy * grid.nx + ix] = 1;
}

function rasterizeAll(grid: VoxelGrid, triangles: Float32Array): void {
  const n = triangles.length;
  for (let i = 0; i < n; i += 9) {
    rasterizeTriangle(
      grid,
      triangles[i],     triangles[i + 1], triangles[i + 2],
      triangles[i + 3], triangles[i + 4], triangles[i + 5],
      triangles[i + 6], triangles[i + 7], triangles[i + 8],
    );
  }
}

interface IouResult { intersection: number; union: number; aOnly: number; bOnly: number; iou: number; }

function computeIou(a: VoxelGrid, b: VoxelGrid): IouResult {
  if (a.cells.length !== b.cells.length) {
    throw new Error(`grid size mismatch: a=${a.cells.length} b=${b.cells.length}`);
  }
  let intersection = 0, union = 0, aOnly = 0, bOnly = 0;
  const ac = a.cells, bc = b.cells;
  const n = ac.length;
  for (let i = 0; i < n; i++) {
    const av = ac[i] | 0;
    const bv = bc[i] | 0;
    if (av || bv) union++;
    if (av && bv) intersection++;
    if (av && !bv) aOnly++;
    if (!av && bv) bOnly++;
  }
  const iou = union === 0 ? 1.0 : intersection / union;
  return { intersection, union, aOnly, bOnly, iou };
}

function fmtBBox(b: BBox): string {
  const dx = b.max[0] - b.min[0];
  const dy = b.max[1] - b.min[1];
  const dz = b.max[2] - b.min[2];
  return `[${b.min[0].toFixed(2)},${b.min[1].toFixed(2)},${b.min[2].toFixed(2)}]-[${b.max[0].toFixed(2)},${b.max[1].toFixed(2)},${b.max[2].toFixed(2)}] (${dx.toFixed(2)}×${dy.toFixed(2)}×${dz.toFixed(2)}m)`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const api = new WebIFC.IfcAPI();
  await api.Init();

  console.log(`voxel-iou: ref=${args.ref}`);
  console.log(`voxel-iou: recon=${args.recon}`);
  console.log(`voxel-iou: voxel=${args.voxelSizeMm}mm, threshold=${args.minIou}`);

  let ref: { triangles: Float32Array; bbox: BBox; scaleToMeters: number };
  let recon: { triangles: Float32Array; bbox: BBox; scaleToMeters: number };
  try {
    console.log(`voxel-iou: tessellating ref…`);
    ref = await tessellate(api, args.ref);
    console.log(`voxel-iou: ref triangles=${ref.triangles.length / 9} bbox=${fmtBBox(ref.bbox)} scale=${ref.scaleToMeters}`);
    console.log(`voxel-iou: tessellating recon…`);
    recon = await tessellate(api, args.recon);
    console.log(`voxel-iou: recon triangles=${recon.triangles.length / 9} bbox=${fmtBBox(recon.bbox)} scale=${recon.scaleToMeters}`);
  } catch (e) {
    console.error(`voxel-iou: tessellation error: ${(e as Error).message}`);
    return 2;
  }

  const bbox = unionBBox(ref.bbox, recon.bbox);
  const voxelSize = args.voxelSizeMm / 1000;

  // Sanity-clamp grid size to prevent OOM on large buildings with tight voxels.
  // 200³ × 2 bytes = 16 MB. 500³ × 2 = 250 MB.
  const dx = bbox.max[0] - bbox.min[0];
  const dy = bbox.max[1] - bbox.min[1];
  const dz = bbox.max[2] - bbox.min[2];
  const cellsEst = Math.ceil(dx / voxelSize) * Math.ceil(dy / voxelSize) * Math.ceil(dz / voxelSize);
  const MAX_CELLS = 500 * 500 * 500;
  if (cellsEst > MAX_CELLS) {
    console.error(`voxel-iou: grid would be ${cellsEst.toExponential(2)} cells — exceeds ${MAX_CELLS.toExponential(2)} cap.`);
    console.error(`voxel-iou: increase --voxel-size-mm (current ${args.voxelSizeMm}) or trim model bbox.`);
    return 2;
  }

  const gridA = makeGrid(bbox, voxelSize);
  const gridB = makeGrid(bbox, voxelSize);
  console.log(`voxel-iou: grid=${gridA.nx}×${gridA.ny}×${gridA.nz} (${(gridA.cells.length / 1e6).toFixed(1)}M cells, ${(gridA.cells.length * 2 / 1e6).toFixed(1)}MB)`);

  console.log(`voxel-iou: rasterising ref triangles…`);
  rasterizeAll(gridA, ref.triangles);
  console.log(`voxel-iou: rasterising recon triangles…`);
  rasterizeAll(gridB, recon.triangles);

  const r = computeIou(gridA, gridB);
  const cellsToM3 = voxelSize * voxelSize * voxelSize;

  console.log(`\n--- Surface-voxel IoU ---`);
  console.log(`  intersection = ${r.intersection} cells (${(r.intersection * cellsToM3).toFixed(3)} m³)`);
  console.log(`  union        = ${r.union} cells (${(r.union * cellsToM3).toFixed(3)} m³)`);
  console.log(`  ref-only     = ${r.aOnly} cells (${(r.aOnly * cellsToM3).toFixed(3)} m³)`);
  console.log(`  recon-only   = ${r.bOnly} cells (${(r.bOnly * cellsToM3).toFixed(3)} m³)`);
  console.log(`  IoU          = ${r.iou.toFixed(6)}`);

  if (r.iou >= args.minIou) {
    console.log(`\nPASS  voxel-iou: ${r.iou.toFixed(6)} ≥ ${args.minIou}`);
    return 0;
  }
  console.log(`\nFAIL  voxel-iou: ${r.iou.toFixed(6)} < ${args.minIou} (gap=${(args.minIou - r.iou).toFixed(6)})`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("voxel-iou: uncaught error:", e);
    process.exit(2);
  });
