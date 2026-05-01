/**
 * Synthetic dataset generator — D2 of docs/plan-18-day.md.
 *
 * Emits 200 (NL prompt, replicad-JS sequence) pairs across 8 subcategories.
 * All output is by-construction Tier 1 (validated by validate.ts before write).
 *
 * Deterministic given a seed — same seed reproduces the same 200 rows.
 *
 * Subcategory targets per dataset/v2-spec.md:
 *   60 single-element parametric  (12 each: wall / circ-col / rect-col / slab / beam)
 *   30 L-shape wall corner        (20 fuse + 10 cut-from-corner)
 *   25 U-shape enclosure
 *   25 closed rectangular room (4 walls)
 *   20 wall with rectangular opening (door / window)
 *   15 column grid (additive fuse)
 *   15 sloped roof slab (translated + rotated)
 *   10 stair-stepped retaining
 *  ----
 *  200 total
 */

import { RNG } from "./rng.js";
import { num, fill, pickTemplate } from "./format.js";

export type SynthRow = {
  id: string;
  subcategory: string;
  prompt: string;
  sequence: string;
  ops: string[];
  params: Record<string, number | string>;
};

// ---------------------------------------------------------------------------
// helpers shared across subcategories

function opsOf(js: string): string[] {
  const m = Array.from(js.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)).map(x => x[1]);
  const lang = new Set(["const", "let", "var", "function", "if", "for", "while", "return"]);
  return Array.from(new Set(m.filter(c => !lang.has(c)))).sort();
}

// ---------------------------------------------------------------------------
// 1. single-element parametric (60 rows)

function genWall(rng: RNG, i: number): SynthRow {
  const L = rng.logFloat(2, 12);
  const T = rng.float(0.1, 0.4);
  const H = rng.float(2.4, 4.5);
  const templates = [
    "Build a wall {L}m long, {T}m thick, {H}m tall.",
    "Make a wall, {L} meters long, {T} meters thick, {H} meters tall.",
    "Create a {L}m wall with thickness {T}m and height {H}m.",
    "Place a wall: length {L}m, thickness {T}m, height {H}m.",
    "I need a wall that's {L}m long, {T}m thick, and {H}m tall.",
  ];
  const prompt = fill(pickTemplate(templates, rng), { L: num(L), T: num(T), H: num(H) });
  const sequence = `const wall = drawRectangle(${num(L)}, ${num(T)}).sketchOnPlane("XY").extrude(${num(H)});`;
  return { id: `s-wall-${i}`, subcategory: "single-wall", prompt, sequence, ops: opsOf(sequence), params: { L, T, H } };
}

function genCircColumn(rng: RNG, i: number): SynthRow {
  const R = rng.float(0.15, 0.6);
  const H = rng.float(2.5, 5.0);
  const templates = [
    "Place a circular column, {D}m diameter, {H}m tall.",
    "Build a round column, radius {R}m, height {H}m.",
    "Make a cylindrical column {H}m high with diameter {D}m.",
    "Create a {H}m tall round column, {R}m radius.",
  ];
  const useDiameter = rng.bool();
  const prompt = fill(pickTemplate(templates, rng), {
    R: num(R),
    D: num(2 * R),
    H: num(H),
  });
  const sequence = `const col = drawCircle(${num(R)}).sketchOnPlane("XY").extrude(${num(H)});`;
  void useDiameter;
  return { id: `s-circcol-${i}`, subcategory: "single-circcol", prompt, sequence, ops: opsOf(sequence), params: { R, H } };
}

function genRectColumn(rng: RNG, i: number): SynthRow {
  const S = rng.float(0.2, 0.5);
  const H = rng.float(2.5, 5.0);
  const templates = [
    "Stand up a {S}x{S}m square column, {H}m tall.",
    "Build a square column, {S} meters on a side, {H}m high.",
    "Place a rectangular column {S}m by {S}m, {H}m tall.",
    "Create a square column with {S}m side and {H}m height.",
  ];
  const prompt = fill(pickTemplate(templates, rng), { S: num(S), H: num(H) });
  const sequence = `const col = drawRectangle(${num(S)}, ${num(S)}).sketchOnPlane("XY").extrude(${num(H)});`;
  return { id: `s-rectcol-${i}`, subcategory: "single-rectcol", prompt, sequence, ops: opsOf(sequence), params: { S, H } };
}

