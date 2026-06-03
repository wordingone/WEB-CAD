#!/usr/bin/env node
// CJS helper — builds a 3x3 bilinear NurbsSurface .3dm and writes bytes to stdout as base64.
// Called from verify-333-rt.mjs to avoid ESM/WASM top-level-await interaction.
// Must be run from node_modules/rhino3dm/ so WASM locates correctly.

const rhino3dmInit = require("rhino3dm");

(async () => {
  const rh = await rhino3dmInit();
  const deg = 1, n = 3;
  const refCP = [
    [0,0,0],[1,0,0],[2,0,0],
    [0,1,0],[1,1,1],[2,1,0],
    [0,2,0],[1,2,0],[2,2,0],
  ];
  const truncKnots = [0, 1, 2]; // full [0,0,1,2,2] strip first/last

  const orderU = deg + 1, orderV = deg + 1;
  const ns = rh.NurbsSurface.create(3, false, orderU, orderV, n, n);
  if (!ns) { process.stderr.write("NurbsSurface.create returned null\n"); process.exit(1); }

  const pts = ns.points();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const p = refCP[i * n + j];
      pts.set(i, j, [p[0], p[1], p[2]]);
    }
  }
  const ku = ns.knotsU(), kv = ns.knotsV();
  for (let i = 0; i < truncKnots.length; i++) {
    ku.set(i, truncKnots[i]);
    kv.set(i, truncKnots[i]);
  }

  const attrs = new rh.ObjectAttributes();
  const file3dm = new rh.File3dm();
  file3dm.objects().addSurface(ns, attrs);
  ns.delete();
  const dmBytes = file3dm.toByteArray();
  file3dm.delete();

  process.stdout.write(Buffer.from(dmBytes).toString("base64"));
  process.exit(0);
})();
