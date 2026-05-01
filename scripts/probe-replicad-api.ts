/**
 * One-shot probe: which replicad methods exist on Drawing/Sketch/Solid after
 * OCCT init. Used by D3 hand-curation to confirm which Tier 2 ops actually
 * resolve before writing 50 rows that may all fail execute().
 */

import { setOC } from "replicad";

async function main() {
  const ocModule: any = await import("replicad-opencascadejs/src/replicad_single.js");
  const init = ocModule.default ?? ocModule;
  const oc = await init();
  setOC(oc);

  const r: any = await import("replicad");

  const dump = (label: string, obj: any) => {
    const methods = new Set<string>();
    let proto = Object.getPrototypeOf(obj);
    while (proto && proto !== Object.prototype) {
      for (const n of Object.getOwnPropertyNames(proto)) {
        if (n !== "constructor" && typeof obj[n] === "function" && !n.startsWith("_")) {
          methods.add(n);
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    console.log(`\n=== ${label} (${obj.constructor.name}) ===`);
    console.log([...methods].sort().join(", "));
  };

  const drawing = r.drawRectangle(2, 1);
  dump("drawRectangle(2,1)", drawing);

  const sketch = drawing.sketchOnPlane("XY");
  dump("sketchOnPlane('XY')", sketch);

  // Try several revolve signatures
  const tryRevolve = (label: string, fn: () => any) => {
    try {
      const out = fn();
      console.log(`  ${label} → OK ${out?.constructor?.name ?? typeof out}`);
    } catch (e: any) {
      console.log(`  ${label} → THROW ${typeof e === "object" ? JSON.stringify(e?.message ?? e) : String(e)}`);
    }
  };
  console.log("\nrevolve signature probe:");
  tryRevolve("revolve()", () => r.drawRectangle(2, 4).sketchOnPlane("XZ").revolve());
  tryRevolve("revolve([0,0,1])", () => r.drawRectangle(2, 4).sketchOnPlane("XZ").revolve([0, 0, 1]));
  tryRevolve("revolve([1,0,0])", () => r.drawRectangle(2, 4).sketchOnPlane("XZ").revolve([1, 0, 0]));
  // Profile offset from axis (so revolve doesn't cut through profile)
  tryRevolve("offset profile, revolve()", () =>
    r.drawRectangle(2, 4).translate([3, 0]).sketchOnPlane("XZ").revolve()
  );
  tryRevolve("offset profile, revolve([0,0,1])", () =>
    r.drawRectangle(2, 4).translate([3, 0]).sketchOnPlane("XZ").revolve([0, 0, 1])
  );

  // Boolean ops — try multiple shapes
  const tryShape = (label: string, fn: () => any) => {
    try {
      const out = fn();
      console.log(`  ${label} → OK ${out?.constructor?.name ?? typeof out}`);
    } catch (e: any) {
      console.log(`  ${label} → THROW ${typeof e === "object" ? JSON.stringify(e?.message ?? e) : String(e)}`);
    }
  };
  console.log("\nSolid + boolean probe:");
  tryShape("makeBox(2,2,2)", () => r.makeBox(2, 2, 2));
  tryShape("makeCylinder(1,3)", () => r.makeCylinder(1, 3));
  tryShape("Box.fuse(Box)", () => r.makeBox(2, 2, 2).fuse(r.makeBox(1, 1, 1)));
  tryShape("Box.cut(Box translated)", () =>
    r.makeBox(2, 2, 2).cut(r.makeBox(1, 1, 1).translate([0.5, 0.5, 0.5]))
  );

  // 2D Drawing booleans
  console.log("\n2D Drawing boolean probe:");
  tryShape("Drawing.cut(Drawing)", () => r.drawRectangle(5, 3).cut(r.drawRectangle(1, 1).translate([1, 0])));
  tryShape("Drawing.fuse(Drawing)", () => r.drawRectangle(2, 1).fuse(r.drawRectangle(1, 2).translate([1, 0])));

  // 3D Solid extrude path: drawRectangle().sketchOnPlane().extrude() then .cut() with another solid
  console.log("\nextrude → 3D boolean:");
  tryShape("wall.cut(door) (both Solids)", () => {
    const wall = r.drawRectangle(5, 0.2).sketchOnPlane("XY").extrude(3);
    const door = r.drawRectangle(0.9, 0.2).sketchOnPlane("XY").extrude(2.1).translate([1, 0, 0]);
    return wall.cut(door);
  });

  // draw() builder for polyline composition
  console.log("\ndraw() builder probe:");
  tryShape("draw([0,0]).lineTo×2.close()", () =>
    r.draw([0, 0]).lineTo([1, 0]).lineTo([1, 1]).close()
  );
  tryShape("polyline ext: draw.lineTo×3.close.extrude", () => {
    const poly = r.draw([0, 0]).lineTo([3, 0]).lineTo([3, 0.2]).lineTo([0, 0.2]).close();
    return poly.sketchOnPlane("XY").extrude(2.5);
  });
  // Truncated cone profile: closed trapezoid revolved
  tryShape("trapezoid.sketchOnPlane('XZ').revolve([0,0,1])", () => {
    const trap = r.draw([1, 0]).lineTo([3, 0]).lineTo([1.5, 4]).lineTo([1, 4]).close();
    return trap.sketchOnPlane("XZ").revolve([0, 0, 1]);
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
