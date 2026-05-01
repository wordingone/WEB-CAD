# Sample training pairs — format comparison

5 hand-written pairs in both candidate formats. Pre-spike validation:
which format produces cleaner, less ambiguous training data?

Format (a) = tool-call JSON
Format (b) = fluent replicad JS source

Both validated against the actual replicad API surface (per #87
follow-up agent verdict).

---

## Pair 1 — simple wall

**NL prompt:**
> Build a 5-meter long wall, 0.2 meters thick and 3 meters tall.

**Format (a) JSON:**
```json
{
  "ops": [
    {"tool": "drawRectangle", "args": {"width": 5, "height": 0.2}},
    {"tool": "sketchOnPlane", "args": {"plane": "XY"}},
    {"tool": "extrude", "args": {"distance": 3}}
  ]
}
```

**Format (b) fluent JS:**
```js
const wall = drawRectangle(5, 0.2)
  .sketchOnPlane("XY")
  .extrude(3);
```

---

## Pair 2 — circular column

**NL prompt:**
> Place a cylindrical column at position (2, 4, 0), 0.3 meters radius and 4 meters tall.

**Format (a):**
```json
{
  "ops": [
    {"tool": "drawCircle", "args": {"radius": 0.3}},
    {"tool": "sketchOnPlane", "args": {"plane": "XY"}},
    {"tool": "extrude", "args": {"distance": 4}},
    {"tool": "translate", "args": {"vector": [2, 4, 0]}}
  ]
}
```

**Format (b):**
```js
const column = drawCircle(0.3)
  .sketchOnPlane("XY")
  .extrude(4)
  .translate([2, 4, 0]);
```

---

## Pair 3 — wall with door opening

**NL prompt:**
> Make a 6m wall, 0.2m thick, 3m tall, with a 1m wide × 2.1m tall door opening centered along its length.

**Format (a):**
```json
{
  "ops": [
    {"id": "wall_solid", "tool": "drawRectangle", "args": {"width": 6, "height": 0.2}},
    {"tool": "sketchOnPlane", "args": {"plane": "XY"}},
    {"tool": "extrude", "args": {"distance": 3}},
    {"id": "door_void", "tool": "drawRectangle", "args": {"width": 1, "height": 0.2}},
    {"tool": "sketchOnPlane", "args": {"plane": "XY"}},
    {"tool": "extrude", "args": {"distance": 2.1}},
    {"tool": "translate", "args": {"vector": [3, 0, 0]}},
    {"tool": "cut", "args": {"target": "wall_solid", "tool": "door_void"}}
  ]
}
```

**Format (b):**
```js
const wall = drawRectangle(6, 0.2).sketchOnPlane("XY").extrude(3);
const door = drawRectangle(1, 0.2)
  .sketchOnPlane("XY")
  .extrude(2.1)
  .translate([3, 0, 0]);
const wallWithDoor = wall.cut(door);
```

---

## Pair 4 — slab

**NL prompt:**
> Add a flat floor slab, 8m by 6m by 0.15m thick, at ground level.

**Format (a):**
```json
{
  "ops": [
    {"tool": "drawRectangle", "args": {"width": 8, "height": 6}},
    {"tool": "sketchOnPlane", "args": {"plane": "XY"}},
    {"tool": "extrude", "args": {"distance": 0.15}}
  ]
}
```

**Format (b):**
```js
const slab = drawRectangle(8, 6)
  .sketchOnPlane("XY")
  .extrude(0.15);
```

---

## Pair 5 — revolved column (capital + shaft)

**NL prompt:**
> Make a Doric-style column: a 5m tall cylindrical shaft of radius 0.4m, with a square plinth 0.5m on each side and 0.2m tall at the base, and a square abacus the same dimensions at the top.

