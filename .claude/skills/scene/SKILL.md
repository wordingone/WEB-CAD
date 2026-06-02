---
name: scene
description: "List all objects in the active WEB-CAD scene. Calls list_scene_objects via the webcad MCP server. Returns UUIDs, names, types, and layer assignments. No browser lock required."
allowed-tools: Bash
disable-model-invocation: false
user-invocable: true
---

# /scene

List all objects in the WEB-CAD scene. Thin wrapper over `webcad.list_scene_objects`.

## Steps

1. Call `list_scene_objects` (optionally pass a `slotId` if targeting a specific slot session).
2. Report:
   - Total object count
   - Table: UUID (first 8 chars), name, type, layer
   - "(empty scene)" if count is 0

## Quick overrides

```
/scene                → objects in the default :9222 WEB-CAD tab
/scene <slotId>       → objects in the named slot session
```

## Notes

- No browser lock needed — pure JS eval, no cursor/focus interaction.
- If the WEB-CAD page is not reachable on `:9222`, start the shared browser:
  ```bash
  bun run shared-browser:start
  ```
