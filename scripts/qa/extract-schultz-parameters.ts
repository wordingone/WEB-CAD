#!/usr/bin/env bun
// extract-schultz-parameters.ts — per-storey element parameter dump for §25
// reconstruction-parity walkthrough.
//
// Walks Schultz_Residence.ifc (or any architectural IFC) and emits one
// markdown table per IfcBuildingStorey with the basic parameters Eli needs
// to recreate every element in the web app. Phase 1 ships the foundation:
// id/type/name/world position/bbox/material name (where extractable).
// Type-specific parameters (wall start/end, door host_id, profile) are
// follow-up extensions and are commented as TODO inline.
//
// Why a script and not a hand-extraction: 549 elements × 8 fields = 4392
// values is ~8h of error-prone copy-paste from raw IFC text. The script
// is run-once-and-trust because the source data is the IFC the gate
// itself diffs against.
//
// Usage: bun scripts/qa/extract-schultz-parameters.ts [<ifc-path>]
//        Defaults to web/public/samples/Schultz_Residence.ifc
//        Output: docs/qa/schultz-reconstruction-tables/{README.md, <storey>.md}

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import * as WebIFC from "web-ifc";

interface ElementRow {
  expressID: number;
  className: string;
  name: string | null;
  storey: string;
  position: [number, number, number] | null;
  bboxMin: [number, number, number] | null;
  bboxMax: [number, number, number] | null;
}

interface StoreyInfo {
  expressID: number;
  name: string;
  elevationM: number | null;
  index: number;
}

const ARCH_TYPES: Array<[string, number]> = [
  ["IfcWall",                WebIFC.IFCWALL],
  ["IfcWallStandardCase",    WebIFC.IFCWALLSTANDARDCASE],
  ["IfcSlab",                WebIFC.IFCSLAB],
  ["IfcDoor",                WebIFC.IFCDOOR],
  ["IfcWindow",              WebIFC.IFCWINDOW],
  ["IfcStair",               WebIFC.IFCSTAIR],
  ["IfcStairFlight",         WebIFC.IFCSTAIRFLIGHT],
  ["IfcColumn",              WebIFC.IFCCOLUMN],
  ["IfcBeam",                WebIFC.IFCBEAM],
  ["IfcRailing",             WebIFC.IFCRAILING],
  ["IfcRoof",                WebIFC.IFCROOF],
  ["IfcSpace",               WebIFC.IFCSPACE],
];

// Same length-unit detection as diff-ifc.ts. METRE=1, FOOT=0.3048, etc.
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

