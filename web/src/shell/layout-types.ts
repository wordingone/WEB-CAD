// layout-types.ts — shared types and pure utilities for layout (paper-space) mode.
// Imported by layout.ts and layout-export.ts; has no dependency on either.

import { getState } from "../app-state.js";
import { formatLength } from "../units.js";

// --- Sheet sizes (mm) -------------------------------------------------------

export type SheetSizeId =
  | "A0" | "A1" | "A2" | "A3" | "A4"
  | "Letter" | "Legal" | "Tabloid"
  | "Custom";
export type Orientation = "portrait" | "landscape";

export interface SheetDims { w: number; h: number; }

export const SHEET_DIMS: Record<Exclude<SheetSizeId, "Custom">, SheetDims> = {
  A0:      { w: 841,  h: 1189 },
  A1:      { w: 594,  h: 841  },
  A2:      { w: 420,  h: 594  },
  A3:      { w: 297,  h: 420  },
  A4:      { w: 210,  h: 297  },
  Letter:  { w: 216,  h: 279  },
  Legal:   { w: 216,  h: 356  },
  Tabloid: { w: 279,  h: 432  },
};

export const DEFAULT_CUSTOM: SheetDims = { w: 400, h: 600 };

export function sheetMm(size: SheetSizeId, orientation: Orientation, custom: SheetDims): SheetDims {
  const base = size === "Custom" ? custom : SHEET_DIMS[size];
  const portrait = base.w <= base.h ? base : { w: base.h, h: base.w };
  return orientation === "landscape" ? { w: portrait.h, h: portrait.w } : portrait;
}

// 96 dpi at 25.4 mm per inch ⇒ 1 mm = 96/25.4 px ≈ 3.7795 px.
export const MM_TO_PX = 96 / 25.4;

export function sheetPx(mm: SheetDims): { w: number; h: number } {
  return { w: mm.w * MM_TO_PX, h: mm.h * MM_TO_PX };
}

// --- Viewports --------------------------------------------------------------

export type ViewportId =
  | "top" | "bottom"
  | "front" | "back"
  | "left" | "right"
  | "perspective" | "axonometric";

export const VIEWPORT_LABELS: Record<ViewportId, string> = {
  top:          "PLAN",
  bottom:       "CEILING PLAN",
  front:        "SOUTH ELEVATION",
  back:         "NORTH ELEVATION",
  left:         "WEST ELEVATION",
  right:        "EAST ELEVATION",
  perspective:  "PERSPECTIVE",
  axonometric:  "AXONOMETRIC",
};

// --- Scale ratios -----------------------------------------------------------

export const SCALE_PRESETS = [
  "1:1", "1:5", "1:10", "1:20", "1:25", "1:50",
  "1:100", "1:200", "1:500", "1:1000",
  "NTS", "Custom",
] as const;

// Standard US/Imperial architectural scales shown when unitSystem === "imperial".
export const IMPERIAL_SCALE_PRESETS = [
  `1/16" = 1'-0"`,  // 1:192
  `1/8" = 1'-0"`,   // 1:96
  `1/4" = 1'-0"`,   // 1:48
  `1/2" = 1'-0"`,   // 1:24
  `3/4" = 1'-0"`,   // 1:16
  `1" = 1'-0"`,     // 1:12
  `1-1/2" = 1'-0"`, // 1:8
  `3" = 1'-0"`,     // 1:4
  "NTS", "Custom",
] as const;

export function activeScalePresets(): readonly string[] {
  return getState("unitSystem") === "imperial" ? IMPERIAL_SCALE_PRESETS : SCALE_PRESETS;
}

export type ScaleId = typeof SCALE_PRESETS[number] | typeof IMPERIAL_SCALE_PRESETS[number] | string;

export function parseScale(s: ScaleId): number {
  if (s === "NTS") return 1;
  const metricM = /^1:(\d+(?:\.\d+)?)$/.exec(s);
  if (metricM) return parseFloat(metricM[1]);
  const impM = /^(.+?)" = 1'-0"$/.exec(s);
  if (impM) {
    const frac = impM[1].trim();
    const mixed = /^(\d+)-(\d+)\/(\d+)$/.exec(frac);
    const simple = /^(\d+)\/(\d+)$/.exec(frac);
    const whole = /^(\d+)$/.exec(frac);
    let inches: number;
    if (mixed) inches = parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
    else if (simple) inches = parseInt(simple[1]) / parseInt(simple[2]);
    else if (whole) inches = parseInt(whole[1]);
    else return 1;
    return inches > 0 ? 12 / inches : 1;
  }
  return 1;
}