function genSlab(rng: RNG, i: number): SynthRow {
  const W = rng.logFloat(3, 12);
  const D = rng.logFloat(3, 12);
  const T = rng.float(0.1, 0.4);
  const templates = [
    "Build a floor slab, {W}m by {D}m, {T}m thick.",
    "Create a {W}x{D}m slab, thickness {T}m.",
    "Make a rectangular slab: {W} meters wide, {D} meters deep, {T}m thick.",
    "Place a slab measuring {W}m x {D}m, {T}m thick.",
  ];
  const prompt = fill(pickTemplate(templates, rng), { W: num(W), D: num(D), T: num(T) });
  const sequence = `const slab = drawRectangle(${num(W)}, ${num(D)}).sketchOnPlane("XY").extrude(${num(T)});`;
  return { id: `s-slab-${i}`, subcategory: "single-slab", prompt, sequence, ops: opsOf(sequence), params: { W, D, T } };
}

function genBeam(rng: RNG, i: number): SynthRow {
  const L = rng.logFloat(3, 10);
  const W = rng.float(0.2, 0.5);
  const Hb = rng.float(0.3, 0.8);
  const templates = [
    "A horizontal beam, {L}m long, {W}m wide, {Hb}m deep.",
    "Build a beam {L} meters long with cross-section {W}m x {Hb}m.",
    "Place a horizontal beam: length {L}m, width {W}m, depth {Hb}m.",
    "Make a {L}m beam, {W}m wide and {Hb}m deep, lying horizontally.",
  ];
  const prompt = fill(pickTemplate(templates, rng), { L: num(L), W: num(W), Hb: num(Hb) });
  const sequence = `const beam = drawRectangle(${num(W)}, ${num(Hb)}).sketchOnPlane("XZ").extrude(${num(L)});`;
  return { id: `s-beam-${i}`, subcategory: "single-beam", prompt, sequence, ops: opsOf(sequence), params: { L, W, Hb } };
}

// ---------------------------------------------------------------------------
// 2. L-shape (30 rows: 20 fuse, 10 cut)

function genLShapeFuse(rng: RNG, i: number): SynthRow {
  const Lx = rng.logFloat(3, 10);
  const Ly = rng.logFloat(3, 10);
  const T = rng.float(0.1, 0.4);
  const H = rng.float(2.5, 4.0);
  const templates = [
    "Build an L-shaped wall corner: one {Lx}m wall along X, one {Ly}m wall along Y, both {T}m thick and {H}m tall.",
    "Make an L corner — a {Lx}-meter wall and a perpendicular {Ly}-meter wall, both {T}m thick, {H}m tall.",
    "Create two walls meeting at the origin in an L: {Lx}x{T}m along X, {Ly}x{T}m along Y, both {H}m tall.",
    "Two walls forming an L: {Lx}m and {Ly}m, both {T}m thick and {H}m tall, fused at the corner.",
  ];
  const prompt = fill(pickTemplate(templates, rng), { Lx: num(Lx), Ly: num(Ly), T: num(T), H: num(H) });
  const sequence =
    `const wallX = drawRectangle(${num(Lx)}, ${num(T)}).sketchOnPlane("XY").extrude(${num(H)});\n` +
    `const wallY = drawRectangle(${num(T)}, ${num(Ly)}).sketchOnPlane("XY").extrude(${num(H)});\n` +
    `const corner = wallX.fuse(wallY);`;
  return { id: `s-lfuse-${i}`, subcategory: "l-shape-fuse", prompt, sequence, ops: opsOf(sequence), params: { Lx, Ly, T, H } };
}

function genLShapeCut(rng: RNG, i: number): SynthRow {
  const W = rng.logFloat(4, 10);
  const D = rng.logFloat(4, 10);
  const Cx = rng.float(1, Math.min(W - 1, 4));
  const Cy = rng.float(1, Math.min(D - 1, 4));
  const H = rng.float(0.2, 0.5);
  const templates = [
    "Build a slab, {W}m by {D}m, {H}m thick, with an L-shaped corner cut out: {Cx}m by {Cy}m removed from one corner.",
    "A {W}x{D}m slab, {H}m thick, with a {Cx}x{Cy}m rectangular notch cut out of one corner.",
    "Make a slab measuring {W}m x {D}m and {H}m thick, then cut a {Cx}m by {Cy}m corner out of it.",
    "An L-plan slab: start with a {W}x{D}m rectangle {H}m thick, remove a {Cx}x{Cy}m corner.",
  ];
  const prompt = fill(pickTemplate(templates, rng), {
    W: num(W), D: num(D), Cx: num(Cx), Cy: num(Cy), H: num(H),
  });
  const sequence =
    `const block = drawRectangle(${num(W)}, ${num(D)}).sketchOnPlane("XY").extrude(${num(H)});\n` +
    `const corner = drawRectangle(${num(Cx)}, ${num(Cy)}).sketchOnPlane("XY").extrude(${num(H)}).translate([${num(W - Cx)}, ${num(D - Cy)}, 0]);\n` +
    `const lShape = block.cut(corner);`;
  return { id: `s-lcut-${i}`, subcategory: "l-shape-cut", prompt, sequence, ops: opsOf(sequence), params: { W, D, Cx, Cy, H } };
}

