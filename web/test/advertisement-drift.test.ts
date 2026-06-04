// advertisement-drift.test.ts — AC for #422
//
// Every verb advertised in spatial-api.yaml (and therefore list_verbs) must:
//   1. Dispatch without returning UnknownVerb.
//   2. Return a structured { error: "NotYetImplemented" } result for stubs —
//      never the generic shim's { dispatched: kernel_op }.
//
// Candidate set: SdTrim, SdBooleanSplit, SdMeshFromBrep, SdDwgRead, SdIgesWrite.
//
// Note: SdStepWrite was a stub target in the original #422 scope but graduated to
// a live OCCT implementation in PR #514. It is excluded from the NotYetImplemented
// assertions and covered only by the full-sweep test below.

import { describe, test, expect, beforeAll } from "bun:test";
import { dispatch, registerHandler } from "../src/commands/dispatch";
import { getDictionary } from "../src/commands/dictionary";
import type { Viewer } from "../src/viewer/viewer";
import { registerSurface325Handlers } from "../src/handlers/s325-impl";
import { handle_SdBooleanSplit } from "../src/handlers/s326-impl";
import { handle_SdMeshFromBrep } from "../src/handlers/s329-impl";
import {
  handle_SdDwgReadStub,
  handle_SdIgesWrite,
} from "../src/handlers/s333-impl";

// Minimal mock viewer — stub handlers don't call any viewer methods.
const MOCK_VIEWER = {} as Viewer;

beforeAll(() => {
  // SdTrim — registered by registerSurface325Handlers (C++-blocked stubs section).
  registerSurface325Handlers(MOCK_VIEWER);

  registerHandler("SdBooleanSplit", (args) =>
    handle_SdBooleanSplit(args as Record<string, unknown>, MOCK_VIEWER),
  );
  registerHandler("SdMeshFromBrep", (args) =>
    handle_SdMeshFromBrep(args as Record<string, unknown>, MOCK_VIEWER),
  );
  registerHandler("SdDwgRead", (args) =>
    handle_SdDwgReadStub(args as Record<string, unknown>),
  );
  registerHandler("SdIgesWrite", (args) =>
    handle_SdIgesWrite(args as Record<string, unknown>, MOCK_VIEWER),
  );
});

function assertNotImplemented(
  r: Awaited<ReturnType<typeof dispatch>>,
  verb: string,
): void {
  // Dispatch layer: verb resolved (no UnknownVerb), handler was registered (no NoHandler).
  if (!r.ok) {
    const errType = (r as { error: string }).error;
    expect(errType, `${verb}: dispatch returned ${errType} — expected ok:true`).not.toBe(
      "UnknownVerb",
    );
    expect(errType, `${verb}: dispatch returned NoHandler — handler not registered`).not.toBe(
      "NoHandler",
    );
  }
  // Handler layer: result carries the structured NotYetImplemented error,
  // not the default shim's { dispatched: kernel_op }.
  expect(r.ok, `${verb}: dispatch ok should be true for a stub handler`).toBe(true);
  if (r.ok) {
    const result = (r as { ok: true; result: unknown }).result as Record<string, unknown> | undefined;
    expect(result?.error, `${verb}: expected result.error="NotYetImplemented", got "${result?.error}"`).toBe(
      "NotYetImplemented",
    );
  }
}

describe("#422 — advertisement drift: stub verbs return NotYetImplemented", () => {
  test("SdTrim: resolves + returns NotYetImplemented (not default shim)", async () => {
    const r = await dispatch("SdTrim", { source: "fake-edge-1", cutter: "fake-edge-2" });
    assertNotImplemented(r, "SdTrim");
  });

  test("SdBooleanSplit: resolves + returns NotYetImplemented", async () => {
    const r = await dispatch("SdBooleanSplit", { a: "fake-uuid-1", b: "fake-uuid-2" });
    assertNotImplemented(r, "SdBooleanSplit");
  });

  test("SdMeshFromBrep: resolves + returns NotYetImplemented", async () => {
    const r = await dispatch("SdMeshFromBrep", { target: "fake-uuid-3" });
    assertNotImplemented(r, "SdMeshFromBrep");
  });

  test("SdDwgRead: resolves + returns NotYetImplemented", async () => {
    const r = await dispatch("SdDwgRead", { bytes: new ArrayBuffer(0) });
    assertNotImplemented(r, "SdDwgRead");
  });

  test("SdIgesWrite: resolves + returns NotYetImplemented", async () => {
    const r = await dispatch("SdIgesWrite", {});
    assertNotImplemented(r, "SdIgesWrite");
  });
});

describe("#422 — full-sweep: no advertised verb returns UnknownVerb", () => {
  // Guards against future parser regressions silently dropping dictionary entries.
  // Asserts every verb in getDictionary() is resolvable by dispatch —
  // result may be NoHandler / ArgValidationError / ok:true, but never UnknownVerb.
  test("all dictionary verbs dispatch without UnknownVerb", async () => {
    const verbs = getDictionary().map((e) => e.name);
    expect(verbs.length, "dictionary must be non-empty").toBeGreaterThan(0);
    const failures: string[] = [];
    for (const verb of verbs) {
      const r = await dispatch(verb, {});
      if (!r.ok && (r as { error: string }).error === "UnknownVerb") {
        failures.push(verb);
      }
    }
    expect(
      failures,
      `${failures.length} verb(s) returned UnknownVerb: ${failures.join(", ")}`,
    ).toHaveLength(0);
  });
});
