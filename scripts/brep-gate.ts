#!/usr/bin/env bun
// brep-gate.ts — §WEB-CAD#62
// Run FZK-Haus Brep comparison for all 6 parametric element types and write JSON to stdout.
// Usage (from repo root):
//   bun --preload ./web/test/setup-dom.ts scripts/brep-gate.ts
// Called by phase-j-verify.mjs to populate brep_comparison in the receipt.

import { buildRoof, buildWall, buildSlab, buildStair } from "../web/src/tools/structural";
import { buildDoor, buildWindow } from "../web/src/tools/openings";
import { objectToBrepSnapshot, geometryToBrepSnapshot } from "../web/src/test/mesh-to-brep-snapshot";
import { compareBrepSnapshot } from "../web/src/test/brep-compare";

import roofFixture   from "../web/test/fixtures/fzk-brep-roof.json";
import wallFixture   from "../web/test/fixtures/fzk-brep-wall.json";
import slabFixture   from "../web/test/fixtures/fzk-brep-slab.json";
import doorFixture   from "../web/test/fixtures/fzk-brep-door.json";
import windowFixture from "../web/test/fixtures/fzk-brep-window.json";
import stairFixture  from "../web/test/fixtures/fzk-brep-stair.json";

const VERTEX_TOL = 1e-3;
const NORMAL_TOL = 1e-3;

type ElementResult = {
  pass: boolean;
  max_vertex_delta_m: number;
  max_normal_angular_dev: number;
  vert_count: number;
  face_count: number;
  count_mismatch: boolean;
};

const elements: Record<string, ElementResult> = {};

// ── Roof ──────────────────────────────────────────────────────────────────────
{
  const { mesh } = buildRoof({ x: -6, y: -5 }, { x: 6, y: 5 }, { pitchDeg: 30, overhang: 0.5 });
  const actual = objectToBrepSnapshot(mesh);
  const ref = roofFixture.snapshot as typeof actual;
  const r = compareBrepSnapshot(actual, ref, VERTEX_TOL, NORMAL_TOL);
  elements.roof = {
    pass: r.pass,
    max_vertex_delta_m: r.max_vertex_delta_m,
    max_normal_angular_dev: r.max_normal_angular_dev,
    vert_count: actual.vertCount,
    face_count: actual.faceCount,
    count_mismatch: r.count_mismatch,
  };
}

// ── Wall ──────────────────────────────────────────────────────────────────────
{
  const { mesh } = buildWall({ x: -6, y: 0 }, { x: 6, y: 0 }, 2.7);
  mesh.updateMatrixWorld(true);
  const actual = geometryToBrepSnapshot(mesh.geometry, mesh.matrixWorld);
  const ref = wallFixture.snapshot as typeof actual;
  const r = compareBrepSnapshot(actual, ref, VERTEX_TOL, NORMAL_TOL);
  elements.wall = {
    pass: r.pass,
    max_vertex_delta_m: r.max_vertex_delta_m,
    max_normal_angular_dev: r.max_normal_angular_dev,
    vert_count: actual.vertCount,
    face_count: actual.faceCount,
    count_mismatch: r.count_mismatch,
  };
}

// ── Slab ──────────────────────────────────────────────────────────────────────
{
  const { mesh } = buildSlab({ x: -6, y: -5 }, { x: 6, y: 5 });
  mesh.updateMatrixWorld(true);
  const actual = geometryToBrepSnapshot(mesh.geometry, mesh.matrixWorld);
  const ref = slabFixture.snapshot as typeof actual;
  const r = compareBrepSnapshot(actual, ref, VERTEX_TOL, NORMAL_TOL);
  elements.slab = {
    pass: r.pass,
    max_vertex_delta_m: r.max_vertex_delta_m,
    max_normal_angular_dev: r.max_normal_angular_dev,
    vert_count: actual.vertCount,
    face_count: actual.faceCount,
    count_mismatch: r.count_mismatch,
  };
}

// ── Door ──────────────────────────────────────────────────────────────────────
{
  const { mesh } = buildDoor({ x: 0, y: 0 });
  mesh.updateMatrixWorld(true);
  const actual = geometryToBrepSnapshot(mesh.geometry, mesh.matrixWorld);
  const ref = doorFixture.snapshot as typeof actual;
  const r = compareBrepSnapshot(actual, ref, VERTEX_TOL, NORMAL_TOL);
  elements.door = {
    pass: r.pass,
    max_vertex_delta_m: r.max_vertex_delta_m,
    max_normal_angular_dev: r.max_normal_angular_dev,
    vert_count: actual.vertCount,
    face_count: actual.faceCount,
    count_mismatch: r.count_mismatch,
  };
}

// ── Window ────────────────────────────────────────────────────────────────────
{
  const { mesh } = buildWindow({ x: 0, y: 0 });
  mesh.updateMatrixWorld(true);
  const actual = geometryToBrepSnapshot(mesh.geometry, mesh.matrixWorld);
  const ref = windowFixture.snapshot as typeof actual;
  const r = compareBrepSnapshot(actual, ref, VERTEX_TOL, NORMAL_TOL);
  elements.window = {
    pass: r.pass,
    max_vertex_delta_m: r.max_vertex_delta_m,
    max_normal_angular_dev: r.max_normal_angular_dev,
    vert_count: actual.vertCount,
    face_count: actual.faceCount,
    count_mismatch: r.count_mismatch,
  };
}

// ── Stair ─────────────────────────────────────────────────────────────────────
{
  const { group } = buildStair({ x: 0, y: 0 }, { x: 3, y: 2 }, { width: 1.0 });
  const actual = objectToBrepSnapshot(group);
  const ref = stairFixture.snapshot as typeof actual;
  const r = compareBrepSnapshot(actual, ref, VERTEX_TOL, NORMAL_TOL);
  elements.stair = {
    pass: r.pass,
    max_vertex_delta_m: r.max_vertex_delta_m,
    max_normal_angular_dev: r.max_normal_angular_dev,
    vert_count: actual.vertCount,
    face_count: actual.faceCount,
    count_mismatch: r.count_mismatch,
  };
}

const allPass = Object.values(elements).every((r) => r.pass);

console.log(JSON.stringify({
  pass: allPass,
  vertex_tol_m: VERTEX_TOL,
  normal_tol_rad: NORMAL_TOL,
  elements,
}));
