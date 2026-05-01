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

  // IFC type codes per web-ifc/web-ifc-api spec.
  const TARGET_TYPES: Array<[string, number]> = [
    ["IfcWallStandardCase", 3512223829],
    ["IfcSlab", 1529196076],
    ["IfcColumn", 843113511],
    ["IfcBeam", 753842376],
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

        const ctx: NLContext = {
          elementType: typeName,
          name: element.Name?.value,
          representation: repr,
          loadBearing: extractLoadBearing(api, modelID, expressID),
        };

        const variants = renderAllVariants(ctx);
        const varName = `e${varCounter++}`;
        const sequence = emitReplicadSequence(varName, repr);

        pairs.push({
          id: `${typeName}-${expressID}`,
          expressID,
          elementType: typeName,
          nl: variants[0],
          nl_variants: variants,
          sequence,
          representation: repr,
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
