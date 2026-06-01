# RhinoMCP Reference

Complete capability surface for the McNeel RhinoMCP platform. Source: https://mcneel.github.io/RhinoMCP/ + github.com/mcneel/RhinoMCP (v0.1.3, 2026-05-29).

## Installation

```
# Inside Rhino 8: PackageManager → search "Rhino-MCP-Platform" → Install
# Or Yak CLI:
"C:\Program Files\Rhino 8\System\Yak.exe" install Rhino-MCP-Platform
```

Run `MCPStart` in Rhino (accepts port, default 10500). Run `MCPConnect` to get the `.mcp.json` snippet.

## MCP Config (Eli's live router)

```json
"rhino": {
  "type": "stdio",
  "command": "node",
  "args": ["B:/M/avir/rhino-mcp/shared/router-launcher.mjs", "--default-version", "8"]
}
```

Architecture: CC ↔ stdio router ↔ plugin HTTP JSON-RPC localhost:10500. SQLite slot state. Listener announcements in `%LOCALAPPDATA%\McNeel\rhino-mcp\listeners\`.

## Tool Catalog

### Core Rhino (Rhino 8+)

| Tool | ReadOnly | Key params |
|---|---|---|
| `get_commands` | yes | `filter?` (string) — use always; unfiltered = 1000+ |
| `list_objects` | yes | `names?`, `layer?`, `geometryType?`, `includeHidden`, `limit=1000` |
| `get_selection` | yes | — |
| `get_viewport_image` | yes | `width`, `height`, `view?`, `displayMode?`, `cameraLocation?`, `target?`, `boxMin?`, `boxMax?`, `zoom?` |
| `set_selection` | no | `ids?`, `names?`, `layer?`, `geometryType?` |
| `set_camera` | no | `location?`, `target?`, `up?`, `lensLength?`, `projection?`, `boxMin?`, `boxMax?` |
| `set_layer_material` | no | `layer`, `color?` (#RRGGBB), `transparency?` (0–1), `gloss?` (0–1) |
| `zoom_to_object` | no | `ids` |
| `zoom_to_layer` | no | `layer` |
| `run_command` | no | `command` (Rhino command string, e.g. `"_Box 0,0,0 10,10,10"`) |
| `run_python` | no | `script` — use `__rhino_doc__`, NOT `scriptcontext.doc` |
| `run_csharp` | no | `script` — use `__rhino_doc__`, NOT `RhinoDoc.ActiveDoc` |
| `open_doc` | no | `path` (abs), `clearFirst=false` |
| `save_doc` | no | `path` (abs .3dm) |
| `close_doc` | no | `path?` (save-path before close) |

**`get_viewport_image` display modes:** `Wireframe`, `Shaded`, `Rendered`, `Ghosted`, `X-Ray`, `Technical`, `Artistic`, `Pen`, `Monochrome`, `Arctic`, `Raytraced`

**`list_objects` geometryType values:** `point`, `pointset`, `curve`, `surface`, `brep`, `mesh`, `annotation`, `light`, `block`

**Scripting constraints:**
- `run_python` / `run_csharp`: doc is injected as `__rhino_doc__`. Do NOT use `scriptcontext.doc`, `rhinoscriptsyntax`, or `RhinoDoc.ActiveDoc` — they don't bind in the slot model.
- `run_command` fails if Rhino is mid-command. Use `run_python`/`run_csharp` for scripted geometry instead.

### Slot Management (multi-Rhino)

| Tool | Purpose |
|---|---|
| `spawn_slot` | Launch a new Rhino slot; `version?` = `"8"`, `"WIP"`, `"9"`; returns `{slot_id, port, pid}` |
| `close_slot` | Close a managed slot |

Pass `slot="<id>"` on any tool call to target a specific Rhino instance. Slot IDs are animal names.

### Grasshopper 1 (Rhino 8+)

| Tool | Purpose | Key params |
|---|---|---|
| `g1_start` | Start GH1 | — |
| `g1_clear_canvas` | Clear all components | `confirm=true` (required), `solve=true` |
| `g1_search_components` | Find components | `query`, `category?`, `subcategory?`, `limit` |
| `g1_describe_component` | Full I/O spec for a component | `name` (e.g. `"Addition"`, `"Number Slider"`) |
| `g1_place_component` | Place on canvas | `selector` (Guid or Name), `x`, `y`, `solve=true` |
| `g1_place_slider` | Place number slider | `min`, `value`, `max`, `x`, `y`, `type` (float/int/even/odd), `name?` |
| `g1_connect` | Wire one connection | `src_id`, `src` (index/name), `dst_id`, `dst`, `solve=true` |
| `g1_connect_many` | Wire batch | `wires: [{SrcId,Src,DstId,Dst}]`, `solve=true` |
| `g1_solve_graph` | Trigger solver | `zoom_views?` |
| `g1_get_canvas_graph` | Snapshot canvas | `include_data=false` |
| `g1_apply_graph` | Atomic batch build | `sliders[]`, `components[]`, `wires[]`, `solve=true` |

**`g1_apply_graph`** is the preferred tool — places all sliders + components + wires in ONE call using caller-supplied key strings, then solves once. Avoids round-trips.

**Selector disambiguation:** component `selector` = proxy Guid (unambiguous) OR Name string. Name ambiguity returns candidate list with Guids; retry with Guid.

**Canvas positions:** pixel coords on GH canvas (X, Y float). No auto-layout — caller manages layout.

### Grasshopper 2 (Rhino 9 WIP only)

Identical to g1_* tools, prefixed `g2_`. Differences:
- `g2_place_slider`: uses `decimals` (int 0–12) instead of `type`
- `g2_describe_component`: returns `chapter`/`info` instead of `Category`/`Description`
- `g2_connect`/`g2_connect_many`: uses UserName instead of NickName

## GPU / Rendering Notes

- `Raytraced` display mode is exposed in `get_viewport_image` but has no GPU warmup/wait.
- Rhino render + WEB-CAD WebGPU (4090) compete for VRAM — serialize heavy render passes.
- Cold-cache WEB-CAD model pass + Rhino Raytraced render simultaneously = VRAM pressure.

## Known Constraints

- Plugin won't load on .NET Framework or Intel-based Macs.
- Rhino 8.29 required (plugin install fails on 8.28).
- GH2 tools require Rhino 9 WIP; GH1 works on Rhino 8.
- `clear_canvas` requires `confirm=true` — safety guard.
