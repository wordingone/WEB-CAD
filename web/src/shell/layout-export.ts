// layout-export.ts — SVG/PDF/DXF/AI export and sheet-cut logic for layout mode.
// Imported by layout.ts; uses import type for LayoutController to avoid circular runtime dep.

import type { LayoutController } from "./layout";
import type { Viewer, ExportFacePoly, ClassifiedEdgeSeg } from "../viewer/viewer";
import { LINEWEIGHT, DASH_PATTERN, DXF_LWEIGHT, DXF_LINETYPE } from "../viewer/viewer";
import { clippingPlaneStore } from "../geometry/clipping-planes";
import {
  sheetMm, sheetPx, MM_TO_PX, DEFAULT_CUSTOM,
  isStubBounds, renderScaleBar,
  type SheetSizeId, type Orientation, type ViewportId,
  type PanelState, type SceneBounds,
} from "./layout-types";

// --- Viewport ID → Viewer ViewName mapping ----------------------------------

export function layoutViewportToViewName(v: ViewportId): "top" | "persp" | "front" | "right" {
  switch (v) {
    case "front": case "back": return "front";
    case "right": case "left": return "right";
    case "perspective": case "axonometric": return "persp";
    default: return "top";
  }
}

// --- Viewport SVG rendering (real projection + AABB fallback) ---------------

interface PlanProj {
  sx: (a: number, b: number, c: number) => number;
  sy: (a: number, b: number, c: number) => number;
  au: number;
  av: number;
}

