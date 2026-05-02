// Probe each tier1 primitive in isolation to learn the conventions:
// where is the origin? Centered? Base-at-origin? Axis defaults?
// Pin them down so I can compute correct expected bounds.

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

function bounds(solid: any): { x: [number, number]; y: [number, number]; z: [number, number] } {
  const m = solid.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
  const v = m.vertices;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < minX) minX = v[i]; if (v[i] > maxX) maxX = v[i];
    if (v[i + 1] < minY) minY = v[i + 1]; if (v[i + 1] > maxY) maxY = v[i + 1];
    if (v[i + 2] < minZ) minZ = v[i + 2]; if (v[i + 2] > maxZ) maxZ = v[i + 2];
  }
  return { x: [minX, maxX], y: [minY, maxY], z: [minZ, maxZ] };
}

function fmt(b: ReturnType<typeof bounds>): string {
  return `x=[${b.x[0].toFixed(2)}, ${b.x[1].toFixed(2)}]  y=[${b.y[0].toFixed(2)}, ${b.y[1].toFixed(2)}]  z=[${b.z[0].toFixed(2)}, ${b.z[1].toFixed(2)}]`;
}

async function main() {
  await ensureOC();

  console.log("=== Probe: makeBox(2, 3, 4) ===");
  const box = tier1.makeBox(2, 3, 4);
  console.log("  bounds:", fmt(bounds(box)));
  console.log("  → expect [-1,1]×[-1.5,1.5]×[-2,2] if centered, or [0,2]×[0,3]×[0,4] if base-at-origin\n");

  console.log("=== Probe: makeCylinder(1.5, 6) ===");
  const cyl = tier1.makeCylinder(1.5, 6);
  console.log("  bounds:", fmt(bounds(cyl)));
  console.log("  → expect axis along Z if default; centered or base-at-origin?\n");

  console.log("=== Probe: drawRectangle(2, 3).sketchOnPlane(\"XY\").extrude(4) ===");
  const ext = tier1.drawRectangle(2, 3).sketchOnPlane("XY").extrude(4);
  console.log("  bounds:", fmt(bounds(ext)));
  console.log("  → drawRectangle is centered at origin (per the demos); extrude direction?\n");

  console.log("=== Probe: drawCircle(1).sketchOnPlane(\"XY\").extrude(2) ===");
  const cyl2 = tier1.drawCircle(1).sketchOnPlane("XY").extrude(2);
  console.log("  bounds:", fmt(bounds(cyl2)));
  console.log("  → drawCircle is centered at origin (per the demos); extrude direction?\n");

  console.log("=== Probe: makeBox(2, 2, 2).translate([0, 0, 1]) ===");
  const boxT = tier1.makeBox(2, 2, 2).translate([0, 0, 1]);
  console.log("  bounds:", fmt(bounds(boxT)));
  console.log("  → if box was centered, should be [-1,1]×[-1,1]×[0,2]\n");

  console.log("=== Probe: fuse two non-touching boxes ===");
  const a = tier1.makeBox(1, 1, 1).translate([-2, 0, 0.5]);
  const b = tier1.makeBox(1, 1, 1).translate([ 2, 0, 0.5]);
  const fused = a.fuse(b);
  console.log("  bounds:", fmt(bounds(fused)));
  console.log("  result kind:", (fused as object).constructor?.name);
  console.log("  → expect x=[-2.5, 2.5]; if z=[0,1] both pieces present\n");

  console.log("=== Probe: fuse 5 disjoint pieces (mimicking pier-and-beam) ===");
  const PIER_W = 0.4, PIER_H = 1, FOOT_X = 5, FOOT_Y = 4, SLAB_T = 0.2;
  const half_x = (FOOT_X - PIER_W) / 2;
  const half_y = (FOOT_Y - PIER_W) / 2;
  const half_z = PIER_H / 2;
  const p0 = tier1.makeBox(PIER_W, PIER_W, PIER_H).translate([-half_x, -half_y, half_z]);
  const p1 = tier1.makeBox(PIER_W, PIER_W, PIER_H).translate([ half_x, -half_y, half_z]);
  const p2 = tier1.makeBox(PIER_W, PIER_W, PIER_H).translate([-half_x,  half_y, half_z]);
  const p3 = tier1.makeBox(PIER_W, PIER_W, PIER_H).translate([ half_x,  half_y, half_z]);
  const slab = tier1.makeBox(FOOT_X, FOOT_Y, SLAB_T).translate([0, 0, PIER_H + SLAB_T / 2]);
  console.log("  individual pieces:");
  console.log("    p0:", fmt(bounds(p0)));
  console.log("    p1:", fmt(bounds(p1)));
  console.log("    slab:", fmt(bounds(slab)));
  console.log("  fuse stages:");
  const f1 = p0.fuse(p1);
  console.log("    p0+p1:", fmt(bounds(f1)), "kind=", (f1 as object).constructor?.name);
  const f2 = f1.fuse(p2);
  console.log("    +p2:", fmt(bounds(f2)), "kind=", (f2 as object).constructor?.name);
  const f3 = f2.fuse(p3);
  console.log("    +p3:", fmt(bounds(f3)), "kind=", (f3 as object).constructor?.name);
  const f4 = f3.fuse(slab);
  console.log("    +slab:", fmt(bounds(f4)), "kind=", (f4 as object).constructor?.name);

  console.log("\n=== Probe: drawPolyline(5-pt octagon) closed ===");
  const N = 5;
  const pts: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const ang = (2 * Math.PI * i) / N;
    pts.push([Math.cos(ang), Math.sin(ang)]);
  }
  const poly = tier1.drawPolyline(pts).sketchOnPlane("XY").extrude(1);
  console.log("  bounds:", fmt(bounds(poly)));
  console.log("  result kind:", (poly as object).constructor?.name);
  console.log("  → expect ~1m circumradius, height 1m\n");
}

main().catch(console.error);
