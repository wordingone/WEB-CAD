# Screenshot grid for the Kaggle post

Captured 2026-05-04 from the live deployed page
(https://wordingone.github.io/gemma-architect/) via Playwright at
1920×1080. The shots cover the demo-script.md narrative arc — wall
demo + Schultz Residence hero + chrome surfaces (EXPORT drawer,
Cmd-K palette, PARAMETERS tab).

## Files captured

| File | Commit | What it shows |
|------|--------|--------------|
| `01-prompt-wall.png`        | 9c7c0be | PROMPT tab — wall chip loaded, demo sentence filled, GENERATE ready |
| `02-wall-rendered.png`      | 9c7c0be | Wall (12 tri) rendered solid — title block + SCENE panel visible |
| `03-console-cache.png`      | 9c7c0be | CONSOLE tab — init sequence + DSL ready prompt |
| `04-schultz-solid.png`      | 725b56a | Schultz Residence (14-element multi-fuse) — south 3/4 angle, doorway cut visible, solid shading |
| `05-schultz-drafting.png`   | 725b56a | Same angle, `D`-key toggled — flat-white drafting render with edge lines, doorway cut prominent |
| `06-export-drawer.png`      | 9c7c0be | EXPORT drawer open — 12 tiles (IFC/STEP/DXF / OBJ/STL/GLB/gLTF/USDZ / SVG/DXF/PDF) |
| `07-cmdk-palette.png`       | 9c7c0be | ⌘K palette open — full command list (GENERATE / MODEL / VIEW groups, kbd shortcuts) |
| `08-cmdk-schultz.png`       | 9c7c0be | ⌘K with "Schultz" typed — filtered to single "Schultz Residence (14 elements)" entry |
| `09-parameters-sliders.png` | 9c7c0be | PARAMETERS tab — wall sliders (5.5 / 0.2 / 2.8m values visible) |

`live-demo-2026-05-04.png` is a wider initial capture kept for reference;
the 9 numbered shots are the canonical embed set.

ai-cache.json verified live at 60 rows as of `a59a8a3` (the
`column-square-3m` corpus row that demo-script.md cut 2 depends on
for an exact F1=1.000 cache hit is restored).

## Pending (manual capture pre-grid-composite)

BlenderBIM column (3 shots) — judges-facing proof that exported IFC4
files load cleanly in a real BIM tool:

- [ ] `wall-bim.png` — `wall.ifc` opened in BlenderBIM, default
      perspective, no extra UI panels.
- [ ] `column-3m-bim.png` — `column.ifc` (typed-from-scratch column
      demo's IFC export) in BlenderBIM, oblique view.
- [ ] `schultz-bim.png` — `schultz.ifc` in BlenderBIM. Floor slab,
      four walls (with doorway + window cuts), interior partition,
      two corner columns, roof slab — all visible as IFC entities.

Capture procedure: install BlenderBIM
(https://blenderbim.org/, free), File → Open IFC Project, select
the IFC the EXPORT drawer wrote, frame oblique, screenshot at
1920×1080.

## Composition for the Kaggle post

Once all 12 shots are ready (9 web + 3 BIM), compose a 3×4 grid
(3 demos × 4 stages: prompt + web-render + drafting + BIM):

```bash
magick montage \
  01-prompt-wall.png 02-wall-rendered.png ANY-DRAFTING-WALL wall-bim.png \
  PROMPT-COLUMN RENDER-COLUMN DRAFT-COLUMN column-3m-bim.png \
  04-schultz-solid.png 05-schultz-drafting.png 08-cmdk-schultz.png schultz-bim.png \
  -tile 4x3 -geometry 1920x1080+8+8 grid.png
```

Then `pngquant grid.png --quality=70-85` to fit Kaggle's upload size.

The cut-2 (typed-from-scratch column) prompt+render shots are NOT in
the current 9-set — they were skipped in the first capture pass per
the demo-script narrative arc choice. Capture them alongside the
BlenderBIM column or simplify the grid to a 3×3 wall+Schultz+chrome
layout.
