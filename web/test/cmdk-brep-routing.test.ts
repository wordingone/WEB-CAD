import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const CMDK_SOURCE = readFileSync(new URL("../src/ui/cmdk.ts", import.meta.url), "utf8");

describe("Cmd-K BRep tool routing", () => {
  test("BRep operation rows activate the same op-tool IDs as the MODEL left palette", () => {
    const expectations: Record<string, string> = {
      explode: "brep-explode",
      join: "brep-join",
      rebuild: "brep-rebuild",
      contour: "brep-contour",
    };

    for (const [label, toolId] of Object.entries(expectations)) {
      const row = CMDK_SOURCE.split(/\r?\n/).find((line) => line.includes(`label: "${label} `));
      expect(row, label).toBeDefined();
      expect(row!, label).toContain(`toolId: "${toolId}"`);
      expect(row!, label).not.toContain(`toolId: "${label}"`);
      expect(row!, label).toContain(`icon: "${toolId}"`);
    }
  });
});
