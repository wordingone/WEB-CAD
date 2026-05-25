import { registerHandler } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { buildDoor, buildWindow, buildOpening } from "../tools/openings";
import {
  DEFAULT_DOOR_W, DEFAULT_DOOR_H,
  FZK_DOOR_W, FZK_DOOR_H,
  FZK_FRONT_DOOR_W, FZK_FRONT_DOOR_H,
  FZK_TERRACE_DOOR_W, FZK_TERRACE_DOOR_H,
  FZK_WINDOW_W, FZK_WINDOW_H, FZK_WINDOW_SILL,
  FZK_OG_WINDOW_W, FZK_OG_WINDOW_H,
} from "../tools/dimensions";
import { addVoidToWallObject } from "../tools/join-groups";
import { onElementCommitted } from "../tools/join-groups";
import { pushAction, pushReplaceAction, beginTransaction, endTransaction } from "../history";
import { resolveCPlane } from "../viewer/cplane";
import { levelStore, getActiveLevelId } from "../geometry/levels";
import { resolveLayerId } from "./shared";

function getActiveLevelElevation(): number {
  return levelStore.get(getActiveLevelId())?.elevation ?? 0;
}

export function registerOpeningHandlers(viewer: Viewer): void {
  registerHandler("SdDoor", (args) => {
    const hostUuidDoor = args.hostUuid as string | undefined;
    let hostObjDoor: THREE.Object3D | undefined = hostUuidDoor
      ? viewer.getScene().getObjectByProperty("uuid", hostUuidDoor) ?? undefined
      : undefined;
    const elevation = getActiveLevelElevation();
    const doorType = (args.doorType as string | undefined);
    let doorW: number;
    let doorH: number;
    if (doorType === "front") {
      doorW = FZK_FRONT_DOOR_W;
      doorH = FZK_FRONT_DOOR_H;
    } else if (doorType === "terrace") {
      doorW = FZK_TERRACE_DOOR_W;
      doorH = FZK_TERRACE_DOOR_H;
    } else if (doorType === "interior") {
      doorW = FZK_DOOR_W;
      doorH = FZK_DOOR_H;
    } else {
      doorW = DEFAULT_DOOR_W;
      doorH = DEFAULT_DOOR_H;
    }
    // §#1516,#1546,#1665: auto-find nearest wall within 3m when hostUuid absent.
    // 3-D distance from the door's expected world center selects the correct floor's
    // wall even when levelId is absent (IFC walls). 2-pass: active level first.
    if (!hostObjDoor) {
      const posArr = args.position as number[] | undefined;
      const doorRef = new THREE.Vector3(posArr?.[0] ?? 0, posArr?.[1] ?? 0, elevation + doorH / 2);
      const activeLvlIdDoor = getActiveLevelId();
      let minDist = 3;
      viewer.forEachSceneChild((child) => {
        const c = child.userData?.creator;
        if (c !== "SdWall" && c !== "wall") return;
        if (child.userData?.levelId !== activeLvlIdDoor) return;
        const wallCenter = new THREE.Box3().setFromObject(child).getCenter(new THREE.Vector3());
        // §#1725: use 2D XY distance — levelId already ensures correct floor.
        const dist = Math.sqrt((doorRef.x - wallCenter.x) ** 2 + (doorRef.y - wallCenter.y) ** 2);
        if (dist < minDist) { minDist = dist; hostObjDoor = child; }
      });
      if (!hostObjDoor) {
        minDist = 3;
        viewer.forEachSceneChild((child) => {
          const c = child.userData?.creator;
          if (c !== "SdWall" && c !== "wall") return;
          const wallCenter = new THREE.Box3().setFromObject(child).getCenter(new THREE.Vector3());
          const dist = doorRef.distanceTo(wallCenter);
          if (dist < minDist) { minDist = dist; hostObjDoor = child; }
        });
      }
    }
    const cplane = resolveCPlane("SdDoor", args as Record<string, unknown>, viewer, hostObjDoor);
    const pos = args.position as number[] | undefined;
    const rawP = { x: pos?.[0] ?? 0, y: pos?.[1] ?? 0 };
    // §#1679: project click onto wall centerline so mesh position and void center share identical world XY.
    let p = rawP;
    if (hostObjDoor) {
      hostObjDoor.updateMatrixWorld(true);
      const lc = hostObjDoor.worldToLocal(new THREE.Vector3(rawP.x, rawP.y, elevation + doorH / 2));
      lc.y = 0;
      const snapped = hostObjDoor.localToWorld(lc);
      p = { x: snapped.x, y: snapped.y };
    }
    const { mesh, chain } = buildDoor(p, { w: doorW, h: doorH });
    mesh.position.z = elevation;
    if (cplane.kind === "host-derived") {
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), cplane.normal);
      mesh.quaternion.copy(q);
    }
    mesh.userData.creator = "door";
    mesh.userData.voidW = doorW;
    mesh.userData.voidH = doorH;
    mesh.userData.cplaneKind = cplane.kind;
    mesh.userData.layerId = resolveLayerId("SdDoor", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    viewer.addMesh(mesh, "brep", { noHistory: true });
    let voidCut = false;
    beginTransaction("SdDoor");
    if (hostObjDoor) {
      const voidCenter = new THREE.Vector3(p.x, p.y, elevation + doorH / 2);
      const voidGroup = addVoidToWallObject(hostObjDoor, voidCenter, doorW, doorH);
      if (voidGroup) {
        pushReplaceAction(voidGroup, [hostObjDoor], "wall-void-cut");
        mesh.userData.hostExpressID = (hostObjDoor.userData as Record<string, unknown>).expressID as string ?? hostObjDoor.uuid;
      }
      voidCut = true;
    }
    pushAction(mesh, chain);
    endTransaction();
    onElementCommitted(mesh, viewer.getScene());
    return { created: "door", voidCut };
  });

  registerHandler("SdWindow", (args) => {
    const hostUuidWin = args.hostUuid as string | undefined;
    let hostObjWin: THREE.Object3D | undefined = hostUuidWin
      ? viewer.getScene().getObjectByProperty("uuid", hostUuidWin) ?? undefined
      : undefined;
    const elevation = getActiveLevelElevation();
    const winType = (args.windowType as string | undefined);
    const isOG = winType === "og";
    const winW    = isOG ? FZK_OG_WINDOW_W : FZK_WINDOW_W;
    const winH    = isOG ? FZK_OG_WINDOW_H : FZK_WINDOW_H;
    const winSill = FZK_WINDOW_SILL;
    // §#1545,#1665: auto-find nearest wall within 3m when hostUuid absent.
    if (!hostObjWin) {
      const posArr = args.position as number[] | undefined;
      const winRef = new THREE.Vector3(posArr?.[0] ?? 0, posArr?.[1] ?? 0, elevation + winSill + winH / 2);
      const activeLvlIdWin = getActiveLevelId();
      let minDist = 3;
      viewer.forEachSceneChild((child) => {
        const c = child.userData?.creator;
        if (c !== "SdWall" && c !== "wall") return;
        if (child.userData?.levelId !== activeLvlIdWin) return;
        const wallCenter = new THREE.Box3().setFromObject(child).getCenter(new THREE.Vector3());
        // §#1725: use 2D XY distance.
        const dist = Math.sqrt((winRef.x - wallCenter.x) ** 2 + (winRef.y - wallCenter.y) ** 2);
        if (dist < minDist) { minDist = dist; hostObjWin = child; }
      });
      if (!hostObjWin) {
        minDist = 3;
        viewer.forEachSceneChild((child) => {
          const c = child.userData?.creator;
          if (c !== "SdWall" && c !== "wall") return;
          const wallCenter = new THREE.Box3().setFromObject(child).getCenter(new THREE.Vector3());
          const dist = winRef.distanceTo(wallCenter);
          if (dist < minDist) { minDist = dist; hostObjWin = child; }
        });
      }
    }
    const cplane = resolveCPlane("SdWindow", args as Record<string, unknown>, viewer, hostObjWin);
    const pos = args.position as number[] | undefined;
    const rawP = { x: pos?.[0] ?? 0, y: pos?.[1] ?? 0 };
    // §#1679: project onto wall centerline.
    let p = rawP;
    if (hostObjWin) {
      hostObjWin.updateMatrixWorld(true);
      const lc = hostObjWin.worldToLocal(new THREE.Vector3(rawP.x, rawP.y, elevation + winSill + winH / 2));
      lc.y = 0;
      const snapped = hostObjWin.localToWorld(lc);
      p = { x: snapped.x, y: snapped.y };
    }
    const { mesh, chain } = buildWindow(p, { w: winW, h: winH, sill: winSill });
    mesh.position.z = elevation + mesh.position.z;
    if (cplane.kind === "host-derived") {
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), cplane.normal);
      mesh.quaternion.copy(q);
    }
    mesh.userData.creator = "window";
    mesh.userData.voidW = winW;
    mesh.userData.voidH = winH;
    mesh.userData.cplaneKind = cplane.kind;
    mesh.userData.layerId = resolveLayerId("SdWindow", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    viewer.addMesh(mesh, "brep", { noHistory: true });
    let voidCut = false;
    beginTransaction("SdWindow");
    if (hostObjWin) {
      // §#1518: addVoidToWallObject handles Mesh + Group walls.
      // §#1679: voidCenter from same p as mesh position.
      const voidCenter = new THREE.Vector3(p.x, p.y, elevation + winSill + winH / 2);
      const voidGroup = addVoidToWallObject(hostObjWin, voidCenter, winW, winH);
      if (voidGroup) {
        pushReplaceAction(voidGroup, [hostObjWin], "wall-void-cut");
        mesh.userData.hostExpressID = (hostObjWin.userData as Record<string, unknown>).expressID as string ?? hostObjWin.uuid;
      }
      voidCut = true;
    }
    pushAction(mesh, chain);
    endTransaction();
    onElementCommitted(mesh, viewer.getScene());
    return { created: "window", voidCut };
  });

  registerHandler("SdOpening", (args) => {
    const hostUuidOp = args.hostUuid as string | undefined;
    const hostObjOp = hostUuidOp
      ? viewer.getScene().getObjectByProperty("uuid", hostUuidOp) ?? undefined
      : undefined;
    const cplane = resolveCPlane("SdOpening", args as Record<string, unknown>, viewer, hostObjOp);
    const pos = args.position as number[] | undefined;
    const elevation = getActiveLevelElevation();
    const p = { x: pos?.[0] ?? 0, y: pos?.[1] ?? 0 };
    const { mesh, chain } = buildOpening(p);
    mesh.position.z = elevation;
    if (cplane.kind === "host-derived") {
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), cplane.normal);
      mesh.quaternion.copy(q);
    }
    mesh.userData.creator = "opening";
    mesh.userData.cplaneKind = cplane.kind;
    mesh.userData.layerId = resolveLayerId("SdOpening", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    viewer.addMesh(mesh, "brep", { noHistory: true });
    let voidCut = false;
    beginTransaction("SdOpening");
    if (hostUuidOp) {
      const host = viewer.getScene().getObjectByProperty("uuid", hostUuidOp);
      if (host instanceof THREE.Mesh || host instanceof THREE.Group) {
        const voidCenter = mesh.position.clone();
        voidCenter.z = elevation + 1;
        const voidGroup = addVoidToWallObject(host, voidCenter, 1, 2);
        if (voidGroup) pushReplaceAction(voidGroup, [host], "wall-void-cut");
        voidCut = true;
      }
    }
    pushAction(mesh, chain);
    endTransaction();
    return { created: "opening", voidCut };
  });
}
