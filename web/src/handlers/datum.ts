import { registerHandler } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { gridStore } from "../geometry/grids";
import { levelStore, getActiveLevelId } from "../geometry/levels";
import { makeLevelSprite } from "../tools/structural";
import { resolveLayerId } from "./shared";
import type { Point3 } from "../nurbs/nurbs-primitives";
import type { Surface } from "../nurbs/nurbs-surfaces";

function getActiveLevelElevation(): number {
  return levelStore.get(getActiveLevelId())?.elevation ?? 0;
}

export function syncLevelOpacities(viewer: Viewer): void {
  const activeId = levelStore.getActive().id;
  viewer.forEachSceneChild((child) => {
    if (child.userData?.creator !== "IfcLevel") return;
    const isActive = child.userData.levelId === activeId;
    const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
    if (mat?.opacity !== undefined) {
      mat.opacity = isActive ? 0.05 : 0.02;
      mat.needsUpdate = true;
    }
    for (const ch of child.children) {
      if (ch.userData?.isLevelLabel) {
        (ch as THREE.Sprite).material.opacity = isActive ? 1.0 : 0.4;
        (ch as THREE.Sprite).material.needsUpdate = true;
      }
    }
  });
}

export function registerDatumHandlers(viewer: Viewer): void {
  registerHandler("SdRefGrid", (args) => {
    const spacing  = (args.spacing  as number          | undefined) ?? 5;
    const count    = Math.max(2, Math.min(10, Math.trunc((args.count as number | undefined) ?? 4)));
    const name     = (args.name     as string          | undefined) ?? `Grid ${gridStore.all().length + 1}`;
    const rotDeg   = (args.rotation as number          | undefined) ?? 0;
    const origin   = (args.origin   as [number,number] | undefined) ?? [0, 0];

    const grid = gridStore.add({ name, spacing, count, rotation: (rotDeg * Math.PI) / 180, origin, visible: true });

    const extent = spacing * (count - 1);
    const half   = extent / 2;
    const t      = 0.02;
    const mat    = new THREE.MeshBasicMaterial({ color: 0x888899, transparent: true, opacity: 0.5 });
    const group  = new THREE.Group();
    group.rotation.z = grid.rotation;
    group.position.set(origin[0], origin[1], 0);
    group.userData.kind = "grid";
    group.userData.gridId = grid.id;

    for (let i = 0; i < count; i++) {
      const offset = -half + i * spacing;
      const gv = new THREE.BoxGeometry(t, extent + spacing, t);
      const mv = new THREE.Mesh(gv, mat);
      mv.position.set(offset, 0, 0);
      group.add(mv);
      const gh = new THREE.BoxGeometry(extent + spacing, t, t);
      const mh = new THREE.Mesh(gh, mat);
      mh.position.set(0, offset, 0);
      group.add(mh);
    }

    viewer.addMesh(group, "grid");
    return { created: "grid", gridId: grid.id, count, spacing, name };
  });

  registerHandler("setGridVisible", (args) => {
    const id      = args.id as string;
    const visible = args.visible as boolean;
    const ok = gridStore.setVisible(id, visible);
    if (!ok) return { error: `no grid with id "${id}"` };
    viewer.forEachSceneChild((obj) => { if (obj.userData.gridId === id) obj.visible = visible; });
    return { gridId: id, visible };
  });

  registerHandler("setGridSpacing", (args) => {
    const id      = args.id as string;
    const spacing = args.spacing as number;
    const ok = gridStore.setSpacing(id, spacing);
    if (!ok) return { error: `invalid id or spacing for grid "${id}"` };
    return { gridId: id, spacing };
  });

  registerHandler("setActiveGrid", (args) => {
    const id = args.id as string;
    const ok = gridStore.setActive(id);
    if (!ok) return { error: `no grid with id "${id}"` };
    return { activeGridId: id };
  });

  registerHandler("SdLevel", (args) => {
    const elev   = (args.elevation as number | undefined) ?? 0;
    const height = (args.height as number | undefined) ?? 3.0;
    const extent = (args.extent  as number | undefined) ?? 20;
    const canonicalName = `Level ${levelStore.all().length + 1}`;
    const level = levelStore.findOrCreate(canonicalName, elev, height);
    const geom  = new THREE.BoxGeometry(extent, extent, 0.02);
    const mat   = new THREE.MeshBasicMaterial({ color: 0x44aa88, transparent: true, opacity: 0.05, side: THREE.DoubleSide });
    const mesh  = new THREE.Mesh(geom, mat);
    mesh.position.z = elev;
    mesh.userData.kind = "brep";
    mesh.userData.creator = "IfcLevel";
    mesh.userData.levelId = level.id;
    mesh.userData.noSnap = true;
    const surface: Surface = {
      kind: "plane",
      plane: {
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      },
      uDomain: { min: -extent / 2, max: extent / 2 },
      vDomain: { min: -extent / 2, max: extent / 2 },
      uExtent: { min: -extent / 2, max: extent / 2 },
      vExtent: { min: -extent / 2, max: extent / 2 },
    };
    const canonical = viewer.getCanonicalGeometryStore().create({
      kind: "surface",
      surface,
      source: "command",
      createdBy: "SdLevel",
      displayMesh: {
        revision: 1,
        generatedAt: Date.now(),
        vertexCount: geom.getAttribute("position")?.count,
        triangleCount: geom.index ? Math.floor(geom.index.count / 3) : undefined,
        derivation: "tessellated-surface",
      },
      metadata: {
        creator: mesh.userData.creator,
        levelId: level.id,
        elevation: elev,
        height,
        extent,
      },
    });
    viewer.getCanonicalGeometryStore().linkObject(mesh, canonical.id);
    const label = makeLevelSprite(level.name);
    label.position.set(extent / 2 - 2.5, extent / 2 - 2.5, 0.3);
    mesh.add(label);
    levelStore.setActive(level.id);
    viewer.addMesh(mesh, "brep");
    syncLevelOpacities(viewer);
    return { created: "level", elevation: elev, levelId: level.id };
  });

  registerHandler("setActiveLevel", (args) => {
    const id = args.id as string | undefined;
    if (!id) return { error: "id required" };
    // §#16: accept both programmatic id ("level/1") and display name ("Level 2") — model may send either
    const level = levelStore.get(id) ?? levelStore.all().find(l => l.name === id);
    if (!level) return { error: `level not found: ${id}` };
    if (level.locked) return { status: "error", detail: `level ${level.name} is locked` };
    const ok = levelStore.setActive(level.id);
    if (!ok) return { error: `level not found: ${level.id}` };
    syncLevelOpacities(viewer);
    return { ok: true, activeLevel: level.id, elevation: level.elevation };
  });

  registerHandler("setLevelVisible", (args) => {
    const id      = args.id as string | undefined;
    const visible = args.visible as boolean | undefined;
    if (!id || visible === undefined) return { error: "id and visible required" };
    const ok = levelStore.setVisible(id, visible);
    if (!ok) return { error: `level not found: ${id}` };
    viewer.forEachSceneChild((child) => {
      if (child.userData?.levelId === id) child.visible = visible;
    });
    return { ok: true, levelId: id, visible };
  });

  registerHandler("removeLevel", (args) => {
    const id = args.id as string | undefined;
    if (!id) return { error: "id required" };
    const ok = levelStore.remove(id);
    if (!ok) return { error: `cannot remove level: ${id}` };
    const toRemove: THREE.Object3D[] = [];
    viewer.forEachSceneChild((child) => {
      if (child.userData?.levelId === id) toRemove.push(child);
    });
    for (const obj of toRemove) viewer.removeObject(obj);
    return { ok: true, levelId: id };
  });

  registerHandler("SdDatum", (args) => {
    const pos  = (args.position as number[] | undefined);
    const elev = (args.elevation as number | undefined) ?? pos?.[2] ?? 0;
    const geom = new THREE.SphereGeometry(0.15, 8, 8);
    const mat  = new THREE.MeshStandardMaterial({ color: 0x33bb66, roughness: 0.3, metalness: 0.2 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(pos?.[0] ?? 0, pos?.[1] ?? 0, elev);
    mesh.userData.kind = "brep";
    mesh.userData.creator = "datum";
    if (args.label) mesh.userData.label = args.label as string;
    const point: Point3 = { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z };
    const canonical = viewer.getCanonicalGeometryStore().create({
      kind: "point",
      point,
      source: "command",
      createdBy: "SdDatum",
      displayMesh: {
        revision: 1,
        generatedAt: Date.now(),
        vertexCount: geom.getAttribute("position")?.count,
        derivation: "reference-marker",
      },
      metadata: {
        creator: mesh.userData.creator,
        label: mesh.userData.label,
      },
    });
    viewer.getCanonicalGeometryStore().linkObject(mesh, canonical.id);
    viewer.addMesh(mesh, "brep");
    return { created: "datum", elevation: elev };
  });

  registerHandler("SdFurnishing", (args) => {
    const w    = (args.width       as number | undefined) ?? 0.8;
    const d    = (args.depth       as number | undefined) ?? 0.6;
    const h    = (args.height      as number | undefined) ?? 0.75;
    const rotDeg = (args.orientation as number | undefined) ?? 0;
    const geom = new THREE.BoxGeometry(w, d, h);
    geom.translate(0, 0, h / 2);
    const mat  = new THREE.MeshStandardMaterial({ color: 0xd4b896, roughness: 0.8, metalness: 0.0 });
    const mesh = new THREE.Mesh(geom, mat);
    const pos  = args.position as number[] | undefined;
    mesh.position.set(pos?.[0] ?? 0, pos?.[1] ?? 0, pos?.[2] ?? getActiveLevelElevation());
    if (rotDeg) mesh.rotation.z = (rotDeg * Math.PI) / 180;
    mesh.userData.kind = "brep";
    mesh.userData.creator = "furnishing";
    mesh.userData.layerId = resolveLayerId("SdFurnishing", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    viewer.addMesh(mesh, "brep");
    return { created: "furnishing", width: w, depth: d, height: h };
  });
}
