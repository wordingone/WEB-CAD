// Selection/query handler family: SdQuery, SdMeasure, SdMeasureBetween
// SdSelect / SdSelectAll / SdSelectByQuery / SdDeselect live in transforms.ts

import { registerHandler } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { formatLength, unitLabel } from "../units";
import { drawingLayerStore } from "../geometry/drawing-layers";

export function registerSelectionQueryHandlers(viewer: Viewer): void {

  // ── SdQuery ──────────────────────────────────────────────────────────────
  // Read-only scene inspection: count + list objects matching optional filters.
  registerHandler("SdQuery", (args) => {
    const kindQ = (args.kind as string | undefined)?.toLowerCase();
    const visibleQ = args.visible as boolean | undefined;
    const layerQ = args.layer as string | undefined;

    // Resolve layer name → id if a name was provided
    let layerIdQ: string | undefined;
    if (layerQ) {
      const match = drawingLayerStore.all().find((l) => l.name === layerQ || l.id === layerQ);
      layerIdQ = match?.id;
    }

    const results: Array<{
      uuid: string;
      name: string;
      kind: string;
      creator: string;
      visible: boolean;
      layer?: string;
    }> = [];

    viewer.getScene().traverse((obj) => {
      const ud = obj.userData as Record<string, unknown>;
      if (!ud.kind && !ud.creator) return; // scaffolding / non-dispatch objects

      const creatorStr = String(ud.creator ?? ud.kind ?? "");

      if (kindQ) {
        const objKind = (String(ud.kind ?? "")).toLowerCase();
        const objCreator = creatorStr.toLowerCase();
        if (!objKind.includes(kindQ) && !objCreator.includes(kindQ)) return;
      }

      if (visibleQ !== undefined && obj.visible !== visibleQ) return;

      if (layerIdQ && ud.layerId !== layerIdQ) return;

      results.push({
        uuid: obj.uuid,
        name: obj.name || obj.uuid.slice(0, 8),
        kind: String(ud.kind ?? ""),
        creator: creatorStr,
        visible: obj.visible,
        ...(ud.layerId ? { layer: String(ud.layerId) } : {}),
      });
    });

    return { count: results.length, objects: results };
  });

  // ── SdMeasure ─────────────────────────────────────────────────────────────
  // Point-to-point distance. from/to are [x,y,z] arrays or {x,y,z} objects.
  registerHandler("SdMeasure", (args) => {
    const parsePoint = (v: unknown): THREE.Vector3 | null => {
      if (Array.isArray(v) && v.length >= 3) return new THREE.Vector3(Number(v[0]), Number(v[1]), Number(v[2]));
      if (v && typeof v === "object" && "x" in v) {
        const p = v as { x: number; y: number; z: number };
        return new THREE.Vector3(Number(p.x), Number(p.y), Number(p.z));
      }
      return null;
    };
    const from = parsePoint(args.from);
    const to = parsePoint(args.to);
    if (!from || !to) return { error: "SdMeasure requires from and to as [x,y,z] or {x,y,z}" };

    const dist = from.distanceTo(to);
    const unit = unitLabel();
    return {
      distance: parseFloat(dist.toFixed(6)),
      formatted: formatLength(dist),
      unit,
      from: { x: from.x, y: from.y, z: from.z },
      to: { x: to.x, y: to.y, z: to.z },
    };
  });

  // ── SdMeasureBetween ──────────────────────────────────────────────────────
  // Centroid-to-centroid distance between two objects identified by UUID.
  registerHandler("SdMeasureBetween", (args) => {
    const fromId = args.from as string | undefined;
    const toId = args.to as string | undefined;
    if (!fromId || !toId) return { error: "SdMeasureBetween requires from and to UUIDs" };

    const objA = viewer.getScene().getObjectByProperty("uuid", fromId);
    const objB = viewer.getScene().getObjectByProperty("uuid", toId);
    if (!objA) return { error: "SdMeasureBetween — from object not found", uuid: fromId };
    if (!objB) return { error: "SdMeasureBetween — to object not found", uuid: toId };

    const posA = new THREE.Vector3();
    const posB = new THREE.Vector3();
    objA.getWorldPosition(posA);
    objB.getWorldPosition(posB);

    const dist = posA.distanceTo(posB);
    const unit = unitLabel();
    return {
      distance: parseFloat(dist.toFixed(6)),
      formatted: formatLength(dist),
      unit,
      from_uuid: fromId,
      to_uuid: toId,
      from_position: { x: parseFloat(posA.x.toFixed(3)), y: parseFloat(posA.y.toFixed(3)), z: parseFloat(posA.z.toFixed(3)) },
      to_position: { x: parseFloat(posB.x.toFixed(3)), y: parseFloat(posB.y.toFixed(3)), z: parseFloat(posB.z.toFixed(3)) },
    };
  });
}
