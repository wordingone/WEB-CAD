// gh-def-ingester.ts — Ingest a Grasshopper definition into a WEB-CAD skill canvas node.
// Accepts either a .gh file path or a structured GhDefSpec (from Eli's GH evaluator output).
// Layer 2 of docs/grasshopper-skills-tab-design.md.

export interface GhInputPort {
  name: string;
  min: number;
  max: number;
  default: number;
}

/** One param on a component: either a port reference or a literal constant. */
export interface GhComponentParam {
  /** Name of an inputPort whose slider value is substituted at eval time. */
  portRef?: string;
  /** Literal constant (used when the param is not driven by a slider). */
  value?: unknown;
}

/** One component in the inline graph: a dispatch verb + its param bindings. */
export interface GhComponent {
  id: string;
  /** Dispatch verb to call (e.g. "SdBox", "SdWall", "SdBooleanUnion"). */
  type: string;
  params: Record<string, GhComponentParam>;
}

export interface GhDefSpec {
  /** Path to a .gh file (when loaded from disk / delegated to Rhino). */
  ghPath?: string;
  /** Client-side registry key — set when components is present. */
  inlineGraphId?: string;
  inputPorts: GhInputPort[];
  label?: string;
  /** Inline graph topology for client-side evaluation (no gh-runtime needed). */
  components?: GhComponent[];
}

export interface GhDefNodeDescriptor {
  kind: "gh-def";
  ghDef: GhDefSpec;
  label: string;
}

/**
 * Ingest a GH definition spec into a canvas-ready node descriptor.
 *
 * Accepts:
 * - A .gh file path string → creates a node with ghPath set, no inputPorts (pending evaluation)
 * - A structured GhDefSpec object → full node with inputPorts ready for slider rendering
 *
 * The returned descriptor is merged into a CanvasNode by the canvas drop/import handler.
 */
export function ingestGhDef(source: GhDefSpec | string): GhDefNodeDescriptor {
  if (typeof source === "string") {
    const label = source.split(/[\\/]/).pop()?.replace(/\.gh$/i, "") ?? "GH Def";
    return {
      kind: "gh-def",
      ghDef: { ghPath: source, inputPorts: [] },
      label,
    };
  }
  const label =
    source.label ??
    source.ghPath?.split(/[\\/]/).pop()?.replace(/\.gh$/i, "") ??
    source.inlineGraphId ??
    "GH Def";
  return { kind: "gh-def", ghDef: source, label };
}

/**
 * Parse a JSON-encoded GhDefSpec from a string (e.g. from Eli's gh-runtime over mail/IPC).
 * Throws a descriptive Error on any structural violation — AC#4 fail-loud seam.
 */
export function parseGhDefJson(json: string): GhDefSpec {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("ParseGhDefJson: root must be a JSON object");
    obj = parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`ParseGhDefJson: invalid JSON — ${(e as Error).message}`);
  }

  if (!Array.isArray(obj.inputPorts))
    throw new Error("ParseGhDefJson: missing required field 'inputPorts' (must be an array)");

  const inputPorts: GhInputPort[] = (obj.inputPorts as Array<Record<string, unknown>>).map(
    (p, i) => {
      if (typeof p.name !== "string" || !p.name)
        throw new Error(`ParseGhDefJson: inputPorts[${i}].name must be a non-empty string`);
      return {
        name: p.name,
        min: Number(p.min ?? 0),
        max: Number(p.max ?? 100),
        default: Number(p.default ?? 0),
      };
    },
  );

  const components: GhComponent[] = [];
  if (Array.isArray(obj.components)) {
    for (let i = 0; i < (obj.components as Array<unknown>).length; i++) {
      const c = (obj.components as Array<Record<string, unknown>>)[i];
      if (typeof c.id !== "string" || !c.id)
        throw new Error(`ParseGhDefJson: components[${i}].id must be a non-empty string`);
      if (typeof c.type !== "string" || !c.type)
        throw new Error(`ParseGhDefJson: components[${i}].type must be a non-empty string (dispatch verb)`);
      const rawParams = (c.params ?? c.inputBindings ?? {}) as Record<string, Record<string, unknown>>;
      const params: Record<string, GhComponentParam> = {};
      for (const [k, p] of Object.entries(rawParams)) {
        params[k] = {
          portRef: typeof p.portRef === "string" ? p.portRef : undefined,
          value: p.value,
        };
      }
      components.push({ id: c.id, type: c.type, params });
    }
  }

  return {
    ghPath: typeof obj.ghPath === "string" ? obj.ghPath : undefined,
    inlineGraphId: typeof obj.inlineGraphId === "string" ? obj.inlineGraphId : undefined,
    inputPorts,
    label: typeof obj.label === "string" ? obj.label : undefined,
    components: components.length > 0 ? components : undefined,
  };
}
