// Visibility ops: SdHide, SdShow, SdLock, SdUnlock.
// Extracts object-level visibility and layer-level locking from register-handlers.ts
// so tests can import this module without pulling in import.meta.glob (skills) deps.

import type { Viewer } from "../viewer/viewer";
import { registerHandler } from "../commands/dispatch";
import { drawingLayerStore } from "../geometry/drawing-layers";

export function registerVisibilityHandlers(viewer: Viewer): void {
  registerHandler("SdHide", (args) => {
    const uuid = args.target as string;
    if (!uuid) return { error: "target uuid required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", uuid);
    if (!obj) return { error: "object not found", uuid };
    obj.visible = false;
    obj.userData.hidden = true;
    document.dispatchEvent(new CustomEvent("viewer:visibility-changed", { detail: { uuid, visible: false } }));
    return { ok: true, uuid };
  });

  registerHandler("SdShow", (args) => {
    const target = args.target as string;
    if (!target) return { error: "target required (uuid or 'all')" };
    if (target === "all") {
      let count = 0;
      viewer.getScene().traverse((obj) => {
        if (obj.userData.hidden) {
          obj.visible = true;
          obj.userData.hidden = false;
          count++;
        }
      });
      document.dispatchEvent(new CustomEvent("viewer:visibility-changed", { detail: { all: true } }));
      return { ok: true, revealed: count };
    }
    const obj = viewer.getScene().getObjectByProperty("uuid", target);
    if (!obj) return { error: "object not found", uuid: target };
    obj.visible = true;
    obj.userData.hidden = false;
    document.dispatchEvent(new CustomEvent("viewer:visibility-changed", { detail: { uuid: target, visible: true } }));
    return { ok: true, uuid: target };
  });

  registerHandler("SdLock", (args) => {
    const target = args.target as string;
    if (!target) return { error: "target layer name or id required" };
    const layer = drawingLayerStore.all().find(l => l.id === target || l.name === target);
    if (!layer) return { error: "layer not found", target };
    drawingLayerStore.setLocked(layer.id, true);
    document.dispatchEvent(new CustomEvent("viewer:layer-changed", { detail: { id: layer.id } }));
    return { ok: true, layer_id: layer.id, layer_name: layer.name };
  });

  registerHandler("SdUnlock", (args) => {
    const target = args.target as string;
    if (!target) return { error: "target layer name or id required" };
    const layer = drawingLayerStore.all().find(l => l.id === target || l.name === target);
    if (!layer) return { error: "layer not found", target };
    drawingLayerStore.setLocked(layer.id, false);
    document.dispatchEvent(new CustomEvent("viewer:layer-changed", { detail: { id: layer.id } }));
    return { ok: true, layer_id: layer.id, layer_name: layer.name };
  });
}
