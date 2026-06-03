// sample-defs.ts — Hand-authored sample GH definitions for testing and demos.
// These are the first end-to-end test cases for the client-side GH evaluator (#480).

import type { GhDefSpec } from "./gh-def-ingester";

/** Box parametrised by width, height, depth — the canonical #480 smoke-test def. */
export const BOX_SAMPLE_DEF: GhDefSpec = {
  inlineGraphId: "sample:box-from-params",
  label: "Box from W/H/D",
  inputPorts: [
    { name: "w", min: 0.1, max: 20, default: 5 },
    { name: "h", min: 0.1, max: 10, default: 3 },
    { name: "d", min: 0.1, max: 20, default: 5 },
  ],
  components: [
    {
      id: "box1",
      type: "SdBox",
      params: {
        width:  { portRef: "w" },
        height: { portRef: "h" },
        depth:  { portRef: "d" },
      },
    },
  ],
};

/** All built-in sample defs, keyed by inlineGraphId for easy lookup. */
export const SAMPLE_DEFS: Record<string, GhDefSpec> = {
  [BOX_SAMPLE_DEF.inlineGraphId!]: BOX_SAMPLE_DEF,
};
