# Demo video

`web/public/demo/demo.mp4` is a recording of the real app with the real in-browser model answering three prompts. The in-page player (Help > Play demo video, the consent dialog, the no-WebGPU modal, `?demo=1`) plays it. It is for visitors whose browser cannot run the model, and for anyone who does not want to download several GB to see what the agent does.

What it is not: it is not a benchmark and it does not show the agent building a whole building. It shows three single elements.

## The recording

| | |
|---|---|
| Recorded on | 2026-11-24 |
| Hardware | a desktop PC with an RTX 4090, headless Chrome (WebGPU) |
| Model | Gemma 4 E2B (the E4B model was not used: its download was too slow to finish; the caption says E2B) |
| Length | 71 s, one continuous take, 1280x720, H.264, 0.83 MB |
| Speed-up | none. Nothing is sped up, cut or spliced. The caption says no speed-up was applied |
| Poster | the last frame region of the same file (`demo-poster.jpg`) |

Every frame comes from one take: page load, model load from the browser cache (12 s), then three prompts typed into the chat box and answered by the live model. The generation times in `demo.json` (8.1 s, 10.1 s, 6.1 s) are the real ones.

The page shows a "Restore your last session?" box in the top right for the whole take. I did not test why it appears (my guess is that the profile had a saved session from the earlier checks); it was left as it was.

## Model files served from a verified local copy

The download of the model from Hugging Face ran at well under 1 MB/s for the two encoder files and took most of an hour for the rest, so the four large weight files were fetched separately and served to the page from disk during the recording:

- `audio_encoder_q4f16.onnx_data`, `vision_encoder_q4f16.onnx_data`, `decoder_model_merged_q4f16.onnx_data`, `embed_tokens_q4f16.onnx_data` from `onnx-community/gemma-4-E2B-it-ONNX`.
- Each file was downloaded in 16 parallel ranges and checked: size and sha256 are equal to the LFS hash Hugging Face lists for it.
- Playwright `route()` fulfils the request for those four file names with the file on disk (`--local-files`). Same bytes, same model. The session itself (typing, generation, 3D view) is untouched. The small graph files were downloaded normally.
- `demo.json` carries this in its `note` field and the player shows it in the caption.

## Prompts tried

Ids are the ones used by `--prompts` in `scripts/record-demo.mjs`; the prompt text comes from `web/src/agent/demo-prompts.ts`.

| id | prompt | result |
|---|---|---|
| wall | Build a wall, 5.5m long, 0.2m thick, 2.8m tall. | pass, 8.1 s, built one wall (SdWall). KEPT |
| slab-with-hole | Slab 6x6m x 0.2m thick with a 1x1m square hole at (2.5, 2.5). | pass, 10.1 s, built one slab (SdSlab). KEPT. The hole was not checked in the geometry |
| circular-column | A circular column with 0.45m radius and 5m height. | pass, 6.1 s, built one column (SdColumn). KEPT |
| four-walled-room | Four-walled room 9.12m x 9.34m, 0.24m thick walls, 3.06m tall. | fail: 46 s, no tool call, scene unchanged. Dropped |
| wall-with-doorway | Wall 4.13x0.28x2.69m with a 1.01m x 2.1m doorway 1.77m from the left. | fail: 4 s, no tool call, scene unchanged. Dropped |
| raised-slab | Place a 5 by 4m floor slab, 0.2m thick, raised 3m above ground. | fail: 351 s, no tool call. Dropped |
| l-walls, stair-step | not tried | the probe was stopped after raised-slab to save time |

The first full take used five prompts (the first three passed, the last two failed). It is not shipped: the file in the repo is the second take, with only the three that passed. The first take is not mixed into the second.

Pass means: the model finished the turn, the app reported a tool call, and the 3D scene gained geometry.

## Re-record

Needs Chrome, Node, Bun, an ffmpeg with libx264 (set `FFMPEG` to it), and a GPU that runs the E2B or E4B model.

```bash
bun run web:build && bun run web:preview -- --port 5872     # or any URL serving the built app

# once: load the model into a dedicated browser profile (several GB, unrecorded)
node scripts/record-demo.mjs --base http://localhost:5872/ --model e2b \
  --profile <empty-profile-dir> --warm-only

# the recorded take; the model loads from the profile cache
FFMPEG=<path to ffmpeg> node scripts/record-demo.mjs --base http://localhost:5872/ --model e2b \
  --profile <same-profile-dir> --no-warm \
  --prompts wall,slab-with-hole,circular-column \
  --hardware "an RTX 4090" --out web/public/demo --work <scratch-dir>
```

Add `--probe` to try prompts without recording or encoding. Add `--wait-speedup 4` to speed up only the waiting segments (model load and generation); the factor is then written to `demo.json` and shown in the caption. Add `--local-files <dir>` only for files you verified against the Hugging Face hash, and say so with `--note`.

Playwright's own video recorder wants an ffmpeg at `%LOCALAPPDATA%\ms-playwright\ffmpeg-1011\ffmpeg-win64.exe`. If you have not run `npx playwright install ffmpeg`, copy any recent ffmpeg there (the recording PC used the imageio-ffmpeg 7.1 binary).

The test `web/test/demo-assets.test.ts` checks that the video, poster and `demo.json` exist and are the size this page promises. If you re-record, update the table above.