function safeName(api: WebIFC.IfcAPI, modelID: number, expressID: number): string | null {
  try {
    const line: any = api.GetLine(modelID, expressID, false);
    const v = line?.Name?.value;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function buildStoreyIndex(api: WebIFC.IfcAPI, modelID: number, scale: number): {
  storeyByExpressID: Map<number, StoreyInfo>;
  elementToStorey: Map<number, number>;
} {
  const storeyIds = api.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGSTOREY);
  const storeysRaw: StoreyInfo[] = [];
  for (let i = 0; i < storeyIds.size(); i++) {
    const id = storeyIds.get(i);
    let name = `Storey-${id}`;
    let elev: number | null = null;
    try {
      const line: any = api.GetLine(modelID, id, false);
      if (typeof line?.Name?.value === "string" && line.Name.value.length > 0) name = line.Name.value;
      if (typeof line?.Elevation?.value === "number") elev = line.Elevation.value * scale;
    } catch { /* keep defaults */ }
    storeysRaw.push({ expressID: id, name, elevationM: elev, index: 0 });
  }
  storeysRaw.sort((a, b) => {
    if (a.elevationM !== null && b.elevationM !== null) return a.elevationM - b.elevationM;
    if (a.elevationM !== null) return -1;
    if (b.elevationM !== null) return 1;
    return a.expressID - b.expressID;
  });
  storeysRaw.forEach((s, idx) => { s.index = idx + 1; });
  const storeyByExpressID = new Map<number, StoreyInfo>();
  for (const s of storeysRaw) storeyByExpressID.set(s.expressID, s);

  // Walk IfcRelContainedInSpatialStructure to map element → storey.
  const elementToStorey = new Map<number, number>();
  const relIds = api.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
  for (let i = 0; i < relIds.size(); i++) {
    const relID = relIds.get(i);
    try {
      const rel: any = api.GetLine(modelID, relID, false);
      const structRef = rel?.RelatingStructure;
      const structID = typeof structRef?.value === "number" ? structRef.value : null;
      if (structID === null || !storeyByExpressID.has(structID)) continue;
      const elements = rel?.RelatedElements;
      if (!Array.isArray(elements)) continue;
      for (const elRef of elements) {
        const elID = typeof elRef?.value === "number" ? elRef.value : null;
        if (elID !== null) elementToStorey.set(elID, structID);
      }
    } catch { /* ignore malformed rel */ }
  }

  return { storeyByExpressID, elementToStorey };
}

function buildPositionAndBBoxIndex(api: WebIFC.IfcAPI, modelID: number, scale: number): Map<number, {
  position: [number, number, number];
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}> {
  const out = new Map<number, { position: [number, number, number]; bboxMin: [number, number, number]; bboxMax: [number, number, number]; }>();
  api.StreamAllMeshes(modelID, (flatMesh: any) => {
    const id = flatMesh.expressID as number;
    const size = flatMesh.geometries.size();
    if (size === 0) return;
    let posSet = false;
    let position: [number, number, number] = [0, 0, 0];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let j = 0; j < size; j++) {
      const placed = flatMesh.geometries.get(j);
      const geom = api.GetGeometry(modelID, placed.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize()) as Float32Array;
      const m = placed.flatTransformation as number[];
      if (!posSet) {
        position = [m[12] * scale, m[13] * scale, m[14] * scale];
        posSet = true;
      }
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
    if (!posSet) return;
    if (!Number.isFinite(minX)) {
      out.set(id, { position, bboxMin: position, bboxMax: position });
    } else {
      out.set(id, { position, bboxMin: [minX, minY, minZ], bboxMax: [maxX, maxY, maxZ] });
    }
  });
  return out;
}

function fmtCoord(n: number): string { return n.toFixed(3); }
function fmtName(n: string | null): string {
  if (n === null) return "-";
  return n.replace(/\|/g, "\\|").slice(0, 60);
}

function renderStoreyTable(rows: ElementRow[], storey: StoreyInfo): string {
  const elev = storey.elevationM !== null ? `${storey.elevationM.toFixed(3)}m` : "n/a";
  const lines: string[] = [];
  lines.push(`# ${storey.name} — storey #${storey.index}`);
  lines.push("");
  lines.push(`Elevation: ${elev}  ·  Elements: ${rows.length}`);
  lines.push("");

  const byClass = new Map<string, ElementRow[]>();
  for (const r of rows) {
    if (!byClass.has(r.className)) byClass.set(r.className, []);
    byClass.get(r.className)!.push(r);
  }
  const classOrder = ARCH_TYPES.map(([n]) => n);

  for (const cls of classOrder) {
    const list = byClass.get(cls);
    if (!list || list.length === 0) continue;
    lines.push(`## ${cls} (${list.length})`);
    lines.push("");
    lines.push("| id | name | x | y | z | dx | dy | dz |");
    lines.push("|---|---|---|---|---|---|---|---|");
    list.sort((a, b) => a.expressID - b.expressID);
    for (const r of list) {
      const pos = r.position ?? [0, 0, 0];
      let dx = 0, dy = 0, dz = 0;
      if (r.bboxMin && r.bboxMax) {
        dx = r.bboxMax[0] - r.bboxMin[0];
        dy = r.bboxMax[1] - r.bboxMin[1];
        dz = r.bboxMax[2] - r.bboxMin[2];
      }
      lines.push(
        `| ${r.expressID} | ${fmtName(r.name)} ` +
        `| ${fmtCoord(pos[0])} | ${fmtCoord(pos[1])} | ${fmtCoord(pos[2])} ` +
        `| ${fmtCoord(dx)} | ${fmtCoord(dy)} | ${fmtCoord(dz)} |`,
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("All coordinates are in meters (file's native unit normalised via `IfcSIUnit`).");
  lines.push("Bounding-box dx/dy/dz are world-axis-aligned (post-`COORDINATE_TO_ORIGIN`).");
  lines.push("");
  lines.push("Phase-1 fields only. Phase-2 follow-up adds wall start/end axis,");
  lines.push("door/window host_id + position-along-wall, profile cross-section, and material layers.");
  return lines.join("\n");
}

function renderReadme(
  storeys: StoreyInfo[],
  countsByClass: Map<string, number>,
  countsByStorey: Map<number, Map<string, number>>,
  scaleToMeters: number,
  ifcPath: string,
): string {
  const total = [...countsByClass.values()].reduce((a, b) => a + b, 0);
  const lines: string[] = [];
  lines.push(`# Schultz Residence reconstruction parameter tables`);
  lines.push("");
  lines.push(`Source: \`${ifcPath}\``);
  lines.push(`File length scale: ${scaleToMeters} (file unit → meters; ${scaleToMeters === 0.3048 ? "FOOT" : scaleToMeters === 1 ? "METRE" : "custom"})`);
  lines.push(`Total architectural elements: **${total}** across ${storeys.length} storeys`);
  lines.push("");
  lines.push("## Per-class totals");
  lines.push("");
  lines.push("| class | count |");
  lines.push("|---|---|");
  for (const [n] of ARCH_TYPES) {
    const c = countsByClass.get(n) ?? 0;
    if (c > 0) lines.push(`| ${n} | ${c} |`);
  }
  lines.push("");
  lines.push("## Storeys (sorted by elevation, low → high)");
  lines.push("");
  lines.push("| # | storey | elevation (m) | elements | file |");
  lines.push("|---|---|---|---|---|");
  for (const s of storeys) {
    const elev = s.elevationM !== null ? s.elevationM.toFixed(3) : "n/a";
    const total = [...(countsByStorey.get(s.expressID) ?? new Map()).values()].reduce((a, b) => a + b, 0);
    const slug = storeySlug(s);
    lines.push(`| ${s.index} | ${s.name} | ${elev} | ${total} | [${slug}.md](./${slug}.md) |`);
  }
  lines.push("");
  lines.push("## Per-storey class breakdown");
  lines.push("");
  const allClasses = ARCH_TYPES.map(([n]) => n).filter((n) => (countsByClass.get(n) ?? 0) > 0);
  lines.push("| storey | " + allClasses.join(" | ") + " |");
  lines.push("|---|" + allClasses.map(() => "---").join("|") + "|");
  for (const s of storeys) {
    const m = countsByStorey.get(s.expressID) ?? new Map();
    const cells = allClasses.map((cls) => String(m.get(cls) ?? 0));
    lines.push(`| ${s.name} | ` + cells.join(" | ") + " |");
  }
  lines.push("");
  lines.push("## Reconstruction sequencing recommendation");
  lines.push("");
  lines.push("Walk storeys low → high. Within a storey:");
  lines.push("");
  lines.push("1. IfcBuildingStorey itself (set elevation in scene before placing elements)");
  lines.push("2. IfcSlab (floor) — establishes the level surface");
  lines.push("3. IfcWall + IfcWallStandardCase — walls reference slab + storey");
  lines.push("4. IfcColumn + IfcBeam — structural members");
  lines.push("5. IfcDoor + IfcWindow — hosted in walls; place after wall");
  lines.push("6. IfcStair + IfcStairFlight — connect storeys (place after both ends exist)");
  lines.push("7. IfcRailing — usually attached to stairs / balconies");
  lines.push("8. IfcRoof — top storey only");
  lines.push("9. IfcSpace — defined last (logical, not geometric)");
  lines.push("");
  lines.push("After every storey, run:");
  lines.push("```");
  lines.push("bun scripts/qa/diff-ifc.ts <ref> <recon-export>.ifc --tolerance-mm 1");
  lines.push("```");
  lines.push("");
  lines.push("Look at the per-storey delta lines to spot drift early — don't wait until all 549 are placed.");
  return lines.join("\n");
}

function storeySlug(s: StoreyInfo): string {
  const safe = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const idx = String(s.index).padStart(2, "0");
  return `storey-${idx}-${safe || "unnamed"}`;
}

async function main(): Promise<number> {
  const ifcPath = process.argv[2] ?? "web/public/samples/Schultz_Residence.ifc";
  if (!existsSync(ifcPath)) {
    console.error(`extract: file not found: ${ifcPath}`);
    return 2;
  }

  const api = new WebIFC.IfcAPI();
  await api.Init();

  const buffer = readFileSync(ifcPath);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true } as any);
  if (modelID < 0) { console.error(`extract: OpenModel returned ${modelID}`); return 2; }

  const scale = detectLengthUnitScale(api, modelID);
  console.log(`extract: ${ifcPath} (scale=${scale})`);

  const { storeyByExpressID, elementToStorey } = buildStoreyIndex(api, modelID, scale);
  const storeys = [...storeyByExpressID.values()].sort((a, b) => a.index - b.index);
  console.log(`extract: ${storeys.length} storeys`);

  const posIndex = buildPositionAndBBoxIndex(api, modelID, scale);

  // Default storey for elements that lack containment relation. Group as
  // "unassigned" so the reconstruction reviewer can place them by hand.
  const UNASSIGNED_ID = -1;
  const unassignedInfo: StoreyInfo = {
    expressID: UNASSIGNED_ID,
    name: "Unassigned",
    elevationM: null,
    index: storeys.length + 1,
  };

  const rowsByStorey = new Map<number, ElementRow[]>();
  const countsByClass = new Map<string, number>();
  const countsByStorey = new Map<number, Map<string, number>>();

  for (const [className, code] of ARCH_TYPES) {
    const ids = api.GetLineIDsWithType(modelID, code);
    for (let i = 0; i < ids.size(); i++) {
      const expressID = ids.get(i);
      const storeyID = elementToStorey.get(expressID) ?? UNASSIGNED_ID;
      const storey = storeyByExpressID.get(storeyID) ?? unassignedInfo;
      const row: ElementRow = {
        expressID,
        className,
        name: safeName(api, modelID, expressID),
        storey: storey.name,
        position: posIndex.get(expressID)?.position ?? null,
        bboxMin: posIndex.get(expressID)?.bboxMin ?? null,
        bboxMax: posIndex.get(expressID)?.bboxMax ?? null,
      };
      if (!rowsByStorey.has(storeyID)) rowsByStorey.set(storeyID, []);
      rowsByStorey.get(storeyID)!.push(row);
      countsByClass.set(className, (countsByClass.get(className) ?? 0) + 1);
      let storeyCounts = countsByStorey.get(storeyID);
      if (!storeyCounts) { storeyCounts = new Map(); countsByStorey.set(storeyID, storeyCounts); }
      storeyCounts.set(className, (storeyCounts.get(className) ?? 0) + 1);
    }
  }

  const outDir = resolve("docs/qa/schultz-reconstruction-tables");
  mkdirSync(outDir, { recursive: true });

  const allStoreysForReadme = [...storeys];
  if (rowsByStorey.has(UNASSIGNED_ID)) allStoreysForReadme.push(unassignedInfo);

  const readme = renderReadme(allStoreysForReadme, countsByClass, countsByStorey, scale, ifcPath);
  writeFileSync(resolve(outDir, "README.md"), readme);

  for (const s of allStoreysForReadme) {
    const rows = rowsByStorey.get(s.expressID) ?? [];
    const slug = storeySlug(s);
    const md = renderStoreyTable(rows, s);
    writeFileSync(resolve(outDir, `${slug}.md`), md);
  }

  api.CloseModel(modelID);

  const total = [...countsByClass.values()].reduce((a, b) => a + b, 0);
  console.log(`extract: wrote ${allStoreysForReadme.length} storey files + README.md to ${outDir}`);
  console.log(`extract: ${total} elements (${[...countsByClass.entries()].map(([k, v]) => `${k}=${v}`).join(", ")})`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("extract: uncaught error:", e);
    process.exit(2);
  });
