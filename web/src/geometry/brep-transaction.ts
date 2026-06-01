// brep-transaction.ts — #370 PR3 accumulation model
//
// BrepTransaction collects multi-step construction operations against a starting
// Brep and compiles them in sequence into a single unified Brep result.
//
// Usage:
//   const tx = new BrepTransaction(baseBrep);
//   tx.fillet([0, 1], 0.05);
//   tx.union(bracket);
//   const { brep, applied } = await tx.commit();
//
// Design:
//   Operations queue lazily; commit() executes them in order, each step
//   receiving the Brep produced by the previous step. This enables sequential
//   construction without geometry-store round-trips between steps.
//
// References:
//   - OCCT BRep_Builder, BRepAlgoAPI_BuilderAlgo (sequential op accumulation)
//   - issue #370 (accumulation model — foundational geometry system, part 3)

import type { Brep, BrepShell } from "../nurbs/nurbs-brep";
import { brepConcat } from "../nurbs/nurbs-brep";
import { brepUnion, brepDifference, brepIntersection } from "../nurbs/brep-boolean";
import type { BooleanCallOptions } from "../nurbs/brep-boolean";
import { kernFillet } from "../nurbs/kern-ops";

// ── Step types ────────────────────────────────────────────────────────────────

/** Fillet specified edges with given radius. Uses kern path if loaded. */
export type FilletStep = {
  readonly kind: "fillet";
  readonly edges: readonly number[];
  readonly radius: number;
};

/** Boolean union with another Brep. */
export type UnionStep = {
  readonly kind: "union";
  readonly other: Brep;
  readonly opts?: BooleanCallOptions;
};

/** Boolean difference (subtract other from current). */
export type SubtractStep = {
  readonly kind: "subtract";
  readonly other: Brep;
  readonly opts?: BooleanCallOptions;
};

/** Boolean intersection. */
export type IntersectStep = {
  readonly kind: "intersect";
  readonly other: Brep;
  readonly opts?: BooleanCallOptions;
};

export type BrepStep = FilletStep | UnionStep | SubtractStep | IntersectStep;

// ── Result type ───────────────────────────────────────────────────────────────

export type StepOutcome =
  | { ok: true; step: BrepStep }
  | { ok: false; step: BrepStep; error: string };

export type BrepTransactionResult = {
  brep: Brep;
  outcomes: StepOutcome[];
};

// ── BrepTransaction ───────────────────────────────────────────────────────────

/**
 * Accumulate construction operations against a base Brep and commit them as a
 * single unified Brep result.
 *
 * Invariants:
 *   - commit() is called at most once per transaction instance.
 *   - After commit(), the transaction is sealed; further pushes throw.
 *   - Failed steps do NOT abort the transaction — the error is recorded in
 *     outcomes and the Brep from the previous successful step is carried forward.
 */
export class BrepTransaction {
  private readonly _base: Brep;
  private readonly _steps: BrepStep[] = [];
  private _committed = false;

  constructor(base: Brep) {
    this._base = base;
  }

  /** Queue a fillet operation. */
  fillet(edges: number[], radius: number): this {
    this._assertOpen();
    this._steps.push({ kind: "fillet", edges, radius });
    return this;
  }

  /** Queue a boolean union with another Brep. */
  union(other: Brep, opts?: BooleanCallOptions): this {
    this._assertOpen();
    this._steps.push({ kind: "union", other, opts });
    return this;
  }

  /** Queue a boolean difference (subtract other from current). */
  subtract(other: Brep, opts?: BooleanCallOptions): this {
    this._assertOpen();
    this._steps.push({ kind: "subtract", other, opts });
    return this;
  }

  /** Queue a boolean intersection. */
  intersect(other: Brep, opts?: BooleanCallOptions): this {
    this._assertOpen();
    this._steps.push({ kind: "intersect", other, opts });
    return this;
  }

  /** Number of queued steps (before commit). */
  get stepCount(): number {
    return this._steps.length;
  }

  /**
   * Execute all queued steps in order and return the resulting Brep.
   * Each step receives the Brep produced by the previous step.
   * Failed steps are recorded in `outcomes` but do not abort the transaction.
   *
   * @throws if called more than once.
   */
  async commit(): Promise<BrepTransactionResult> {
    this._assertOpen();
    this._committed = true;

    let current: Brep = this._base;
    const outcomes: StepOutcome[] = [];

    for (const step of this._steps) {
      try {
        current = applyStep(current, step);
        outcomes.push({ ok: true, step });
      } catch (err) {
        outcomes.push({
          ok: false,
          step,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { brep: current, outcomes };
  }

  /** Read-only snapshot of the base Brep this transaction operates on. */
  get base(): Brep {
    return this._base;
  }

  private _assertOpen(): void {
    if (this._committed) throw new Error("BrepTransaction: already committed");
  }
}

// ── Step executor ─────────────────────────────────────────────────────────────

function applyStep(brep: Brep, step: BrepStep): Brep {
  switch (step.kind) {
    case "fillet": {
      const result = kernFillet(brep, step.radius, step.edges as number[]);
      if (result === null) {
        throw new Error(
          `fillet step failed: kern not loaded or operation error (edges=${JSON.stringify(step.edges)}, radius=${step.radius})`,
        );
      }
      return result;
    }

    case "union": {
      const result = brepUnion(brep, step.other, step.opts);
      if (!result.ok) {
        throw new Error(`union step failed: ${result.error.message}`);
      }
      return result.brep;
    }

    case "subtract": {
      const result = brepDifference(brep, step.other, step.opts);
      if (!result.ok) {
        throw new Error(`subtract step failed: ${result.error.message}`);
      }
      return result.brep;
    }

    case "intersect": {
      const result = brepIntersection(brep, step.other, step.opts);
      if (!result.ok) {
        throw new Error(`intersect step failed: ${result.error.message}`);
      }
      return result.brep;
    }
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

/**
 * Create a BrepTransaction starting from a Brep that is the structural
 * concatenation of multiple shells. Useful for compound solid construction.
 */
export function transactionFromShells(shells: BrepShell[]): BrepTransaction {
  const base: Brep = { shells };
  return new BrepTransaction(base);
}
