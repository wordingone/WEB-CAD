# Submission — Gemma 4 Good Hackathon

**Track:** Equity (3D design for non-CAD users)
**Project:** gemma-architect — browser-native parametric architectural design from natural-language prompts
**Deadline:** 2026-05-18

## Required artifacts

- [ ] **Public Kaggle write-up** — project description, technical approach, impact statement, demo link.
- [ ] **Public GitHub repo** — this repo, license = Apache-2.0, README points to demo + writeup.
- [ ] **3-min demo video** — screen-record the in-browser flow: type prompt → render geometry → export IFC.
- [ ] **Hosted live demo** — static-hosted single page running Gemma 4 in-browser via WebGPU + replicad.
- [ ] **Reproducible model artifact** — LoRA adapter on Hugging Face Hub or Kaggle Datasets.

## Judging criteria (hackathon spec)

1. **Impact** — clarity of who benefits, depth of need, realistic adoption path.
2. **Technical execution** — fine-tuning quality, novel use of Gemma 4 capabilities (multimodality / long context / on-device).
3. **Communication** — write-up readability, demo polish, code reproducibility.

Each section gets its own page in this directory near the deadline:
- `submission/writeup.md` — the Kaggle post.
- `submission/demo-script.md` — exact demo path + voiceover.
- `submission/repro.md` — step-by-step training + inference reproduction.
- `submission/impact.md` — equity story: barrier-to-entry for parametric CAD, target users, deployment plan.

## Status (2026-04-30)

- ✅ Spike B (IFC mining pipeline) — 12 pairs mined from open IFC corpus, retrospective at `docs/spike-b-retrospective.md`.
- ✅ Spike A (LoRA training) — 76 train + 8 eval pairs, Gemma-3-4b-it QLoRA r=16, eval_loss 0.144 @ epoch 3, **8/8 parse_ok | 8/8 api_clean | 8/8 has_extrude** on held-out set. Adapter at `outputs/spike-a-lora/`. Retrospective at `docs/spike-a-retrospective.md`.
- ✅ 18-day plan — `docs/plan-18-day.md` (5 sub-gates: model artifact, browser inference, render+export, demo video, Kaggle writeup).
- ⏳ Dataset v2 (target 400+ pairs) — D1-D4 in plan.
- ⏳ E2B/E4B re-train — D4 in plan.
- ⏳ Browser runtime — D5-D10 in plan.
- ⏳ Demo recording — D11-D12 in plan.
- ⏳ Kaggle writeup — D13-D15 in plan.
