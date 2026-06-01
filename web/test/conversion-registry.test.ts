// conversion-registry.test.ts — #370 PR2 registry scaffold tests.
//
// Tests the registry machinery (register/convert/canConvert) and the built-in
// canonical→brep registration. The brep→mesh registration lives in exporters.ts
// (side-effect import) and is exercised in the exporter tests.

import { describe, test, expect, beforeEach } from "bun:test";
import { register, convert, canConvert } from "../src/geometry/conversion-registry.js";
import type { GeomFormat } from "../src/geometry/conversion-registry.js";
import type { CanonicalBrepGeometry } from "../src/geometry/canonical-geometry.js";
import type { Brep } from "../src/nurbs/nurbs-brep.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function minimalBrep(): Brep {
  return { shells: [] };
}

function minimalCanonicalBrep(): CanonicalBrepGeometry {
  return {
    id: "test-id",
    schemaVersion: 1,
    units: "m",
    source: "command",
    kind: "brep",
    brep: minimalBrep(),
  };
}

// ── canConvert ────────────────────────────────────────────────────────────────

describe("conversion-registry — canConvert", () => {
  test("canonical→brep: true (built-in)", () => {
    expect(canConvert("canonical", "brep")).toBe(true);
  });

  test("brep→canonical: false (no reverse built-in)", () => {
    expect(canConvert("brep", "canonical")).toBe(false);
  });

  test("unknown pair: false", () => {
    expect(canConvert("ifc" as GeomFormat, "stl" as GeomFormat)).toBe(false);
  });

  test("pivot: true when from→brep and brep→to both registered", () => {
    register<string, Brep>("obj", "brep", (_s) => minimalBrep());
    register<Brep, string>("brep", "stl", (_b) => "stl-data");
    expect(canConvert("obj", "stl")).toBe(true);
  });
});

// ── convert ───────────────────────────────────────────────────────────────────

describe("conversion-registry — convert", () => {
  test("canonical→brep: returns the brep field", async () => {
    const geo = minimalCanonicalBrep();
    const result = await convert("canonical", "brep", geo);
    expect(result).toBe(geo.brep);
  });

  test("canonical→brep: throws for non-brep canonical", async () => {
    const surfaceGeo = {
      id: "x", schemaVersion: 1, units: "m", source: "command",
      kind: "surface", surface: {} as never,
    };
    await expect(convert("canonical", "brep", surfaceGeo)).rejects.toThrow(/kind="brep"/);
  });

  test("no path: throws with descriptive message", async () => {
    await expect(convert("ifc", "3dm", {})).rejects.toThrow(/no path from "ifc" to "3dm"/);
  });

  test("direct path: uses registered converter", async () => {
    register<number, string>("brep", "obj", (n) => `obj:${n}`);
    const result = await convert("brep", "obj", 42);
    expect(result).toBe("obj:42");
  });

  test("pivot path: routes from→brep→to", async () => {
    register<string, Brep>("step", "brep", (_s) => minimalBrep());
    register<Brep, string>("brep", "3dm", (_b) => "3dm-output");
    const result = await convert("step", "3dm", "step-data");
    expect(result).toBe("3dm-output");
  });

  test("async converter: awaited correctly", async () => {
    register<string, number>("ifc", "brep", (_s) => Promise.resolve(99 as never));
    const result = await convert("ifc", "brep", "ifc-data");
    expect(result).toBe(99);
  });
});

// ── register overwrite ────────────────────────────────────────────────────────

describe("conversion-registry — register", () => {
  test("re-register overwrites previous converter", async () => {
    register<unknown, string>("brep", "mesh", (_) => "first");
    register<unknown, string>("brep", "mesh", (_) => "second");
    const result = await convert("brep", "mesh", {});
    expect(result).toBe("second");
  });
});
