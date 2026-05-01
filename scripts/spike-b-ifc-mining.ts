/**
 * Spike B — IFC mining dry run.
 *
 * Loads one IFC file via web-ifc, walks all IfcWallStandardCase /
 * IfcSlab / IfcColumn instances, extracts (NL, replicad sequence) pairs,
 * writes JSONL.
 *
 * Acceptance: ≥20/30 sampled pairs round-trip-pass + look semantically
 * reasonable to human eyeball.
 *
 * Usage:
 *   bun scripts/spike-b-ifc-mining.ts --ifc data/ifc/Schependomlaan.ifc --out fixtures/spike-b-pairs.jsonl
 */

import { readFile, writeFile } from "node:fs/promises";
import { walkRepresentation } from "../src/extract/walk-representation.js";
import { emitReplicadSequence } from "../src/extract/emit-sequence.js";
import { renderNL, renderAllVariants, type NLContext } from "../src/extract/nl-template.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ifcPath = args.ifc ?? "data/ifc/Schependomlaan.ifc";
  const outPath = args.out ?? "fixtures/spike-b-pairs.jsonl";

  const { IfcAPI } = await import("web-ifc");
  const api = new IfcAPI();
  await api.Init();

  const buf = await readFile(ifcPath);
  const modelID = api.OpenModel(new Uint8Array(buf));
  console.log(`[spike-b] opened ${ifcPath} as model ${modelID}`);

  const meterScale = detectLengthScale(api, modelID);
  console.log(`[spike-b] length scale to meters: ${meterScale}`);

  // IFC type codes per web-ifc/web-ifc-api spec.
  // IFC4 deprecated WallStandardCase in favor of plain Wall — both kept for
  // 2x3 + 4 corpus coverage.
  const TARGET_TYPES: Array<[string, number]> = [
    ["IfcWall", 2391406946],
    ["IfcWallStandardCase", 3512223829],
    ["IfcSlab", 1529196076],
    ["IfcColumn", 843113511],
    ["IfcBeam", 753842376],
    ["IfcMember", 1073191201],
    ["IfcPlate", 3171933400],
    ["IfcFooting", 900683007],
    ["IfcBuildingElementProxy", 1095909175],
  ];

  const pairs: Array<{
    id: string;
    expressID: number;
    elementType: string;
    nl: string;
    nl_variants: string[];
    sequence: string;
    representation: any;
  }> = [];

  let varCounter = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  for (const [typeName, typeCode] of TARGET_TYPES) {
    let lineIDs;
    try {
      lineIDs = api.GetLineIDsWithType(modelID, typeCode);
    } catch (e) {
      console.warn(`[spike-b] type ${typeName} not in this model, skipping`);
      continue;
    }
    const count = lineIDs.size();
    console.log(`[spike-b] ${typeName}: ${count} instances`);

    for (let i = 0; i < count; i++) {
      const expressID = lineIDs.get(i);
      try {
        const element = api.GetLine(modelID, expressID, true);
        const repr = walkRepresentation(element);
        if (!repr) {
          skipped++;
          skipReasons["no-supported-repr"] = (skipReasons["no-supported-repr"] ?? 0) + 1;
          continue;
        }

        const scaledRepr = scaleRepresentation(repr, meterScale);

        const ctx: NLContext = {
          elementType: typeName,
          name: element.Name?.value,
          representation: scaledRepr,
          loadBearing: extractLoadBearing(api, modelID, expressID),
        };

        const variants = renderAllVariants(ctx);
        const varName = `e${varCounter++}`;
        const sequence = emitReplicadSequence(varName, scaledRepr);

        pairs.push({
          id: `${typeName}-${expressID}`,
          expressID,
          elementType: typeName,
          nl: variants[0],
          nl_variants: variants,
          sequence,
          representation: scaledRepr,
        });
      } catch (e) {
        skipped++;
        const key = (e as Error).message?.slice(0, 60) ?? "unknown";
        skipReasons[key] = (skipReasons[key] ?? 0) + 1;
      }
    }
  }

  const lines = pairs.map((p) => JSON.stringify(p)).join("\n");
  await writeFile(outPath, lines + "\n", "utf-8");

  console.log(`[spike-b] wrote ${pairs.length} pairs to ${outPath}`);
  console.log(`[spike-b] skipped ${skipped}; reasons:`, skipReasons);

  api.CloseModel(modelID);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    const v = argv[i + 1];
    if (k && v) out[k] = v;
  }
  return out;
}

/**
 * Find the model's length unit and return the scale factor to meters.
 * IFC SI prefixes: MILLI=1e-3, CENTI=1e-2, DECI=1e-1, none=1, KILO=1e3.
 * Defaults to 1 if no IfcUnitAssignment found (rare in real models).
 */
function detectLengthScale(api: any, modelID: number): number {
  const IFCUNITASSIGNMENT = 2444336181;
  const IFCSIUNIT = 448429030;
  try {
    const ids = api.GetLineIDsWithType(modelID, IFCSIUNIT);
    for (let i = 0; i < ids.size(); i++) {
      const u = api.GetLine(modelID, ids.get(i), false);
      const unitType = u.UnitType?.value ?? u.UnitType;
      if (unitType !== "LENGTHUNIT") continue;
      const prefix = u.Prefix?.value ?? u.Prefix ?? "";
      const name = u.Name?.value ?? u.Name ?? "";
      if (name !== "METRE") continue;
      switch (prefix) {
        case "MILLI": return 1e-3;
        case "CENTI": return 1e-2;
        case "DECI": return 1e-1;
        case "KILO": return 1e3;
        case "":
        case null:
        case undefined:
          return 1;
        default: return 1;
      }
    }
  } catch {
    /* swallow */
  }
  return 1;
}

function scaleRepresentation(
  repr: any,
  scale: number
): any {
  if (scale === 1) return repr;
  // Placement translation is in the same unit system as profile dims —
  // scale together so [0, 100mm, 0] becomes [0, 0.1m, 0].
  const [tx, ty, tz] = repr.placement.translation;
  const scaledPlacement = {
    ...repr.placement,
    translation: [tx * scale, ty * scale, tz * scale] as [number, number, number],
  };
  switch (repr.kind) {
    case "extruded_rectangle":
      return { ...repr, width: repr.width * scale, height: repr.height * scale, depth: repr.depth * scale, placement: scaledPlacement };
    case "extruded_circle":
      return { ...repr, radius: repr.radius * scale, depth: repr.depth * scale, placement: scaledPlacement };
    case "extruded_polyline":
      return {
        ...repr,
        points: repr.points.map(([x, y]: [number, number]) => [x * scale, y * scale]),
        depth: repr.depth * scale,
        placement: scaledPlacement,
      };
  }
  return repr;
}

function extractLoadBearing(api: any, modelID: number, expressID: number): boolean | undefined {
  try {
    const psets = api.properties?.getPropertySets?.(modelID, expressID, true);
    if (!psets) return undefined;
    for (const ps of psets) {
      if (ps.Name?.value === "Pset_WallCommon" || ps.Name === "Pset_WallCommon") {
        for (const p of ps.HasProperties ?? []) {
          if (p.Name?.value === "LoadBearing" || p.Name === "LoadBearing") {
            const val = p.NominalValue?.value ?? p.NominalValue;
            return typeof val === "boolean" ? val : undefined;
          }
        }
      }
    }
  } catch {
    /* swallow — best-effort */
  }
  return undefined;
}

main().catch((e) => {
  console.error("[spike-b] fatal:", e);
  process.exit(1);
});
