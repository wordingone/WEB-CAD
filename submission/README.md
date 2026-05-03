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

## Status (2026-05-03)

- ✅ Spike B (IFC mining pipeline) — 12 pairs mined from open IFC corpus, retrospective at `docs/spike-b-retrospective.md`.
- ✅ Spike A (LoRA training) — 76 train + 8 eval pairs, Gemma-3-4b-it QLoRA r=16, eval_loss 0.144 @ epoch 3, **8/8 parse_ok | 8/8 api_clean | 8/8 has_extrude** on held-out set. Adapter at `outputs/spike-a-lora/`. Retrospective at `docs/spike-a-retrospective.md`.
- ✅ 18-day plan — `docs/plan-18-day.md` (5 sub-gates: model artifact, browser inference, render+export, demo video, Kaggle writeup).
- ✅ **Dataset v2** — 400 base rows, 5 buckets (50+50+200+50+50), **round-trip 100%**, 932 augmented training rows, 40-row stratified holdout. See `dataset/v2-results.md`.
- ✅ **4b-it LoRA shipped 2026-05-01** — 53 min on a 4090, train_loss 0.244 @ epoch 3, **40/40 (100%) full round-trip** on the held-out eval. Adapter at `outputs/cad-lora-v2-4b-it/`. Publish plan staged at `outputs/cad-lora-v2-publish-plan.json` (HF push pending HF_TOKEN).
- ⏳ E2B variant — deferred per `dataset/v2-results.md`; will ship once 4b-it submission cycle closes.
- ✅ **Browser runtime running** — Vite + TypeScript + three.js + replicad + web-ifc 0.0.77 all wired, 8 canned demos shipping, IFC4 export round-trip-verified, drag-drop loader for IFC/STEP/GLB/GLTF/OBJ/STL, sample IFC files (Schultz Residence + KIT FZK-Haus + Bonsai openings) bundled. Self-harness: 8/8 demos pass. Live design-handoff in flight (#170 umbrella) bringing the page up to the bundle's drafting-workbench aesthetic.
- 🟡 **Kaggle writeup drafted** — `submission/writeup.md` (270+ lines), `submission/impact.md`, `submission/repro.md`, `submission/demo-script.md` all drafted. Outstanding: HF adapter URL (HF_TOKEN), GitHub repo URL (no public remote yet), Spaces/Vercel demo URL, and the 3-min video.
- ⏳ Demo recording — D11-D12 in plan.
- ⏳ Public hosting — public GitHub remote + HF Spaces + LoRA on HF Hub still pending external auth.

## Outstanding blockers (judge-visible)

These four lines in `writeup.md` are placeholders — without them, the submission isn't externally verifiable:

- `https://github.com/wordingone/gemma-architect` — no public git remote yet (`git remote -v` is empty).
- `https://huggingface.co/gemma-architect/cad-lora-v2` — adapter not pushed (HF_TOKEN absent).
- Live demo URL (Spaces / Vercel) — TBD.
- Demo video URL (YouTube) — TBD.
