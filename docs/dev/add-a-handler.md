# How to Add a Handler — WEB-CAD

A "handler" is a function that runs when a `Sd*` verb is dispatched. This guide covers adding a new verb end-to-end.

## 1. Add the verb to `spatial-api.yaml`

`web/src/commands/spatial-api.yaml` is the SDK contract. Every verb must have an entry.

```yaml
- name: SdMyVerb
  ifc4_class: ~           # omit if not a direct IFC entity
  kernel_op: myVerb
  parameters:
    type: object
    properties:
      width:
        type: number
        description: "[optional unit=m default=1.0] Width in metres"
      label:
        type: string
        description: "[optional] Display label"
    required: []          # list required param names, or [] if all optional
  topology_role: solid    # host | hosted | void | solid | curve | annotation | …
  kg_predicates: []
  synonyms:
    - create my thing
    - add my verb
  alias_source: generic_cad_vocabulary
  kernel: replicad
```

Rules:
- If a parameter can be supplied as either a scalar OR a vector (e.g., `x/y/z` OR `vector`), mark ALL forms as `optional` and let the handler pick.
- `description` must include `[required/optional unit=X default=Y]` markers for the audit.

## 2. Register the handler

**Where:** Add to the appropriate file in `web/src/handlers/` (domain module) or directly in `web/src/register-handlers.ts` for verbs without a natural home.

```typescript
// web/src/handlers/my-domain.ts
import { registerHandler } from "../commands/dispatch";
import type { Viewer } from "../viewer/viewer";
import { pushCustomAction } from "../history";

export function registerMyDomainHandlers(viewer: Viewer): void {
  registerHandler("SdMyVerb", (args) => {
    const width = (args.width as number | undefined) ?? 1.0;
    const label = (args.label as string | undefined) ?? "MyThing";

    // Build geometry
    const mesh = buildMyThing(width);
    mesh.userData.kind = "my-verb";       // C5: semantic kind, not "brep"/"mesh"
    mesh.userData.creator = "SdMyVerb";
    mesh.userData.dispatchArgs = args;    // needed for inspector re-dispatch

    viewer.addMesh(mesh, "my-verb");      // handles undo automatically

    return { ok: true, uuid: mesh.uuid, width, label };
  });
}
```

**Register the module** in `register-handlers.ts`:

```typescript
import { registerMyDomainHandlers } from "./handlers/my-domain";

export function registerAllHandlers(viewer: Viewer, scenePanel: ScenePanel): void {
  // ...existing calls...
  registerMyDomainHandlers(viewer);
}
```

## 3. Verify schema ↔ handler agreement

```bash
bun run audit:dispatch
```

This checks that every `required` parameter in the YAML is read by the handler and vice versa. Exit 0 = agreement.

## 4. Add a test

```typescript
// web/test/my-verb.test.ts
import { describe, expect, test } from "bun:test";
import { dispatchSync } from "../src/commands/dispatch";

describe("SdMyVerb", () => {
  test("creates object with defaults", () => {
    const result = dispatchSync("SdMyVerb", {});
    expect(result).toMatchObject({ ok: true });
    expect(result.width).toBe(1.0);
  });
});
```

## 5. Checklist

- [ ] `spatial-api.yaml` entry with required/optional markers
- [ ] Handler sets `userData.kind` (semantic, not "brep"), `userData.creator`, `userData.dispatchArgs`
- [ ] Handler uses `viewer.addMesh()` or `pushReplaceAction()` (not raw `scene.add()`)
- [ ] `bun run audit:dispatch` exits 0
- [ ] Test added, `bun test web/` exits 0
- [ ] `bun run web:typecheck` exits 0

## Common failure modes (from the C catalog)

- **C2**: Schema marks `vector` as required but handler reads `x/y/z`. Mark both forms optional.
- **C5**: `userData.kind = "brep"` — use the semantic verb suffix instead.
- **C8**: Adding `@ts-ignore` to silence TS on an external API — verify at runtime first.
