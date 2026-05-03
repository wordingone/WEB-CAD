// Validate that data/schultz-target.jsonl's gold answer executes against
// the same tier1 surface the worker uses. Same pattern as
// scripts/web-self-harness.ts.

import { setOC } from "replicad";
import * as tier1 from "../src/tools/tier1.js";
import { readFileSync } from "node:fs";

let _ocReady: Promise<void> | null = null;
async function ensureOC(): Promise<void> {
  if (_ocReady) return _ocReady;
  _ocReady = (async () => {
    const ocModule: any = await import("replicad-opencascadejs/src/replicad_single.js");
    const init = ocModule.default ?? ocModule;
    const oc = await init();
    setOC(oc);
  })();
  return _ocReady;
}

const bindings = {
  drawRectangle: tier1.drawRectangle,
  drawCircle: tier1.drawCircle,
  drawLine: tier1.drawLine,
  drawPolyline: tier1.drawPolyline,
  makeBox: tier1.makeBox,
  makeCylinder: tier1.makeCylinder,
};

await ensureOC();
console.log("OpenCascade ready.");

const row = JSON.parse(readFileSync("data/schultz-target.jsonl", "utf8").trim());
const js = row.messages[2].content as string;
console.log(`Schultz target: ${js.split("\n").length} lines, ${js.length} chars`);

const constNames = Array.from(js.matchAll(/^\s*const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/gm)).map((m) => m[1]);
const lastName = constNames[constNames.length - 1];
console.log(`top-level consts: ${constNames.length}, final: ${lastName}`);

const fn = new Function(...Object.keys(bindings), `${js}\nreturn ${lastName};`);
let result;
try {
  result = fn(...Object.values(bindings));
} catch (e) {
  console.log("FAIL execute:", (e as Error).message);
  process.exit(1);
}

const kind = (result as object).constructor?.name ?? typeof result;
console.log(`result kind: ${kind}`);
if (!["Solid", "Compound", "Shell", "CompSolid"].includes(kind)) {
  console.log("FAIL: not a meshable kind");
  process.exit(1);
}

const m = (result as any).mesh({ tolerance: 0.05, angularTolerance: 0.3 });
const tris = (m.triangles as Uint32Array | number[]).length / 3;
const verts = (m.vertices as Float32Array | number[]).length / 3;
console.log(`mesh: ${tris} triangles, ${verts} vertices`);

console.log("PASS  schultz-target executes + meshes against tier1");
