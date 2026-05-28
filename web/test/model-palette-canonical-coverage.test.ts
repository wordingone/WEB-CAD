import { describe, expect, test, beforeEach } from "bun:test";
import { getState, setState, syncToolActiveClass } from "../src/app-state";
import { buildPalette, PALETTE_SECTIONS } from "../src/shell/workbench-panels";
import { dispatchSync } from "../src/commands/dispatch";
import { getCreateToolCausalSpecs, type CreateToolCausalSpec } from "../src/tools/index";
import { OP_TOOL_IDS } from "../src/viewer/picker-hint";

const SHARED_TOOLS = [
  "select", "move", "rotate", "scale", "copy", "array",
  "align-left", "align-center-h", "align-right", "align-top", "align-center-v", "align-bottom", "dist-h", "dist-v",
  "section", "clip",
  "aligned-dim", "angular-dim", "area-dim", "volume-dim", "label", "transient-measure",
];

const CAD_TOOLS = [
  "line", "rect", "circle", "polygon", "arc", "polyline", "curve", "spline", "point",
  "extrude", "loft", "sweep", "revolve", "plane", "surface",
  "boolean", "bool-union", "bool-diff", "bool-intersect", "fillet",
  "brep-explode", "brep-join", "brep-rebuild", "brep-contour",
];

const ARCH_TOOLS = [
  "wall", "slab", "column", "beam", "roof", "space", "foundation", "ceiling", "grid", "level", "datum",
  "stair", "door", "window", "ramp", "railing", "curtainwall", "skylight", "opening",
];

const DIRECT_TOOLS = new Set(["select"]);
const TRANSFORM_TOOLS = new Set(["move", "rotate", "scale"]);
const IMMEDIATE_TOOLS = new Set([
  "align-left", "align-center-h", "align-right", "align-top", "align-center-v", "align-bottom", "dist-h", "dist-v",
]);

const EXPECTED_CREATE_SPECS: Record<string, Pick<CreateToolCausalSpec, "clicks" | "chain"> & { minPoints?: number }> = {
  wall: { clicks: 2, chain: false },
  "wall-polyline": { clicks: 2, chain: true },
  "wall-curve": { clicks: -1, chain: false },
  rect: { clicks: 2, chain: false },
  circle: { clicks: 2, chain: false },
  line: { clicks: 2, chain: false },
  slab: { clicks: 2, chain: false },
  door: { clicks: 1, chain: false },
  window: { clicks: 1, chain: false },
  column: { clicks: 1, chain: false },
  stair: { clicks: 2, chain: false },
  "stair-polyline": { clicks: -1, chain: false },
  "stair-curve": { clicks: -1, chain: false },
  polygon: { clicks: 2, chain: false },
  arc: { clicks: 3, chain: false },
  polyline: { clicks: -1, chain: false },
  curve: { clicks: -1, chain: false },
  spline: { clicks: -1, chain: false, minPoints: 4 },
  point: { clicks: 1, chain: false },
  beam: { clicks: 2, chain: false },
  roof: { clicks: 2, chain: false },
  space: { clicks: 2, chain: false },
  foundation: { clicks: 2, chain: false },
  ceiling: { clicks: 2, chain: false },
  curtainwall: { clicks: 2, chain: false },
  skylight: { clicks: 2, chain: false },
  opening: { clicks: 1, chain: false },
  ramp: { clicks: 2, chain: false },
  railing: { clicks: 2, chain: false },
  grid: { clicks: 2, chain: false },
  level: { clicks: 1, chain: false },
  datum: { clicks: 2, chain: false },
  section: { clicks: 2, chain: false },
  clip: { clicks: 1, chain: false },
  "clip-section": { clicks: 2, chain: false },
};

function visibleToolIds(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>(".palette-section:not(.palette-section--hidden) .palette-btn[data-tool]")]
    .map((btn) => btn.dataset.tool!)
    .filter(Boolean);
}

function buildHost(): HTMLElement {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  buildPalette(host);
  return host;
}

beforeEach(() => {
  setState("activeTool", "select");
});

