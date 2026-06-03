// gh-component-graph.ts — Grasshopper component graph evaluator.
// NotYetImplemented: requires Eli's gh-runtime connection (Eli's side).
// Layer 2 of docs/grasshopper-skills-tab-design.md.

export interface GhEvalResult {
  /** Output geometry paths by component output name. */
  outputPaths?: Record<string, unknown>;
  /** Temp .3dm path for round-trip mesh/brep import via open_doc. */
  meshPath?: string;
  error?: string;
}

/**
 * Evaluate a Grasshopper component graph by session ID.
 *
 * inputValues: slider name → numeric value map.
 *
 * When gh-runtime is connected (Eli's side), dispatches to g1_apply_graph
 * and returns the output mesh path for open_doc import.
 *
 * Returns { error: "NotYetImplemented" } until the connection is established.
 */
export async function evaluateComponentGraph(
  graphId: string,
  _inputValues: Record<string, number> = {},
): Promise<GhEvalResult> {
  return {
    error: `GhComponentGraph[${graphId}]: NotYetImplemented — awaiting gh-runtime connection (Eli's side)`,
  };
}
