---
name: rhino-geometry
description: "Run a Rhino geometry script via run_python, capture viewport, and optionally import result into WEB-CAD. Uses RhinoMCP. Requires Rhino 8.29 + MCPStart."
allowed-tools: Bash
disable-model-invocation: false
user-invocable: true
---

# Rhino Geometry

Create geometry in Rhino via `run_python` (preferred over `run_command` for scripted work), capture the result, and optionally export a .3dm for WEB-CAD import.

## Rules

- ALWAYS use `__rhino_doc__` as the document handle — NOT `scriptcontext.doc`, `rhinoscriptsyntax`, or `RhinoDoc.ActiveDoc`. Those fail in the slot model.
- Use `run_python` for scripted geometry. Use `run_command` only for interactive Rhino commands (and never when Rhino is mid-command — use `run_python` instead).
- Capture with `get_viewport_image` after geometry is created.

## Standard pattern

```python
# Example: create a box
import Rhino
import Rhino.Geometry as rg

pt_min = rg.Point3d(0, 0, 0)
pt_max = rg.Point3d(10, 10, 5)
box = rg.Box(rg.BoundingBox(pt_min, pt_max))
brep = box.ToBrep()

attr = Rhino.DocObjects.ObjectAttributes()
attr.Name = "box-001"
__rhino_doc__.Objects.AddBrep(brep, attr)
__rhino_doc__.Views.Redraw()
print("ok: box added")
```

After `run_python`:
1. `list_objects` to confirm geometry is present
2. `get_viewport_image` to capture (view="perspective", displayMode="Shaded")
3. If import to WEB-CAD requested: `save_doc` to a temp path → present the path for WEB-CAD `open_doc`

## Parity-check pattern (S1–S14)

Use this to produce reference geometry for WEB-CAD kernel parity verification:
1. Run operation in Rhino via `run_python` (e.g., fillet an edge)
2. `save_doc` to `B:/M/avir/rhino-mcp/state/ref-<op>.3dm`
3. Parse the .3dm / compare output with WEB-CAD kern for the same op
4. `get_viewport_image(displayMode="Technical")` for visual diff

## GPU note

Heavy Rhino renders (Raytraced, full-scene) compete with WEB-CAD's WebGPU for 4090 VRAM. Run them sequentially, not concurrently.
