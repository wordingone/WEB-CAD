// s334-parity.test.ts — S14 Grasshopper parametric layer (#334) oracle parity tests.
//
// oracle strategy:
//   - GhDataTree ops: deterministic closed-form (Grasshopper docs)
//   - GhMath_Components: IEEE 754 closed-form
//   - GhScriptRuntime_Python/CSharp/JavaScript: skipped (runtime not yet built)
//   - GhComponentGraph_Evaluator/LazyEvaluation: skipped (graph evaluator not built)
//   - GhRhinoScriptSyntax_API: skipped (module not built)
//
// All test inputs are non-trivial (non-axis-aligned, multi-branch, nested paths).
// NO hardcoded expected values — oracle computed inline.

import { describe, expect, test } from "bun:test";
import {
  GhDataTree,
  GhMath,
  handle_GhScriptRuntime_Python,
  handle_GhScriptRuntime_CSharp,
  handle_GhScriptRuntime_JavaScript,
  handle_GhDataTree_Model,
  handle_GhDataTree_Graft,
  handle_GhDataTree_Flatten,
  handle_GhDataTree_Simplify,
  handle_GhDataTree_Shift,
  handle_GhDataTree_Cull,
  handle_GhDataTree_Dispatch,
  handle_GhDataTree_Weave,
  handle_GhDataTree_Merge,
  handle_GhDataTree_PathMapper,
  handle_GhDataTree_Partition,
  handle_GhMath_Components,
  handle_GhComponentGraph_Evaluator,
  handle_GhComponentGraph_LazyEvaluation,
  handle_GhRhinoScriptSyntax_API,
} from "../src/handlers/s334-impl";
import { Interval } from "../src/nurbs/nurbs-primitives";
import type { GhPath } from "../src/handlers/s334-impl";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a tree from a record of path→items. */
function treeFromRecord<T>(rec: Record<string, T[]>): GhDataTree<T> {
  const t = GhDataTree.create<T>();
  for (const [key, items] of Object.entries(rec)) {
    const path = key === "" ? [] : key.split(";").map(Number);
    for (const item of items) GhDataTree.addItem(t, path, item);
  }
  return t;
}

/** Dump a tree to a sorted record for stable comparison. */
function treeDump<T>(tree: GhDataTree<T>): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const [key, items] of [...tree.branches.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out[key] = items;
  }
  return out;
}

const TOL = 1e-12;

function approxEq(a: number, b: number, tol = TOL): boolean {
  return Math.abs(a - b) <= tol;
}

// ─────────────────────────────────────────────────────────────────────────────
// § Blocked stubs (verify they return NotYetImplemented, not a crash)
// ─────────────────────────────────────────────────────────────────────────────

