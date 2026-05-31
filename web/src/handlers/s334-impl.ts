// s334-impl.ts — S14 Grasshopper parametric layer (#334)
//
// All 18 tsOps from the research plan. This file exports named handler
// functions for each verb. The corresponding dispatch registrations live
// in register-handlers.ts (or a dedicated register-s334.ts when the full
// gh/ subsystem is ready).
//
// Architecture note: GhScriptRuntime_Python, GhScriptRuntime_CSharp,
// GhScriptRuntime_JavaScript, GhComponentGraph_Evaluator, and
// GhComponentGraph_LazyEvaluation require new subsystem files under
// web/src/gh/ before their handlers can be fully implemented. See:
// docs/spec-334-grasshopper.md for the full architectural spec.
//
// All handlers below return { error: "NotYetImplemented" } until the
// gh/ subsystem is built. Data-tree ops are partially implemented in
// the GhDataTree helper below (pure TypeScript, no external deps).

import type { DispatchArgs } from "../commands/dispatch";
import type { Viewer } from "../viewer/viewer";
import { Point3, Vector3, Plane, Interval } from "../nurbs/nurbs-primitives";

// ─────────────────────────────────────────────────────────────────────────────
// § GhDataTree — core data structure
// ─────────────────────────────────────────────────────────────────────────────
//
// oracle: closed-form (deterministic tree manipulation — no numeric tolerance)
// Reference: Grasshopper data tree semantics per McNeel documentation.

export type GhPath = number[];

export interface GhDataTree<T = unknown> {
  branches: Map<string, T[]>;
}

/** Serialise a path to a Map key. */
function pathKey(path: GhPath): string {
  return path.join(";");
}

/** Parse a Map key back to a path. */
function keyPath(key: string): GhPath {
  return key === "" ? [] : key.split(";").map(Number);
}

