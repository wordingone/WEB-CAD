# How to Add a Palette Tool — WEB-CAD

A "palette tool" is an interactive create-mode tool that appears in the left toolbar. The user clicks it, then interacts with the viewport (clicks, drags) to place geometry. Contrast with command handlers, which are fired programmatically.

## Overview

Palette tools are managed by `create-mode.ts`. Each tool has:

1. An ID (string) — used as `toolId` throughout
2. An activation path — `dispatchSync("setActiveTool", { toolId: "my-tool" })`
3. A pointer-event handler — runs on each viewport click/drag while the tool is active
4. A completion path — calls `dispatchSync("setActiveTool", { toolId: "select" })` when done (C7)

## Step-by-step

### 1. Add the tool ID constant

```typescript
// web/src/viewer/create-mode.ts
export const MY_TOOL_ID = "my-tool";
```

### 2. Register the tool handler

Inside `initCreateMode(viewer)` in `web/src/tools/index.ts`, add a branch for your tool:

```typescript
viewer.on("pointerdown", (pt: WorldPoint) => {
  const tool = getActiveTool();
  if (tool === MY_TOOL_ID) {
    handleMyToolClick(viewer, pt);
  }
  // ... other tools
});
```

Implement `handleMyToolClick`:

```typescript
function handleMyToolClick(viewer: Viewer, pt: WorldPoint): void {
  const mesh = buildMyShape(pt.x, pt.y);
  mesh.userData.kind = "my-tool";         // C5: semantic
  mesh.userData.creator = "my-tool";
  mesh.position.set(cx, cy, 0);           // C6: centroid-anchored
  viewer.addMesh(mesh, "my-tool");

  dispatchSync("setActiveTool", { toolId: "select" }); // C7: auto-return
}
```

### 3. Add the button to the workbench palette

In `web/src/shell/workbench.ts`, add to the tool button list:

```typescript
{ id: "my-tool", label: "My Tool", icon: "⬡", hotkey: "M" },
```

The workbench builder picks this up and renders the button. The button calls `dispatchSync("setActiveTool", { toolId: "my-tool" })` on click.

### 4. Add a `setActiveTool` handler (if not already generic)

`setActiveTool` is handled generically in dispatch. The palette highlights the active button via the `syncToolActiveClass()` call in `main.ts`. No additional handler needed unless your tool needs setup/teardown on activation.

### 5. Checklist

- [ ] Tool ID constant defined and exported
- [ ] Pointer-event branch in `initCreateMode`
- [ ] Builder function: centroid-anchored (C6), semantic `userData.kind` (C5), auto-return to select (C7)
- [ ] Palette button registered in `workbench.ts`
- [ ] `userData.controlPoints` set if the tool draws a curve/polyline (C4)
- [ ] `bun run web:typecheck` exits 0
- [ ] Visual verification: tool appears in palette, geometry lands correctly, Gumball shows

## Common failure modes

- **C4**: Polyline/spline tool doesn't set `userData.controlPoints` — Gumball sub-handles missing.
- **C6**: Mesh positioned at world origin instead of centroid — Gumball at wrong location.
- **C7**: Tool stays active after geometry is placed — user must manually click Select.
