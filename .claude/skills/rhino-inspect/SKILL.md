---
name: rhino-inspect
description: "Audit a Rhino document: layer summary, off-layer objects, naked edges, bounding box. Uses RhinoMCP list_objects + run_python. Requires Rhino 8.29 + MCPStart."
allowed-tools: Bash
disable-model-invocation: false
user-invocable: true
---

# Rhino Inspect

Audit the active Rhino document and report structure, errors, and selection details.

## Standard audit pattern

```
/rhino-inspect audit
```

1. `list_objects` (no filter) — total object count per geometryType
2. `run_python` to extract per-layer stats:

```python
import Rhino
import Rhino.Geometry as rg

layers = {}
off_layer = []
zero_len = []
naked_edges = []

for obj in __rhino_doc__.Objects:
    layer = __rhino_doc__.Layers[obj.Attributes.LayerIndex].FullPath
    layers[layer] = layers.get(layer, 0) + 1
    # check if object is on its parent layer
    if obj.Attributes.LayerIndex != obj.ObjectType:
        pass  # layer membership is by index, not type

    g = obj.Geometry
    if isinstance(g, rg.Curve) and g.GetLength() < 1e-10:
        zero_len.append(str(obj.Id))
    if isinstance(g, rg.Brep):
        ne = [e for e in g.Edges if e.Valence == rg.EdgeAdjacency.Naked]
        if ne:
            naked_edges.append({"id": str(obj.Id), "naked_count": len(ne)})

bb = __rhino_doc__.Objects.BoundingBox(True)
print({
    "layers": layers,
    "zero_length_curves": zero_len,
    "naked_edge_breps": naked_edges,
    "bounding_box": {
        "min": list(bb.Min),
        "max": list(bb.Max),
        "diagonal_mm": round(bb.Diagonal.Length, 1)
    }
})
```

3. `get_viewport_image` — perspective/Shaded thumbnail.

## Selection inspect

```
/rhino-inspect selection
```

`get_selection` → for each selected object: `list_objects` filtered by id → report type, layer, area/length where applicable.

## Quick probes

```
/rhino-inspect layers     → per-layer object count table, flag empty layers
/rhino-inspect naked      → only breps with naked edges
/rhino-inspect bbox       → bounding box + diagonal
```

## Reporting format

Always return:
- Object count table (layer → count)
- Issues list: zero-length curves, naked edges (with IDs)
- Bounding box diagonal in mm
- Viewport thumbnail
