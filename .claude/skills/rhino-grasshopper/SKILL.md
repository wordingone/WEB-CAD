---
name: rhino-grasshopper
description: "Build and run a Grasshopper 1 definition via RhinoMCP. Use g1_apply_graph for atomic builds. Requires Rhino 8.29 + GH1 + MCPStart."
allowed-tools: Bash
disable-model-invocation: false
user-invocable: true
---

# Rhino Grasshopper

Build Grasshopper 1 definitions programmatically via RhinoMCP's g1_* tools.

## Canonical workflow

1. `g1_start` — ensure GH1 is running
2. `g1_search_components` — find component by name/description (e.g. `query: "Box"`)
3. `g1_describe_component` — get exact I/O spec (Names, TypeNames, access modes)
4. `g1_apply_graph` — build entire definition in ONE call (preferred over iterative place+connect)
5. `get_viewport_image` — capture Rhino viewport to see GH output geometry

## g1_apply_graph format

```json
{
  "sliders": [
    { "key": "s_width",  "min": 0, "value": 10, "max": 50, "type": "float", "x": 0,   "y": 0 },
    { "key": "s_height", "min": 0, "value": 5,  "max": 30, "type": "float", "x": 0,   "y": 60 }
  ],
  "components": [
    { "key": "c_box", "selector": "Box", "x": 200, "y": 30 }
  ],
  "wires": [
    { "srcKey": "s_width",  "src": "0", "dstKey": "c_box", "dst": "X" },
    { "srcKey": "s_height", "src": "0", "dstKey": "c_box", "dst": "Z" }
  ],
  "solve": true
}
```

Keys (`s_width`, `c_box`) are caller-supplied labels — any string. No round-trip needed to discover Guids.

## Component selector disambiguation

- `selector` = component Name string (case-insensitive) OR proxy Guid
- If name is ambiguous (multiple matches), the tool returns a candidate list with Guids — retry with Guid
- Use `g1_describe_component` first to confirm the exact component name and I/O ports

## WEB-CAD Skills tab absorption

This skill produces geometry that can be ingested into WEB-CAD:
1. After `g1_apply_graph` + `g1_solve_graph`, Rhino's viewport has the GH output
2. Use `run_python` to bake the GH output to a doc layer (`__rhino_doc__.Objects.AddBrep(...)`)
3. `save_doc` → temp .3dm
4. WEB-CAD `SdImportRhino` (future verb) or `open_doc` brings it into the WEB-CAD scene

See `docs/grasshopper-skills-tab-design.md` for the full Grasshopper→Skills tab absorption design.

## Canvas layout tips

- GH canvas coordinates are pixels. Left-to-right data flow: sliders at x=0, components at x=200+, outputs at x=400+.
- Vertical separation: 60–80px per component row avoids port overlap.
- `g1_get_canvas_graph` to inspect current state; `g1_clear_canvas(confirm=true)` to reset.

## Rhino 8 vs 9 WIP

- All g1_* tools: Rhino 8 (GH1)
- All g2_* tools: Rhino 9 WIP only (GH2) — not available on current setup
