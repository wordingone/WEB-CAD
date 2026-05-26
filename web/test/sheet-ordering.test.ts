// Regression-net for default sheet ordering.
// New order: [Plan(s)][RCP(s)][Roof Plan][S Elev][E Elev][N Elev][W Elev][Lng Section][Trans Section]

import { test, expect, describe, beforeEach } from "bun:test";
import { levelStore } from "../src/geometry/levels";
import { buildLayoutMode, DEMO_SHEET_SET } from "../src/shell/layout";

beforeEach(() => {
  const extras = levelStore.all().filter(l => l.id !== "level/0");
  for (const l of extras) levelStore.remove(l.id);
  levelStore.update("level/0", { name: "Level 1" });
});

// ── DEMO_SHEET_SET ordering ────────────────────────────────────────────────────

describe("DEMO_SHEET_SET ordering", () => {
  test("sections come before elevations", () => {
    const secIdx = DEMO_SHEET_SET.findIndex(s => s.viewType === "section");
    const elvIdx = DEMO_SHEET_SET.findIndex(s => s.viewType === "elevation");
    expect(secIdx).toBeLessThan(elvIdx);
  });

  test("all sections appear before any elevation", () => {
    const lastSec = DEMO_SHEET_SET.reduce((acc, s, i) => s.viewType === "section" ? i : acc, -1);
    const firstElv = DEMO_SHEET_SET.findIndex(s => s.viewType === "elevation");
    expect(lastSec).toBeLessThan(firstElv);
  });
});

// ── LayoutController default sheet tab order ─────────────────────────────────

describe("LayoutController sheet order", () => {
  test("first sheet is 'Plan: Level 1'", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    expect(c.sheets[0].name).toBe("Plan: Level 1");
  });

  test("RCP: Level 1 follows all Plan sheets", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const planCount = c.sheets.filter(s => s.name.startsWith("Plan:")).length;
    expect(c.sheets[planCount].name).toBe("RCP: Level 1");
  });

  test("Roof Plan follows all RCP sheets", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const planCount = c.sheets.filter(s => s.name.startsWith("Plan:")).length;
    const rcpCount  = c.sheets.filter(s => s.name.startsWith("RCP:")).length;
    expect(c.sheets[planCount + rcpCount].name).toBe("Roof Plan");
  });

  test("South Elevation follows Roof Plan", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const planCount = c.sheets.filter(s => s.name.startsWith("Plan:")).length;
    const rcpCount  = c.sheets.filter(s => s.name.startsWith("RCP:")).length;
    expect(c.sheets[planCount + rcpCount + 1].name).toBe("South Elevation");
  });

  test("Transverse Section is last", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    expect(c.sheets[c.sheets.length - 1].name).toBe("Transverse Section");
  });

  test("full order for single level", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const names = c.sheets.map(s => s.name);
    expect(names).toEqual([
      "Plan: Level 1",
      "RCP: Level 1",
      "Roof Plan",
      "South Elevation",
      "East Elevation",
      "North Elevation",
      "West Elevation",
      "Longitudinal Section",
      "Transverse Section",
    ]);
  });
});

// ── Plan sheet insertion index on level add ────────────────────────────────────

describe("Plan sheet insertion order on level add", () => {
  test("second plan sheet inserts at index 1 (after first plan)", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    expect(c.sheets[0].name).toBe("Plan: Level 1");
    expect(c.sheets[1].name).toBe("Plan: Level 2");
  });

  test("two plans: RCP still follows both plans", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    expect(c.sheets[2].name).toBe("RCP: Level 1");
  });

  test("plan removal restores original order", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const l2 = levelStore.add({ name: "Level 2", elevation: 3.0 });
    levelStore.remove(l2.id);
    expect(c.sheets[0].name).toBe("Plan: Level 1");
    expect(c.sheets[1].name).toBe("RCP: Level 1");
  });
});

// ── RCP sheet insertion index on level add ────────────────────────────────────

describe("RCP sheet insertion order on level add", () => {
  test("two levels: both RCP sheets are after both plan sheets", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    // [Plan:L1, Plan:L2, RCP:L1, RCP:L2, Roof Plan, S Elev, E Elev, N Elev, W Elev, Lng, Trans]
    const names = c.sheets.map(s => s.name);
    const rcpIdxs = names.reduce<number[]>((a, n, i) => n.startsWith("RCP:") ? [...a, i] : a, []);
    const lastPlanIdx = names.reduce((a, n, i) => n.startsWith("Plan:") ? i : a, -1);
    expect(rcpIdxs.every(i => i > lastPlanIdx)).toBe(true);
  });

  test("RCP sheets appear before Roof Plan", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    const names = c.sheets.map(s => s.name);
    const lastRcp = names.reduce((a, n, i) => n.startsWith("RCP:") ? i : a, -1);
    const roofIdx = names.indexOf("Roof Plan");
    expect(lastRcp).toBeLessThan(roofIdx);
  });

  test("two levels full order", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    const names = c.sheets.map(s => s.name);
    expect(names).toEqual([
      "Plan: Level 1",
      "Plan: Level 2",
      "RCP: Level 1",
      "RCP: Level 2",
      "Roof Plan",
      "South Elevation",
      "East Elevation",
      "North Elevation",
      "West Elevation",
      "Longitudinal Section",
      "Transverse Section",
    ]);
  });
});
