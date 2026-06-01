---
name: rhino-cleanup
description: "Clean up a Rhino document: layer hygiene, material consolidation, duplicate detection. Uses RhinoMCP run_python. Requires Rhino 8.29 + MCPStart."
allowed-tools: Bash
disable-model-invocation: false
user-invocable: true
---

# Rhino Cleanup

Three cleanup operations: layer hygiene, material standardization, duplicate detection.

## Layer hygiene

```
/rhino-cleanup layers
```

```python
import Rhino

changes = []
for layer in __rhino_doc__.Layers:
    old = layer.Name
    new = old.title()  # Title Case
    if new != old:
        layer.Name = new
        changes.append({"from": old, "to": new})

# Delete empty layers (no objects, no children)
empty = []
for layer in __rhino_doc__.Layers:
    obj_count = __rhino_doc__.Objects.CountObjectsOnLayer(layer.Index, True)
    child_count = len(__rhino_doc__.Layers.FindChildren(layer.Index))
    if obj_count == 0 and child_count == 0 and not layer.IsDeleted:
        if __rhino_doc__.Layers.Delete(layer.Index, True):
            empty.append(layer.FullPath)

print({"renamed": changes, "deleted_empty": empty})
```

Report changes before applying if `--dry-run` is passed.

## Standardize materials

```
/rhino-cleanup materials
```

```python
import Rhino

# Group objects by render color
color_groups = {}
for obj in __rhino_doc__.Objects:
    color = str(obj.RenderMaterial.SimulatedMaterial(Rhino.Render.RenderTexture.TextureGeneration.Allow).Diffuse)
    color_groups.setdefault(color, []).append(str(obj.Id))

# For groups of 2+: create a named material, assign all
consolidated = []
for color, ids in color_groups.items():
    if len(ids) > 1:
        # create named material with this color
        consolidated.append({"color": color, "object_count": len(ids)})

print({"color_groups": len(color_groups), "consolidatable": consolidated})
```

## Find duplicates

```
/rhino-cleanup duplicates
```

```python
import Rhino
import Rhino.Geometry as rg

seen = {}
dupes = []
for obj in __rhino_doc__.Objects:
    g = obj.Geometry
    if hasattr(g, 'GetBoundingBox'):
        bb = g.GetBoundingBox(True)
        key = f"{round(bb.Min.X,3)},{round(bb.Min.Y,3)},{round(bb.Min.Z,3)},{round(bb.Max.X,3)},{round(bb.Max.Y,3)},{round(bb.Max.Z,3)}"
        if key in seen:
            dupes.append(str(obj.Id))
        else:
            seen[key] = str(obj.Id)

# Move duplicates to "Duplicates" layer
if dupes:
    di = __rhino_doc__.Layers.FindName("Duplicates")
    if di is None:
        di_idx = __rhino_doc__.Layers.Add("Duplicates", System.Drawing.Color.Red)
    else:
        di_idx = di.Index
    for id_str in dupes:
        obj = __rhino_doc__.Objects.FindId(System.Guid(id_str))
        if obj:
            obj.Attributes.LayerIndex = di_idx
            obj.CommitChanges()

print({"duplicate_count": len(dupes), "moved_to_Duplicates": dupes[:10]})
```

## Usage

- Always report what WILL change before changing it (dry-run first, then confirm)
- `save_doc` to a temp path before destructive operations
