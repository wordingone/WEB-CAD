// brep-transaction.test.ts — #370 PR3 BrepTransaction unit tests.
//
// Tests the accumulation model using the toy boolean backend via explicit
// { backend: 'toy' } opts. Never calls _clearRegistryForTest — that mutates
// shared module-level state and breaks the nurbs-backend registration that
// brep-boolean.test.ts depends on.

import { describe, test, expect } from "bun:test";
import { BrepTransaction, transactionFromShells } from "../src/geometry/brep-transaction";
import type { BrepStep } from "../src/geometry/brep-transaction";
import type { Brep } from "../src/nurbs/nurbs-brep";

// ── Helpers ───────────────────────────────────────────────────────────────────

function minimalBrep(): Brep {
  return { shells: [{ faces: [], edges: [], vertices: [], isClosed: false }] };
}

// Explicit toy backend — keeps test assertions deterministic (structural concat)
// without touching the shared backend registry.
const TOY = { backend: "toy" } as const;

// ── Constructor ───────────────────────────────────────────────────────────────

describe("BrepTransaction — constructor", () => {
  test("base brep accessible", () => {
    const base = minimalBrep();
    const tx = new BrepTransaction(base);
    expect(tx.base).toBe(base);
  });

  test("stepCount starts at 0", () => {
    const tx = new BrepTransaction(minimalBrep());
    expect(tx.stepCount).toBe(0);
  });
});

// ── Step queuing ──────────────────────────────────────────────────────────────

describe("BrepTransaction — step queuing", () => {
  test("fillet increments stepCount", () => {
    const tx = new BrepTransaction(minimalBrep());
    tx.fillet([0], 0.05);
    expect(tx.stepCount).toBe(1);
  });

  test("union increments stepCount", () => {
    const tx = new BrepTransaction(minimalBrep());
    tx.union(minimalBrep());
    expect(tx.stepCount).toBe(1);
  });

  test("subtract increments stepCount", () => {
    const tx = new BrepTransaction(minimalBrep());
    tx.subtract(minimalBrep());
    expect(tx.stepCount).toBe(1);
  });

  test("intersect increments stepCount", () => {
    const tx = new BrepTransaction(minimalBrep());
    tx.intersect(minimalBrep());
    expect(tx.stepCount).toBe(1);
  });

  test("chaining returns the same instance", () => {
    const tx = new BrepTransaction(minimalBrep());
    const chained = tx.union(minimalBrep()).subtract(minimalBrep());
    expect(chained).toBe(tx);
    expect(tx.stepCount).toBe(2);
  });

  test("push after commit throws", async () => {
    const tx = new BrepTransaction(minimalBrep());
    await tx.commit();
    expect(() => tx.fillet([0], 0.05)).toThrow(/already committed/);
  });

  test("double commit throws", async () => {
    const tx = new BrepTransaction(minimalBrep());
    await tx.commit();
    await expect(tx.commit()).rejects.toThrow(/already committed/);
  });
});

// ── commit() ──────────────────────────────────────────────────────────────────

describe("BrepTransaction — commit", () => {
  test("empty transaction returns base brep", async () => {
    const base = minimalBrep();
    const tx = new BrepTransaction(base);
    const { brep, outcomes } = await tx.commit();
    expect(brep).toBe(base);
    expect(outcomes).toHaveLength(0);
  });

  test("union step (toy) structural-concat shells", async () => {
    const base = minimalBrep();
    const other = minimalBrep();
    const tx = new BrepTransaction(base);
    tx.union(other, TOY);
    const { brep, outcomes } = await tx.commit();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(true);
    // Toy union = structural concat: result has base.shells + other.shells
    expect(brep.shells.length).toBe(base.shells.length + other.shells.length);
  });

  test("failed fillet step recorded but does not abort chain", async () => {
    // kernFillet returns null when kern.wasm is not loaded — becomes a failure
    const base = minimalBrep();
    const tx = new BrepTransaction(base);
    tx.fillet([0], 0.05);           // fails (no kern.wasm in CI)
    tx.union(minimalBrep(), TOY);   // should still execute
    const { brep, outcomes } = await tx.commit();
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].ok).toBe(false);
    expect((outcomes[0] as { ok: false; error: string }).error).toMatch(/kern not loaded/);
    expect(outcomes[1].ok).toBe(true);
    // union was applied to base (fillet failed, base carried forward)
    expect(brep.shells.length).toBe(2);
  });

  test("multiple union steps chain — toy concat", async () => {
    const base: Brep = { shells: [{ faces: [], edges: [], vertices: [], isClosed: false }] };
    const b1:   Brep = { shells: [{ faces: [], edges: [], vertices: [], isClosed: false }] };
    const b2:   Brep = { shells: [{ faces: [], edges: [], vertices: [], isClosed: false }] };
    const tx = new BrepTransaction(base);
    tx.union(b1, TOY).union(b2, TOY);
    const { brep, outcomes } = await tx.commit();
    expect(outcomes.every((o) => o.ok)).toBe(true);
    // After 2 toy unions: 1 + 1 + 1 = 3 shells
    expect(brep.shells.length).toBe(3);
  });

  test("step kind preserved in outcome", async () => {
    const tx = new BrepTransaction(minimalBrep());
    tx.union(minimalBrep(), TOY);
    const { outcomes } = await tx.commit();
    const step = outcomes[0].step as BrepStep;
    expect(step.kind).toBe("union");
  });
});

// ── transactionFromShells ─────────────────────────────────────────────────────

describe("transactionFromShells", () => {
  test("creates transaction from shell array", () => {
    const s1 = { faces: [], edges: [], vertices: [], isClosed: false };
    const s2 = { faces: [], edges: [], vertices: [], isClosed: false };
    const tx = transactionFromShells([s1, s2]);
    expect(tx.base.shells).toHaveLength(2);
    expect(tx.base.shells[0]).toBe(s1);
    expect(tx.base.shells[1]).toBe(s2);
  });
});