// --- Display modes ----------------------------------------------------------

export type DisplayMode = "shaded" | "wireframe" | "ghosted" | "realistic" | "technical";
export const DISPLAY_MODES: DisplayMode[] = ["shaded", "wireframe", "ghosted", "realistic", "technical"];

// --- Scene bounds provider --------------------------------------------------

export interface SceneBounds {
  min: [number, number, number];
  max: [number, number, number];
}
export type SceneBoundsProvider = () => SceneBounds;

export const DEFAULT_BOUNDS: SceneBounds = { min: [-1, -1, -1], max: [1, 1, 1] };
export const DEFAULT_PROVIDER: SceneBoundsProvider = () => DEFAULT_BOUNDS;

export function isStubBounds(b: SceneBounds): boolean {
  return (
    Math.abs(b.min[0] + 1) < 0.001 && Math.abs(b.min[1] + 1) < 0.001 && Math.abs(b.min[2] + 1) < 0.001 &&
    Math.abs(b.max[0] - 1) < 0.001 && Math.abs(b.max[1] - 1) < 0.001 && Math.abs(b.max[2] - 1) < 0.001
  );
}

// --- Panel state ------------------------------------------------------------

export interface DetailRef {
  parentPanelId: string;
  regionX: number;
  regionY: number;
  regionW: number;
  regionH: number;
  label: string;
}

export interface PanelInit {
  x: number;
  y: number;
  w: number;
  h: number;
  viewport: ViewportId;
  scale?: ScaleId;
  title?: string;
  border?: "thin" | "thick" | "none";
  displayMode?: DisplayMode;
  detailOf?: DetailRef;
}

export interface PanelState {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  viewport: ViewportId;
  scale: ScaleId;
  title: string;
  border: "thin" | "thick" | "none";
  displayMode: DisplayMode;
  detailOf?: DetailRef;
}

// --- Layout options / title block -------------------------------------------

export interface LayoutOptions {
  size?: SheetSizeId;
  orientation?: Orientation;
  customMm?: SheetDims;
  bounds?: SceneBoundsProvider;
  initialPanels?: PanelInit[];
  titleBlock?: Partial<TitleBlock>;
  showTitleBlock?: boolean;
  spawnDefault?: boolean;
}

export interface TitleBlock {
  project: string;
  sheet: string;
  scale: string;
  drawnBy: string;
  date: string;
}

export function formatToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}·${m}·${dd}`;
}

export const DEFAULT_TITLE: TitleBlock = {
  project:  "UNTITLED · 001",
  sheet:    "A-101",
  scale:    "1:50 / NTS",
  drawnBy:  "GEMMA·AI",
  date:     formatToday(),
};

// Rendering helper shared by LayoutController.renderPanel and layout-export.ts
export function renderScaleBar(p: PanelState): string {
  const ratio = parseScale(p.scale);
  const barPx = 50;
  const barMm = barPx / MM_TO_PX;
  const drawingMm = barMm * ratio;
  let label: string;
  if (p.scale === "NTS") label = "NTS";
  else label = formatLength(drawingMm / 1000);
  const half = barPx / 2;
  return `<svg viewBox="0 0 ${barPx + 14} 14" width="${barPx + 14}" height="14" aria-label="scale bar">
    <g stroke="#1a1a22" fill="#1a1a22" font-family="monospace" font-size="7">
      <rect x="2" y="6" width="${half}" height="3" fill="#1a1a22"/>
      <rect x="${2 + half}" y="6" width="${half}" height="3" fill="none" stroke-width="0.5"/>
      <line x1="2" y1="6" x2="2" y2="11" stroke-width="0.6"/>
      <line x1="${2 + half}" y1="6" x2="${2 + half}" y2="11" stroke-width="0.6"/>
      <line x1="${2 + barPx}" y1="6" x2="${2 + barPx}" y2="11" stroke-width="0.6"/>
      <text x="${2 + barPx + 2}" y="10">${label}</text>
    </g>
  </svg>`;
}