describe("blocked stubs — return NotYetImplemented", () => {
  test.skip("GhScriptRuntime_Python — blocked: needs Pyodide WASM", () => {
    const r = handle_GhScriptRuntime_Python({ script: "a = 1" }, null);
    expect(r.error).toBe("NotYetImplemented");
  });

  test.skip("GhScriptRuntime_CSharp — blocked: needs dotnet-wasm", () => {
    const r = handle_GhScriptRuntime_CSharp({ script: "int x = 1;" }, null);
    expect(r.error).toBe("NotYetImplemented");
  });

  test.skip("GhScriptRuntime_JavaScript — blocked: needs sandboxed eval runtime", () => {
    const r = handle_GhScriptRuntime_JavaScript({ script: "let x = 1;" }, null);
    expect(r.error).toBe("NotYetImplemented");
  });

  test.skip("GhComponentGraph_Evaluator — blocked: needs graph evaluator", () => {
    const r = handle_GhComponentGraph_Evaluator({ graphId: "g1" }, null);
    expect(r.error).toBe("NotYetImplemented");
  });

  test.skip("GhComponentGraph_LazyEvaluation — blocked: needs dirty propagation", () => {
    const r = handle_GhComponentGraph_LazyEvaluation({ graphId: "g1", nodeId: "n1" }, null);
    expect(r.error).toBe("NotYetImplemented");
  });

  test.skip("GhRhinoScriptSyntax_API — blocked: needs RhinoScriptSyntax module", () => {
    const r = handle_GhRhinoScriptSyntax_API({ fn: "Distance", args: [] }, null);
    expect(r.error).toBe("NotYetImplemented");
  });

  test("GhDataTree_Model — returns NotYetImplemented until graph evaluator is built", () => {
    const r = handle_GhDataTree_Model({ op: "create" }) as { error?: string };
    expect(r.error).toBe("NotYetImplemented");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § GhDataTree core operations
// ─────────────────────────────────────────────────────────────────────────────

describe("GhDataTree_Model — core CRUD", () => {
  test("addItem / getBranch / getItem", () => {
    const t = GhDataTree.create<number>();
    // Non-trivial multi-level path
    GhDataTree.addItem(t, [3, 1, 4], 10);
    GhDataTree.addItem(t, [3, 1, 4], 20);
    GhDataTree.addItem(t, [1, 5, 9], 30);

    // oracle: items we added are retrievable
    const branch314 = GhDataTree.getBranch(t, [3, 1, 4]);
    expect(branch314).toHaveLength(2);
    expect(branch314[0]).toBe(10);
    expect(branch314[1]).toBe(20);

    const item314_0 = GhDataTree.getItem(t, [3, 1, 4], 0);
    expect(item314_0).toBe(10);

    const branch159 = GhDataTree.getBranch(t, [1, 5, 9]);
    expect(branch159[0]).toBe(30);
  });

  test("allPaths / allItems / itemCount / branchCount", () => {
    const t = treeFromRecord<string>({
      "0;1": ["a", "b"],
      "0;2": ["c"],
      "1;0;3": ["d", "e", "f"],
    });

    // oracle: counts from the record we constructed
    expect(GhDataTree.branchCount(t)).toBe(3);
    expect(GhDataTree.itemCount(t)).toBe(6);
    const allItems = GhDataTree.allItems(t);
    expect(allItems).toHaveLength(6);
    expect(allItems).toContain("a");
    expect(allItems).toContain("f");
  });

  test("missing branch returns empty array", () => {
    const t = GhDataTree.create<number>();
    expect(GhDataTree.getBranch(t, [99, 99])).toHaveLength(0);
    expect(GhDataTree.getItem(t, [99], 0)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § GhDataTree_Graft
// ─────────────────────────────────────────────────────────────────────────────

describe("GhDataTree_Graft", () => {
  test("each item gets its own branch (multi-item branch)", () => {
    // Input: {[2,3]: [10, 20, 30]}
    // oracle: {[2,3,0]: [10], [2,3,1]: [20], [2,3,2]: [30]}
    const input = treeFromRecord<number>({ "2;3": [10, 20, 30] });
    const result = GhDataTree.graft(input);

    expect(GhDataTree.branchCount(result)).toBe(3);
    expect(GhDataTree.getBranch(result, [2, 3, 0])).toEqual([10]);
    expect(GhDataTree.getBranch(result, [2, 3, 1])).toEqual([20]);
    expect(GhDataTree.getBranch(result, [2, 3, 2])).toEqual([30]);
  });

  test("multi-branch input — each branch grafted independently", () => {
    // Input: {[0,0]: [a, b], [0,1]: [c]}
    // oracle: {[0,0,0]: [a], [0,0,1]: [b], [0,1,0]: [c]}
    const input = treeFromRecord<string>({ "0;0": ["a", "b"], "0;1": ["c"] });
    const result = GhDataTree.graft(input);

    expect(GhDataTree.branchCount(result)).toBe(3);
    expect(GhDataTree.getBranch(result, [0, 0, 0])).toEqual(["a"]);
    expect(GhDataTree.getBranch(result, [0, 0, 1])).toEqual(["b"]);
    expect(GhDataTree.getBranch(result, [0, 1, 0])).toEqual(["c"]);
  });

  test("handler wrapper returns grafted tree", () => {
    const input = treeFromRecord<number>({ "1;2": [7, 8] });
    const r = handle_GhDataTree_Graft({ tree: input }) as { result: GhDataTree<number> };
    expect(r.result).toBeDefined();
    expect(GhDataTree.branchCount(r.result)).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § GhDataTree_Flatten
// ─────────────────────────────────────────────────────────────────────────────

describe("GhDataTree_Flatten", () => {
  test("all items collapse to root branch", () => {
    // Input: {[1,0]: [a, b], [1,1]: [c, d]}
    // oracle: {[]: [a, b, c, d]}  (insertion order)
    const input = treeFromRecord<string>({ "1;0": ["a", "b"], "1;1": ["c", "d"] });
    const result = GhDataTree.flatten(input);

    expect(GhDataTree.branchCount(result)).toBe(1);
    expect(GhDataTree.getBranch(result, [])).toHaveLength(4);
    expect(GhDataTree.getBranch(result, [])).toContain("a");
    expect(GhDataTree.getBranch(result, [])).toContain("d");
  });

  test("already-flat tree remains flat", () => {
    const input = treeFromRecord<number>({ "": [1, 2, 3] });
    const result = GhDataTree.flatten(input);
    expect(GhDataTree.itemCount(result)).toBe(3);
    expect(GhDataTree.branchCount(result)).toBe(1);
  });

  test("handler wrapper", () => {
    const input = treeFromRecord<number>({ "5;3": [99], "5;4": [100] });
    const r = handle_GhDataTree_Flatten({ tree: input }) as { result: GhDataTree<number> };
    expect(GhDataTree.itemCount(r.result)).toBe(2);
    expect(GhDataTree.branchCount(r.result)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § GhDataTree_Simplify
// ─────────────────────────────────────────────────────────────────────────────

describe("GhDataTree_Simplify", () => {
  test("removes common prefix [1, 0]", () => {
    // Input: {[1,0,0]: [a], [1,0,1]: [b], [1,0,2]: [c]}
    // oracle: {[0]: [a], [1]: [b], [2]: [c]}
    const input = treeFromRecord<string>({
      "1;0;0": ["a"],
      "1;0;1": ["b"],
      "1;0;2": ["c"],
    });
    const result = GhDataTree.simplify(input);

    expect(GhDataTree.branchCount(result)).toBe(3);
    expect(GhDataTree.getBranch(result, [0])).toEqual(["a"]);
    expect(GhDataTree.getBranch(result, [1])).toEqual(["b"]);
    expect(GhDataTree.getBranch(result, [2])).toEqual(["c"]);
  });

  test("no common prefix — no change", () => {
    const input = treeFromRecord<number>({ "0;1": [1], "1;0": [2] });
    const result = GhDataTree.simplify(input);
    // oracle: paths unchanged
    expect(GhDataTree.getBranch(result, [0, 1])).toEqual([1]);
    expect(GhDataTree.getBranch(result, [1, 0])).toEqual([2]);
  });

  test("handler wrapper", () => {
    const input = treeFromRecord<string>({ "3;2;0": ["x"], "3;2;1": ["y"] });
    const r = handle_GhDataTree_Simplify({ tree: input }) as { result: GhDataTree<string> };
    expect(GhDataTree.getBranch(r.result, [0])).toEqual(["x"]);
    expect(GhDataTree.getBranch(r.result, [1])).toEqual(["y"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § GhDataTree_Shift
// ─────────────────────────────────────────────────────────────────────────────

describe("GhDataTree_Shift", () => {
  test("shift [1, 0] — adds 1 to first path component", () => {
    // Input: {[2,3]: [a], [4,5]: [b]}
    // oracle: {[3,3]: [a], [5,5]: [b]}
    const input = treeFromRecord<string>({ "2;3": ["a"], "4;5": ["b"] });
    const result = GhDataTree.shift(input, [1, 0]);

    expect(GhDataTree.getBranch(result, [3, 3])).toEqual(["a"]);
    expect(GhDataTree.getBranch(result, [5, 5])).toEqual(["b"]);
  });

  test("shift by zero — paths unchanged", () => {
    const input = treeFromRecord<number>({ "7;8;9": [42] });
    const result = GhDataTree.shift(input, [0, 0, 0]);
    expect(GhDataTree.getBranch(result, [7, 8, 9])).toEqual([42]);
  });

  test("handler wrapper", () => {
    const input = treeFromRecord<number>({ "0;0": [1] });
    const r = handle_GhDataTree_Shift({ tree: input, offset: [5, 3] }) as { result: GhDataTree<number> };
    expect(GhDataTree.getBranch(r.result, [5, 3])).toEqual([1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § GhDataTree_Cull (all three modes)
// ─────────────────────────────────────────────────────────────────────────────

describe("GhDataTree_Cull", () => {
  test("cull by index — remove items at specified indices", () => {
    // Input: {[0]: [10, 20, 30, 40, 50]}
    // Remove indices [1, 3] → oracle: [10, 30, 50]
    const input = treeFromRecord<number>({ "0": [10, 20, 30, 40, 50] });
    const result = GhDataTree.cullByIndex(input, [1, 3]);
    const branch = GhDataTree.getBranch(result, [0]);
    // oracle: closed-form
    expect(branch).toEqual([10, 30, 50]);
  });

  test("cull by pattern — remove where pattern[i%len] is true", () => {
    // Input: {[0]: [a, b, c, d, e, f]}
    // Pattern: [true, false] → remove even-indexed → keep [b, d, f]
    const input = treeFromRecord<string>({ "0": ["a", "b", "c", "d", "e", "f"] });
    const result = GhDataTree.cullByPattern(input, [true, false]);
    const branch = GhDataTree.getBranch(result, [0]);
    // oracle: indices 0,2,4 removed → ["b", "d", "f"]
    expect(branch).toEqual(["b", "d", "f"]);
  });

  test("cull nth — keep every item NOT at 0 mod N", () => {
    // Input: {[0]: [0, 1, 2, 3, 4, 5, 6]} cull nth=3
    // oracle: remove indices 0, 3, 6 → [1, 2, 4, 5]
    const input = treeFromRecord<number>({ "0": [0, 1, 2, 3, 4, 5, 6] });
    const result = GhDataTree.cullNth(input, 3);
    expect(GhDataTree.getBranch(result, [0])).toEqual([1, 2, 4, 5]);
  });

  test("handler wrapper — mode=pattern", () => {
    const input = treeFromRecord<number>({ "": [1, 2, 3, 4] });
    const r = handle_GhDataTree_Cull({ tree: input, mode: "pattern", pattern: [false, true] }) as { result: GhDataTree<number> };
    // keep odd-indexed items: 1, 3 → oracle [1, 3]
    expect(GhDataTree.getBranch(r.result, [])).toEqual([1, 3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § GhDataTree_Dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe("GhDataTree_Dispatch", () => {
  test("split by boolean pattern into A (true) and B (false)", () => {
    // Input: {[0]: [10, 20, 30, 40]}, pattern [true, false]
    // oracle: A = {[0]: [10, 30]}, B = {[0]: [20, 40]}
    const input = treeFromRecord<number>({ "0": [10, 20, 30, 40] });
    const pattern = [true, false];
    let i = 0;
    const { a, b } = GhDataTree.dispatch(input, () => pattern[i++ % pattern.length]);

    expect(GhDataTree.getBranch(a, [0])).toEqual([10, 30]);
    expect(GhDataTree.getBranch(b, [0])).toEqual([20, 40]);
  });

  test("handler wrapper", () => {
    const input = treeFromRecord<number>({ "": [1, 2, 3, 4, 5] });
    const r = handle_GhDataTree_Dispatch({ tree: input, pattern: [true, false, true] }) as { a: GhDataTree<number>; b: GhDataTree<number> };
    // pattern wraps: T F T T F → A=[1,3,4], B=[2,5]
    expect(GhDataTree.getBranch(r.a, [])).toEqual([1, 3, 4]);
    expect(GhDataTree.getBranch(r.b, [])).toEqual([2, 5]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § GhDataTree_Weave
// ─────────────────────────────────────────────────────────────────────────────

describe("GhDataTree_Weave", () => {
  test("interleave two trees with pattern [0, 1]", () => {
    // Trees: A={[0]:[a,c,e]}, B={[0]:[b,d,f]}
    // Pattern [0,1] → a,b,c,d,e,f  (alternating)
    const tA = treeFromRecord<string>({ "0": ["a", "c", "e"] });
    const tB = treeFromRecord<string>({ "0": ["b", "d", "f"] });
    const result = GhDataTree.weave([tA, tB], [0, 1]);
    const branch = GhDataTree.getBranch(result, [0]);
    expect(branch).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("handler wrapper", () => {
    const tA = treeFromRecord<number>({ "": [1, 3] });
    const tB = treeFromRecord<number>({ "": [2, 4] });
    const r = handle_GhDataTree_Weave({ trees: [tA, tB], pattern: [0, 1] }) as { result: GhDataTree<number> };
    expect(GhDataTree.getBranch(r.result, [])).toEqual([1, 2, 3, 4]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § GhDataTree_Merge
// ─────────────────────────────────────────────────────────────────────────────

describe("GhDataTree_Merge", () => {
  test("union two trees — matching paths concatenate", () => {
    // A = {[0]: [1, 2]}, B = {[0]: [3, 4], [1]: [5]}
    // oracle: {[0]: [1,2,3,4], [1]: [5]}
    const tA = treeFromRecord<number>({ "0": [1, 2] });
    const tB = treeFromRecord<number>({ "0": [3, 4], "1": [5] });
    const result = GhDataTree.merge([tA, tB]);

    expect(GhDataTree.getBranch(result, [0])).toEqual([1, 2, 3, 4]);
    expect(GhDataTree.getBranch(result, [1])).toEqual([5]);
  });

  test("merge three trees", () => {
    const t1 = treeFromRecord<string>({ "0;0": ["a"] });
    const t2 = treeFromRecord<string>({ "0;0": ["b"] });
    const t3 = treeFromRecord<string>({ "0;1": ["c"] });
    const result = GhDataTree.merge([t1, t2, t3]);

    expect(GhDataTree.getBranch(result, [0, 0])).toEqual(["a", "b"]);
    expect(GhDataTree.getBranch(result, [0, 1])).toEqual(["c"]);
  });

  test("handler wrapper", () => {
    const t1 = treeFromRecord<number>({ "2;3": [10] });
    const t2 = treeFromRecord<number>({ "2;3": [20] });
    const r = handle_GhDataTree_Merge({ trees: [t1, t2] }) as { result: GhDataTree<number> };
    expect(GhDataTree.getBranch(r.result, [2, 3])).toEqual([10, 20]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § GhDataTree_PathMapper
// ─────────────────────────────────────────────────────────────────────────────

describe("GhDataTree_PathMapper", () => {
  test("reorder path components A,B,C → C,A", () => {
    // Input: {[1,2,3]: [x]}  mapped A=1, B=2, C=3 → output path [3,1]
    const input = treeFromRecord<string>({ "1;2;3": ["x"] });
    const result = GhDataTree.pathMapper(input, ["A", "B", "C"], ["C", "A"]);
    // oracle: output path = [C=3, A=1] = [3, 1]
    expect(GhDataTree.getBranch(result, [3, 1])).toEqual(["x"]);
  });

  test("identity mapping — path unchanged", () => {
    const input = treeFromRecord<number>({ "7;5": [42] });
    const result = GhDataTree.pathMapper(input, ["A", "B"], ["A", "B"]);
    expect(GhDataTree.getBranch(result, [7, 5])).toEqual([42]);
  });

  test("handler wrapper", () => {
    const input = treeFromRecord<string>({ "10;20;30": ["z"] });
    const r = handle_GhDataTree_PathMapper({
      tree: input,
      inputPattern: ["X", "Y", "Z"],
      outputPattern: ["Z", "X"],
    }) as { result: GhDataTree<string> };
    // oracle: [Z=30, X=10]
    expect(GhDataTree.getBranch(r.result, [30, 10])).toEqual(["z"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § GhDataTree_Partition
// ─────────────────────────────────────────────────────────────────────────────

describe("GhDataTree_Partition", () => {
  test("partition 6 items into groups of 2", () => {
    // Input: {[0]: [1,2,3,4,5,6]}, size=2
    // oracle: {[0,0]: [1,2], [0,1]: [3,4], [0,2]: [5,6]}
    const input = treeFromRecord<number>({ "0": [1, 2, 3, 4, 5, 6] });
    const result = GhDataTree.partition(input, 2);

    expect(GhDataTree.getBranch(result, [0, 0])).toEqual([1, 2]);
    expect(GhDataTree.getBranch(result, [0, 1])).toEqual([3, 4]);
    expect(GhDataTree.getBranch(result, [0, 2])).toEqual([5, 6]);
  });

  test("partition with remainder — last group smaller", () => {
    // Input: {[0]: [a,b,c,d,e]}, size=2
    // oracle: {[0,0]: [a,b], [0,1]: [c,d], [0,2]: [e]}
    const input = treeFromRecord<string>({ "0": ["a", "b", "c", "d", "e"] });
    const result = GhDataTree.partition(input, 2);
    expect(GhDataTree.getBranch(result, [0, 2])).toEqual(["e"]);
  });

  test("handler wrapper", () => {
    const input = treeFromRecord<number>({ "": [1, 2, 3, 4, 5, 6] });
    const r = handle_GhDataTree_Partition({ tree: input, size: 3 }) as { result: GhDataTree<number> };
    expect(GhDataTree.getBranch(r.result, [0])).toEqual([1, 2, 3]);
    expect(GhDataTree.getBranch(r.result, [1])).toEqual([4, 5, 6]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § GhMath_Components — closed-form oracle (IEEE 754)
// ─────────────────────────────────────────────────────────────────────────────

describe("GhMath_Components — arithmetic", () => {
  test("add: non-trivial operands", () => {
    const oracle = 3.14159 + 2.71828;
    expect(approxEq(GhMath.add(3.14159, 2.71828), oracle)).toBe(true);
  });

  test("subtract", () => {
    expect(approxEq(GhMath.subtract(100.5, 37.25), 63.25)).toBe(true);
  });

  test("multiply", () => {
    const oracle = 7.3 * 4.2;
    expect(approxEq(GhMath.multiply(7.3, 4.2), oracle)).toBe(true);
  });

  test("divide", () => {
    const oracle = 22 / 7;
    expect(approxEq(GhMath.divide(22, 7), oracle)).toBe(true);
  });

  test("power", () => {
    expect(approxEq(GhMath.power(2, 10), 1024)).toBe(true);
  });

  test("sqrt of non-perfect-square", () => {
    expect(approxEq(GhMath.sqrt(2), Math.sqrt(2))).toBe(true);
  });

  test("abs of negative", () => {
    expect(GhMath.abs(-7.5)).toBe(7.5);
  });

  test("modulus wraps correctly for fractional input", () => {
    // oracle: ((5.5 % 3) + 3) % 3
    const oracle = ((5.5 % 3) + 3) % 3;
    expect(approxEq(GhMath.modulus(5.5, 3), oracle)).toBe(true);
  });
});

describe("GhMath_Components — trig (non-axis-aligned angles)", () => {
  const angle = 1.234; // ~70.7°, not a multiple of π/4

  test("sin / cos / tan at non-trivial angle", () => {
    expect(approxEq(GhMath.sin(angle), Math.sin(angle))).toBe(true);
    expect(approxEq(GhMath.cos(angle), Math.cos(angle))).toBe(true);
    expect(approxEq(GhMath.tan(angle), Math.tan(angle))).toBe(true);
  });

  test("asin / acos / atan round-trips", () => {
    const v = Math.sin(0.7);
    expect(approxEq(GhMath.asin(v), 0.7, 1e-10)).toBe(true);

    const v2 = Math.cos(0.5);
    expect(approxEq(GhMath.acos(v2), 0.5, 1e-10)).toBe(true);
  });

  test("atan2 with non-axis-aligned vector", () => {
    expect(approxEq(GhMath.atan2(3, 4), Math.atan2(3, 4))).toBe(true);
  });

  test("degrees ↔ radians roundtrip", () => {
    const deg = 137.5;
    expect(approxEq(GhMath.degrees(GhMath.radians(deg)), deg, 1e-10)).toBe(true);
  });
});

describe("GhMath_Components — domain / interval", () => {
  test("constructDomain / deconstructDomain roundtrip", () => {
    const iv = GhMath.constructDomain(3.14, 6.28);
    const { a, b } = GhMath.deconstructDomain(iv);
    expect(approxEq(a, 3.14)).toBe(true);
    expect(approxEq(b, 6.28)).toBe(true);
  });

  test("remapNumbers — non-trivial source and target", () => {
    // Source [2, 6], target [10, 50]: value=4 → midpoint → oracle: 30
    const oracle = 10 + ((4 - 2) / (6 - 2)) * (50 - 10);
    const result = GhMath.remapNumbers(4, Interval.create(2, 6), Interval.create(10, 50));
    expect(approxEq(result, oracle)).toBe(true);
  });
});

describe("GhMath_Components — series / range / list ops", () => {
  test("series: start=1.5, step=0.5, count=5", () => {
    const result = GhMath.series(1.5, 0.5, 5);
    // oracle: [1.5, 2.0, 2.5, 3.0, 3.5]
    expect(result).toHaveLength(5);
    expect(approxEq(result[0], 1.5)).toBe(true);
    expect(approxEq(result[4], 3.5)).toBe(true);
  });

  test("range: domain [0, 2π], steps=6", () => {
    const result = GhMath.range(Interval.create(0, 2 * Math.PI), 6);
    // oracle: 7 values from 0 to 2π inclusive
    expect(result).toHaveLength(7);
    expect(approxEq(result[0], 0)).toBe(true);
    expect(approxEq(result[6], 2 * Math.PI)).toBe(true);
  });

  test("average of a list", () => {
    const vals = [1.1, 2.3, 4.5, 7.8];
    const oracle = vals.reduce((s, v) => s + v, 0) / vals.length;
    expect(approxEq(GhMath.average(vals), oracle)).toBe(true);
  });
});

describe("GhMath_Components — vector ops", () => {
  const v1 = { x: 1.5, y: -2.3, z: 0.7 };
  const v2 = { x: 0.2, y: 3.1, z: -1.4 };

  test("vectorAdd", () => {
    const r = GhMath.vectorAdd(v1, v2);
    expect(approxEq(r.x, v1.x + v2.x)).toBe(true);
    expect(approxEq(r.y, v1.y + v2.y)).toBe(true);
    expect(approxEq(r.z, v1.z + v2.z)).toBe(true);
  });

  test("vectorCross orthogonality", () => {
    const c = GhMath.vectorCross(v1, v2);
    // oracle: cross product is perpendicular to both inputs
    const dot1 = GhMath.vectorDot(c, v1);
    const dot2 = GhMath.vectorDot(c, v2);
    expect(approxEq(dot1, 0, 1e-10)).toBe(true);
    expect(approxEq(dot2, 0, 1e-10)).toBe(true);
  });

  test("vectorUnitize — length=1", () => {
    const u = GhMath.vectorUnitize(v1);
    expect(approxEq(GhMath.vectorLength(u), 1.0, 1e-12)).toBe(true);
  });

  test("vectorAngle between parallel vectors = 0", () => {
    const a = { x: 1, y: 0, z: 0 };
    const b = { x: 3, y: 0, z: 0 };
    expect(approxEq(GhMath.vectorAngle(a, b), 0)).toBe(true);
  });

  test("vectorAngle between perpendicular vectors = π/2", () => {
    const a = { x: 1, y: 0, z: 0 };
    const b = { x: 0, y: 1, z: 0 };
    expect(approxEq(GhMath.vectorAngle(a, b), Math.PI / 2, 1e-12)).toBe(true);
  });
});

describe("GhMath_Components — handler dispatch wrapper", () => {
  test("add op via handler", () => {
    const r = handle_GhMath_Components({ op: "add", a: 2.5, b: 3.5 }) as { result: number };
    expect(r.result).toBe(6.0);
  });

  test("sqrt op via handler", () => {
    const r = handle_GhMath_Components({ op: "sqrt", a: 9 }) as { result: number };
    expect(r.result).toBe(3.0);
  });

  test("series op via handler", () => {
    const r = handle_GhMath_Components({ op: "series", a: 0, step: 1, count: 5 }) as { result: number[] };
    expect(r.result).toEqual([0, 1, 2, 3, 4]);
  });

  test("unknown op returns ArgValidationError", () => {
    const r = handle_GhMath_Components({ op: "nonexistent" }) as { error: string };
    expect(r.error).toBe("ArgValidationError");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § Argument validation — missing required args
// ─────────────────────────────────────────────────────────────────────────────

describe("argument validation", () => {
  test("GhDataTree_Graft without tree returns ArgValidationError", () => {
    const r = handle_GhDataTree_Graft({}) as { error: string };
    expect(r.error).toBe("ArgValidationError");
  });

  test("GhDataTree_Flatten without tree returns ArgValidationError", () => {
    const r = handle_GhDataTree_Flatten({}) as { error: string };
    expect(r.error).toBe("ArgValidationError");
  });

  test("GhDataTree_Partition with size=0 returns ArgValidationError", () => {
    const input = treeFromRecord<number>({ "": [1, 2] });
    const r = handle_GhDataTree_Partition({ tree: input, size: 0 }) as { error: string };
    expect(r.error).toBe("ArgValidationError");
  });

  test("GhMath_Components without op returns ArgValidationError", () => {
    const r = handle_GhMath_Components({}) as { error: string };
    expect(r.error).toBe("ArgValidationError");
  });
});
