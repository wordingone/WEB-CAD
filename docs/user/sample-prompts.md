# Sample Prompts — WEB-CAD AI Agent

The AI agent understands natural-language descriptions of architectural geometry. These prompts work reliably with the in-browser Gemma 4 model.

## Walls and rooms

```
a wall 5m long, 0.2m thick, 2.8m tall
```

```
a 4m × 3m room with 2.8m walls, open top
```

```
an L-shaped wall, each arm 4m long, 0.2m thick, 3m tall
```

```
four walls forming a 6m × 4m enclosure, 3m tall
```

## Slabs and floors

```
a 6m × 4m concrete slab, 0.2m thick, at ground level
```

```
a raised slab 4m × 3m at elevation 3m
```

## Structural

```
a 0.3m square column, 3m tall, at position (2, 2)
```

```
a steel beam 6m long spanning the room at 3m elevation
```

## Roofs

```
a gabled roof over a 6m × 4m footprint, 30-degree pitch
```

```
a flat roof 6m × 4m at elevation 3m
```

```
a hip roof over a 5m × 4m footprint with 0.5m overhang
```

## Openings

```
a door 0.9m wide, 2.1m tall, centered in the south wall
```

```
a window 1.2m wide, 1.2m tall at sill height 0.9m
```

## Levels / storeys

```
add a second floor level at elevation 3.2m called "Level 2"
```

```
move the selected wall to Level 2
```

## Multi-element scenes

```
a two-storey house: ground floor 6m × 4m × 3m, upper floor 6m × 4m × 2.8m with a gabled roof
```

```
the Schultz Residence — a 14-element L-shaped house with walls, slabs, and openings
```
(Use Cmd-K → type "schultz" for the bundled Schultz hero demo.)

## View and selection

```
zoom to extents
```

```
isolate the selected wall
```

```
list all objects in the scene
```

## Tips

- Be specific about dimensions and units. The model defaults to metres.
- If a prompt produces unexpected geometry, try breaking it into smaller steps.
- Use the **Console** tab (DSL) for precise numeric control without the AI model.