// ---------------------------------------------------------------------------
// 3. U-shape (25 rows)

function genUShape(rng: RNG, i: number): SynthRow {
  const W = rng.logFloat(4, 10);
  const D = rng.logFloat(4, 10);
  const T = rng.float(0.15, 0.35);
  const H = rng.float(2.5, 4.0);
  const templates = [
    "Build a U-shaped enclosure: a back wall {W}m long, two side walls {D}m long, all {T}m thick and {H}m tall.",
    "Make a U-shape: back wall is {W}m, sides are {D}m, walls {T}m thick and {H}m tall.",
    "Three walls forming a U: a {W}m back wall and two {D}m side walls, {T}m thick, {H}m tall.",
    "A courtyard footprint open on one side: back wall {W}m, side walls {D}m, all {T}m thick and {H}m high.",
  ];
  const prompt = fill(pickTemplate(templates, rng), { W: num(W), D: num(D), T: num(T), H: num(H) });
  const sequence =
    `const back = drawRectangle(${num(W)}, ${num(T)}).sketchOnPlane("XY").extrude(${num(H)});\n` +
    `const left = drawRectangle(${num(T)}, ${num(D)}).sketchOnPlane("XY").extrude(${num(H)}).translate([0, ${num(T)}, 0]);\n` +
    `const right = drawRectangle(${num(T)}, ${num(D)}).sketchOnPlane("XY").extrude(${num(H)}).translate([${num(W - T)}, ${num(T)}, 0]);\n` +
    `const u = back.fuse(left).fuse(right);`;
  return { id: `s-ushape-${i}`, subcategory: "u-shape", prompt, sequence, ops: opsOf(sequence), params: { W, D, T, H } };
}

// ---------------------------------------------------------------------------
// 4. Closed rectangular room (25 rows)

function genClosedRoom(rng: RNG, i: number): SynthRow {
  const W = rng.logFloat(3, 10);
  const D = rng.logFloat(3, 10);
  const T = rng.float(0.15, 0.35);
  const H = rng.float(2.4, 3.5);
  const templates = [
    "Build a closed rectangular room: {W}m wide, {D}m deep, walls {T}m thick and {H}m tall.",
    "A four-walled room {W}m by {D}m, with {T}m thick walls, {H}m tall.",
    "Create a closed room footprint {W}m x {D}m, walls {T}m thick, {H}m high.",
    "Build a {W}x{D}m enclosed space with four walls, {T}m thick, {H}m tall.",
  ];
  const prompt = fill(pickTemplate(templates, rng), { W: num(W), D: num(D), T: num(T), H: num(H) });
  const innerD = D - 2 * T;
  const sequence =
    `const front = drawRectangle(${num(W)}, ${num(T)}).sketchOnPlane("XY").extrude(${num(H)});\n` +
    `const back = drawRectangle(${num(W)}, ${num(T)}).sketchOnPlane("XY").extrude(${num(H)}).translate([0, ${num(D - T)}, 0]);\n` +
    `const left = drawRectangle(${num(T)}, ${num(innerD)}).sketchOnPlane("XY").extrude(${num(H)}).translate([0, ${num(T)}, 0]);\n` +
    `const right = drawRectangle(${num(T)}, ${num(innerD)}).sketchOnPlane("XY").extrude(${num(H)}).translate([${num(W - T)}, ${num(T)}, 0]);\n` +
    `const room = front.fuse(back).fuse(left).fuse(right);`;
  return { id: `s-room-${i}`, subcategory: "closed-room", prompt, sequence, ops: opsOf(sequence), params: { W, D, T, H } };
}

// ---------------------------------------------------------------------------
// 5. Wall with rectangular opening (20 rows: 10 door, 10 window)

