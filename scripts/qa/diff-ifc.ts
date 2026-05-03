#!/usr/bin/env bun
// diff-ifc.ts — IFC structural diff for §25 reconstruction-parity gate.
//
// Compares two IFC files at three layers, defining what "100% parity" means
// in code for the §25 reconstruction-parity gate of full-smoke-screenplay.md:
//
//   Layer 1a  entity-class counts per architectural type — must match exactly
//   Layer 1b  per-element type+position pairing within tolerance (default 1mm)
//   Layer 1c  IfcRel* relation cardinality — must match per relation class
//
// Files are normalised to meters using each file's IfcSIUnit declaration so
// the same `--tolerance-mm` value is meaningful regardless of file units.
// Greedy nearest-neighbour pairing within class — sufficient for the kinds
// of mistakes this gate exists to catch (placement drift, missing element,
// extra element, spurious class).
//
// Exit 0 = PASS with summary. Exit 1 with structured delta report.
// Exit 2 = bad CLI args / file load error.
//
// Usage:
//   bun scripts/qa/diff-ifc.ts <ref.ifc> <recon.ifc> [--tolerance-mm N]
//   bun scripts/qa/diff-ifc.ts --reference <p> --reconstruction <p> [--tolerance-mm N]
//   bun scripts/qa/diff-ifc.ts --ref <p> --recon <p> [--tolerance-mm N]   # short alias

import { readFileSync, existsSync } from "node:fs";
import * as WebIFC from "web-ifc";

interface CliArgs {
  ref: string;
  recon: string;
  toleranceMm: number;
  maxFailures: number;
}

interface ElementRecord {
  expressID: number;
  className: string;
  positionM: [number, number, number] | null;
  name: string | null;
}

interface ModelView {
  path: string;
  modelID: number;
  scaleToMeters: number;
  elementsByClass: Map<string, ElementRecord[]>;
  relCounts: Map<string, number>;
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
  ["IfcBuildingStorey",      WebIFC.IFCBUILDINGSTOREY],
];

const REL_TYPES: Array<[string, number]> = [
  ["IfcRelAggregates",                    WebIFC.IFCRELAGGREGATES],
  ["IfcRelVoidsElement",                  WebIFC.IFCRELVOIDSELEMENT],
  ["IfcRelFillsElement",                  WebIFC.IFCRELFILLSELEMENT],
  ["IfcRelContainedInSpatialStructure",   WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE],
  ["IfcRelConnectsElements",              WebIFC.IFCRELCONNECTSELEMENTS],
  ["IfcRelSpaceBoundary",                 WebIFC.IFCRELSPACEBOUNDARY],
  ["IfcRelAssignsToGroup",                WebIFC.IFCRELASSIGNSTOGROUP],
];

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let toleranceMm = 1.0;
  let refFlag: string | null = null;
  let reconFlag: string | null = null;
  let maxFailures = 20;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tolerance-mm") toleranceMm = Number(argv[++i]);
    else if (a === "--max-failures") maxFailures = Number(argv[++i]);
    else if (a === "--ref" || a === "--reference") refFlag = argv[++i];
    else if (a === "--recon" || a === "--reconstruction") reconFlag = argv[++i];
    else if (!a.startsWith("--")) positional.push(a);
  }
  const ref = refFlag ?? positional[0];
  const recon = reconFlag ?? positional[1];
  if (!ref || !recon) {
    console.error("usage: bun scripts/qa/diff-ifc.ts <ref.ifc> <recon.ifc> [--tolerance-mm N] [--max-failures N]");
    process.exit(2);
  }
  if (!existsSync(ref))   { console.error(`diff-ifc: ref not found: ${ref}`); process.exit(2); }
  if (!existsSync(recon)) { console.error(`diff-ifc: recon not found: ${recon}`); process.exit(2); }
  if (!Number.isFinite(toleranceMm) || toleranceMm <= 0) {
    console.error(`diff-ifc: --tolerance-mm must be a positive number`);
    process.exit(2);
  }
  return { ref, recon, toleranceMm, maxFailures };
}