export const GhDataTree = {
  /** Create an empty data tree. */
  create<T>(): GhDataTree<T> {
    return { branches: new Map() };
  },

  /** Add an item to a branch at the given path (creates the branch if needed). */
  addItem<T>(tree: GhDataTree<T>, path: GhPath, item: T): void {
    const key = pathKey(path);
    const branch = tree.branches.get(key) ?? [];
    branch.push(item);
    tree.branches.set(key, branch);
  },

  /** Get all items in a branch. Returns [] if path does not exist. */
  getBranch<T>(tree: GhDataTree<T>, path: GhPath): T[] {
    return tree.branches.get(pathKey(path)) ?? [];
  },

  /** Get item at path[index]. Returns undefined if out of range. */
  getItem<T>(tree: GhDataTree<T>, path: GhPath, index: number): T | undefined {
    return GhDataTree.getBranch(tree, path)[index];
  },

  /** All paths in the tree (insertion order). */
  allPaths<T>(tree: GhDataTree<T>): GhPath[] {
    return [...tree.branches.keys()].map(keyPath);
  },

  /** Flat list of every item across all branches. */
  allItems<T>(tree: GhDataTree<T>): T[] {
    const out: T[] = [];
    for (const branch of tree.branches.values()) out.push(...branch);
    return out;
  },

  itemCount<T>(tree: GhDataTree<T>): number {
    let n = 0;
    for (const branch of tree.branches.values()) n += branch.length;
    return n;
  },

  branchCount<T>(tree: GhDataTree<T>): number {
    return tree.branches.size;
  },

  // ── Data-tree ops ──────────────────────────────────────────────────────────
  //
  // Each op matches the canonical Grasshopper component of the same name.
  // oracle: deterministic Grasshopper output per McNeel docs.

  /**
   * GhDataTree_Graft — each item gets its own branch.
   * Input  {[0]: [a, b, c]} → Output {[0,0]: [a], [0,1]: [b], [0,2]: [c]}
   * oracle: Grasshopper Graft component
   */
  graft<T>(tree: GhDataTree<T>): GhDataTree<T> {
    const out: GhDataTree<T> = GhDataTree.create();
    for (const [key, items] of tree.branches) {
      const basePath = keyPath(key);
      for (let i = 0; i < items.length; i++) {
        GhDataTree.addItem(out, [...basePath, i], items[i]);
      }
    }
    return out;
  },

  /**
   * GhDataTree_Flatten — collapse all branches to root.
   * Input  {[0,0]: [a], [0,1]: [b]} → Output {[]: [a, b]}
   * oracle: Grasshopper Flatten component
   */
  flatten<T>(tree: GhDataTree<T>): GhDataTree<T> {
    const out: GhDataTree<T> = GhDataTree.create();
    const rootItems = GhDataTree.allItems(tree);
    for (const item of rootItems) GhDataTree.addItem(out, [], item);
    return out;
  },

  /**
   * GhDataTree_Simplify — remove the common path prefix from all branches.
   * Input  {[1,0,0]: [a], [1,0,1]: [b]} → Output {[0]: [a], [1]: [b]}
   * oracle: Grasshopper Simplify component
   */
  simplify<T>(tree: GhDataTree<T>): GhDataTree<T> {
    const paths = GhDataTree.allPaths(tree);
    if (paths.length === 0) return GhDataTree.create();

    // Find common prefix length.
    const minLen = Math.min(...paths.map((p) => p.length));
    let commonLen = 0;
    outer: for (let d = 0; d < minLen; d++) {
      const v = paths[0][d];
      for (const p of paths) {
        if (p[d] !== v) break outer;
      }
      commonLen++;
    }

    const out: GhDataTree<T> = GhDataTree.create();
    for (const [key, items] of tree.branches) {
      const path = keyPath(key);
      const simplified = path.slice(commonLen);
      for (const item of items) GhDataTree.addItem(out, simplified, item);
    }
    return out;
  },

  /**
   * GhDataTree_Shift — shift path indices by an offset vector.
   * E.g. offset [1, 0] shifts the first path component by 1.
   * oracle: Grasshopper Shift Paths component
   */
  shift<T>(tree: GhDataTree<T>, offset: GhPath): GhDataTree<T> {
    const out: GhDataTree<T> = GhDataTree.create();
    for (const [key, items] of tree.branches) {
      const path = keyPath(key);
      const shifted = path.map((v, i) => v + (offset[i] ?? 0));
      for (const item of items) GhDataTree.addItem(out, shifted, item);
    }
    return out;
  },

  /**
   * GhDataTree_Cull (index mode) — remove items at given indices from each branch.
   * oracle: Grasshopper Cull Index component
   */
  cullByIndex<T>(tree: GhDataTree<T>, indices: number[]): GhDataTree<T> {
    const cullSet = new Set(indices);
    const out: GhDataTree<T> = GhDataTree.create();
    for (const [key, items] of tree.branches) {
      const path = keyPath(key);
      for (let i = 0; i < items.length; i++) {
        if (!cullSet.has(i)) GhDataTree.addItem(out, path, items[i]);
      }
    }
    return out;
  },

  /**
   * GhDataTree_Cull (pattern mode) — remove items where pattern[i % len] is true.
   * oracle: Grasshopper Cull Pattern component
   */
  cullByPattern<T>(tree: GhDataTree<T>, pattern: boolean[]): GhDataTree<T> {
    if (pattern.length === 0) return GhDataTree.create();
    const out: GhDataTree<T> = GhDataTree.create();
    for (const [key, items] of tree.branches) {
      const path = keyPath(key);
      for (let i = 0; i < items.length; i++) {
        if (!pattern[i % pattern.length]) GhDataTree.addItem(out, path, items[i]);
      }
    }
    return out;
  },

  /**
   * GhDataTree_Cull (nth mode) — keep every N-th item (0-indexed).
   * oracle: Grasshopper Cull Nth component
   */
  cullNth<T>(tree: GhDataTree<T>, n: number): GhDataTree<T> {
    if (n <= 0) return GhDataTree.create();
    const out: GhDataTree<T> = GhDataTree.create();
    for (const [key, items] of tree.branches) {
      const path = keyPath(key);
      for (let i = 0; i < items.length; i++) {
        if (i % n !== 0) GhDataTree.addItem(out, path, items[i]);
      }
    }
    return out;
  },

  /**
   * GhDataTree_Dispatch — split items into two trees by boolean predicate.
   * Returns { a: GhDataTree (true), b: GhDataTree (false) }
   * oracle: Grasshopper Dispatch component
   */
  dispatch<T>(
    tree: GhDataTree<T>,
    predicate: (item: T, path: GhPath, index: number) => boolean,
  ): { a: GhDataTree<T>; b: GhDataTree<T> } {
    const a: GhDataTree<T> = GhDataTree.create();
    const b: GhDataTree<T> = GhDataTree.create();
    for (const [key, items] of tree.branches) {
      const path = keyPath(key);
      for (let i = 0; i < items.length; i++) {
        if (predicate(items[i], path, i)) {
          GhDataTree.addItem(a, path, items[i]);
        } else {
          GhDataTree.addItem(b, path, items[i]);
        }
      }
    }
    return { a, b };
  },

  /**
   * GhDataTree_Weave — interleave items from multiple trees per pattern.
   * pattern[i] is the source tree index for the i-th output item per branch.
   * oracle: Grasshopper Weave component
   */
  weave<T>(trees: GhDataTree<T>[], pattern: number[]): GhDataTree<T> {
    if (trees.length === 0 || pattern.length === 0) return GhDataTree.create();
    const out: GhDataTree<T> = GhDataTree.create();
    // Collect all unique paths across all input trees.
    const allPathSets = new Set<string>();
    for (const t of trees) for (const k of t.branches.keys()) allPathSets.add(k);
    for (const key of allPathSets) {
      const path = keyPath(key);
      const cursors = trees.map(() => 0);
      const branchArrays = trees.map((t) => t.branches.get(key) ?? []);
      const totalItems = branchArrays.reduce((s, b) => s + b.length, 0);
      let emitted = 0;
      let pi = 0;
      // Cycle through the pattern; skip exhausted sources.
      // We allow at most totalItems * pattern.length iterations to prevent infinite loops.
      const maxIter = totalItems * Math.max(pattern.length, 1) * trees.length + 1;
      let iter = 0;
      while (emitted < totalItems && iter < maxIter) {
        iter++;
        const srcIdx = pattern[pi % pattern.length];
        pi++;
        if (srcIdx < 0 || srcIdx >= trees.length) continue;
        const items = branchArrays[srcIdx];
        const cursor = cursors[srcIdx];
        if (cursor < items.length) {
          GhDataTree.addItem(out, path, items[cursor]);
          cursors[srcIdx]++;
          emitted++;
        }
        // If source is exhausted, skip and continue with next pattern slot.
      }
    }
    return out;
  },

  /**
   * GhDataTree_Merge — union all input trees, combining branches at matching paths.
   * oracle: Grasshopper Merge component
   */
  merge<T>(trees: GhDataTree<T>[]): GhDataTree<T> {
    const out: GhDataTree<T> = GhDataTree.create();
    for (const t of trees) {
      for (const [key, items] of t.branches) {
        const path = keyPath(key);
        for (const item of items) GhDataTree.addItem(out, path, item);
      }
    }
    return out;
  },

  /**
   * GhDataTree_PathMapper — remap paths using a simple token-substitution map.
   * inputPattern: array of depth tokens, e.g. ["A", "B", "C"]
   * outputPattern: reordering / selection, e.g. ["C", "A"]
   * The path components are assigned to tokens then reassembled.
   * oracle: Grasshopper Path Mapper component
   */
  pathMapper<T>(
    tree: GhDataTree<T>,
    inputPattern: string[],
    outputPattern: string[],
  ): GhDataTree<T> {
    const out: GhDataTree<T> = GhDataTree.create();
    for (const [key, items] of tree.branches) {
      const path = keyPath(key);
      const tokens: Record<string, number> = {};
      for (let i = 0; i < inputPattern.length; i++) {
        tokens[inputPattern[i]] = path[i] ?? 0;
      }
      const newPath = outputPattern.map((tok) => tokens[tok] ?? 0);
      for (const item of items) GhDataTree.addItem(out, newPath, item);
    }
    return out;
  },

  /**
   * GhDataTree_Partition — split each branch's item list into sub-lists of size N.
   * oracle: Grasshopper Partition List component
   */
  partition<T>(tree: GhDataTree<T>, size: number): GhDataTree<T> {
    if (size <= 0) return GhDataTree.create();
    const out: GhDataTree<T> = GhDataTree.create();
    for (const [key, items] of tree.branches) {
      const basePath = keyPath(key);
      let partIdx = 0;
      for (let i = 0; i < items.length; i += size) {
        const chunk = items.slice(i, i + size);
        for (const item of chunk) {
          GhDataTree.addItem(out, [...basePath, partIdx], item);
        }
        partIdx++;
      }
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// § GhMath — pure-math component implementations
// ─────────────────────────────────────────────────────────────────────────────
//
// oracle: closed-form (IEEE 754 exact or better) for all ops.

export const GhMath = {
  // Arithmetic
  add(a: number, b: number): number { return a + b; },
  subtract(a: number, b: number): number { return a - b; },
  multiply(a: number, b: number): number { return a * b; },
  divide(a: number, b: number): number { return a / b; },
  power(base: number, exp: number): number { return Math.pow(base, exp); },
  sqrt(x: number): number { return Math.sqrt(x); },
  abs(x: number): number { return Math.abs(x); },
  modulus(a: number, b: number): number { return ((a % b) + b) % b; },

  // Trig
  sin(angle: number): number { return Math.sin(angle); },
  cos(angle: number): number { return Math.cos(angle); },
  tan(angle: number): number { return Math.tan(angle); },
  asin(v: number): number { return Math.asin(v); },
  acos(v: number): number { return Math.acos(v); },
  atan(v: number): number { return Math.atan(v); },
  atan2(y: number, x: number): number { return Math.atan2(y, x); },

  // Logarithm
  logN(x: number, base: number): number { return Math.log(x) / Math.log(base); },
  log(x: number): number { return Math.log(x); },
  log10(x: number): number { return Math.log10(x); },

  // Constants
  pi(): number { return Math.PI; },
  e(): number { return Math.E; },

  // Domain / interval
  constructDomain(a: number, b: number): Interval { return Interval.create(a, b); },
  deconstructDomain(iv: Interval): { a: number; b: number } {
    return { a: iv.min, b: iv.max };
  },
  remapNumbers(value: number, source: Interval, target: Interval): number {
    const t = (value - source.min) / (source.max - source.min);
    return target.min + t * (target.max - target.min);
  },

  // List utilities
  average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((s, v) => s + v, 0) / values.length;
  },
  maximum(a: number, b: number): number { return Math.max(a, b); },
  minimum(a: number, b: number): number { return Math.min(a, b); },
  round(x: number): number { return Math.round(x); },
  floor(x: number): number { return Math.floor(x); },
  ceiling(x: number): number { return Math.ceil(x); },
  clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  },
  interpolate(a: number, b: number, t: number): number { return a + (b - a) * t; },

  // Series / range
  series(start: number, step: number, count: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(start + i * step);
    return out;
  },
  range(domain: Interval, steps: number): number[] {
    if (steps <= 0) return [];
    const out: number[] = [];
    for (let i = 0; i <= steps; i++) {
      out.push(domain.min + (i / steps) * (domain.max - domain.min));
    }
    return out;
  },

  // Angle conversion
  degrees(radians: number): number { return (radians * 180) / Math.PI; },
  radians(degrees: number): number { return (degrees * Math.PI) / 180; },

  // Vector math (delegates to nurbs-primitives)
  vectorAdd(a: Vector3, b: Vector3): Vector3 { return Vector3.add(a, b); },
  vectorSubtract(a: Vector3, b: Vector3): Vector3 { return Vector3.sub(a, b); },
  vectorScale(v: Vector3, s: number): Vector3 { return Vector3.scale(v, s); },
  vectorCross(a: Vector3, b: Vector3): Vector3 { return Vector3.cross(a, b); },
  vectorDot(a: Vector3, b: Vector3): number { return Vector3.dot(a, b); },
  vectorLength(v: Vector3): number { return Vector3.length(v); },
  vectorUnitize(v: Vector3): Vector3 { return Vector3.normalize(v); },
  vectorAngle(a: Vector3, b: Vector3): number {
    const dot = Vector3.dot(Vector3.normalize(a), Vector3.normalize(b));
    return Math.acos(Math.max(-1, Math.min(1, dot)));
  },

  // Plane constructors
  constructPlane(origin: Point3, xAxis: Vector3, yAxis: Vector3): Plane {
    return Plane.create(origin, xAxis, yAxis);
  },
  worldXY(): Plane { return Plane.worldXY(); },
  worldYZ(): Plane {
    return Plane.create(Point3.zero(), Vector3.yAxis(), Vector3.zAxis());
  },
  worldZX(): Plane {
    return Plane.create(Point3.zero(), Vector3.zAxis(), Vector3.xAxis());
  },
  deconstructPlane(pl: Plane): {
    origin: Point3; xAxis: Vector3; yAxis: Vector3; normal: Vector3;
  } {
    return { origin: pl.origin, xAxis: pl.xAxis, yAxis: pl.yAxis, normal: pl.normal };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// § Dispatch handler stubs
// ─────────────────────────────────────────────────────────────────────────────
//
// These are the Sd* dispatch handler functions. Each will be registered via
// registerHandler() in register-handlers.ts once the gh/ subsystem is built.
//
// Handlers that require the gh/ subsystem return { error: "NotYetImplemented" }
// with a detail string describing what C++ / subsystem function is needed.

/** args type for script runtime handlers */
interface ScriptArgs {
  script?: string;
  inputs?: Record<string, unknown>;
}

// oracle: GhPython (real Grasshopper) — see docs/spec-334-grasshopper.md § A1-Python
export function handle_GhScriptRuntime_Python(
  _args: DispatchArgs,
  _viewer: Viewer | null,
): { error: string; detail: string } {
  // Requires: Pyodide WASM runtime (web/src/gh/gh-script-python.ts).
  // C++ function signature (none — pure WASM JS, no kern.wasm call needed):
  //   Pyodide.runPythonAsync(script: string, globals: PyProxy) → PyProxy
  return {
    error: "NotYetImplemented",
    detail:
      "blocked: requires Pyodide WASM runtime (web/src/gh/gh-script-python.ts) — see docs/spec-334-grasshopper.md § A1-Python",
  };
}

// oracle: real Grasshopper C# scripting (GH_ScriptComponent.SolveInstance)
export function handle_GhScriptRuntime_CSharp(
  _args: DispatchArgs,
  _viewer: Viewer | null,
): { error: string; detail: string } {
  // Requires: dotnet-wasm / mono-wasm runtime (web/src/gh/gh-script-csharp.ts).
  // Blocked: no viable in-browser C# runtime available without multi-month spike.
  return {
    error: "NotYetImplemented",
    detail:
      "blocked: requires dotnet-wasm/mono-wasm C# runtime — no viable in-browser option; see docs/spec-334-grasshopper.md § A1-CSharp",
  };
}

// oracle: deterministic JS evaluation (own oracle — sandboxed eval)
export function handle_GhScriptRuntime_JavaScript(
  _args: DispatchArgs,
  _viewer: Viewer | null,
): { error: string; detail: string } {
  // Requires: sandboxed JS evaluator (web/src/gh/gh-script-javascript.ts).
  return {
    error: "NotYetImplemented",
    detail:
      "blocked: requires sandboxed JS eval runtime (web/src/gh/gh-script-javascript.ts) — see docs/spec-334-grasshopper.md § A1-JavaScript",
  };
}

// oracle: deterministic tree manipulation (closed-form — see GhDataTree above)
export function handle_GhDataTree_Model(args: DispatchArgs): {
  created?: { kind: "GhDataTree" };
  error?: string;
} {
  // GhDataTree_Model is the CRUD shell around GhDataTree.
  // The actual tree is stored in session state by the graph evaluator.
  // Until the graph evaluator (gh-component-graph.ts) is built, return a stub.
  void args;
  return {
    error: "NotYetImplemented",
    // @ts-expect-error — included for ABI documentation; remove when implemented
    detail:
      "requires GhComponentGraph evaluator (web/src/gh/gh-component-graph.ts) for session state management",
  };
}

export function handle_GhDataTree_Graft(args: DispatchArgs): unknown {
  const tree = args.tree as GhDataTree | undefined;
  if (!tree) return { error: "ArgValidationError", detail: "tree required" };
  return { result: GhDataTree.graft(tree) };
}

export function handle_GhDataTree_Flatten(args: DispatchArgs): unknown {
  const tree = args.tree as GhDataTree | undefined;
  if (!tree) return { error: "ArgValidationError", detail: "tree required" };
  return { result: GhDataTree.flatten(tree) };
}

export function handle_GhDataTree_Simplify(args: DispatchArgs): unknown {
  const tree = args.tree as GhDataTree | undefined;
  if (!tree) return { error: "ArgValidationError", detail: "tree required" };
  return { result: GhDataTree.simplify(tree) };
}

export function handle_GhDataTree_Shift(args: DispatchArgs): unknown {
  const tree = args.tree as GhDataTree | undefined;
  const offset = args.offset as GhPath | undefined;
  if (!tree) return { error: "ArgValidationError", detail: "tree required" };
  return { result: GhDataTree.shift(tree, offset ?? []) };
}

export function handle_GhDataTree_Cull(args: DispatchArgs): unknown {
  const tree = args.tree as GhDataTree | undefined;
  if (!tree) return { error: "ArgValidationError", detail: "tree required" };
  const mode = (args.mode as string) ?? "index";
  if (mode === "index") {
    const indices = (args.indices as number[]) ?? [];
    return { result: GhDataTree.cullByIndex(tree, indices) };
  } else if (mode === "pattern") {
    const pattern = (args.pattern as boolean[]) ?? [];
    return { result: GhDataTree.cullByPattern(tree, pattern) };
  } else if (mode === "nth") {
    const n = (args.n as number) ?? 2;
    return { result: GhDataTree.cullNth(tree, n) };
  }
  return { error: "ArgValidationError", detail: `unknown cull mode: ${mode}` };
}

export function handle_GhDataTree_Dispatch(args: DispatchArgs): unknown {
  const tree = args.tree as GhDataTree | undefined;
  const pattern = args.pattern as boolean[] | undefined;
  if (!tree) return { error: "ArgValidationError", detail: "tree required" };
  if (!pattern) return { error: "ArgValidationError", detail: "pattern required" };
  let i = 0;
  const result = GhDataTree.dispatch(tree, () => pattern[i++ % pattern.length]);
  return { a: result.a, b: result.b };
}

export function handle_GhDataTree_Weave(args: DispatchArgs): unknown {
  const trees = args.trees as GhDataTree[] | undefined;
  const pattern = args.pattern as number[] | undefined;
  if (!trees || trees.length === 0) return { error: "ArgValidationError", detail: "trees required" };
  if (!pattern || pattern.length === 0) return { error: "ArgValidationError", detail: "pattern required" };
  return { result: GhDataTree.weave(trees, pattern) };
}

export function handle_GhDataTree_Merge(args: DispatchArgs): unknown {
  const trees = args.trees as GhDataTree[] | undefined;
  if (!trees || trees.length === 0) return { error: "ArgValidationError", detail: "trees required" };
  return { result: GhDataTree.merge(trees) };
}

export function handle_GhDataTree_PathMapper(args: DispatchArgs): unknown {
  const tree = args.tree as GhDataTree | undefined;
  const inputPattern = args.inputPattern as string[] | undefined;
  const outputPattern = args.outputPattern as string[] | undefined;
  if (!tree) return { error: "ArgValidationError", detail: "tree required" };
  if (!inputPattern || !outputPattern) return { error: "ArgValidationError", detail: "inputPattern and outputPattern required" };
  return { result: GhDataTree.pathMapper(tree, inputPattern, outputPattern) };
}

export function handle_GhDataTree_Partition(args: DispatchArgs): unknown {
  const tree = args.tree as GhDataTree | undefined;
  const size = args.size as number | undefined;
  if (!tree) return { error: "ArgValidationError", detail: "tree required" };
  if (typeof size !== "number" || size <= 0) return { error: "ArgValidationError", detail: "size must be a positive number" };
  return { result: GhDataTree.partition(tree, size) };
}

// oracle: closed-form math (IEEE 754)
export function handle_GhMath_Components(args: DispatchArgs): unknown {
  const op = args.op as string | undefined;
  if (!op) return { error: "ArgValidationError", detail: "op required" };
  const a = args.a as number | undefined;
  const b = args.b as number | undefined;
  switch (op) {
    case "add": return { result: GhMath.add(a ?? 0, b ?? 0) };
    case "subtract": return { result: GhMath.subtract(a ?? 0, b ?? 0) };
    case "multiply": return { result: GhMath.multiply(a ?? 0, b ?? 0) };
    case "divide": return { result: GhMath.divide(a ?? 0, b ?? 1) };
    case "power": return { result: GhMath.power(a ?? 0, b ?? 1) };
    case "sqrt": return { result: GhMath.sqrt(a ?? 0) };
    case "abs": return { result: GhMath.abs(a ?? 0) };
    case "modulus": return { result: GhMath.modulus(a ?? 0, b ?? 1) };
    case "sin": return { result: GhMath.sin(a ?? 0) };
    case "cos": return { result: GhMath.cos(a ?? 0) };
    case "tan": return { result: GhMath.tan(a ?? 0) };
    case "asin": return { result: GhMath.asin(a ?? 0) };
    case "acos": return { result: GhMath.acos(a ?? 0) };
    case "atan": return { result: GhMath.atan(a ?? 0) };
    case "atan2": return { result: GhMath.atan2(a ?? 0, b ?? 0) };
    case "logN": {
      const base = args.base as number | undefined;
      return { result: GhMath.logN(a ?? 1, base ?? Math.E) };
    }
    case "pi": return { result: GhMath.pi() };
    case "average": {
      const values = args.values as number[] | undefined;
      return { result: GhMath.average(values ?? []) };
    }
    case "max": return { result: GhMath.maximum(a ?? 0, b ?? 0) };
    case "min": return { result: GhMath.minimum(a ?? 0, b ?? 0) };
    case "round": return { result: GhMath.round(a ?? 0) };
    case "floor": return { result: GhMath.floor(a ?? 0) };
    case "ceiling": return { result: GhMath.ceiling(a ?? 0) };
    case "clamp": {
      const lo = args.min as number | undefined;
      const hi = args.max as number | undefined;
      return { result: GhMath.clamp(a ?? 0, lo ?? 0, hi ?? 1) };
    }
    case "interpolate": {
      const t = args.t as number | undefined;
      return { result: GhMath.interpolate(a ?? 0, b ?? 0, t ?? 0.5) };
    }
    case "series": {
      const step = args.step as number | undefined;
      const count = args.count as number | undefined;
      return { result: GhMath.series(a ?? 0, step ?? 1, count ?? 10) };
    }
    case "range": {
      const domain = args.domain as Interval | undefined;
      const steps = args.steps as number | undefined;
      return { result: GhMath.range(domain ?? Interval.create(0, 1), steps ?? 10) };
    }
    case "degrees": return { result: GhMath.degrees(a ?? 0) };
    case "radians": return { result: GhMath.radians(a ?? 0) };
    default:
      return { error: "ArgValidationError", detail: `unknown GhMath op: ${op}` };
  }
}

// oracle: requires GhComponentGraph evaluator (web/src/gh/gh-component-graph.ts)
export function handle_GhComponentGraph_Evaluator(
  _args: DispatchArgs,
  _viewer: Viewer | null,
): { error: string; detail: string } {
  return {
    error: "NotYetImplemented",
    detail:
      "blocked: requires GhComponentGraph evaluator (web/src/gh/gh-component-graph.ts) — see docs/spec-334-grasshopper.md § A3",
  };
}

export function handle_GhComponentGraph_LazyEvaluation(
  _args: DispatchArgs,
  _viewer: Viewer | null,
): { error: string; detail: string } {
  return {
    error: "NotYetImplemented",
    detail:
      "blocked: requires GhComponentGraph lazy dirty-propagation (web/src/gh/gh-component-graph.ts) — see docs/spec-334-grasshopper.md § A3",
  };
}

// oracle: McNeel RhinoScriptSyntax docs https://developer.rhino3d.com/api/rhinoscript/
export function handle_GhRhinoScriptSyntax_API(
  _args: DispatchArgs,
  _viewer: Viewer | null,
): { error: string; detail: string } {
  return {
    error: "NotYetImplemented",
    detail:
      "blocked: requires RhinoScriptSyntax-equivalent module (web/src/gh/gh-rhinoscript-api.ts) — see docs/spec-334-grasshopper.md § A4",
  };
}

// ── Registration entry point ─────────────────────────────────────────────────
import { registerHandler } from "../commands/dispatch";

export function registerS334Handlers(_viewer: Viewer | null): void {
  registerHandler("GhScriptRuntime_Python", (args) => handle_GhScriptRuntime_Python(args, _viewer));
  registerHandler("GhScriptRuntime_CSharp", (args) => handle_GhScriptRuntime_CSharp(args, _viewer));
  registerHandler("GhScriptRuntime_JavaScript", (args) => handle_GhScriptRuntime_JavaScript(args, _viewer));
  registerHandler("GhDataTree_Model", (args) => handle_GhDataTree_Model(args));
  registerHandler("GhDataTree_Graft", (args) => handle_GhDataTree_Graft(args));
  registerHandler("GhDataTree_Flatten", (args) => handle_GhDataTree_Flatten(args));
  registerHandler("GhDataTree_Simplify", (args) => handle_GhDataTree_Simplify(args));
  registerHandler("GhDataTree_Shift", (args) => handle_GhDataTree_Shift(args));
  registerHandler("GhDataTree_Cull", (args) => handle_GhDataTree_Cull(args));
  registerHandler("GhDataTree_Dispatch", (args) => handle_GhDataTree_Dispatch(args));
  registerHandler("GhDataTree_Weave", (args) => handle_GhDataTree_Weave(args));
  registerHandler("GhDataTree_Merge", (args) => handle_GhDataTree_Merge(args));
  registerHandler("GhDataTree_PathMapper", (args) => handle_GhDataTree_PathMapper(args));
  registerHandler("GhDataTree_Partition", (args) => handle_GhDataTree_Partition(args));
  registerHandler("GhMath_Components", (args) => handle_GhMath_Components(args));
  registerHandler("GhComponentGraph_Evaluator", (args) => handle_GhComponentGraph_Evaluator(args, _viewer));
  registerHandler("GhComponentGraph_LazyEvaluation", (args) => handle_GhComponentGraph_LazyEvaluation(args, _viewer));
  registerHandler("GhRhinoScriptSyntax_API", (args) => handle_GhRhinoScriptSyntax_API(args, _viewer));
}
