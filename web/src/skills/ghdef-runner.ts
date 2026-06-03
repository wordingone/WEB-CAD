// ghdef-runner.ts — fetch and sequential-dispatch a GhDefSpec v0.3 building definition.
import { dispatch } from "../commands/dispatch";

export interface GhDefPort {
  name: string;
  default: number;
  label?: string;
}

export interface GhDefParamBinding {
  value?: unknown;
  portRef?: string;
}

export interface GhDefComponent {
  id: string;
  type: string;
  params: Record<string, GhDefParamBinding>;
  _note?: string;
}

export interface GhDefSpec {
  inlineGraphId: string;
  inputPorts: GhDefPort[];
  components: GhDefComponent[];
  _meta?: Record<string, unknown>;
}

export async function fetchGhDefSpec(url: string): Promise<GhDefSpec> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GhDefSpec fetch failed: ${r.status} ${r.statusText} (${url})`);
  return r.json() as Promise<GhDefSpec>;
}

export function resolvePortValues(
  spec: GhDefSpec,
  overrides?: Record<string, number>,
): Record<string, number> {
  const vals: Record<string, number> = {};
  for (const port of spec.inputPorts) {
    vals[port.name] =
      typeof overrides?.[port.name] === "number" ? (overrides[port.name] as number) : port.default;
  }
  return vals;
}

export function resolveComponentArgs(
  comp: GhDefComponent,
  portValues: Record<string, number>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, binding] of Object.entries(comp.params)) {
    if (binding.portRef !== undefined) {
      args[key] = portValues[binding.portRef] ?? 0;
    } else {
      args[key] = binding.value;
    }
  }
  return args;
}

export interface RunGhDefOptions {
  portOverrides?: Record<string, number>;
  onProgress?: (idx: number, total: number, compId: string) => void;
  delayMs?: number;
}

export async function runGhDef(
  spec: GhDefSpec,
  opts: RunGhDefOptions = {},
): Promise<{ ran: number }> {
  const portValues = resolvePortValues(spec, opts.portOverrides);
  const delay = opts.delayMs ?? 80;
  const total = spec.components.length;
  for (let i = 0; i < total; i++) {
    const comp = spec.components[i]!;
    const args = resolveComponentArgs(comp, portValues);
    opts.onProgress?.(i, total, comp.id);
    await dispatch(comp.type, args);
    if (delay > 0) await new Promise<void>(res => setTimeout(res, delay));
  }
  return { ran: total };
}
