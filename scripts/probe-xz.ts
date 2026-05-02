import { setOC } from "replicad";
import * as tier1 from "../src/tools/tier1.js";

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

function bounds(solid: any) {
  const m = solid.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
  const v = m.vertices;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < minX) minX = v[i]; if (v[i] > maxX) maxX = v[i];
    if (v[i + 1] < minY) minY = v[i + 1]; if (v[i + 1] > maxY) maxY = v[i + 1];
    if (v[i + 2] < minZ) minZ = v[i + 2]; if (v[i + 2] > maxZ) maxZ = v[i + 2];
  }
  return `x=[${minX.toFixed(2)},${maxX.toFixed(2)}] y=[${minY.toFixed(2)},${maxY.toFixed(2)}] z=[${minZ.toFixed(2)},${maxZ.toFixed(2)}]`;
}

async function main() {
  await ensureOC();

  console.log("=== drawRectangle(2, 3).sketchOnPlane(\"XZ\").extrude(4) ===");
  const a = tier1.drawRectangle(2, 3).sketchOnPlane("XZ").extrude(4);
  console.log("  bounds:", bounds(a));

  console.log("=== drawRectangle(2, 3).sketchOnPlane(\"YZ\").extrude(4) ===");
  const b = tier1.drawRectangle(2, 3).sketchOnPlane("YZ").extrude(4);
  console.log("  bounds:", bounds(b));

  console.log("=== triangle gable in XZ ===");
  const tri = tier1.drawPolyline([[-2, 2.5],[2, 2.5],[0, 3.75]]).sketchOnPlane("XZ").extrude(3);
  console.log("  bounds:", bounds(tri));
}

main().catch(console.error);
