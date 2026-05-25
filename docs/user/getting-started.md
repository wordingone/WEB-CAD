# Getting Started — WEB-CAD

## Open the app

Go to https://wordingone.github.io/WEB-CAD/ in Chrome or Edge (113+). No account, no install.

If the AI agent is slow on first load, it is downloading the Gemma 4 model (~1 GB) in the background. The geometry tools work immediately while it loads.

## The interface

```
┌─────────────────────────────────────────────────────┐
│  [Toolbar: File / Export / Cmd-K / mode switcher]   │
├────────┬────────────────────────────┬────────────────┤
│Palette │                            │  Scene panel   │
│        │      3D Viewport           │  (hierarchy)   │
│Wall    │                            │                │
│Slab    │                            ├────────────────┤
│Column  │                            │  Chat / AI     │
│…       │                            │  agent         │
└────────┴────────────────────────────┴────────────────┘
│  Status bar                                          │
└─────────────────────────────────────────────────────┘
```

## Draw something

1. Click **Wall** in the left palette.
2. Click two points in the viewport — start point, end point.
3. The wall appears. You're back in Select mode.

Other tools work the same way: click the tool, click in the viewport.

## Use the AI agent

1. Open the **Chat** panel (bottom-right, or press `Cmd-K` and type a prompt).
2. Type: `add a 4m × 3m room with 2.8m walls and a flat roof`
3. Press Enter. The agent dispatches geometry commands; the scene updates.

The agent understands natural language for most schematic-design operations. For precise control, use the palette tools directly.

## Import a file

Drag any of these onto the page:

| Format | Notes |
|---|---|
| `.ifc` | IFC2×3 or IFC4; web-ifc parser (may take a few seconds for large files) |
| `.step` / `.stp` | Via OpenCascade WASM |
| `.glb` / `.gltf` | Three.js loader |
| `.obj` | Three.js loader |
| `.stl` | Three.js loader |

Or use **File → Open** in the toolbar.

## Export

Click **Export** in the toolbar. Choose a format:

| Format | Use when |
|---|---|
| IFC4 | Sending to Revit, ArchiCAD, BlenderBIM, any BIM tool |
| GLB | Web viewers, Blender, general 3D |
| OBJ | Legacy 3D tools |
| STL | 3D printing |
| STEP | Mechanical CAD, precision geometry |
| 3DM | Rhino |
| SVG / DXF / PDF | 2D drawings (use Layout mode first) |

## Undo / redo

`Ctrl+Z` / `Cmd+Z` to undo. `Ctrl+Y` or `Ctrl+Shift+Z` to redo.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `1` | Front view |
| `3` | Right view |
| `7` | Top view |
| `9` | Iso view |
| `F` / `5` | Zoom extents |
| `D` | Toggle drafting style |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Cmd-K` | Command palette |
| `Ctrl+E` | Open export drawer |

## Session restore

WEB-CAD auto-saves your scene to the browser's IndexedDB every 2 seconds after a change and every 60 seconds as a heartbeat. If you close the tab and reopen, it offers to restore your last session.