function genWallOpening(rng: RNG, i: number, kind: "door" | "window"): SynthRow {
  const L = rng.logFloat(4, 10);
  const T = rng.float(0.15, 0.3);
  const H = rng.float(2.6, 3.5);
  const Ow = kind === "door" ? rng.float(0.8, 1.2) : rng.float(1.0, 2.0);
  const Oh = kind === "door" ? rng.float(2.0, 2.2) : rng.float(1.0, 1.5);
  const Sill = kind === "door" ? 0 : rng.float(0.8, 1.1);
  const Ox = rng.float(0.5, L - Ow - 0.5);
  const labelKind = kind;
  const doorTemplates = [
    "A wall {L}m long, {T}m thick, {H}m tall, with a {Ow}x{Oh}m door at x={Ox}m.",
    "Build a {L}m by {T}m wall, {H}m tall, with a {Ow}m wide and {Oh}m tall door cut into it.",
    "Make a wall with a doorway: wall is {L}x{T}x{H}m, door is {Ow}m wide and {Oh}m tall, offset {Ox}m from the left.",
  ];
  const windowTemplates = [
    "A wall {L}m long, {T}m thick, {H}m tall, with a {Ow}x{Oh}m window centered at x={Ox}m, sill at {Sill}m.",
    "Build a {L}x{T}x{H}m wall with a window: {Ow}m wide, {Oh}m tall, sill height {Sill}m, x-offset {Ox}m.",
    "Wall {L}m by {T}m by {H}m, cut a window {Ow}m by {Oh}m at x={Ox}m, sill {Sill}m.",
  ];
  const templates = labelKind === "door" ? doorTemplates : windowTemplates;
  const prompt = fill(pickTemplate(templates, rng), {
    L: num(L), T: num(T), H: num(H), Ow: num(Ow), Oh: num(Oh), Ox: num(Ox), Sill: num(Sill),
  });
  const sequence =
    `const wall = drawRectangle(${num(L)}, ${num(T)}).sketchOnPlane("XY").extrude(${num(H)});\n` +
    `const opening = drawRectangle(${num(Ow)}, ${num(T)}).sketchOnPlane("XY").extrude(${num(Oh)}).translate([${num(Ox)}, 0, ${num(Sill)}]);\n` +
    `const result = wall.cut(opening);`;
  return { id: `s-${kind}-${i}`, subcategory: `wall-with-${kind}`, prompt, sequence, ops: opsOf(sequence), params: { L, T, H, Ow, Oh, Sill, Ox } };
}

// ---------------------------------------------------------------------------
// 6. Column grid (15 rows)

function genColumnGrid(rng: RNG, i: number): SynthRow {
  const rows = rng.int(2, 3);
  const cols = rng.int(2, 3);
  const Sx = rng.float(3, 6);
  const Sy = rng.float(3, 6);
  const S = rng.float(0.3, 0.5);
  const H = rng.float(3.0, 5.0);
  const templates = [
    "Build a column grid, {rows} by {cols} columns, spaced {Sx}m by {Sy}m, columns {S}x{S}m, {H}m tall.",
    "A {rows}x{cols} grid of square columns: {S}m on each side, {H}m tall, spaced {Sx}m by {Sy}m.",
    "Place {rows} rows of {cols} columns, {Sx}m and {Sy}m apart, each column {S}m square and {H}m tall.",
  ];
  const prompt = fill(pickTemplate(templates, rng), {
    rows: rows.toString(),
    cols: cols.toString(),
    Sx: num(Sx), Sy: num(Sy), S: num(S), H: num(H),
  });

  const lines: string[] = [];
  const names: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const name = `c${r}${c}`;
      names.push(name);
      const tx = c * Sx;
      const ty = r * Sy;
      if (r === 0 && c === 0) {
        lines.push(`const ${name} = drawRectangle(${num(S)}, ${num(S)}).sketchOnPlane("XY").extrude(${num(H)});`);
      } else {
        lines.push(`const ${name} = drawRectangle(${num(S)}, ${num(S)}).sketchOnPlane("XY").extrude(${num(H)}).translate([${num(tx)}, ${num(ty)}, 0]);`);
      }
    }
  }
  const fuseChain = names.slice(1).reduce((acc, n) => `${acc}.fuse(${n})`, names[0]);
  lines.push(`const grid = ${fuseChain};`);
  const sequence = lines.join("\n");
  return { id: `s-grid-${i}`, subcategory: "column-grid", prompt, sequence, ops: opsOf(sequence), params: { rows, cols, Sx, Sy, S, H } };
}

// ---------------------------------------------------------------------------
// 7. Sloped roof slab (15 rows)