export function renderViewportSvg(p: PanelState, b: SceneBounds, viewer?: Viewer): string {
  const w = p.w, h = p.h;
  if (w < 4 || h < 4) return "";

  if (viewer) {
    const viewName = layoutViewportToViewName(p.viewport);
    const classifiedSegs: ClassifiedEdgeSeg[] = viewer.getClassifiedEdgeSegmentsForView
      ? viewer.getClassifiedEdgeSegmentsForView(viewName, w, h)
      : [];
    const segs = classifiedSegs.length > 0
      ? []
      : viewer.getEdgeSegmentsForView(viewName, w, h);
    const polys: ExportFacePoly[] = viewer.getFacePolygonsForView
      ? viewer.getFacePolygonsForView(viewName, w, h)
      : [];

    if (classifiedSegs.length > 0 || segs.length > 0 || polys.length > 0) {
      const fillMarkup = polys.map(({ pts, fill }) => {
        const [a, b2, c] = pts;
        return `<polygon points="${a[0].toFixed(2)},${a[1].toFixed(2)} ${b2[0].toFixed(2)},${b2[1].toFixed(2)} ${c[0].toFixed(2)},${c[1].toFixed(2)}" fill="${fill}" stroke="none"/>`;
      }).join("\n      ");

      let edgeMarkup: string;
      if (classifiedSegs.length > 0) {
        edgeMarkup = classifiedSegs.map(({ x1, y1, x2, y2, cls }) => {
          const dash = DASH_PATTERN[cls];
          const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
          return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke-width="${LINEWEIGHT[cls]}"${dashAttr}/>`;
        }).join("\n      ");
      } else {
        edgeMarkup = segs.map(([x1, y1, x2, y2]) =>
          `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`,
        ).join("\n      ");
      }

      return `<svg viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" preserveAspectRatio="xMidYMid meet">
      <rect x="0" y="0" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="#ffffff"/>
      <g>${fillMarkup}</g>
      <g fill="none" stroke="#1a1a22" stroke-linecap="round" stroke-linejoin="round">
      ${edgeMarkup}
      </g>
    </svg>`;
    }
  }

  const dx = b.max[0] - b.min[0] || 1;
  const dy = b.max[1] - b.min[1] || 1;
  const dz = b.max[2] - b.min[2] || 1;

  let proj: PlanProj;
  switch (p.viewport) {
    case "top":         proj = { sx: (x, _y, _z) => x,  sy: (_x, y, _z) => -y, au: dx, av: dy }; break;
    case "bottom":      proj = { sx: (x, _y, _z) => x,  sy: (_x, y, _z) =>  y, au: dx, av: dy }; break;
    case "front":       proj = { sx: (x, _y, _z) => x,  sy: (_x, _y, z) => -z, au: dx, av: dz }; break;
    case "back":        proj = { sx: (x, _y, _z) => -x, sy: (_x, _y, z) => -z, au: dx, av: dz }; break;
    case "left":        proj = { sx: (_x, y, _z) => -y, sy: (_x, _y, z) => -z, au: dy, av: dz }; break;
    case "right":       proj = { sx: (_x, y, _z) =>  y, sy: (_x, _y, z) => -z, au: dy, av: dz }; break;
    case "axonometric":
    case "perspective": {
      const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
      proj = {
        sx: (x, y, _z) =>  x * c30 - y * c30,
        sy: (x, y,  z) => -z + (x * s30 + y * s30),
        au: (dx + dy) * c30,
        av: (dx + dy) * s30 + dz,
      };
      break;
    }
  }

  const corners: Array<[number, number, number]> = [
    [b.min[0], b.min[1], b.min[2]],
    [b.max[0], b.min[1], b.min[2]],
    [b.max[0], b.max[1], b.min[2]],
    [b.min[0], b.max[1], b.min[2]],
    [b.min[0], b.min[1], b.max[2]],
    [b.max[0], b.min[1], b.max[2]],
    [b.max[0], b.max[1], b.max[2]],
    [b.min[0], b.max[1], b.max[2]],
  ];
  const projected = corners.map((c) => [proj.sx(c[0], c[1], c[2]), proj.sy(c[0], c[1], c[2])] as [number, number]);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of projected) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const PAD = 8;
  const aw = maxX - minX || 1;
  const ah = maxY - minY || 1;
  const k = Math.min((w - 2 * PAD) / aw, (h - 2 * PAD) / ah);
  const ox = (w - aw * k) / 2 - minX * k;
  const oy = (h - ah * k) / 2 - minY * k;
  const xy = projected.map(([x, y]) => [x * k + ox, y * k + oy] as [number, number]);

  const isOrtho = p.viewport !== "axonometric" && p.viewport !== "perspective";

  if (isOrtho) {
    const pts = [xy[0], xy[1], xy[2], xy[3]];
    const path = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)} ` +
                 `L ${pts[1][0].toFixed(2)} ${pts[1][1].toFixed(2)} ` +
                 `L ${pts[2][0].toFixed(2)} ${pts[2][1].toFixed(2)} ` +
                 `L ${pts[3][0].toFixed(2)} ${pts[3][1].toFixed(2)} Z`;
    const isStub = isStubBounds(b);
    const diagonals = isStub
      ? `<line x1="${pts[0][0].toFixed(2)}" y1="${pts[0][1].toFixed(2)}" x2="${pts[2][0].toFixed(2)}" y2="${pts[2][1].toFixed(2)}" stroke-width="0.4" stroke-dasharray="2 2"/>
        <line x1="${pts[1][0].toFixed(2)}" y1="${pts[1][1].toFixed(2)}" x2="${pts[3][0].toFixed(2)}" y2="${pts[3][1].toFixed(2)}" stroke-width="0.4" stroke-dasharray="2 2"/>`
      : "";
    const vb1 = `0 0 ${w.toFixed(2)} ${h.toFixed(2)}`;
    return `<svg viewBox="${vb1}" preserveAspectRatio="xMidYMid meet">
      <g fill="none" stroke="#1a1a22" stroke-width="1">
        <path d="${path}" stroke-width="1.4"/>
        ${diagonals}
      </g>
    </svg>`;
  }

  const E: Array<[number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const edgeLines = E.map(([a, c], i) => {
    const x1 = xy[a][0].toFixed(2);
    const y1 = xy[a][1].toFixed(2);
    const x2 = xy[c][0].toFixed(2);
    const y2 = xy[c][1].toFixed(2);
    const dashed = i === 1 || i === 2 || i === 10 || i === 11;
    const sw = dashed ? 0.5 : 1.2;
    const da = dashed ? ` stroke-dasharray="3 2"` : "";
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${sw}"${da}/>`;
  }).join("\n      ");
  const vb2 = `0 0 ${w.toFixed(2)} ${h.toFixed(2)}`;
  return `<svg viewBox="${vb2}" preserveAspectRatio="xMidYMid meet">
    <g fill="none" stroke="#1a1a22">
      ${edgeLines}
    </g>
  </svg>`;
}

// --- Export helpers ---------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (ch) => {
    switch (ch) {
      case "<":  return "&lt;";
      case ">":  return "&gt;";
      case "&":  return "&amp;";
      case "\"": return "&quot;";
      default:   return "&apos;";
    }
  });
}

// --- SVG composition --------------------------------------------------------

export function composeSvg(c: LayoutController): string {
  const mm = sheetMm(c.size, c.orientation, c.customMm);
  const px = sheetPx(mm);
  const w = px.w, h = px.h;
  const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;

  const panelMarkup = c.panels.map((p) => {
    const inner = renderViewportSvg(p, c.bounds(), viewer).replace(/^<svg [^>]*>|<\/svg>$/g, "");
    const sb = renderScaleBar(p).replace(/^<svg [^>]*>|<\/svg>$/g, "");
    const titleLabel = `<text x="6" y="10" font-size="7" font-family="monospace" fill="#1a1a22">${escapeXml(p.title)}</text>`;
    const scaleLabel = `<text x="${(p.w - 4).toFixed(2)}" y="10" font-size="7" font-family="monospace" fill="#5a5a66" text-anchor="end">${escapeXml(p.scale)}</text>`;
    const sbX = (p.w - 70).toFixed(2);
    const sbY = (p.h - 16).toFixed(2);
    return `<g transform="translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})">
      <rect x="0" y="0" width="${p.w.toFixed(2)}" height="${p.h.toFixed(2)}" fill="#ffffff" stroke="#1a1a22" stroke-width="${p.border === "thick" ? 1.5 : 0.6}"${p.border === "none" ? ` stroke-opacity="0"` : ""}/>
      <svg x="0" y="0" width="${p.w.toFixed(2)}" height="${p.h.toFixed(2)}" viewBox="0 0 ${p.w.toFixed(2)} ${p.h.toFixed(2)}">${inner}</svg>
      ${titleLabel}
      ${scaleLabel}
      <g transform="translate(${sbX} ${sbY})">${sb}</g>
    </g>`;
  }).join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" width="${mm.w}mm" height="${mm.h}mm">
  <rect x="0" y="0" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="#fefefa" stroke="#1a1a22" stroke-width="1"/>
  <rect x="12" y="12" width="${(w - 24).toFixed(2)}" height="${(h - 24).toFixed(2)}" fill="none" stroke="#5a5a66" stroke-width="0.4"/>
  ${panelMarkup}
</svg>
`;
}

// --- Sheet template — #1805 -------------------------------------------------

export type SheetViewType = "plan" | "rcp" | "section" | "elevation" | "3d";
export type CardinalDir = "N" | "S" | "E" | "W";
export type SectionAxis = "NS-1" | "NS-2" | "EW-1" | "EW-2";

export interface SheetTemplate {
  id: string;
  viewType: SheetViewType;
  title: string;
  levelId?: string;
  cutOffset?: number;
  rcpCutOffset?: number;
  origin?: [number, number, number];
  normal?: [number, number, number];
  farClip?: number;
  cardinalDir?: CardinalDir;
  sectionAxis?: SectionAxis;
  camera: "top" | "front" | "right";
  clipPlaneId?: string;
}

export const DEMO_SHEET_SET: SheetTemplate[] = [
  { id: "S5", viewType: "section",   title: "Section A-A",       sectionAxis: "NS-1", camera: "front" },
  { id: "S6", viewType: "section",   title: "Section B-B",       sectionAxis: "NS-2", camera: "front" },
  { id: "S7", viewType: "section",   title: "Section C-C",       sectionAxis: "EW-1", camera: "right" },
  { id: "S8", viewType: "section",   title: "Section D-D",       sectionAxis: "EW-2", camera: "right" },
  { id: "S1", viewType: "elevation", title: "Elevation: North",  cardinalDir: "N",    farClip: 40, camera: "front" },
  { id: "S2", viewType: "elevation", title: "Elevation: East",   cardinalDir: "E",    farClip: 40, camera: "right" },
  { id: "S3", viewType: "elevation", title: "Elevation: South",  cardinalDir: "S",    farClip: 40, camera: "front" },
  { id: "S4", viewType: "elevation", title: "Elevation: West",   cardinalDir: "W",    farClip: 40, camera: "right" },
];

export interface SheetLevelRef { elevation: number; height?: number; }

export function applySheetCut(
  viewer: Viewer,
  t: SheetTemplate,
  levels?: Record<string, SheetLevelRef>,
): void {
  viewer.clearClippingPlanes();
  viewer.clearSectionBox();

  const BIG = 1e6;

  if (t.viewType === "plan") {
    const lvl = levels?.[t.levelId ?? ""] ?? { elevation: 0 };
    const cut = (t.cutOffset ?? 1.372);
    viewer.setSectionBox(
      [-BIG, -BIG, lvl.elevation],
      [ BIG,  BIG, lvl.elevation + cut],
    );
  } else if (t.viewType === "rcp") {
    const lvl = levels?.[t.levelId ?? ""] ?? { elevation: 0, height: 3.0 };
    const rcpCut = t.rcpCutOffset ?? 2.44;
    const levelHeight = lvl.height ?? 3.0;
    viewer.setSectionBox(
      [-BIG, -BIG, lvl.elevation + rcpCut],
      [ BIG,  BIG, lvl.elevation + levelHeight],
    );
  } else if (t.viewType === "section") {
    let origin: [number, number, number] = t.origin ?? [0, 0, 0];
    let normal: [number, number, number] = t.normal ?? [0, -1, 0];
    let farClip = t.farClip;
    if (t.clipPlaneId) {
      const entity = clippingPlaneStore.get(t.clipPlaneId);
      if (entity) {
        origin = entity.origin;
        normal = entity.normal;
        farClip = entity.bounds.farClip;
      }
    } else if (t.sectionAxis) {
      const bounds = viewer.getSceneBounds?.();
      const cx = bounds ? (bounds.min.x + bounds.max.x) / 2 : 0;
      const cy = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
      const cz = bounds ? (bounds.min.z + bounds.max.z) / 2 : 0;
      const spanX = bounds ? bounds.max.x - bounds.min.x : 20;
      const spanY = bounds ? bounds.max.y - bounds.min.y : 20;
      const minX = bounds ? bounds.min.x : -10;
      const minY = bounds ? bounds.min.y : -10;
      switch (t.sectionAxis) {
        case "NS-1": origin = [cx, minY + spanY / 3, cz];           normal = [0, -1, 0]; farClip = farClip ?? spanY * 1.1; break;
        case "NS-2": origin = [cx, minY + 2 * spanY / 3, cz];       normal = [0, -1, 0]; farClip = farClip ?? spanY * 1.1; break;
        case "EW-1": origin = [minX + spanX / 3, cy, cz];           normal = [-1, 0, 0]; farClip = farClip ?? spanX * 1.1; break;
        case "EW-2": origin = [minX + 2 * spanX / 3, cy, cz];       normal = [-1, 0, 0]; farClip = farClip ?? spanX * 1.1; break;
      }
    }
    viewer.addClippingPlane(origin, normal, "sheet-front");
    if (farClip != null) {
      const back: [number, number, number] = [
        origin[0] + normal[0] * farClip,
        origin[1] + normal[1] * farClip,
        origin[2] + normal[2] * farClip,
      ];
      viewer.addClippingPlane(back, [-normal[0], -normal[1], -normal[2]], "sheet-back");
    }
  } else if (t.viewType === "elevation") {
    let origin: [number, number, number];
    let normal: [number, number, number];
    if (t.cardinalDir) {
      const bounds = viewer.getSceneBounds?.();
      const cx = bounds ? (bounds.min.x + bounds.max.x) / 2 : 0;
      const cy = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
      const cz = bounds ? (bounds.min.z + bounds.max.z) / 2 : 0;
      const margin = 0.1;
      switch (t.cardinalDir) {
        case "N": origin = [cx, bounds ? bounds.max.y + margin : BIG, cz]; normal = [0, -1, 0]; break;
        case "S": origin = [cx, bounds ? bounds.min.y - margin : -BIG, cz]; normal = [0,  1, 0]; break;
        case "E": origin = [bounds ? bounds.max.x + margin : BIG, cy, cz]; normal = [-1, 0, 0]; break;
        case "W": origin = [bounds ? bounds.min.x - margin : -BIG, cy, cz]; normal = [ 1, 0, 0]; break;
      }
    } else {
      origin = t.origin ?? [0, 0, 0];
      normal = t.normal ?? [0, -1, 0];
    }
    viewer.addClippingPlane(origin!, normal!, "sheet-front");
    if (t.farClip != null) {
      const n = normal!;
      const back: [number, number, number] = [
        origin![0] + n[0] * t.farClip,
        origin![1] + n[1] * t.farClip,
        origin![2] + n[2] * t.farClip,
      ];
      viewer.addClippingPlane(back, [-n[0], -n[1], -n[2]], "sheet-back");
    }
  }
}

export function resetSheetCut(viewer: Viewer): void {
  viewer.clearClippingPlanes();
  viewer.clearSectionBox();
}

export async function exportSheetSetAsPdf(
  templates: SheetTemplate[],
  opts: {
    sheetSize?: SheetSizeId;
    orientation?: Orientation;
    levels?: Record<string, SheetLevelRef>;
    panelMarginMm?: number;
  } = {},
): Promise<ArrayBuffer> {
  const {
    sheetSize = "A1",
    orientation = "landscape",
    levels = {},
    panelMarginMm = 10,
  } = opts;

  const mm = sheetMm(sheetSize, orientation, DEFAULT_CUSTOM);
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({
    orientation: mm.w > mm.h ? "landscape" : "portrait",
    unit: "mm",
    format: [mm.w, mm.h],
  });

  const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;
  const PX_TO_MM = 25.4 / 96;
  const panelWmm = mm.w - panelMarginMm * 2;
  const panelHmm = mm.h - panelMarginMm * 2;
  const panelWpx = Math.round(panelWmm / PX_TO_MM);
  const panelHpx = Math.round(panelHmm / PX_TO_MM);

  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    if (i > 0) doc.addPage([mm.w, mm.h], mm.w > mm.h ? "landscape" : "portrait");

    doc.setLineWidth(0.4);
    doc.setDrawColor(60, 60, 70);
    doc.rect(3, 3, mm.w - 6, mm.h - 6);

    doc.setFontSize(9);
    doc.setTextColor(26, 26, 34);
    doc.text(`${t.id}  ${t.title}`, panelMarginMm, mm.h - panelMarginMm / 2);

    if (viewer) {
      applySheetCut(viewer, t, levels);
    }

    const px = panelMarginMm;
    const py = panelMarginMm;

    if (viewer?.getFacePolygonsForView) {
      const polys = viewer.getFacePolygonsForView(t.camera, panelWpx, panelHpx);
      for (const { pts, fill } of polys) {
        const [r, g, b2] = hexToRgb(fill);
        doc.setFillColor(r, g, b2);
        doc.triangle(
          px + pts[0][0] * PX_TO_MM, py + pts[0][1] * PX_TO_MM,
          px + pts[1][0] * PX_TO_MM, py + pts[1][1] * PX_TO_MM,
          px + pts[2][0] * PX_TO_MM, py + pts[2][1] * PX_TO_MM,
          "F",
        );
      }
    }
    doc.setDrawColor(26, 26, 34);
    if (viewer?.getClassifiedEdgeSegmentsForView) {
      const clSegs = viewer.getClassifiedEdgeSegmentsForView(t.camera, panelWpx, panelHpx);
      for (const { x1, y1, x2, y2, cls } of clSegs) {
        doc.setLineWidth(LINEWEIGHT[cls] * PX_TO_MM);
        const dash = DASH_PATTERN[cls];
        if (dash) {
          const [d, g] = dash.split(" ").map((v) => parseFloat(v) * PX_TO_MM);
          doc.setLineDashPattern([d, g], 0);
        } else {
          doc.setLineDashPattern([], 0);
        }
        doc.line(px + x1 * PX_TO_MM, py + y1 * PX_TO_MM, px + x2 * PX_TO_MM, py + y2 * PX_TO_MM);
      }
      doc.setLineDashPattern([], 0);
      doc.setLineWidth(0.25);
    }

    if (viewer) resetSheetCut(viewer);
  }

  return doc.output("arraybuffer") as ArrayBuffer;
}

// --- PDF export -------------------------------------------------------------

const MM_TO_PT = 72 / 25.4;
void MM_TO_PT; // referenced by DXF path for unit documentation

export async function exportLayoutAsPdfImpl(c: LayoutController): Promise<ArrayBuffer> {
  const mm = sheetMm(c.size, c.orientation, c.customMm);
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({
    orientation: mm.w > mm.h ? "landscape" : "portrait",
    unit: "mm",
    format: [mm.w, mm.h],
  });

  const PX_TO_MM = 25.4 / 96;
  const sheetWmm = mm.w;
  const sheetHmm = mm.h;

  doc.setLineWidth(0.4);
  doc.setDrawColor(60, 60, 70);
  doc.rect(3, 3, sheetWmm - 6, sheetHmm - 6);

  const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;
  for (const p of c.panels) {
    const px = p.x * PX_TO_MM;
    const py = p.y * PX_TO_MM;
    const pw = p.w * PX_TO_MM;
    const ph = p.h * PX_TO_MM;
    doc.setLineWidth(p.border === "thick" ? 0.6 : 0.25);
    doc.setDrawColor(26, 26, 34);
    if (p.border !== "none") doc.rect(px, py, pw, ph);
    if (viewer?.getFacePolygonsForView) {
      const viewName = layoutViewportToViewName(p.viewport);
      const polys = viewer.getFacePolygonsForView(viewName, p.w, p.h);
      for (const { pts, fill } of polys) {
        const [r, g, b2] = hexToRgb(fill);
        doc.setFillColor(r, g, b2);
        doc.triangle(
          px + pts[0][0] * PX_TO_MM, py + pts[0][1] * PX_TO_MM,
          px + pts[1][0] * PX_TO_MM, py + pts[1][1] * PX_TO_MM,
          px + pts[2][0] * PX_TO_MM, py + pts[2][1] * PX_TO_MM,
          "F",
        );
      }
    }
    doc.setDrawColor(26, 26, 34);
    if (viewer?.getClassifiedEdgeSegmentsForView) {
      const viewName = layoutViewportToViewName(p.viewport);
      const clSegs = viewer.getClassifiedEdgeSegmentsForView(viewName, p.w, p.h);
      for (const { x1, y1, x2, y2, cls } of clSegs) {
        const lw = LINEWEIGHT[cls] * PX_TO_MM;
        doc.setLineWidth(lw);
        const dash = DASH_PATTERN[cls];
        if (dash) {
          const [d, g] = dash.split(" ").map((v) => parseFloat(v) * PX_TO_MM);
          doc.setLineDashPattern([d, g], 0);
        } else {
          doc.setLineDashPattern([], 0);
        }
        doc.line(px + x1 * PX_TO_MM, py + y1 * PX_TO_MM, px + x2 * PX_TO_MM, py + y2 * PX_TO_MM);
      }
      doc.setLineDashPattern([], 0);
      doc.setLineWidth(0.25);
    } else {
      const inner = renderViewportSvg(p, c.bounds(), viewer);
      doc.setLineWidth(0.25);
      extractSvgLines(inner).forEach(([sx, sy, ex, ey]) => {
        doc.line(px + sx * PX_TO_MM, py + sy * PX_TO_MM, px + ex * PX_TO_MM, py + ey * PX_TO_MM);
      });
      extractSvgPaths(inner).forEach((pts) => {
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1], b = pts[k];
          doc.line(px + a[0] * PX_TO_MM, py + a[1] * PX_TO_MM, px + b[0] * PX_TO_MM, py + b[1] * PX_TO_MM);
        }
      });
    }
    doc.setFontSize(7);
    doc.setTextColor(26, 26, 34);
    doc.text(p.title, px + 1.5, py + 3);
    doc.text(String(p.scale), px + pw - 1.5, py + 3, { align: "right" });
  }

  return doc.output("arraybuffer") as ArrayBuffer;
}

// --- SVG path/line extraction (PDF fallback) --------------------------------

function extractSvgLines(svg: string): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  const re = /<line\s[^>]*x1="([\d.\-]+)"\s+y1="([\d.\-]+)"\s+x2="([\d.\-]+)"\s+y2="([\d.\-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    out.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])]);
  }
  return out;
}

function extractSvgPaths(svg: string): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  const re = /<path\s[^>]*d="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    const pts: Array<[number, number]> = [];
    const tokens = m[1].split(/[\s,]+/);
    let i = 0;
    let first: [number, number] | null = null;
    while (i < tokens.length) {
      const tok = tokens[i++];
      if (tok === "M" || tok === "L") {
        const x = parseFloat(tokens[i++]);
        const y = parseFloat(tokens[i++]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          pts.push([x, y]);
          if (tok === "M") first = [x, y];
        }
      } else if (tok === "Z" || tok === "z") {
        if (first) pts.push([first[0], first[1]]);
      }
    }
    if (pts.length >= 2) out.push(pts);
  }
  return out;
}

// --- AI export (SVG with PostScript preamble) --------------------------------

export function exportLayoutAsAiImpl(c: LayoutController): string {
  const svg = composeSvg(c);
  const ps = "<!--%!PS-Adobe-3.0\n%%Creator: WEB-CAD\n%%Title: layout export\n%%Pages: 1\n%%EndComments\n-->";
  return svg.replace("<?xml version=\"1.0\" encoding=\"UTF-8\"?>", `<?xml version="1.0" encoding="UTF-8"?>\n${ps}`);
}

// --- DWG fallback export ---------------------------------------------------

export function exportLayoutAsDwgFallbackImpl(c: LayoutController): string {
  const svg = composeSvg(c);
  const note = "<!-- DWG export not available without LibreDWG-WASM. Export saved as SVG sidecar. -->\n";
  return note + svg;
}

// --- DXF export (AC1015 / R2000) -------------------------------------------

const _DXF_LAYERS: Array<{ name: string; color: number; lweight: number; ltype: string }> = [
  { name: "BORDER",       color: 7, lweight: 50, ltype: "CONTINUOUS" },
  { name: "A-SECT-CUT",   color: 1, lweight: DXF_LWEIGHT["section-cut"], ltype: DXF_LINETYPE["section-cut"] },
  { name: "A-SILHOUETTE", color: 2, lweight: DXF_LWEIGHT["silhouette"],   ltype: DXF_LINETYPE["silhouette"] },
  { name: "A-NAKED",      color: 3, lweight: DXF_LWEIGHT["naked"],        ltype: DXF_LINETYPE["naked"] },
  { name: "A-EDGE",       color: 4, lweight: DXF_LWEIGHT["edge"],         ltype: DXF_LINETYPE["edge"] },
  { name: "A-TANGENT",    color: 5, lweight: DXF_LWEIGHT["tangent"],      ltype: DXF_LINETYPE["tangent"] },
  { name: "A-HIDDEN",     color: 8, lweight: DXF_LWEIGHT["hidden"],       ltype: DXF_LINETYPE["hidden"] },
];

const _DXF_CLS_TO_LAYER: Record<string, string> = {
  "section-cut": "A-SECT-CUT",
  "silhouette":  "A-SILHOUETTE",
  "naked":       "A-NAKED",
  "edge":        "A-EDGE",
  "tangent":     "A-TANGENT",
  "hidden":      "A-HIDDEN",
};

export function exportLayoutAsDxfImpl(c: LayoutController): string {
  const mm = sheetMm(c.size, c.orientation, c.customMm);
  const sheetHpx = sheetPx(mm).h;
  const PX_TO_MM = 1 / MM_TO_PX;
  const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;

  let _h = 1;
  const h = () => (_h++).toString(16).toUpperCase();

  const lines: string[] = [];

  lines.push("0", "SECTION", "2", "HEADER");
  lines.push("9", "$ACADVER", "1", "AC1015");
  lines.push("9", "$HANDSEED", "5", "FFFF");
  lines.push("9", "$EXTMIN", "10", "0", "20", "0", "30", "0");
  lines.push("9", "$EXTMAX",
    "10", mm.w.toFixed(4), "20", mm.h.toFixed(4), "30", "0");
  lines.push("0", "ENDSEC");

  lines.push("0", "SECTION", "2", "TABLES");

  lines.push("0", "TABLE", "2", "LTYPE", "5", h(), "70", "2");
  lines.push("0", "LTYPE", "5", h(),
    "100", "AcDbSymbolTableRecord",
    "100", "AcDbLinetypeTableRecord",
    "2", "CONTINUOUS", "70", "0", "3", "Solid line", "72", "65", "73", "0", "40", "0.0");
  lines.push("0", "LTYPE", "5", h(),
    "100", "AcDbSymbolTableRecord",
    "100", "AcDbLinetypeTableRecord",
    "2", "DASHED", "70", "0", "3", "__ __ __", "72", "65", "73", "2", "40", "0.75",
    "49", "0.5", "74", "0",
    "49", "-0.25", "74", "0");
  lines.push("0", "ENDTAB");

  lines.push("0", "TABLE", "2", "LAYER", "5", h(), "70", String(_DXF_LAYERS.length));
  for (const { name, color, lweight, ltype } of _DXF_LAYERS) {
    lines.push("0", "LAYER", "5", h(),
      "100", "AcDbSymbolTableRecord",
      "100", "AcDbLayerTableRecord",
      "2", name, "70", "0", "62", String(color), "6", ltype, "370", String(lweight));
  }
  lines.push("0", "ENDTAB");
  lines.push("0", "ENDSEC");

  lines.push("0", "SECTION", "2", "ENTITIES");

  for (const p of c.panels) {
    const ox = p.x * PX_TO_MM;
    const oy = (sheetHpx - p.y - p.h) * PX_TO_MM;
    const ph = p.h * PX_TO_MM;

    if (p.border !== "none") {
      const bx1 = ox, by1 = oy, bx2 = ox + p.w * PX_TO_MM, by2 = oy + p.h * PX_TO_MM;
      for (const [ax, ay, bx, by] of [
        [bx1, by1, bx2, by1], [bx2, by1, bx2, by2],
        [bx2, by2, bx1, by2], [bx1, by2, bx1, by1],
      ] as [number, number, number, number][]) {
        lines.push("0", "LINE", "5", h(),
          "100", "AcDbEntity", "8", "BORDER",
          "100", "AcDbLine",
          "10", ax.toFixed(4), "20", ay.toFixed(4), "30", "0",
          "11", bx.toFixed(4), "21", by.toFixed(4), "31", "0");
      }
    }

    const viewName = layoutViewportToViewName(p.viewport);
    const classifiedSegs = viewer?.getClassifiedEdgeSegmentsForView
      ? viewer.getClassifiedEdgeSegmentsForView(viewName, p.w, p.h)
      : [];

    if (classifiedSegs.length > 0) {
      for (const { x1, y1, x2, y2, cls } of classifiedSegs) {
        const layer = _DXF_CLS_TO_LAYER[cls] ?? "A-EDGE";
        const sx = ox + x1 * PX_TO_MM;
        const sy = oy + (ph - y1 * PX_TO_MM);
        const ex = ox + x2 * PX_TO_MM;
        const ey = oy + (ph - y2 * PX_TO_MM);
        lines.push("0", "LINE", "5", h(),
          "100", "AcDbEntity", "8", layer,
          "100", "AcDbLine",
          "10", sx.toFixed(4), "20", sy.toFixed(4), "30", "0",
          "11", ex.toFixed(4), "21", ey.toFixed(4), "31", "0");
      }
    } else {
      const segs = viewer ? viewer.getEdgeSegmentsForView(viewName, p.w, p.h) : [];
      for (const [x1, y1, x2, y2] of segs) {
        const sx = ox + x1 * PX_TO_MM;
        const sy = oy + (ph - y1 * PX_TO_MM);
        const ex = ox + x2 * PX_TO_MM;
        const ey = oy + (ph - y2 * PX_TO_MM);
        lines.push("0", "LINE", "5", h(),
          "100", "AcDbEntity", "8", "A-EDGE",
          "100", "AcDbLine",
          "10", sx.toFixed(4), "20", sy.toFixed(4), "30", "0",
          "11", ex.toFixed(4), "21", ey.toFixed(4), "31", "0");
      }
    }
  }

  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\n") + "\n";
}

// --- Download helper --------------------------------------------------------

export function triggerDownload(c: LayoutController, fmt: string): void {
  const stem = c.title.sheet.replace(/[^A-Za-z0-9_\-]+/g, "_") || "sheet";
  if (fmt === "svg") {
    const text = composeSvg(c);
    saveBlob(new Blob([text], { type: "image/svg+xml" }), `${stem}.svg`);
    return;
  }
  if (fmt === "pdf") {
    exportLayoutAsPdfImpl(c).then((buf) => {
      saveBlob(new Blob([buf], { type: "application/pdf" }), `${stem}.pdf`);
    });
    return;
  }
  if (fmt === "ai") {
    const text = exportLayoutAsAiImpl(c);
    saveBlob(new Blob([text], { type: "application/illustrator" }), `${stem}.ai`);
    return;
  }
  if (fmt === "dwg") {
    const text = exportLayoutAsDwgFallbackImpl(c);
    saveBlob(new Blob([text], { type: "image/svg+xml" }), `${stem}.dwg.svg`);
    return;
  }
}

function saveBlob(blob: Blob, filename: string): void {
  if (typeof URL === "undefined" || typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
