// agent-roles.test.ts — gap #5 PR 1 gate: role-based verb filter
// Does not import agent-harness.ts (has @huggingface dep not testable in Bun).
// Tests matchesRole() and ROLE_TOPOLOGIES directly against the dictionary.

import { describe, expect, test } from "bun:test";
import { getDictionary } from "../src/commands/dictionary";
import { type AgentRole, matchesRole } from "../src/agent/agent-roles";

// Known verbs per topology_role
const ARCHITECTURAL_INCLUDE = "SdWall";      // topology_role: host
const ARCHITECTURAL_EXCLUDE = "SdBox";       // topology_role: solid
const GEOMETRY_INCLUDE = "SdBox";            // topology_role: solid
const GEOMETRY_EXCLUDE = "SdWall";           // topology_role: host
const ANALYSIS_INCLUDE = "SdMeasure";        // topology_role: annotation
const ANALYSIS_EXCLUDE = "SdBox";            // topology_role: solid — no mutations in analysis

// §15 AgentMeta verbs — always present regardless of role
const AGENT_META = ["create_goal", "update_goal", "get_goal"] as const;

function filteredVerbs(role: AgentRole): string[] {
  return getDictionary().filter((e) => matchesRole(e, role)).map((e) => e.name);
}

describe("agent-roles — verb filter", () => {
  test("architectural includes SdWall (host) and excludes SdBox (solid)", () => {
    const names = filteredVerbs("architectural");
    expect(names).toContain(ARCHITECTURAL_INCLUDE);
    expect(names).not.toContain(ARCHITECTURAL_EXCLUDE);
  });

  test("geometry includes SdBox (solid) and excludes SdWall (host)", () => {
    const names = filteredVerbs("geometry");
    expect(names).toContain(GEOMETRY_INCLUDE);
    expect(names).not.toContain(GEOMETRY_EXCLUDE);
  });

  test("analysis includes SdMeasure (annotation) and excludes SdBox (solid)", () => {
    const names = filteredVerbs("analysis");
    expect(names).toContain(ANALYSIS_INCLUDE);
    expect(names).not.toContain(ANALYSIS_EXCLUDE);
  });

  test("§15 AgentMeta verbs (create_goal/update_goal/get_goal) always included in all roles", () => {
    for (const role of ["architectural", "geometry", "analysis"] as AgentRole[]) {
      const names = filteredVerbs(role);
      for (const meta of AGENT_META) {
        expect(names, `${meta} missing from role=${role}`).toContain(meta);
      }
    }
  });

  test("architectural count is less than full dictionary but >80 (includes IFC + system + transform + view + selection + annotation)", () => {
    const total = getDictionary().length;
    const count = filteredVerbs("architectural").length;
    expect(count).toBeGreaterThan(80);
    expect(count).toBeLessThan(total);
  });

  test("geometry count is less than full dictionary but >100 (includes solid + edge + face + curve + compound + transform + selection)", () => {
    const total = getDictionary().length;
    const count = filteredVerbs("geometry").length;
    expect(count).toBeGreaterThan(100);
    expect(count).toBeLessThan(total);
  });

  test("analysis count is less than geometry and architectural (read-only slice of dictionary)", () => {
    const archCount = filteredVerbs("architectural").length;
    const geoCount  = filteredVerbs("geometry").length;
    const anaCount  = filteredVerbs("analysis").length;
    expect(anaCount).toBeLessThan(geoCount);
    expect(anaCount).toBeLessThan(archCount);
  });

  test("geometry includes SdNurbsSurface* (face) — NURBS modeling verbs present", () => {
    const names = filteredVerbs("geometry");
    const nurbs = names.filter((n) => n.startsWith("SdNurbs"));
    expect(nurbs.length).toBeGreaterThan(0);
  });

  test("architectural excludes SdNurbsSurfaceFromGrid (face) — NURBS not in architectural role", () => {
    const names = filteredVerbs("architectural");
    expect(names).not.toContain("SdNurbsSurfaceFromGrid");
  });

  test("analysis excludes SdTranslate/SdMove (transform) — no mutations in analysis role", () => {
    const names = filteredVerbs("analysis");
    // transform topology_role — should not appear in analysis
    expect(names).not.toContain("SdTranslate");
    expect(names).not.toContain("SdMove");
  });
});
