# WEB-CAD Agent Behavior Guide

Guidance for Claude Code agents using the `webcad` MCP server (`tools/mcp/webcad-mcp.mjs`).

---

## Tool reference

| Tool | Description | Browser lock? |
|------|-------------|:---:|
| `slot_create` | Spawn a dedicated isolated WEB-CAD session (separate Chromium, separate user-data-dir) | No |
| `slot_list` | List active slots and dedicated browser status | No |
| `slot_close` | Close a slot; kills dedicated browser when last slot closes | No |
| `dispatch` | Execute a geometry verb on the WEB-CAD page | No |
| `list_verbs` | Browse 323 verbs across 21 categories | No |
| `get_verb_schema` | Get full parameter schema for a verb | No |
| `get_viewport_image` | Capture viewport PNG (requires lock on the default `:9222` tab) | :9222 only |
| `list_scene_objects` | List all scene objects (UUIDs, names, types, layers) | No |

---

## Behavior rules

### No cursor hijack

`dispatch`, `list_scene_objects`, and `list_verbs` evaluate JavaScript via CDP. They do not
move the cursor, steal focus, or alter window z-order. The user's active window is undisturbed.

`get_viewport_image` on the default `:9222` tab calls `Page.captureScreenshot`, which may
require the page to be visible. Use the lock protocol below.

### No parallel dispatch

`window.__wcDispatch` is not re-entrant. Do not issue concurrent `dispatch` calls to the same
tab. For genuinely parallel work, create isolated slots (`slot_create`) and dispatch to each
slot independently.

### Browser lock protocol (`:9222` tab only)

When calling `get_viewport_image` **without** a `slotId` (targeting the shared user browser):

1. Mail `BROWSER LOCKED` before the call.
2. Call `get_viewport_image`.
3. Mail `BROWSER RELEASED` immediately after, regardless of success or failure.

Slot-based `get_viewport_image` (with `slotId`) targets the dedicated browser and does not
require the lock.

### Slot lifecycle

```
slot_create()
  dispatch("SdWall", {...})
  list_scene_objects()
  get_viewport_image(slotId)   ← no lock needed — dedicated browser
slot_close(slotId)
```

Always call `slot_close` when finished. The dedicated browser is killed automatically when
the last slot closes. Stale slots accumulate silently — check `slot_list` before creating new
sessions in long-running agents.

### Verb discovery workflow

```
list_verbs(category="architectural")   # browse verbs in a category
get_verb_schema("SdWall")              # inspect parameter schema + defaults
dispatch("SdWall", {length: 20, ...})  # execute
list_scene_objects()                   # verify scene state
```

---

## N/A commands

The following slash commands are **not applicable** to WEB-CAD (browser application):

- `/launch-rhino` — N/A. WEB-CAD runs in the browser; there is no Rhino process to launch.
  For Rhino integration, use the [RhinoMCP](https://github.com/wordingone/RhinoMCP) plugin.
- `/launch-rhinos` — N/A for the same reason.

---

## MCP server setup

Add to your Claude Code `.mcp.json`:

```json
{
  "mcpServers": {
    "webcad": {
      "type": "stdio",
      "command": "node",
      "args": ["tools/mcp/webcad-mcp.mjs"],
      "env": {}
    }
  }
}
```

Prerequisites:
- Node.js ≥ 18
- For default `:9222` mode: Chromium/Chrome running with `--remote-debugging-port=9222` and
  the WEB-CAD page open at `https://wordingone.github.io/WEB-CAD/`
- For slot mode: no pre-running browser required (dedicated browser launched on first
  `slot_create`)
