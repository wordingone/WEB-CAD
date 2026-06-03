// advertisement-drift.test.ts — AC for #422
//
// Every verb advertised in spatial-api.yaml (and therefore list_verbs) must:
//   1. Dispatch without returning UnknownVerb.
//   2. Return a structured { error: "NotYetImplemented" } result for stubs —
//      never the generic shim's { dispatched: kernel_op }.
//
// Candidate set from Archie's #513: SdTrim, SdBooleanSplit, SdMeshFromBrep,
//   SdStepWrite, SdDwgRead, SdIgesWrite.
//
// De-conflict: SdStepWrite is Archie's headline (#400); the stub here must
//   stay as NotYetImplemented until he lands the real implementation.

import { describe, test, expect, beforeAll } from "bun:test";
import { dispatch, registerHandler } from "../src/commands/dispatch";
import type { Viewer } from "../src/viewer/viewer";
import { registerSurface325Handlers } from "../src/handlers/s325-impl";
import { handle_SdBooleanSplit } from "../src/handlers/s326-impl";
import { handle_SdMeshFromBrep } from "../src/handlers/s329-impl";
import {
  handle_SdStepWriteStub,
  handle_SdDwgReadStub,
  handle_SdIgesWrite,
} from "../src/handlers/s333-impl";

// Minimal mock viewer — stub handlers don't call any viewer methods.
const MOCK_VIEWER = {} as Viewer;

beforeAll(() => {
  // SdTrim — registered by registerSurface325Handlers (inside the C++-blocked stubs section).
  registerSurface325Handlers(MOCK_VIEWER);

  // The remaining 5 stubs: register using the exported handle functions.
  // registerHandler is last-wins so these are safe to call even if the handler
  // was already registered by another test in this file's module context.
  registerHandler("SdBooleanSplit", (args) =>
    handle_SdBooleanSplit(args as Record<string, unknown>, MOCK_VIEWER),
  );
  registerHandler("SdMeshFromBrep", (args) =>
    handle_SdMeshFromBrep(args as Record<string, unknown>, MOCK_VIEWER),
  );
  registerHandler("SdStepWrite", (args) =>
    handle_SdStepWriteStub(args as Record<string, unknown>),
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
    expect(errType, `${verb}: dispatch returned ${errType} — expected ok:true or NotYetImplemented`).not.toBe(
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
    // Args: source + cutter are 'edge' type (custom opaque type — pass-through validation).
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

  test("SdStepWrite: resolves + returns NotYetImplemented (Archie #400 stub)", async () => {
    // De-conflict: SdStepWrite is Archie's headline (#400). This test ensures the stub
    // stays honest (clean NotYetImplemented) until he lands the real implementation.
    const r = await dispatch("SdStepWrite", {});
    assertNotImplemented(r, "SdStepWrite");
  });

  test("SdDwgRead: resolves + returns NotYetImplemented", async () => {
    // Args: bytes is arraybuffer type. Pass a minimal ArrayBuffer.
    const r = await dispatch("SdDwgRead", { bytes: new ArrayBuffer(0) });
    assertNotImplemented(r, "SdDwgRead");
  });

  test("SdIgesWrite: resolves + returns NotYetImplemented", async () => {
    const r = await dispatch("SdIgesWrite", {});
    assertNotImplemented(r, "SdIgesWrite");
  });
});
