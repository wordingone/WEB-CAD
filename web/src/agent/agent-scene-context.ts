// Agent scene context builder — separated from agent-harness.ts for testability.
// agent-harness.ts imports @huggingface/transformers which can't run in Bun tests.
// This module has no such dependency.

import { snapshotAsText } from "../scene/scene-kg";

export function buildSceneContext(): string {
  // Try KG first (populated by dispatch-created objects).
  // snapshotAsText() prefixes its own "Current scene: " — strip it so the
  // caller's `Current scene: ${buildSceneContext()}` doesn't double-prefix.
  const kg = snapshotAsText().replace(/^Current scene:\s*/i, "");
  if (!kg.startsWith("empty")) return kg;

  // Walk for IFC elements — web-ifc sets userData.expressID + userData.ifcClass on each mesh.
  type ViewerLike = { getScene?: () => { traverse?: (cb: (o: unknown) => void) => void; children?: unknown[] } };
  const viewer = (window as unknown as { __viewer?: ViewerLike }).__viewer;
  const scene = viewer?.getScene?.();
  if (scene?.traverse) {
    const ifcCounts: Record<string, number> = {};
    let ifcTotal = 0;
    scene.traverse((obj: unknown) => {
      const ud = (obj as { userData?: Record<string, unknown> })?.userData;
      if (ud?.expressID != null && ud?.ifcClass) {
        const cls = String(ud.ifcClass);
        ifcCounts[cls] = (ifcCounts[cls] ?? 0) + 1;
        ifcTotal++;
      }
    });
    if (ifcTotal > 0) {
      const parts = Object.entries(ifcCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([cls, n]) => `${n}× ${cls}`)
        .join(", ");
      return `IFC model loaded: ${ifcTotal} elements — ${parts}.`;
    }
  }

  // Fall back to top-level scene children (generic / non-IFC scenes).
  // userData.creator is set by every dispatch handler (SdBox, SdWall, etc.) — scaffolding groups
  // added by the viewer (grid, axes, pivot proxy, cplane gizmo) never carry this property.
  // Filter to creator-tagged objects only so the agent's view matches what the user can select.
  type ViewerScene = { children?: Array<{ type: string; name?: string; visible?: boolean; userData?: Record<string, unknown>; position?: { x: number; y: number; z: number } }> };
  const fallbackViewer = (window as unknown as { __viewer?: { scene?: ViewerScene } }).__viewer;
  const children = fallbackViewer?.scene?.children;

  const meshes = children?.filter((c) => (c.type === "Mesh" || c.type === "Group") && c.userData?.creator != null) ?? [];
  if (meshes.length === 0) return "empty workspace — no objects placed yet.";

  const lines = meshes.slice(0, 15).map((m) => {
    const pos = m.position
      ? `at (${m.position.x.toFixed(1)}, ${m.position.y.toFixed(1)}, ${m.position.z.toFixed(1)})`
      : "";
    const hiddenFlag = m.visible === false ? " [hidden]" : "";
    return `${m.name || m.type}${pos ? " " + pos : ""}${hiddenFlag}`;
  });
  const suffix = meshes.length > 15 ? ` … and ${meshes.length - 15} more` : "";
  return `${meshes.length} object(s): ${lines.join("; ")}${suffix}.`;
}