// Returns the multiplier that converts the file's native length unit to
// meters. METRE=1, MILLI METRE=0.001, FOOT=0.3048, INCH=0.0254. Defaults
// to 1.0 (meters) if no IfcSIUnit with UnitType=LENGTHUNIT is found —
// IFC4's documented default.
function detectLengthUnitScale(api: WebIFC.IfcAPI, modelID: number): number {
  const projectIds = api.GetLineIDsWithType(modelID, WebIFC.IFCPROJECT);
  if (projectIds.size() === 0) return 1.0;
  const project: any = api.GetLine(modelID, projectIds.get(0), true);
  const assign = project?.UnitsInContext;
  const units = assign?.Units;
  if (!Array.isArray(units)) return 1.0;
  for (const raw of units) {
    let u: any = raw;
    // web-ifc may return references {value, type} that need dereferencing.
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

async function loadModel(api: WebIFC.IfcAPI, path: string): Promise<ModelView> {
  const buffer = readFileSync(path);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true } as any);
  if (modelID < 0) throw new Error(`OpenModel returned ${modelID} for ${path}`);

  const scaleToMeters = detectLengthUnitScale(api, modelID);

  const positionByExpressID = new Map<number, [number, number, number]>();
  api.StreamAllMeshes(modelID, (flatMesh: any) => {
    const id = flatMesh.expressID as number;
    if (positionByExpressID.has(id)) return;
    const size = flatMesh.geometries.size();
    if (size === 0) return;
    const placed = flatMesh.geometries.get(0);
    const m = placed.flatTransformation as number[];
    positionByExpressID.set(id, [
      m[12] * scaleToMeters,
      m[13] * scaleToMeters,
      m[14] * scaleToMeters,
    ]);
  });

  const elementsByClass = new Map<string, ElementRecord[]>();
  for (const [name, code] of ARCH_TYPES) {
    const ids = api.GetLineIDsWithType(modelID, code);
    const records: ElementRecord[] = [];
    for (let i = 0; i < ids.size(); i++) {
      const expressID = ids.get(i);
      let elementName: string | null = null;
      try {
        const line: any = api.GetLine(modelID, expressID, false);
        elementName = (line?.Name?.value ?? null) as string | null;
      } catch { /* element may have no Name attr */ }
      records.push({
        expressID,
        className: name,
        positionM: positionByExpressID.get(expressID) ?? null,
        name: elementName,
      });
    }
    if (records.length > 0) elementsByClass.set(name, records);
  }

  const relCounts = new Map<string, number>();
  for (const [name, code] of REL_TYPES) {
    const ids = api.GetLineIDsWithType(modelID, code);
    relCounts.set(name, ids.size());
  }

  return { path, modelID, scaleToMeters, elementsByClass, relCounts };
}

interface CountRow { className: string; refN: number; reconN: number; delta: number; }

function diffCounts(ref: ModelView, recon: ModelView): { rows: CountRow[]; failures: CountRow[] } {
  const allKeys = new Set<string>([...ref.elementsByClass.keys(), ...recon.elementsByClass.keys()]);
  const rows: CountRow[] = [];
  for (const k of [...allKeys].sort()) {
    const r = ref.elementsByClass.get(k)?.length ?? 0;
    const c = recon.elementsByClass.get(k)?.length ?? 0;
    rows.push({ className: k, refN: r, reconN: c, delta: c - r });
  }
  const failures = rows.filter((row) => row.delta !== 0);
  return { rows, failures };
}

function diffRelations(ref: ModelView, recon: ModelView): { rows: CountRow[]; failures: CountRow[] } {
  const rows: CountRow[] = [];
  for (const [name] of REL_TYPES) {
    const r = ref.relCounts.get(name) ?? 0;
    const c = recon.relCounts.get(name) ?? 0;
    rows.push({ className: name, refN: r, reconN: c, delta: c - r });
  }
  const failures = rows.filter((row) => row.delta !== 0);
  return { rows, failures };
}

interface PositionFailure {
  className: string;
  refExpressID: number;
  refPositionM: [number, number, number] | null;
  nearestReconExpressID: number | null;
  nearestDistanceM: number | null;
}

function diffPositions(
  ref: ModelView,
  recon: ModelView,
  toleranceMm: number,
): { matched: number; unmatched: number; failures: PositionFailure[] } {
  const tolerance = toleranceMm / 1000.0;
  const tolSq = tolerance * tolerance;
  const failures: PositionFailure[] = [];
  let matched = 0;
  let unmatched = 0;

  for (const [className, refRecords] of ref.elementsByClass.entries()) {
    const reconRecords = recon.elementsByClass.get(className) ?? [];
    const reconUsed = new Set<number>();
    for (const refEl of refRecords) {
      if (refEl.positionM === null) {
        if (reconRecords.length > 0) { matched++; continue; }
        unmatched++;
        failures.push({
          className,
          refExpressID: refEl.expressID,
          refPositionM: null,
          nearestReconExpressID: null,
          nearestDistanceM: null,
        });
        continue;
      }
      let bestIdx = -1;
      let bestDistSq = Infinity;
      for (let i = 0; i < reconRecords.length; i++) {
        if (reconUsed.has(i)) continue;
        const cp = reconRecords[i].positionM;
        if (cp === null) continue;
        const dx = cp[0] - refEl.positionM[0];
        const dy = cp[1] - refEl.positionM[1];
        const dz = cp[2] - refEl.positionM[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDistSq) { bestDistSq = d2; bestIdx = i; }
      }
      if (bestIdx >= 0 && bestDistSq <= tolSq) {
        reconUsed.add(bestIdx);
        matched++;
      } else {
        unmatched++;
        failures.push({
          className,
          refExpressID: refEl.expressID,
          refPositionM: refEl.positionM,
          nearestReconExpressID: bestIdx >= 0 ? reconRecords[bestIdx].expressID : null,
          nearestDistanceM: bestIdx >= 0 ? Math.sqrt(bestDistSq) : null,
        });
      }
    }
  }
  return { matched, unmatched, failures };
}

