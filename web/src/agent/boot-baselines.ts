// boot-baselines.ts — §WEB-CAD#14: predicted phase durations from Phase J receipt averages.
// Cold-cache: 3 PASS runs (89bae2b/043d325/a274d19), boot_ms 241-247s, variance ~5s.
// Warm-cache: 1 PASS run (68f7b2e), boot_ms 216s.
// Update when ≥5 new runs of the same mode are available.

export const COLD_CACHE_BASELINES_MS = {
  pages_load:        2_300,
  consent_to_arc:    5_000,   // consent click → first ARC event
  model_download:  192_000,   // ~192s for ~5.2 GB at typical CDN throughput
  model_init:        1_000,   // ORT weight deserialization
  warmup:           21_800,   // GPU shader compilation
  first_inference:  26_000,   // first token generation
  total_p50:       245_000,   // median total boot
};

export const WARM_CACHE_BASELINES_MS = {
  pages_load:       2_300,
  consent_to_arc:   5_000,
  opfs_load:      100_000,    // ~100s OPFS → ORT load (replaces model_download on warm path)
  model_init:       1_000,
  warmup:          21_800,
  first_inference: 26_000,
  total_p50:      156_000,    // median warm-cache boot
};
