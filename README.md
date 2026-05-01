# gemma-architect

Browser-native 3D architectural design tool — Gemma 4 fine-tuned on
parametric IFC building data, NL/sketch input → replicad construction
sequence → live 3D viewer.

Hackathon entry: **Gemma 4 Good Hackathon** (Kaggle + Google DeepMind),
deadline 2026-05-18.

Track: **equity** — 3D design accessibility for non-CAD-trained users.

## Stack

- **Model:** Gemma 4 E2B (LoRA via Unsloth, 8-10GB on 24GB 4090)
- **Geometry kernel:** [replicad](https://replicad.xyz/) (MIT) on top of
  replicad-opencascadejs (LGPL-2.1 with linking exception)
- **IFC parser:** [web-ifc](https://github.com/ThatOpen/engine_web-ifc)
  v0.0.77 — parametric STEP entity recovery via
  `IfcAPI.GetLine(modelID, expressID, flatten=true)`
- **Viewer:** three.js + replicad mesh export
- **Training corpus:** open IFC datasets (Schependomlaan, Duplex, etc.)
  + IfcOpenHouse-family synthetic generation

## Directory layout

- `src/tools/` — replicad fluent-API tool surface, T1 (12 ops, Spike A
  target) / T2 (7 ops) / T3 (stretch). See
  `docs/tool-taxonomy.md`.
- `src/runtime/` — document state, layer mgmt, viewer wiring (NOT
  taught to model).
- `src/extract/` — IFC → (NL, replicad sequence) extraction pipeline.
  Single-element walkthrough at `docs/extraction-pipeline.md`.
- `src/train/` — Unsloth Gemma 4 LoRA training scripts.
- `fixtures/` — hand-curated training pairs. `fixtures/tier1.jsonl`
  is the Spike A target.
- `scripts/` — bootstrap, dataset prep, eval.
- `data/` — IFC samples (gitignored; download script provided).
- `docs/` — design docs.

## Plan

18 days. Spike A + B run weeks 1-2; weeks 3 build on whichever passes.

Pre-plan artifacts at `B:/M/avir/leo/state/hackathon-*.md`. Formal
18-day plan at `docs/plan.md` written from spike retrospective.

## Status

Pre-plan complete. Bootstrap in progress (#96).
