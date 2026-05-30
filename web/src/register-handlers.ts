import type { Viewer } from "./viewer/viewer";
import type { ScenePanel } from "./scene/scene-panel";
import { registerHandler } from "./commands/dispatch";
import { undo, redo, pushCustomAction, clearHistory } from "./history";
import { setRenderMode, type RenderMode } from "./viewer/render-modes";
import { setState } from "./app-state";
import { clippingPlaneStore, type CPlaneBounds } from "./geometry/clipping-planes";
import { setActiveClipPlaneEntity } from "./viewer/clip-plane-handles";
import { getLayoutHost } from "./shell/modes";
import { addLinkedClipPlaneSheet } from "./shell/layout";
import { clearSelected, clearMultiSelected } from "./viewer/selection-state";
import { registerGoalHandlers } from "./agent/goal-handlers";
import { registerTransformHandlers } from "./handlers/transforms";
import { registerNurbsHandlers } from "./handlers/nurbs";
import { registerStructuralHandlers } from "./handlers/structural";
import { registerOpeningHandlers } from "./handlers/openings";
import { registerSketchHandlers } from "./handlers/sketch";
import { registerDatumHandlers } from "./handlers/datum";
import { registerCPlaneHandlers } from "./handlers/cplane";
import { registerAnnotationHandlers } from "./handlers/annotations";
import { registerSkillHandlers } from "./handlers/skills";
import { registerBrepOpHandlers } from "./handlers/brep-ops";

const ORTHO_VIEWS = ["top", "bottom", "front", "back", "left", "right", "iso"] as const;
type OrthoView = typeof ORTHO_VIEWS[number];

