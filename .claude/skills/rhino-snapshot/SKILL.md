---
name: rhino-snapshot
description: "Capture a Rhino viewport image and describe the scene. Uses RhinoMCP get_viewport_image. Requires Rhino 8.29 + MCPStart running."
allowed-tools: Bash
disable-model-invocation: false
user-invocable: true
---

# Rhino Snapshot

Capture the current Rhino viewport and describe what's visible. Requires:
- Rhino 8.29 running with `MCPStart` active (port 10500)
- `rhino` MCP server wired in `.mcp.json`

## Steps

1. Call `get_viewport_image` with these defaults (adjust args if the user specifies view/mode):
   - `width: 960, height: 540`
   - `view: "perspective"` (or use current active view)
   - `displayMode: "Shaded"`

2. Call `list_objects` to get object count and types.

3. Report:
   - Viewport image (display inline)
   - Scene summary: `{visibleObjectCount, totalObjectCount, boundingBox}` from viewport metadata
   - Object list (name, layer, type) from `list_objects`
   - Camera: location, target, lensLength

## Quick overrides

```
/rhino-snapshot top wireframe        → view=top displayMode=Wireframe
/rhino-snapshot perspective rendered → view=perspective displayMode=Rendered
/rhino-snapshot zoom <layer>         → call zoom_to_layer first, then snapshot
```

## GPU note

`Raytraced` display mode is expensive (full 4090 path). If a WEB-CAD model pass is running, do not use Raytraced — use `Rendered` instead. Serialize: finish one GPU-heavy task before starting the other.