describe("MODEL left palette ARCH/CAD coverage", () => {
  test("source inventory includes every current model palette button exactly once", () => {
    const ids = PALETTE_SECTIONS.flatMap((section) => section.tools.map((tool) => tool.id));
    expect(ids).toEqual([...SHARED_TOOLS.slice(0, 14), ...CAD_TOOLS.slice(0, 9), ...CAD_TOOLS.slice(9, 20), ...CAD_TOOLS.slice(20), ...ARCH_TOOLS.slice(0, 11), ...ARCH_TOOLS.slice(11), ...SHARED_TOOLS.slice(14, 16), ...SHARED_TOOLS.slice(16)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("ARCH tab shows transform, architectural, analysis, and annotation tools but hides CAD geometry tools", () => {
    const host = buildHost();
    window.dispatchEvent(new CustomEvent("ribbon:section-tab", { detail: { tab: "ARCH" } }));

    const visible = visibleToolIds(host);

    expect(visible).toEqual([...SHARED_TOOLS.slice(0, 14), ...ARCH_TOOLS, ...SHARED_TOOLS.slice(14)]);
    for (const id of CAD_TOOLS) expect(visible).not.toContain(id);
  });

  test("CAD tab shows transform, sketch, solid, BRep, analysis, and annotation tools but hides ARCH elements", () => {
    const host = buildHost();
    window.dispatchEvent(new CustomEvent("ribbon:section-tab", { detail: { tab: "CAD" } }));

    const visible = visibleToolIds(host);

    expect(visible).toEqual([...SHARED_TOOLS.slice(0, 14), ...CAD_TOOLS, ...SHARED_TOOLS.slice(14)]);
    for (const id of ARCH_TOOLS) expect(visible).not.toContain(id);
  });

  test("hidden sub-tools highlight their visible parent palette button", () => {
    const host = buildHost();
    syncToolActiveClass();
    const expectations: Record<string, string> = {
      "wall-polyline": "wall",
      "wall-curve": "wall",
      "wall-pick": "wall",
      "stair-polyline": "stair",
      "stair-curve": "stair",
      "clip-section": "clip",
      "scale-1d": "scale",
      "scale-2d": "scale",
      "sel-window": "select",
      "sel-lasso": "select",
      "sel-boundary": "select",
    };

    for (const [activeTool, parentTool] of Object.entries(expectations)) {
      setState("activeTool", activeTool);
      expect(host.querySelector<HTMLElement>(`.palette-btn[data-tool="${parentTool}"]`)?.classList.contains("active"), activeTool).toBe(true);
    }
  });

  test("every model palette button has one explicit activation route", () => {
    const createSpecs = getCreateToolCausalSpecs();
    const ids = PALETTE_SECTIONS.flatMap((section) => section.tools.map((tool) => tool.id));
    const allClassified = new Set([
      ...Object.keys(createSpecs),
      ...OP_TOOL_IDS,
      ...DIRECT_TOOLS,
      ...TRANSFORM_TOOLS,
      ...IMMEDIATE_TOOLS,
    ]);

    for (const id of ids) {
      expect(allClassified.has(id), id).toBe(true);
    }
    for (const id of ids) {
      const routeCount = [
        createSpecs[id] !== undefined,
        OP_TOOL_IDS.has(id),
        DIRECT_TOOLS.has(id),
        TRANSFORM_TOOLS.has(id),
        IMMEDIATE_TOOLS.has(id),
      ].filter(Boolean).length;
      expect(routeCount, id).toBe(1);
    }
  });

  test("create-mode manifest records exact post-click input requirements", () => {
    const createSpecs = getCreateToolCausalSpecs();

    expect(Object.keys(createSpecs).sort()).toEqual(Object.keys(EXPECTED_CREATE_SPECS).sort());
    for (const [id, expected] of Object.entries(EXPECTED_CREATE_SPECS)) {
      expect(createSpecs[id], id).toMatchObject({ route: "create", ...expected });
    }
    for (const id of OP_TOOL_IDS) {
      expect(createSpecs[id], id).toBeUndefined();
    }
  });

  test("visible palette clicks set the active tool, with op-tools toggling back to select on second click", () => {
    const host = buildHost();
    window.dispatchEvent(new CustomEvent("ribbon:section-tab", { detail: { tab: "CAD" } }));

    for (const id of visibleToolIds(host)) {
      if (IMMEDIATE_TOOLS.has(id)) continue;
      setState("activeTool", "select");
      const btn = host.querySelector<HTMLButtonElement>(`.palette-btn[data-tool="${id}"]`);
      expect(btn, id).toBeDefined();
      btn!.click();
      expect(getState("activeTool"), id).toBe(id);
      if (OP_TOOL_IDS.has(id)) {
        btn!.click();
        expect(getState("activeTool"), id).toBe("select");
      }
    }
  });

  test("dispatch-level setActiveTool preserves hidden subtool IDs for their downstream pipelines", () => {
    const subtools = ["wall-polyline", "wall-curve", "wall-pick", "stair-polyline", "stair-curve", "clip-section", "scale-1d", "scale-2d", "sel-window", "sel-lasso", "sel-boundary"];
    for (const toolId of subtools) {
      const result = dispatchSync("setActiveTool", { toolId });
      expect(result.ok, toolId).toBe(true);
      expect(getState("activeTool"), toolId).toBe(toolId);
    }
  });
});