function formatTable(rows: CountRow[]): string {
  const w = Math.max(20, ...rows.map((r) => r.className.length));
  const lines: string[] = [];
  lines.push(`  ${"class".padEnd(w)}  ${"ref".padStart(6)}  ${"recon".padStart(6)}  ${"delta".padStart(6)}`);
  lines.push(`  ${"-".repeat(w)}  ${"-".repeat(6)}  ${"-".repeat(6)}  ${"-".repeat(6)}`);
  for (const r of rows) {
    const flag = r.delta === 0 ? " " : "*";
    const deltaStr = (r.delta > 0 ? "+" + r.delta : String(r.delta)).padStart(6);
    lines.push(`  ${r.className.padEnd(w)}  ${String(r.refN).padStart(6)}  ${String(r.reconN).padStart(6)}  ${deltaStr}${flag}`);
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const api = new WebIFC.IfcAPI();
  await api.Init();

  console.log(`diff-ifc: ref=${args.ref}`);
  console.log(`diff-ifc: recon=${args.recon}`);
  console.log(`diff-ifc: tolerance=${args.toleranceMm}mm`);

  let ref: ModelView, recon: ModelView;
  try {
    ref = await loadModel(api, args.ref);
    recon = await loadModel(api, args.recon);
  } catch (e) {
    console.error(`diff-ifc: load error: ${(e as Error).message}`);
    return 2;
  }
  console.log(`diff-ifc: ref length-scale=${ref.scaleToMeters} (file→m)`);
  console.log(`diff-ifc: recon length-scale=${recon.scaleToMeters} (file→m)`);

  const counts = diffCounts(ref, recon);
  console.log("\n--- Layer 1a: entity counts ---");
  console.log(formatTable(counts.rows));

  const positions = diffPositions(ref, recon, args.toleranceMm);
  console.log(`\n--- Layer 1b: position pairing (${args.toleranceMm}mm tolerance) ---`);
  console.log(`  matched=${positions.matched}  unmatched=${positions.unmatched}`);
  if (positions.failures.length > 0) {
    const limit = Math.min(args.maxFailures, positions.failures.length);
    console.log(`  first ${limit} unmatched:`);
    for (let i = 0; i < limit; i++) {
      const f = positions.failures[i];
      const pos = f.refPositionM
        ? `(${f.refPositionM[0].toFixed(3)}, ${f.refPositionM[1].toFixed(3)}, ${f.refPositionM[2].toFixed(3)})`
        : "no-placement";
      const dist = f.nearestDistanceM !== null ? `${(f.nearestDistanceM * 1000).toFixed(1)}mm` : "no-candidate";
      console.log(`    ${f.className} #${f.refExpressID} ref=${pos} → nearest dist=${dist}`);
    }
    if (positions.failures.length > limit) {
      console.log(`    ... ${positions.failures.length - limit} more`);
    }
  }

  const rels = diffRelations(ref, recon);
  console.log("\n--- Layer 1c: relation counts ---");
  console.log(formatTable(rels.rows));

  api.CloseModel(ref.modelID);
  api.CloseModel(recon.modelID);

  const refTotalArch = [...ref.elementsByClass.values()].reduce((n, list) => n + list.length, 0);
  const reconTotalArch = [...recon.elementsByClass.values()].reduce((n, list) => n + list.length, 0);

  const allFailures = counts.failures.length + positions.failures.length + rels.failures.length;
  if (allFailures === 0) {
    console.log(`\nPASS  diff-ifc: zero structural delta across all three layers (ref=${refTotalArch}, recon=${reconTotalArch} elements)`);
    return 0;
  }
  console.log(
    `\nFAIL  diff-ifc: ` +
    `${counts.failures.length} count delta(s), ` +
    `${positions.failures.length} unmatched element(s), ` +
    `${rels.failures.length} relation delta(s) ` +
    `(ref=${refTotalArch}, recon=${reconTotalArch} elements)`,
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("diff-ifc: uncaught error:", e);
    process.exit(2);
  });
