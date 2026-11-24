# Demo video

`web/public/demo/demo.mp4` is a recording of the real app with the real in-browser model answering four prompts. The in-page player (Help > Play demo video, the consent dialog, the no-WebGPU modal, `?demo=1`) plays it. It is for visitors whose browser cannot run the model, and for anyone who does not want to download several GB to see what the agent does.

What it is not: it is not a benchmark and it does not show the agent building a whole building. It shows four single elements, each placed at the origin.

## The recording

| | |
|---|---|
| Recorded on | 2026-11-24 |
| Hardware | a desktop PC with an RTX 4090, headless Chrome (WebGPU) |
| Model | Gemma 4 E2B (the E4B model was not used: its download was too slow to finish; the caption says E2B) |
| Length | 85 s, one continuous take, 1280x720, H.264, 1.07 MB |
| Speed-up | none. Nothing is sped up, cut or spliced. The caption says no speed-up was applied |
| Poster | the last frame region of the same file (`demo-poster.jpg`) |

Every frame comes from one take: page load, model load from the browser cache (12 s), then four prompts typed into the chat box and answered by the live model. The generation times in `demo.json` (8.1 s, 7.1 s, 6.1 s, 8.0 s) are the real ones.

The recorder clicks Discard on the "Restore your last session?" box that a used browser profile shows, before the first prompt, so it is not in the take. The scene starts with the app's default content (3 meshes); each prompt is checked against the mesh count before and after.

## Model files served from a verified local copy

The download of the model from Hugging Face ran at well under 1 MB/s for the two encoder files and took most of an hour for the rest, so the four large weight files were fetched separately and served to the page from disk during the recording:

- `audio_encoder_q4f16.onnx_data`, `vision_encoder_q4f16.onnx_data`, `decoder_model_merged_q4f16.onnx_data`, `embed_tokens_q4f16.onnx_data` from `onnx-community/gemma-4-E2B-it-ONNX`.
- Each file was downloaded in 16 parallel ranges and checked: size and sha256 are equal to the LFS hash Hugging Face lists for it.
- Playwright `route()` fulfils the request for those four file names with the file on disk (`--local-files`). Same bytes, same model. The session itself (typing, generation, 3D view) is untouched. The small graph files were downloaded normally.
- `demo.json` carries this in its `note` field and the player shows it in the caption.

## Prompts tried

Ids are the ones used by `--prompts` in `scripts/record-demo.mjs`.

The rule for the take that ships: every prompt in it ends with at least one build step (a verb) and a higher mesh count, read from `take-marks.json`, and the result frame matches the prompt's words (checked by eye on frames from the final video). `record-demo.mjs` refuses to finish a take in which a prompt built nothing.

In the shipped take (verbs and mesh counts from `take-marks.json`):

| id | prompt | verbs | meshes before -> after | seconds |
|---|---|---|---|---|
| wall | Build a wall, 5.5m long, 0.2m thick, 2.8m tall. | SdWall | 3 -> 4 | 8.1 |
| slab | Place a 6 by 6m floor slab, 0.2m thick. | SdSlab | 4 -> 5 | 7.1 |
| circular-column | A circular column with 0.45m radius and 5m height. | SdColumn | 5 -> 7 | 6.1 |
| beam | Place a horizontal beam 5m long, 0.3m wide and 0.4m deep, 3m above ground. | SdBeam | 7 -> 8 | 8.0 |

Tried and not shipped:

| id | prompt | result |
|---|---|---|
| slab-with-hole | Slab 6x6m x 0.2m thick with a 1x1m square hole at (2.5, 2.5). | built a slab (SdSlab) but no hole: the caption would overstate. Dropped |
| l-walls | Two walls forming an L: 8.45m and 9.25m, both 0.31m thick and 3.35m tall. | two walls (SdWall x2), meshes 7 -> 9, but no L is visible in the result frame. Dropped |
| l-explicit | two walls at right angles, 6m along x and 4m along y | built one wall, not two. Dropped |
| wall-b, column-b | a second wall / a second column | built (SdWall / SdColumn) but at the origin on top of the first, so the frame shows no change. Dropped |
| roof-slab, raised-slab | a slab raised 3m above ground | the model called SdFoundation, not a slab; one earlier try took 351 s and built nothing. Dropped |
| stair-step | Stair-step structure with 4 steps, run 0.39m, rise 0.21m, 2.77m wide. | no tool call, meshes unchanged. Dropped |
| four-walled-room | Four-walled room 9.12m x 9.34m, 0.24m thick walls, 3.06m tall. | 46 s, no tool call. Dropped |
| wall-with-doorway | Wall 4.13x0.28x2.69m with a 1.01m x 2.1m doorway 1.77m from the left. | no tool call. Dropped |
| rect-column | A rectangular column 0.4m by 0.4m and 3.5m tall. | no tool call. Dropped |

The model places every new shape at the origin, so more than one wall or column stacks on the first; that is why the shipped take uses four different element types.

Earlier takes (three prompts, with a hole-less slab, and a five-prompt one with two failures) were replaced and are not mixed into this file.

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
  --prompts wall,slab,circular-column,beam \
  --hardware "an RTX 4090" --out web/public/demo --work <scratch-dir>
```

Add `--probe` to try prompts without recording or encoding (it prints pass or fail per prompt; `--turn-timeout <seconds>` shortens the wait for a prompt that never answers). Add `--wait-speedup 4` to speed up only the waiting segments (model load and generation); the factor is then written to `demo.json` and shown in the caption. Add `--local-files <dir>` only for files you verified against the Hugging Face hash, and say so with `--note`.

Playwright's own video recorder wants an ffmpeg at `%LOCALAPPDATA%\ms-playwright\ffmpeg-1011\ffmpeg-win64.exe`. If you have not run `npx playwright install ffmpeg`, copy any recent ffmpeg there (the imageio-ffmpeg 7.1 binary worked).

The test `web/test/demo-assets.test.ts` checks that the video, poster and `demo.json` exist and are the size this page promises. If you re-record, update the table above.
