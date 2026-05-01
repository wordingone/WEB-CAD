import { readFile } from "node:fs/promises";
import { walkRepresentation } from "../src/extract/walk-representation.js";

const { IfcAPI } = await import("web-ifc");
const api = new IfcAPI();
await api.Init();
const buf = await readFile("data/ifc/bonsai-project0-walls.ifc");
const modelID = api.OpenModel(new Uint8Array(buf));

const lineIDs = api.GetLineIDsWithType(modelID, 2391406946);
const wall = api.GetLine(modelID, lineIDs.get(0), true);

const body = wall.Representation.Representations.find((s: any) => s.RepresentationIdentifier?.value === "Body");
console.log("body.Items[0].constructor.name:", body.Items[0].constructor?.name);
let cur = body.Items[0];
let depth = 0;
while (cur && depth < 5) {
  const cn = cur.constructor?.name;
  console.log(`  depth=${depth} ctor=${cn} type=${cur.type}`);
  if (cn === "IfcExtrudedAreaSolid") {
    console.log(`    SweptArea.ctor=${cur.SweptArea?.constructor?.name} Depth=${cur.Depth?.value ?? cur.Depth}`);
    break;
  }
  if (cn === "IfcBooleanClippingResult" || cn === "IfcBooleanResult") {
    cur = cur.FirstOperand;
  } else { break; }
  depth++;
}

let extr = body.Items[0];
while (extr.constructor?.name === "IfcBooleanClippingResult" || extr.constructor?.name === "IfcBooleanResult") {
  extr = extr.FirstOperand;
}
console.log("extr.SweptArea.ctor:", extr.SweptArea?.constructor?.name);
console.log("extr.SweptArea keys:", Object.keys(extr.SweptArea ?? {}));
console.log("OuterCurve.ctor:", extr.SweptArea?.OuterCurve?.constructor?.name);
console.log("OuterCurve keys:", Object.keys(extr.SweptArea?.OuterCurve ?? {}));

console.log("---walkRepresentation---");
const result = walkRepresentation(wall);
console.log(result);

api.CloseModel(modelID);
