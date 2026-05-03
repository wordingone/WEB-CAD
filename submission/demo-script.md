# Demo video script — gemma-architect (3:00)

> ⚠️ **STALE pre-bundle-port (last updated 2026-05-01).**
> The script below targets the v1/v2 page (single dropdown + `Run` /
> `Export IFC` buttons). The current page has shipped the bundle
> drafting-workbench port (#170 umbrella): menubar/modebar/ribbon shell,
> mode tabs (MODEL/LAYOUT/RESEARCH), Cmd-K palette, multi-format Export
> drawer, drafting-style toggle (`D` hotkey), IFC sample dropdown.
> Quad-split viewport (#180 Gap 1) is in flight via forge.
>
> **Do not record from this script as-is.** Update mapping (current → v2):
> - "Pick demo from dropdown" → PROMPT dock tab → demo chips OR Cmd-K → "New wall" / "New column" / etc.
> - **Run** button → **GENERATE** in the AIPanel (or `⌘⏎`)
> - **Export IFC** button → **EXPORT** ribbon button (or `⌘E`) → drawer slides in → click IFC tile
> - "OpenCascade ready" status → check `#status` text; format may differ
> - Add: drafting-style toggle (`D`) for the architect-render aesthetic
> - Add: load `Schultz Residence` from sample-select for a real-building hero shot
>
> Refresh this script once Gap 1 lands and the UI surface is stable. Open
> issue: rewrite cut-by-cut against current page; re-shoot pacing; keep
> the equity-track narrative (block below) intact — only the click path
> changes.

---

The 3-minute screen-recording for the Kaggle submission. Voice-over
scripted line-by-line, cuts timed against a single take of the
production page (`bun run web:preview`). Shoot at 1920×1080, 30 fps.

**Prompt selection** follows the 18-day plan D11 spec: three prompts
that span scope — single-element, parametric variation, and multi-element
assembly with boolean cuts.

| Cut | Range | Promo prompt |
| :-: | :---- | :----------- |
| 1 | 0:20–1:00 | "a wall, 5.5m long, 0.2m thick, 2.8m tall" (single-element) |
| 2 | 1:00–1:40 | "a 6m × 4m slab, 0.2m thick, with a 1.2m × 1.2m square stair hole at the back-left corner" (parametric variation + boolean cut) |
| 3 | 1:40–2:30 | "a 4-walled room, 4.6m × 4.5m, 3m tall, 0.18m wall thickness" (multi-element assembly) |

---

## 0:00 — 0:20 — Hook

**Screen:** open in Chrome. Static title card 2s, then the live page,
status `OpenCascade ready. Pick a demo and Run.`, dropdown closed.

**VO (24 words, ~6.5s/line, 4 lines = 26s budget — trim live):**

> "Parametric CAD costs three thousand dollars a year. Revit, AutoCAD,
> ArchiCAD. The tools that exist on the free side all assume you already
> know how to model. **Gemma-architect runs in a browser tab.** No
> install. No login. No API key. You type a sentence; you get a
> building."

**Cut beat:** end on the page idle, dropdown highlighted, cursor
hovering. Hard cut at 0:20.

---

## 0:20 — 1:00 — Demo 1: Wall (single-element + parametric)

**Screen:**
1. Pick **Wall (5.5m × 0.2m × 2.8m)** in dropdown. Prompt + JS appear.
2. Click **Run**. Status flips to `Running...` then `Ready (12 tris,
   4.4 KB IFC).` Wall renders, OrbitControls auto-frame.
3. Drag **length** slider to 8.0m. Geometry updates within ~90ms.
4. Drag **height** slider to 3.5m. Updates again.
5. Click **Export IFC**. Browser downloads `wall.ifc`.

**VO (40s budget):**

> "Pick a demo. Type — or read the prompt the model already wrote:
> 'a wall, five and a half meters long, twenty centimeters thick,
> two meters eighty tall.' Click Run. The model — Gemma 4, four
> billion parameters, fine-tuned on nine hundred building examples —
> emits replicad source, the page executes it in a worker, OpenCascade
> meshes it, and three.js renders. **No server.** All in this tab."

> "Drag the length slider. The geometry rebuilds without re-running
> the model — the parameters are exposed automatically. Drag height.
> Same. Click Export IFC. That file opens in Revit, ArchiCAD,
> BlenderBIM. The same software the architect across town pays
> three grand a year to use."

**Cut beat:** the **Export IFC** click and the browser download
notification. Hard cut at 1:00.

---

## 1:00 — 1:40 — Demo 2: Slab with hole (boolean cut + variation)

**Screen:**
1. Switch dropdown to **Raised slab with stair hole**.
2. Click **Run**. Slab + cut renders.
3. Drag **slab\_length** slider from 6.0m → 8.0m. Stair hole moves
   with it (kept at back-left corner, parameterized).
4. Drag **hole\_size** slider from 1.2m → 1.6m.
5. Click **Export IFC**. Browser downloads `raised-slab.ifc`.

**VO (40s budget):**

> "Second demo: a slab with a square hole — a stair void. The model
> emitted a draw-rectangle, sketch-on-XY-plane, extrude, and a cut
> against a smaller rectangle. Twelve operations covering eighty-five
> percent of what a small-shop architect produces in schematic
> design — walls, slabs, columns, footings, openings, L-shape and
> U-shape footprints."

> "Drag length. The hole stays at the back-left corner because that's
> what the prompt said. Drag the hole size. Live recompute. Export.
> A real IFC4 STEP-21 file with one Building Element Proxy, one
> Faceted Brep, one Closed Shell — round-tripped through web-ifc
> on the way out."

**Cut beat:** the parameter slider drag + IFC download. Hard cut at 1:40.

---

## 1:40 — 2:30 — Demo 3: Four-walled room (multi-element)

**Screen:**
1. Switch to **Four-walled room**.
2. Click **Run**. Four walls render as a fused compound.
3. Orbit the viewer with mouse drag — show the room from inside +
   outside. ~6s of camera work.
4. Drag **width** slider 4.6 → 6.0m. The whole footprint scales.
5. Click **Export IFC**. Download.

**VO (50s budget):**

> "Third demo: a four-walled room. Four walls fused into one solid
> compound. Each wall is its own draw-rectangle / sketch / extrude;
> a translate places it; a fuse merges them. The model wrote the
> coordination — corners, orientations — by itself."

> "Orbit the viewer. The geometry is real OpenCascade BREP, not a
> texture. Drag the width slider — every wall re-positions in
> dependency order. Export the IFC. Open it in BlenderBIM, in
> Revit, in any other BIM tool. The same file."

> "Eight canned demos ship in the page; all eight pass a
> structural validator that runs the same code path the worker
> uses, then validates the IFC4 STEP-21 against schema, face-count,
> and entity count."

**Cut beat:** orbit-frame settling on the rendered room. Hard cut at 2:30.

---

## 2:30 — 3:00 — Closing + CTA

**Screen:**
1. Cut to a static screenshot grid: 3 demos × (prompt | rendered geometry
   | IFC opened in BlenderBIM). 9-pane grid, 4s.
2. Cut to a black title card. Three lines of text overlay:
   - `github.com/wordingone/gemma-architect`
   - `huggingface.co/gemma-architect/cad-lora-v2`
   - `kaggle.com/competitions/gemma-4-good-hackathon` (or wherever the
     submission lands)
3. Hold the title card to 3:00.

**VO (28 words, ~28s):**

> "Apache-2.0 LoRA on Gemma-3-4b-it. Nine hundred training pairs.
> Forty held-out evals — one hundred percent round-trip pass.
> Repo on GitHub. Adapter on Hugging Face. **Try it.** This page
> works on a Chromebook."

**End:** hard cut to black at 3:00.

---

## Production notes

- **Recording**: OBS at 1920×1080 / 30 fps. Disable browser extensions.
  Use a clean Chrome profile (no toolbars, no bookmarks bar).
- **Audio**: voice-over recorded separately (Audacity, single take per
  cut). Normalize to −16 LUFS. Add a 200ms fade at every cut boundary.
- **Cursor**: large-cursor mode + cursor highlight enabled. Slow,
  deliberate motion — judges need to see what's clicked.
- **Slider drags**: drag at human speed, not snapped. Pause briefly
  at the new value so the geometry update is visible (~300ms).
- **Browser zoom**: 110% so prompt text + JS source are legible at
  1080p.
- **Demo prep**: pre-load the page once before recording so the OC
  WASM is cached. `OpenCascade ready.` should appear in <1s on the
  recorded take.
- **Export IFC**: keep the default Downloads folder visible at the
  bottom of frame so the file appearing is on-camera.
- **No cuts mid-VO line.** Lines align to cut beats.
- **Captions**: burn in English captions for accessibility.
  Auto-generate, hand-edit pass for jargon (`replicad`, `OpenCascade`,
  `BREP`, `IFC4`, `Faceted Brep`, `Closed Shell`).

---

## Assets to gather before shooting

- [ ] BlenderBIM screenshots of the 3 exported IFC files (load each,
      orbit, screenshot at the same camera angle as the in-browser
      viewer — for the 9-pane closing grid).
- [ ] Title card PNG at 1920×1080 (black background, white sans-serif,
      three URLs centered).
- [ ] Outro 200ms fade-to-black overlay (single black PNG with alpha
      ramp).
- [ ] Backup recording of the page on Edge in case Chrome glitches
      day-of (same demo path; only narration changes if Edge UI
      differs).

---

## Word count + pacing

| Cut | Words | Seconds | WPM |
| :-: | :---: | :-----: | :-: |
| 0:00–0:20 hook | 50 | 20 | 150 |
| 0:20–1:00 wall | 110 | 40 | 165 |
| 1:00–1:40 slab+hole | 100 | 40 | 150 |
| 1:40–2:30 room | 110 | 50 | 132 |
| 2:30–3:00 CTA | 38 | 30 | 76 (slower for emphasis) |
| **Total** | **408** | **180** | **136 avg** |

136 WPM is conversational, leaves room for breath at cuts, and
matches the deliberate-slider pacing on screen. If the take feels
rushed, drop the third "twelve operations covering eighty-five
percent..." line in cut 2 — it's the densest sentence and the most
expendable.

---

## Sub-gate close

This script + the recorded video close **sub-gate 4** ("3-min demo
video shipped") of `docs/plan-18-day.md`. The shooting day is
2026-05-11 per the plan; buffer through 5/16 if a re-shoot is needed.
