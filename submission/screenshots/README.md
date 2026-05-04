# Screenshot grid for the Kaggle post

The Kaggle write-up (`submission/writeup.md`) embeds a 3×3 screenshot
grid showing each of the three featured demos in three columns:
prompt → in-browser render → exported IFC opened in BlenderBIM.

Captured day-of from the production page (`bun run web:preview`) and
BlenderBIM (free, https://blenderbim.org/) using the IFC files the
**EXPORT → IFC4** drawer writes.

The three demos mirror `submission/demo-script.md` cuts 2/3/4:

1. **Wall** — cache hit on the chip-strip default, parametric sliders
   exercised live.
2. **Typed-from-scratch square column 3m** — judge types
   `Build a square column 0.3m by 0.3m, 3m tall.` into the PROMPT tab,
   `⌘⏎` fires; cache returns the exact match (F1 = 1.000 vs the
   `column-square-3m` corpus row, see `data/dsl-demo-corpus.jsonl`).
3. **Schultz Residence** — Cmd-K palette → "Schultz" → GENERATE.
   14-element multi-fuse + cuts; drafting-style toggle (`D`) flips
   solid → ink-wobble.

## Layout

```
┌──────────────────────┬──────────────────────┬──────────────────────┐
│ wall-prompt.png      │ wall-render.png      │ wall-bim.png         │
│ PROMPT tab + JS src  │ three.js viewer      │ wall.ifc in          │
│ + status `Ready ...` │ (Day mode, default)  │ BlenderBIM           │
├──────────────────────┼──────────────────────┼──────────────────────┤
│ column-3m-prompt.png │ column-3m-render.png │ column-3m-bim.png    │
│ PROMPT tab + emitted │ three.js viewer      │ column.ifc in        │
│ JS for column 3m     │ (Day mode, oblique)  │ BlenderBIM           │
├──────────────────────┼──────────────────────┼──────────────────────┤
│ schultz-prompt.png   │ schultz-drafting.png │ schultz-bim.png      │
│ PROMPT tab + 14-elem │ drafting-style       │ schultz.ifc in       │
│ Schultz JS           │ render (`D` toggle)  │ BlenderBIM           │
└──────────────────────┴──────────────────────┴──────────────────────┘
```

## Files (filled at submission time)

Filename convention: `{demo-id}-{stage}.png` where stage ∈ `prompt`,
`render` (or `drafting` for cut 4), `bim`. All PNGs at 1920×1080, sRGB,
no alpha.

- [ ] `wall-prompt.png` — page after picking **Wall** chip. PROMPT tab
      visible with the demo sentence. JS source mirror visible. Status
      `Ready (12 tris, 4.4 KB IFC).`
- [ ] `wall-render.png` — same view, three.js viewer in focus, wall
      rendered with default OrbitControls angle (auto-framed).
- [ ] `wall-bim.png` — `wall.ifc` opened in BlenderBIM, default
      perspective, no extra UI panels.
- [ ] `column-3m-prompt.png` — page with the typed-from-scratch prompt
      `Build a square column 0.3m by 0.3m, 3m tall.` in the PROMPT
      textarea. Console tab (if visible) shows
      `[ai-generate] cache · 1.00 match · ~50ms`.
- [ ] `column-3m-render.png` — three.js viewer of the 3m column,
      oblique perspective.
- [ ] `column-3m-bim.png` — `column.ifc` in BlenderBIM, oblique view.
- [ ] `schultz-prompt.png` — page after Cmd-K palette → "Schultz" →
      GENERATE. PROMPT textarea full of the Schultz sentence; JS source
      shows the 14 const lines.
- [ ] `schultz-drafting.png` — viewer flipped to drafting style via
      the `D` keystroke. Same Schultz geometry rendered as
      ink-wobble + paper layer.
- [ ] `schultz-bim.png` — `schultz.ifc` in BlenderBIM. Floor slab,
      four walls (with door + window cuts), interior partition, two
      corner columns, roof slab — all visible as IFC entities.

## Capture procedure

For each row:

1. Open the page in a clean Chrome profile at 110% zoom on a 1920×1080
   display. No extensions, no bookmarks bar. Confirm Day mode is on
   (top-bar mode toggle).
2. **Cut 1 (Wall):** click the **Wall · 5.5×0.2×2.8m** chip in the
   PROMPT tab's chip strip. Click **GENERATE** (or `⌘⏎`). Wait for
   status `Ready (...)`.
3. **Cut 2 (Column 3m):** click in the PROMPT textarea, select-all +
   delete, type `Build a square column 0.3m by 0.3m, 3m tall.`,
   `⌘⏎`. Cache returns the matched row in ~50 ms.
4. **Cut 3 (Schultz):** `⌘K` → type "Schultz" → Enter. PROMPT fills
   with the long sentence + JS fills with 14 const lines. Click
   **GENERATE**. Drafting-render: press `D` (toggles solid →
   ink-wobble; press `D` again to revert if needed).
5. Take prompt screenshot: full window, PROMPT tab + JS source mirror
   + status line all visible.
6. Hover the viewer pane. OrbitControls auto-frame fires after the
   first interaction. Take render screenshot.
7. Click **EXPORT** (or `⌘E`) → **IFC4** tile. File downloads to the
   profile's Downloads folder.
8. Open BlenderBIM (any version on the BlenderBIM download page).
   `File → Open IFC Project → <demo>.ifc`. Wait for parse.
9. Frame the geometry: oblique for wall + column + Schultz so all
   pieces are visible.
10. Take BIM screenshot of the BlenderBIM viewport, full window.
11. Save with the filename convention above.

## Compositing for the Kaggle post

The 3×3 grid is composited at submission time (single PNG, 5760×3240
or smaller for upload limits). ImageMagick command:

```bash
magick montage \
  wall-prompt.png wall-render.png wall-bim.png \
  column-3m-prompt.png column-3m-render.png column-3m-bim.png \
  schultz-prompt.png schultz-drafting.png schultz-bim.png \
  -tile 3x3 -geometry 1920x1080+8+8 grid.png
```

Then `pngquant grid.png --quality=70-85` to fit Kaggle's upload size.

## Status

Stub directory committed to make the README reference resolve. The
PNGs already in this directory (e.g. `four-walled-room-rendered.png`,
`v2-four-walled-room-1920x1080.png`) are pre-bundle-port artifacts
from May 1 — kept for historical reference; not the day-of-shoot
captures. Final PNGs filled in per `submission/demo-script.md` shoot
plan.