export function registerAllHandlers(viewer: Viewer, scenePanel: ScenePanel): void {
  registerGoalHandlers();

  registerHandler("SdDelete", () => {
    const deleted = viewer.deleteSelected();
    if (deleted) document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    return { deleted };
  });

  registerHandler("SdUndo", () => { undo(viewer); });
  registerHandler("SdRedo", () => { redo(viewer); });

  registerHandler("SdRenderMode", (args) => {
    const mode = (args.mode as string | undefined) ?? "shaded";
    setRenderMode(mode as RenderMode);
    return { mode };
  });

  registerHandler("SdSetViewOrtho", (args) => {
    const raw = (args.view as string | undefined) ?? "top";
    const view: OrthoView = (ORTHO_VIEWS as readonly string[]).includes(raw) ? raw as OrthoView : "top";
    viewer.setView(view);
    setState("currentView", view);
    return { ok: true, view };
  });

  registerHandler("SdSetViewPerspective", () => {
    viewer.frameAllVisible();
    setState("currentView", "perspective");
    return { ok: true, view: "perspective" };
  });

  registerHandler("SdListObjects", () => {
    const scene = viewer.getScene();
    const objects: Array<{ name: string; uuid: string; kind: string; layer?: string; ifcClass?: string; verb?: string }> = [];
    const ifcClassCounts: Record<string, number> = {};
    scene.traverse((obj) => {
      const ud = obj.userData as Record<string, unknown>;
      const isIfc = ud.expressID != null && ud.ifcClass;
      if (!ud.kind && !isIfc) return;
      if (isIfc) {
        const cls = String(ud.ifcClass);
        ifcClassCounts[cls] = (ifcClassCounts[cls] ?? 0) + 1;
        return;
      }
      objects.push({
        name: obj.name || obj.uuid.slice(0, 8),
        uuid: obj.uuid,
        kind: String(ud.kind ?? ""),
        ...(ud.layer ? { layer: String(ud.layer) } : {}),
        ...(ud.ifcClass ? { ifcClass: String(ud.ifcClass) } : {}),
        ...(ud.dispatchVerb ? { verb: String(ud.dispatchVerb) } : {}),
      });
    });
    for (const [cls, count] of Object.entries(ifcClassCounts).sort((a, b) => b[1] - a[1])) {
      objects.push({ name: `${count}× ${cls}`, uuid: cls, kind: "ifc", ifcClass: cls });
    }
    return { count: objects.length, objects };
  });

  registerHandler("SdZoomExtents", () => { viewer.frameAllVisible(); return { ok: true }; });
  registerHandler("SdZoomSelected", () => { viewer.frameAllVisible(); return { ok: true }; });

  registerHandler("SdSectionBox", (args) => {
    const min = args.min as [number, number, number];
    const max = args.max as [number, number, number];
    const enabled = (args.enabled ?? true) as boolean;
    if (!Array.isArray(min) || min.length < 3 || !Array.isArray(max) || max.length < 3)
      return { error: "min and max must be [x,y,z] arrays" };
    viewer.setSectionBox(min, max, enabled);
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    return { ok: true, min, max, enabled };
  });

  registerHandler("SdSectionBoxOff", () => {
    const prev = viewer.getSectionBox();
    viewer.clearSectionBox();
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    if (prev) {
      const { min, max } = prev;
      pushCustomAction(
        () => { viewer.setSectionBox(min, max); document.dispatchEvent(new CustomEvent("viewer:clip-changed")); },
        () => { viewer.clearSectionBox(); document.dispatchEvent(new CustomEvent("viewer:clip-changed")); },
      );
    }
    return { ok: true };
  });

  registerHandler("SdIsolate", (args) => {
    const uuid = args.uuid as string;
    if (!uuid) return { error: "uuid required" };
    const ok = viewer.isolate(uuid);
    document.dispatchEvent(new CustomEvent("viewer:isolate-changed", { detail: { uuid: ok ? uuid : null } }));
    return ok ? { ok: true, uuid } : { error: "object not found", uuid };
  });

  registerHandler("SdIsolateOff", () => {
    viewer.isolateOff();
    document.dispatchEvent(new CustomEvent("viewer:isolate-changed", { detail: { uuid: null } }));
    return { ok: true };
  });

  registerHandler("SdFitToObject", (args) => {
    const uuid = args.uuid as string;
    if (!uuid) return { error: "uuid required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", uuid);
    if (!obj) return { error: "object not found", uuid };
    viewer.frameObjectOnly(obj);
    return { ok: true, uuid };
  });

  registerHandler("SdClippingPlane", (args) => {
    const origin = args.origin as [number, number, number];
    const normal = args.normal as [number, number, number];
    const label = (args.label as string | undefined) ?? `clip-${Date.now()}`;
    const autoSheet = args.autoSheet !== false;
    const boundsArg = args.bounds as Partial<CPlaneBounds> | undefined;
    if (!Array.isArray(origin) || origin.length < 3 || !Array.isArray(normal) || normal.length < 3)
      return { error: "origin and normal must be [x,y,z] arrays" };
    viewer.addClippingPlane(origin, normal, label);
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    const entity = clippingPlaneStore.add(origin, normal, label, boundsArg);
    setActiveClipPlaneEntity(entity.id);
    let sheetId: string | undefined;
    if (autoSheet) {
      const layoutHost = getLayoutHost();
      if (layoutHost) sheetId = addLinkedClipPlaneSheet(layoutHost, entity.id, `Section – ${label}`);
    }
    return { ok: true, origin, normal, label, clipPlaneId: entity.id, sheetId };
  });

  registerHandler("SdClippingPlanesClear", () => {
    viewer.clearClippingPlanes();
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    return { ok: true };
  });

  registerHandler("SdClippingPlaneRemove", (args) => {
    const label = args.label as string;
    if (!label) return { error: "label required" };
    const removed = viewer.removeClippingPlane(label);
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    return { ok: removed, label };
  });

  registerTransformHandlers(viewer);
  registerNurbsHandlers(viewer);
  registerStructuralHandlers(viewer);
  registerOpeningHandlers(viewer);
  registerSketchHandlers(viewer);
  registerDatumHandlers(viewer);
  registerCPlaneHandlers(viewer);
  registerAnnotationHandlers(viewer);
  registerSkillHandlers();
  registerBrepOpHandlers(viewer);

  registerHandler("SdClearScene", () => {
    viewer.clearScene();
    clearHistory();
    scenePanel.clear();
    clearMultiSelected();
    clearSelected();
    window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
    return { ok: true, cleared: true };
  });
}
