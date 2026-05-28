import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("CAD/BRep op-tool command parity", () => {
  test("visible CAD/BRep op-tool completions route through agent-facing Sd handlers", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");

    for (const command of ["SdExtrude", "SdLoft", "SdSweep", "SdRevolve", "SdPlane", "SdSurface"]) {
      expect(source, command).toContain(`dispatchSync("${command}"`);
    }
  });

  test("extrude completion no longer commits through private mesh construction", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");
    const start = source.indexOf('if (phase.kind === "extrude_height")');
    const end = source.indexOf('if (phase.kind === "loft_curve1")');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const extrudeCommit = source.slice(start, end);

    expect(extrudeCommit).toContain('dispatchSync("SdExtrude"');
    expect(extrudeCommit).not.toContain("opBuildExtrudeMesh");
    expect(extrudeCommit).not.toContain("linkOpToolExtrudeCanonical");
    expect(extrudeCommit).not.toContain("viewer.addMesh");
  });
});
