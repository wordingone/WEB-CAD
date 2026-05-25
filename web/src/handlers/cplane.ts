import { registerHandler } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { resolveCPlane as _resolveCPlane, WORLD_XY, WORLD_XZ, WORLD_YZ, type CPlane } from "../viewer/cplane";
import { setState } from "../app-state";

// Suppress unused import warning — resolveCPlane is used by other handlers, re-exported here for symmetry
void _resolveCPlane;

export function registerCPlaneHandlers(viewer: Viewer): void {
  registerHandler("SdSetCPlane", (args) => {
    const mode = (args.mode as string | undefined) ?? "world";
    const viewMap: Record<string, CPlane> = {
      top: WORLD_XY, bottom: WORLD_XY,
      front: WORLD_XZ, back: WORLD_XZ,
      right: WORLD_YZ, left: WORLD_YZ,
    };
    let newCPlane: CPlane;
    switch (mode) {
      case "top":
        newCPlane = { ...WORLD_XY, kind: "explicit" as const }; break;
      case "front":
        newCPlane = { ...WORLD_XZ, kind: "explicit" as const }; break;
      case "right":
        newCPlane = { ...WORLD_YZ, kind: "explicit" as const }; break;
      case "view-derived": {
        const base = viewMap[viewer.activeView] ?? WORLD_XY;
        newCPlane = { ...base, kind: "explicit" as const }; break;
      }
      case "explicit": {
        const oRaw = (args.origin as number[] | undefined) ?? [0, 0, 0];
        const xRaw = (args.xAxis  as number[] | undefined) ?? [1, 0, 0];
        const yRaw = (args.yAxis  as number[] | undefined) ?? [0, 1, 0];
        const origin = new THREE.Vector3(oRaw[0] ?? 0, oRaw[1] ?? 0, oRaw[2] ?? 0);
        const xAxis  = new THREE.Vector3(xRaw[0] ?? 1, xRaw[1] ?? 0, xRaw[2] ?? 0).normalize();
        const yAxis  = new THREE.Vector3(yRaw[0] ?? 0, yRaw[1] ?? 1, yRaw[2] ?? 0).normalize();
        const normal = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
        newCPlane = { origin, xAxis, yAxis, normal, kind: "explicit" as const }; break;
      }
      case "host-pick": {
        viewer.startHostPick((cplane) => {
          viewer.activeCPlane = cplane;
          window.dispatchEvent(new CustomEvent("viewer:cplane-changed", {
            detail: { cplane, mode: "host-pick" },
            bubbles: false,
          }));
        });
        return { mode: "host-pick", pending: true };
      }
      case "world":
      default:
        newCPlane = { ...WORLD_XY }; break;
    }
    viewer.activeCPlane = newCPlane;
    window.dispatchEvent(new CustomEvent("viewer:cplane-changed", {
      detail: { cplane: newCPlane, mode },
      bubbles: false,
    }));
    return { mode, kind: newCPlane.kind };
  });

  registerHandler("SdToggleCPlaneGizmo", () => {
    viewer.toggleCPlaneGizmo();
    return { toggled: true };
  });

  registerHandler("SdResetCPlane", () => {
    const reset: CPlane = { ...WORLD_XY };
    viewer.activeCPlane = reset;
    window.dispatchEvent(new CustomEvent("viewer:cplane-changed", {
      detail: { cplane: reset, mode: "world" },
      bubbles: false,
    }));
    return { reset: true };
  });

  registerHandler("SdSetUnits", (args) => {
    const sys = (args["system"] as "metric" | "imperial" | undefined) ?? "metric";
    const valid = sys === "metric" || sys === "imperial" ? sys : "metric";
    setState("unitSystem", valid);
    return { ok: true, unitSystem: valid };
  });
}
