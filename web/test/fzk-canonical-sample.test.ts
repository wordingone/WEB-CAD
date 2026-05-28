import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SAMPLES } from "../src/io/sample-files";

type ProjectPayload = {
  format?: string;
  version?: number;
  meta?: { sourceIfc?: string; conversion?: string };
  canonicalGeometry?: Array<{ kind?: string; brep?: unknown; surface?: unknown }>;
  objects?: Array<{ displaySource?: string; userData?: Record<string, unknown> }>;
};

describe("FZK Haus static canonical project sample", () => {
  test("sample registry routes FZK Haus to a WEB-CAD canonical snapshot, not raw IFC", () => {
    const fzk = SAMPLES.find((sample) => sample.id === "kit-fzk-haus");

    expect(fzk).toBeDefined();
    expect(fzk?.format).toBe("webcad");
    expect(fzk?.path).toBe("samples/AC20-FZK-Haus.webcad");
  });

  test("bundled FZK snapshot carries linked canonical BRep geometry", () => {
    const raw = readFileSync(new URL("../public/samples/AC20-FZK-Haus.webcad", import.meta.url), "utf8");
    const payload = JSON.parse(raw) as ProjectPayload;

    expect(payload.format).toBe("web-cad.canonical-project");
    expect(payload.version).toBe(2);
    expect(payload.meta?.sourceIfc).toBe("samples/AC20-FZK-Haus.ifc");
    expect(payload.meta?.conversion).toBe("static-parametric-brep-snapshot");
    expect(payload.canonicalGeometry?.length).toBeGreaterThan(0);
    expect(payload.objects?.length).toBeGreaterThan(0);
    expect(payload.canonicalGeometry?.some((record) => record.kind === "brep")).toBe(true);
    expect(payload.canonicalGeometry?.every((record) => record.kind === "brep" || record.kind === "surface")).toBe(true);
    expect(payload.objects?.every((obj) => obj.displaySource === "canonical")).toBe(true);
    expect(payload.objects?.every((obj) => typeof obj.userData?.canonicalGeometryId === "string")).toBe(true);
  });
});