function genSlopedRoof(rng: RNG, i: number): SynthRow {
  const W = rng.logFloat(4, 10);
  const D = rng.logFloat(4, 10);
  const T = rng.float(0.1, 0.25);
  const Eave = rng.float(2.5, 4.0);
  const Pitch = rng.int(15, 35);
  const templates = [
    "Build a sloped roof slab: {W}m by {D}m, {T}m thick, eave at {Eave}m, pitched {Pitch} degrees.",
    "A pitched roof: {W}x{D}m slab, {T}m thick, eave height {Eave}m, slope {Pitch} degrees.",
    "Make a tilted roof slab {W}m wide and {D}m deep, {T}m thick, sitting on top of an {Eave}m wall and pitched {Pitch} degrees.",
  ];
  const prompt = fill(pickTemplate(templates, rng), {
    W: num(W), D: num(D), T: num(T), Eave: num(Eave), Pitch: Pitch.toString(),
  });
  const sequence = `const roof = drawRectangle(${num(W)}, ${num(D)}).sketchOnPlane("XY").extrude(${num(T)}).translate([0, 0, ${num(Eave)}]).rotate(${Pitch}, [1, 0, 0]);`;
  return { id: `s-roof-${i}`, subcategory: "sloped-roof", prompt, sequence, ops: opsOf(sequence), params: { W, D, T, Eave, Pitch } };
}

// ---------------------------------------------------------------------------
// 8. Stair-stepped retaining (10 rows)

function genStairStep(rng: RNG, i: number): SynthRow {
  const N = rng.int(3, 5);
  const Run = rng.float(0.3, 0.5);
  const Rise = rng.float(0.15, 0.25);
  const W = rng.logFloat(2, 5);
  const templates = [
    "Build a {N}-step stair-stepped retaining: each step {Run}m run and {Rise}m rise, {W}m wide.",
    "A stair-step structure with {N} steps, run {Run}m, rise {Rise}m, {W}m wide.",
    "Make a stepped retaining wall: {N} cuboid steps, each {Run}m deep and {Rise}m tall, total width {W}m.",
  ];
  const prompt = fill(pickTemplate(templates, rng), {
    N: N.toString(), Run: num(Run), Rise: num(Rise), W: num(W),
  });

  const lines: string[] = [];
  const names: string[] = [];
  for (let k = 0; k < N; k++) {
    const name = `s${k}`;
    names.push(name);
    const tx = k * Run;
    const h = (k + 1) * Rise;
    if (k === 0) {
      lines.push(`const ${name} = drawRectangle(${num(Run)}, ${num(W)}).sketchOnPlane("XY").extrude(${num(h)});`);
    } else {
      lines.push(`const ${name} = drawRectangle(${num(Run)}, ${num(W)}).sketchOnPlane("XY").extrude(${num(h)}).translate([${num(tx)}, 0, 0]);`);
    }
  }
  const fuseChain = names.slice(1).reduce((acc, n) => `${acc}.fuse(${n})`, names[0]);
  lines.push(`const stairs = ${fuseChain};`);
  const sequence = lines.join("\n");
  return { id: `s-stairs-${i}`, subcategory: "stair-stepped", prompt, sequence, ops: opsOf(sequence), params: { N, Run, Rise, W } };
}

// ---------------------------------------------------------------------------
// top-level: emit all 200 rows

export function emit200(seed = 42): SynthRow[] {
  const rng = new RNG(seed);
  const rows: SynthRow[] = [];

  // 1. single-element 60 = 12 each
  for (let i = 0; i < 12; i++) rows.push(genWall(rng, i));
  for (let i = 0; i < 12; i++) rows.push(genCircColumn(rng, i));
  for (let i = 0; i < 12; i++) rows.push(genRectColumn(rng, i));
  for (let i = 0; i < 12; i++) rows.push(genSlab(rng, i));
  for (let i = 0; i < 12; i++) rows.push(genBeam(rng, i));

  // 2. L-shape 30 = 20 fuse + 10 cut
  for (let i = 0; i < 20; i++) rows.push(genLShapeFuse(rng, i));
  for (let i = 0; i < 10; i++) rows.push(genLShapeCut(rng, i));

  // 3. U-shape 25
  for (let i = 0; i < 25; i++) rows.push(genUShape(rng, i));

  // 4. closed room 25
  for (let i = 0; i < 25; i++) rows.push(genClosedRoom(rng, i));

  // 5. wall + opening 20 = 10 door + 10 window
  for (let i = 0; i < 10; i++) rows.push(genWallOpening(rng, i, "door"));
  for (let i = 0; i < 10; i++) rows.push(genWallOpening(rng, i, "window"));

  // 6. column grid 15
  for (let i = 0; i < 15; i++) rows.push(genColumnGrid(rng, i));

  // 7. sloped roof 15
  for (let i = 0; i < 15; i++) rows.push(genSlopedRoof(rng, i));

  // 8. stair-stepped 10
  for (let i = 0; i < 10; i++) rows.push(genStairStep(rng, i));

  return rows;
}
