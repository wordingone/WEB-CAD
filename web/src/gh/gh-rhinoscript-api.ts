// gh-rhinoscript-api.ts — RhinoScriptSyntax proxy via RhinoMCP run_python.
// NotYetImplemented: requires Eli's live RhinoMCP connection.
// Layer 1 of docs/grasshopper-skills-tab-design.md.

export interface RhinoScriptResult {
  value?: unknown;
  error?: string;
}

/**
 * Invoke a RhinoScriptSyntax function via RhinoMCP run_python.
 *
 * When the live connection is available (Eli's rhino MCP server),
 * this will serialise to: `import rhinoscriptsyntax as rs; result = rs.${fn}(*args)`
 * and dispatch via the rhino MCP tool.
 *
 * Returns { error: "NotYetImplemented" } until gh-runtime is connected.
 */
export async function runRhinoScript(
  fn: string,
  args: unknown[] = [],
): Promise<RhinoScriptResult> {
  void args;
  return {
    error: `RhinoScriptSyntax.${fn}: NotYetImplemented — awaiting RhinoMCP live connection (Eli's gh-runtime)`,
  };
}

/**
 * Build the Python snippet for a RhinoScriptSyntax call.
 * Used by the rhino-script node renderer to show a preview.
 */
export function buildRhinoScriptPython(fn: string, args: unknown[]): string {
  const argStr = args.map((a) => JSON.stringify(a)).join(", ");
  return `import rhinoscriptsyntax as rs\nresult = rs.${fn}(${argStr})`;
}
