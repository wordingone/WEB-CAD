import { describe, expect, test, beforeEach } from "bun:test";
import { setState, syncToolActiveClass } from "../src/app-state";
import { buildPalette, PALETTE_SECTIONS } from "../src/shell/workbench-panels";

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
});