**Format (a):**
```json
{
  "ops": [
    {"id": "plinth", "tool": "drawRectangle", "args": {"width": 0.5, "height": 0.5}},
    {"tool": "sketchOnPlane", "args": {"plane": "XY"}},
    {"tool": "extrude", "args": {"distance": 0.2}},
    {"id": "shaft", "tool": "drawCircle", "args": {"radius": 0.4}},
    {"tool": "sketchOnPlane", "args": {"plane": "XY"}},
    {"tool": "extrude", "args": {"distance": 5}},
    {"tool": "translate", "args": {"vector": [0, 0, 0.2]}},
    {"id": "abacus", "tool": "drawRectangle", "args": {"width": 0.5, "height": 0.5}},
    {"tool": "sketchOnPlane", "args": {"plane": "XY"}},
    {"tool": "extrude", "args": {"distance": 0.2}},
    {"tool": "translate", "args": {"vector": [0, 0, 5.2]}},
    {"tool": "fuse", "args": {"target": "plinth", "tool": "shaft"}},
    {"tool": "fuse", "args": {"tool": "abacus"}}
  ]
}
```

**Format (b):**
```js
const plinth = drawRectangle(0.5, 0.5).sketchOnPlane("XY").extrude(0.2);
const shaft = drawCircle(0.4).sketchOnPlane("XY").extrude(5).translate([0, 0, 0.2]);
const abacus = drawRectangle(0.5, 0.5).sketchOnPlane("XY").extrude(0.2).translate([0, 0, 5.2]);
const column = plinth.fuse(shaft).fuse(abacus);
```

---

## Comparison

### Format (a) JSON

**Pros:**
- Easier to validate syntactically (JSON parse + schema check).
- Tool/arg structure is explicit; no parser needed for execution.
- Maps 1:1 to tool-calling APIs; could plug into existing MCP infra.

**Cons:**
- Identifier handling is ugly. Pair 3+5 needed `id` fields and target/tool
  refs; Format (b) does this with JS variable names natively.
- Ops like `sketchOnPlane` produce intermediate state that doesn't map
  to a single arg — handled in (b) via the fluent chain.
- Verbose. Pair 5 in (a) is 16 ops + 4 ID refs; in (b) it's 4 lines.
- Loses Gemma's code priors — JSON-with-tool-name is not a strong
  pretraining distribution; fluent JS IS.

### Format (b) fluent JS

**Pros:**
- Compact. Pair 5 fits in 4 lines.
- Variable names = identifiers; chains = composition. Natural.
- Strong pretraining distribution; Gemma should learn this fast.
- Round-trips trivially via `eval` (in sandboxed worker) or
  babel/typescript parser + AST execution.

**Cons:**
- Free-form code. Could emit syntactically-valid JS that doesn't match
  replicad's API. Need a wrapper that catches `ReferenceError` and
  classifies as "valid syntax / invalid API" vs "invalid syntax."
- No structured args — model could write `extrude(3, undefined, "foo")`
  and parse fine. (Mitigation: TypeScript type-check pass on emitted
  code before execution.)

### Verdict

**Use Format (b) fluent JS.** Format (a) wins on validation simplicity;
Format (b) wins on every other axis including the load-bearing one
(model learning speed under 18-day budget). Mitigate (b)'s
loose-validation downside by:
1. Sandbox-eval each emitted sequence.
2. Capture syntax errors → "invalid_syntax" reason code.
3. Capture ReferenceError on undefined symbols → "unknown_api" reason.
4. Capture TypeError on bad arg types → "invalid_args" reason.
5. Capture replicad-side throws (e.g., extrude on non-closed sketch) →
   "geometry_error" reason.

Spike A pass criteria translate to: ≥30/50 emitted sequences
syntactically valid (no SyntaxError), ≥20/50 produce non-empty geometry
when executed.

## Format-locking decision logged

This file is the canonical decision artifact for "fluent JS vs JSON
tool-call". Reference from the formal 18-day plan once written (#98).

If Spike A drops below ≥15/50 syntactic-validity, revisit and consider
Format (a) as fallback. That threshold is half the floor — strong
signal that fluent JS isn't working at all, not just the model needing
more examples.
