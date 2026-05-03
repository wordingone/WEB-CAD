---
name: replicate-from-video
version: 0.1.0
description: Watch a recorded screen workflow and emit an equivalent dispatch sequence.
keywords: [replicate, record, video, workflow, demo, screencast, replay, sequence, capture]
examples:
  - "replicate the workflow from this video"
  - "watch this recording and reproduce the same model"
  - "turn this screen capture into a tool dispatch sequence"
eval_id: skill-replicate-from-video-v01
---

## When to use

The prompt provides (or references) a recorded screen workflow — usually
an MP4 or WebM with synchronized tool-event metadata — and asks for an
equivalent dispatch sequence the agent can replay. Typical phrases:
"replicate this video", "watch the recording and reproduce the model",
"turn this demo into a sequence I can run".

Do NOT pick this skill for:
- live screen capture during a session (use the screen-watch skill, TBD),
- text-only descriptions of a workflow (use `room-from-prompt` or compose
  individual skills),
- pixel-only video without event metadata (out of scope — we don't OCR
  the cursor; the metadata channel is required).

## How it works

Each frame of the source recording carries a `dispatch` event with the
canonical tool name and arguments (per `docs/tool-taxonomy.md`). The
skill walks the event stream and emits the same dispatches in the same
order, substituting parameters from the new context if the prompt asks
for it (e.g., "do the same thing but at a 5×4 footprint").

```js
const events = await loadVideoEvents(videoUrl);   // [{tool, args, ts}, ...]
const overrides = parsePromptOverrides(prompt);   // partial<args>
const out = [];
for (const e of events) {
  out.push({
    tool: e.tool,
    args: { ...e.args, ...(overrides[e.tool] ?? {}) },
  });
}
return { dispatchSequence: out };
```

The skill is geometric only insofar as the underlying tools are — it does
NOT call replicad directly. Its output is a dispatch list the agent
harness re-issues.

## Examples

Prompt: "replicate the workflow from this video, but at a 5×4 footprint"

```js
const overrides = { "extrude-walls": { width: 5, depth: 4 } };
const events = await loadVideoEvents(videoUrl);
return {
  dispatchSequence: events.map((e) => ({
    tool: e.tool,
    args: { ...e.args, ...(overrides[e.tool] ?? {}) },
  })),
};
```

Prompt: "watch this and reproduce the same model"

```js
const events = await loadVideoEvents(videoUrl);
return { dispatchSequence: events.map((e) => ({ tool: e.tool, args: e.args })) };
```

## Failure modes

- Missing event metadata: video without the dispatch sidecar — refuse
  loudly. We do not OCR the recording; this is a deliberate scope cap.
- Tool-name drift: an event references a tool that no longer exists
  (deprecated). Map known renames; flag unknown tools as errors with
  the offending event index.
- Argument-schema drift: an event's `args` no longer match the current
  tool's parameter list. Diff against the current schema and report
  the gap; do not silently drop unknown fields.
- Override conflicts: the prompt asks to "double the size" but the
  recording also explicitly translates by absolute amounts — record
  both interpretations and surface them; do not auto-resolve.
- Long recordings: a 30-minute workflow may emit thousands of events.
  The dispatch sequence is bounded; refuse if it exceeds the per-session
  agent budget.
