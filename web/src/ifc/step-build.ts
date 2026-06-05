// step-build.ts — AP214 STEP scene export from IfcSceneElement[].
//
// Produces one EXTRUDED_AREA_SOLID per scene element (from AABB of world-space
// mesh vertices), wrapped in a full PRODUCT hierarchy per ISO 10303-42/AP214.
//
// Used by SdExport({ format: "step" }) via dom-events.ts exportStep().
// Independent of browser APIs — runs in Node.js for unit tests + cert scripts.

import type { IfcSceneElement } from "./ifc-build.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function stepR(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`step-build: non-finite value ${n}`);
  if (Number.isInteger(n)) return `${n}.`;
  const s = n.toString();
  return /[.eE]/.test(s) ? s : s + ".";
}

function stepLbl(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function aabb(
  vertices: Float32Array,
): { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number } | null {
  if (vertices.length < 3) return null;
  let xMin = Infinity, yMin = Infinity, zMin = Infinity;
  let xMax = -Infinity, yMax = -Infinity, zMax = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i]!, y = vertices[i + 1]!, z = vertices[i + 2]!;
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    if (z < zMin) zMin = z; if (z > zMax) zMax = z;
  }
  if (!Number.isFinite(xMin)) return null;
  return { xMin, xMax, yMin, yMax, zMin, zMax };
}

// ── buildStepScene ────────────────────────────────────────────────────────────

/**
 * Generate an AP214 STEP-21 file from scene elements.
 *
 * Each element's world-space mesh AABB becomes an EXTRUDED_AREA_SOLID with
 * a RECTANGLE_PROFILE_DEF, placed at the AABB base center via
 * AXIS2_PLACEMENT_3D. Elements with degenerate AABB (zero dimension) are
 * skipped. Units: SI metres (same as IFC export).
 *
 * AC (Leo #13386): PRODUCT count == EXTRUDED_AREA_SOLID count == element count.
 */
export function buildStepScene(elements: IfcSceneElement[]): Uint8Array {
  const lines: string[] = [];
  let seq = 0;
  const next = (): string => `#${++seq}`;

  // ── Shared geometric context (emitted once) ───────────────────────────────

  const lenUnit = next();
  lines.push(`${lenUnit}=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.));`);
  const angUnit = next();
  lines.push(`${angUnit}=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));`);
  const solidAng = next();
  lines.push(`${solidAng}=(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT());`);
  const uncert = next();
  lines.push(`${uncert}=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-7),${lenUnit},'distance_accuracy_value','Tolerance');`);
  const grc = next();
  lines.push(
    `${grc}=(GEOMETRIC_REPRESENTATION_CONTEXT(3)` +
      `GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncert}))` +
      `GLOBAL_UNIT_ASSIGNED_CONTEXT((${lenUnit},${angUnit},${solidAng}))` +
      `REPRESENTATION_CONTEXT('context','3D'));`,
  );
  const appCtx = next();
  lines.push(`${appCtx}=APPLICATION_CONTEXT('automotive design');`);
  const prodCtx = next();
  lines.push(`${prodCtx}=PRODUCT_CONTEXT('',${appCtx},'mechanical');`);
  const defCtx = next();
  lines.push(`${defCtx}=PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design');`);

  // Shared 2D profile placement — always at 2D origin, profile centered there.
  const orig2d = next();
  lines.push(`${orig2d}=CARTESIAN_POINT('',(0.,0.));`);
  const ax2d = next();
  lines.push(`${ax2d}=AXIS2_PLACEMENT_2D('',${orig2d},$);`);

  // ── Per-element solids + product hierarchy ────────────────────────────────

  for (const elem of elements) {
    const box = aabb(elem.mesh.vertices);
    if (!box) continue;
    const { xMin, xMax, yMin, yMax, zMin, zMax } = box;
    const w = xMax - xMin, d = yMax - yMin, h = zMax - zMin;
    if (w <= 0 || d <= 0 || h <= 0) continue;

    const cx = (xMin + xMax) / 2;
    const cy = (yMin + yMax) / 2;
    const lbl = elem.label ?? elem.creator ?? "element";

    // Profile (x_dim = full width, y_dim = full depth)
    const prof = next();
    lines.push(`${prof}=RECTANGLE_PROFILE_DEF(.AREA.,$,${ax2d},${stepR(w)},${stepR(d)});`);

    // 3D placement at base center: Z points up, X points in world-X direction
    const pt3d = next();
    lines.push(`${pt3d}=CARTESIAN_POINT('',(${stepR(cx)},${stepR(cy)},${stepR(zMin)}));`);
    const dzUp = next();
    lines.push(`${dzUp}=DIRECTION('',(0.,0.,1.));`);
    const dxRef = next();
    lines.push(`${dxRef}=DIRECTION('',(1.,0.,0.));`);
    const ax3d = next();
    lines.push(`${ax3d}=AXIS2_PLACEMENT_3D('',${pt3d},${dzUp},${dxRef});`);
    const extDir = next();
    lines.push(`${extDir}=DIRECTION('',(0.,0.,1.));`);

    // Solid: (name, swept_area, position, extruded_direction, depth)
    const solid = next();
    lines.push(`${solid}=EXTRUDED_AREA_SOLID(${stepLbl(lbl)},${prof},${ax3d},${extDir},${stepR(h)});`);

    // Shape representation → product hierarchy
    const srep = next();
    lines.push(`${srep}=SHAPE_REPRESENTATION(${stepLbl(lbl)},(${solid}),${grc});`);
    const prod = next();
    lines.push(`${prod}=PRODUCT(${stepLbl(lbl)},${stepLbl(lbl)},'',(${prodCtx}));`);
    const form = next();
    lines.push(`${form}=PRODUCT_DEFINITION_FORMATION('','',${prod});`);
    const pdef = next();
    lines.push(`${pdef}=PRODUCT_DEFINITION('design','',${form},${defCtx});`);
    const pds = next();
    lines.push(`${pds}=PRODUCT_DEFINITION_SHAPE('','',${pdef});`);
    const sdr = next();
    lines.push(`${sdr}=SHAPE_DEFINITION_REPRESENTATION(${pds},${srep});`);
  }

  const ts = new Date().toISOString();
  const header =
    `ISO-10303-21;\n` +
    `HEADER;\n` +
    `FILE_DESCRIPTION(('WEB-CAD STEP scene export'),'2;1');\n` +
    `FILE_NAME('web-cad-export.step','${ts}',(''),(''),'WEB-CAD','step-build.ts','');\n` +
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\n` +
    `ENDSEC;\n` +
    `DATA;\n`;

  const footer = `\nENDSEC;\nEND-ISO-10303-21;\n`;
  return new TextEncoder().encode(header + lines.join("\n") + footer);
}
