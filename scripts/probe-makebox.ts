import { setOC } from "replicad";
async function main() {
  const ocModule: any = await import("replicad-opencascadejs/src/replicad_single.js");
  const init = ocModule.default ?? ocModule;
  setOC(await init());
  const r: any = await import("replicad");

  const t = (label: string, fn: () => any) => {
    try { const o = fn(); console.log(`  ${label} → OK ${o?.constructor?.name}`); }
    catch (e: any) { console.log(`  ${label} → THROW ${typeof e === "object" ? JSON.stringify(e?.message ?? e) : String(e)}`); }
  };
  const t1 = Date.now();
  t("makeBaseBox(2,2,2)", () => r.makeBaseBox && r.makeBaseBox(2, 2, 2));
  console.log(`  (took ${Date.now() - t1}ms)`);
  const t2 = Date.now();
  t("makeBaseBox(2,2,2).fuse(makeBaseBox(1,1,1))", () =>
    r.makeBaseBox(2, 2, 2).fuse(r.makeBaseBox(1, 1, 1).translate([1, 1, 1]))
  );
  console.log(`  (took ${Date.now() - t2}ms)`);
  const t3 = Date.now();
  t("Compound.translate", () => {
    const wall = r.drawRectangle(5, 0.2).sketchOnPlane("XY").extrude(3);
    const door = r.drawRectangle(0.9, 0.2).sketchOnPlane("XY").extrude(2.1).translate([1, 0, 0]);
    return wall.cut(door).translate([10, 0, 0]);
  });
  console.log(`  (took ${Date.now() - t3}ms)`);
  const t4 = Date.now();
  t("slab.cut(h1).cut(h2).cut(h3)", () => {
    const slab = r.drawRectangle(6, 4).sketchOnPlane("XY").extrude(0.2);
    const h1 = r.drawCircle(0.5).sketchOnPlane("XY").extrude(0.2).translate([1, 1, 0]);
    const h2 = r.drawCircle(0.5).sketchOnPlane("XY").extrude(0.2).translate([3, 1, 0]);
    const h3 = r.drawCircle(0.5).sketchOnPlane("XY").extrude(0.2).translate([5, 1, 0]);
    return slab.cut(h1).cut(h2).cut(h3);
  });
  console.log(`  (took ${Date.now() - t4}ms)`);
  console.log("\nmakeBox source:\n" + r.makeBox.toString().slice(0, 600));
  console.log("\nmakeCylinder source:\n" + r.makeCylinder.toString().slice(0, 400));
}
main().catch(e => { console.error(e); process.exit(1); });
