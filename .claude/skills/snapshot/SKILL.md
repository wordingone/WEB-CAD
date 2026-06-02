---
name: snapshot
description: "Capture the WEB-CAD viewport as a PNG. Calls get_viewport_image via the webcad MCP server. For the default :9222 tab, applies the browser-lock protocol (mail BROWSER LOCKED/RELEASED). Slot-based captures are lock-free."
allowed-tools: Bash
disable-model-invocation: false
user-invocable: true
---

# /snapshot

Capture the WEB-CAD viewport. Thin wrapper over `webcad.get_viewport_image`.

## Steps

1. **If no `slotId` provided** (targeting the shared `:9222` browser):
   - Mail `BROWSER LOCKED` before capturing.
2. Call `get_viewport_image` with:
   - `width: 1280, height: 720` (default, or user-specified dimensions)
   - `slotId` (if provided)
3. **If no `slotId`**: mail `BROWSER RELEASED` immediately after, even on error.
4. Report the saved path and estimated token cost from the tool response.

## Quick overrides

```
/snapshot                   → 1280×720, default :9222 tab (locks browser)
/snapshot <slotId>          → 1280×720, slot tab (no lock needed)
/snapshot 1920 1080         → custom resolution, default tab
/snapshot <slotId> 1920 1080 → custom resolution, slot tab
```

## Browser lock

The lock protocol applies only to the shared user browser (`:9222`). A slot tab has its own
dedicated Chromium instance and is never shared, so no lock is required.

See: `docs/webcad-agent.md` — browser lock protocol.
