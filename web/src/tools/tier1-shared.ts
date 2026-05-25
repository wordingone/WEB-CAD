// Tier-1 replicad bindings — single source of truth.
//
// Shared between worker.ts (web worker execution path) and any future
// main-thread path. Vite auto-bundles this into the worker at build time
// so the worker bundle remains self-contained — no runtime imports.

import {
  drawRectangle,
  drawCircle,
  makeBaseBox,
  makeCylinder,
  draw,
  type Solid,
} from "replicad";

export type Pt = [number, number];

export const makeBox = (width: number, depth: number, height: number): Solid =>
  makeBaseBox(width, depth, height);

export function drawLine(p1: Pt, p2: Pt) {
  return draw(p1).lineTo(p2);
}

export function drawPolyline(points: Pt[]) {
  if (points.length < 2) {
    throw new Error("drawPolyline requires at least 2 points");
  }
  let pen = draw(points[0]);
  for (let i = 1; i < points.length; i++) pen = pen.lineTo(points[i]);
  return pen.close();
}

export { drawRectangle, drawCircle, makeCylinder };

export const tier1Bindings = {
  drawRectangle,
  drawCircle,
  drawLine,
  drawPolyline,
  makeBox,
  makeCylinder,
};
