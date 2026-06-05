// gh-component-graph.ts — Client-side Grasshopper component graph evaluator.
// #480: make ingested GH defs actually execute.
//
// Two execution paths:
//   1. Client-side (this file): evaluates inline graphs using existing dispatch verbs.
//      No gh-runtime required. Works for any def whose components map to SdXxx verbs.
//   2. Proxy (future): delegates to Eli's gh-runtime via g1_apply_graph bridge.
//      Wired in once the RhinoMCP connection is live.

import { dispatchSync } from "../commands/dispatch";
import type { GhDefSpec, GhComponent, GhComponentParam } from "./gh-def-ingester";

export interface GhEvalResult {
  /** Output paths by component output name (for future multi-output support). */
  outputPaths?: Record<string, unknown>;
  /** Temp .3dm path for round-trip mesh/brep import (proxy path only). */
  meshPath?: string;
  error?: string;
  /** Net change in scene child count after evaluation. */
  sceneChildrenDelta?: number;
  /** Dispatch verbs that were called, in order. */
  dispatchedVerbs?: string[];
}

// ── Graph registry ─────────────────────────────────────────────────────────────
// Maps inlineGraphId → GhDefSpec. Populated by registerGraph() before evaluation.

const graphRegistry = new Map<string, GhDefSpec>();

export function registerGraph(graphId: string, spec: GhDefSpec): void {
  graphRegistry.set(graphId, spec);
}

export function unregisterGraph(graphId: string): void {
  graphRegistry.delete(graphId);
}

export function hasGraph(graphId: string): boolean {
  return graphRegistry.has(graphId);
}

// ── Param resolution ──────────────────────────────────────────────────────────
// Pure function: substitute portRefs with inputValues, fall back to literals.

export function resolveParams(
  compParams: Record<string, GhComponentParam>,
  inputValues: Record<string, number>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, param] of Object.entries(compParams)) {
    if (param.portRef !== undefined && Object.prototype.hasOwnProperty.call(inputValues, param.portRef)) {
      resolved[key] = inputValues[param.portRef];
    } else if (param.value !== undefined) {
      resolved[key] = param.value;
    }
  }
  return resolved;
}

// ── Client-side evaluator ─────────────────────────────────────────────────────

function sceneChildCount(): number {
  const win = window as unknown as { __viewer?: { scene?: { children: unknown[] } } };
  return win.__viewer?.scene?.children.length ?? 0;
}

/**
 * Evaluate a component graph synchronously.
 *
 * For each component in the spec:
 *   1. Resolve params (portRef → inputValues, literal → value)
 *   2. Call dispatchSync(component.type, resolvedParams)
 *   3. Bail on dispatch error
 *
 * Returns sceneChildrenDelta = (after - before) as the AC gate.
 */
export function evaluateComponentGraph(
  graphId: string,
  inputValues: Record<string, number> = {},
): GhEvalResult {
  const spec = graphRegistry.get(graphId);
  if (!spec) {
    return { error: `GhComponentGraph[${graphId}]: no spec registered — call registerGraph() first` };
  }
  const components = spec.components;
  if (!components || components.length === 0) {
    return { error: `GhComponentGraph[${graphId}]: no components defined — add components[] to GhDefSpec` };
  }

  const before = sceneChildCount();
  const dispatchedVerbs: string[] = [];

  for (const comp of components) {
    const resolved = resolveParams(comp.params, inputValues);
    const result = dispatchSync(comp.type, resolved);
    if (!result.ok) {
      const errDetail = "detail" in result ? String((result as { detail?: unknown }).detail ?? "") : "";
      return {
        error: `Component[${comp.id}] ${comp.type} failed: ${result.error}${errDetail ? " — " + errDetail : ""}`,
        sceneChildrenDelta: sceneChildCount() - before,
        dispatchedVerbs,
      };
    }
    dispatchedVerbs.push(comp.type);
  }

  return {
    sceneChildrenDelta: sceneChildCount() - before,
    dispatchedVerbs,
  };
}
