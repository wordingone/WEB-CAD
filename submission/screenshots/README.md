# Screenshot grid for the Kaggle post

The Kaggle write-up (`submission/writeup.md`) embeds a 3×3 screenshot
grid showing each of the three featured demos in three columns:
prompt → in-browser render → exported IFC opened in BlenderBIM.

Captured day-of from the production page (`bun run web:preview`) and
BlenderBIM (free, https://blenderbim.org/) using the IFC files the
**Export IFC** button writes.

## Layout

```
┌──────────────────────┬──────────────────────┬──────────────────────┐
│ wall.png             │ wall-render.png      │ wall-bim.png         │
│ prompt + emitted JS  │ three.js viewer      │ wall.ifc in          │
│                      │                      │ BlenderBIM           │
├──────────────────────┼──────────────────────┼──────────────────────┤
│ slab-with-hole.png   │ slab-with-hole-      │ slab-with-hole-      │
│ prompt + emitted JS  │ render.png           │ bim.png              │
│                      │ three.js viewer      │ raised-slab.ifc in   │
│                      │                      │ BlenderBIM           │
├──────────────────────┼──────────────────────┼──────────────────────┤
│ four-walled-room.png │ four-walled-room-    │ four-walled-room-    │
│ prompt + emitted JS  │ render.png           │ bim.png              │
│                      │ three.js viewer      │ four-walled-         │
│                      │                      │ room.ifc in          │
│                      │                      │ BlenderBIM           │
└──────────────────────┴──────────────────────┴──────────────────────┘
```

## Files (filled at submission time)

Filename convention: `{demo-id}-{stage}.png` where stage ∈ `prompt`,
`render`, `bim`. All PNGs at 1920×1080, sRGB, no alpha.

- [ ] `wall-prompt.png` — page after picking **Wall** demo, prompt + JS
      visible, status `Ready (12 tris, 4.4 KB IFC).`
- [ ] `wall-render.png` — same view, three.js viewer in focus, wall
      rendered with default OrbitControls angle.
- [ ] `wall-bim.png` — `wall.ifc` opened in BlenderBIM, default
      perspective, no extra UI panels.
- [ ] `slab-with-hole-prompt.png` — page after picking **Raised slab
      with stair hole** demo.
- [ ] `slab-with-hole-render.png` — three.js viewer of the slab + hole.
- [ ] `slab-with-hole-bim.png` — `raised-slab.ifc` in BlenderBIM
      (top-down view recommended so the hole is visible).
- [ ] `four-walled-room-prompt.png` — page after picking
      **Four-walled room** demo.
- [ ] `four-walled-room-render.png` — three.js viewer, oblique
      perspective so all four walls are visible.
- [ ] `four-walled-room-bim.png` — `four-walled-room.ifc` in
      BlenderBIM, oblique view.

## Capture procedure

For each row:

1. Open the page in a clean Chrome profile at 110% zoom on a 1920×1080
   display. No extensions, no bookmarks bar.
2. Pick the demo from the dropdown. Click **Run**. Wait for status
   `Ready (...)`.
3. Take prompt screenshot: full window, both prompt and emitted JS
   visible, status line included.
4. Hover the viewer pane. OrbitControls auto-frame fires after the
   first interaction. Take render screenshot.
5. Click **Export IFC**. File downloads.
6. Open BlenderBIM (any version on the BlenderBIM download page).
   `File → Open IFC Project → <demo>.ifc`. Wait for parse.
7. Frame the geometry: top-down for the slab, oblique for the others.
8. Take BIM screenshot of the BlenderBIM viewport, full window.
9. Save with the filename convention above.

## Compositing for the Kaggle post

The 3×3 grid is composited at submission time (single PNG, 5760×3240
or smaller for upload limits). ImageMagick command:

```bash
magick montage \
  wall-prompt.png wall-render.png wall-bim.png \
  slab-with-hole-prompt.png slab-with-hole-render.png slab-with-hole-bim.png \
  four-walled-room-prompt.png four-walled-room-render.png four-walled-room-bim.png \
  -tile 3x3 -geometry 1920x1080+8+8 grid.png
```

Then `pngquant grid.png --quality=70-85` to fit Kaggle's upload size.

## Status

Stub directory committed to make the README reference resolve. PNGs
filled in at submission day per [`submission/demo-script.md`](../demo-script.md).
