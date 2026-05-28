import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import * as THREE from "three";
import type { Viewer } from "../web/src/viewer/viewer";

const OUT = "web/public/samples/AC20-FZK-Haus.webcad";

(globalThis as { window?: unknown }).window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};

const { dispatchSync } = await import("../web/src/commands/dispatch");
const { createCanonicalGeometryStore } = await import("../web/src/geometry/canonical-geometry");
const { registerStructuralHandlers } = await import("../web/src/handlers/structural");
const { registerOpeningHandlers } = await import("../web/src/handlers/openings");
const { registerSketchHandlers } = await import("../web/src/handlers/sketch");
const { __sceneSerializationForTests } = await import("../web/src/viewer/viewer");
const { WORLD_XY } = await import("../web/src/viewer/cplane");

const scene = new THREE.Scene();
const canonicalStore = createCanonicalGeometryStore();

const viewer = {
  activeView: "top",
  activeCPlane: WORLD_XY,
  getCanonicalGeometryStore() {
    return canonicalStore;
  },
  getCanonicalGeometryForObject(obj: THREE.Object3D) {
    return canonicalStore.resolveObjectOrAncestor(obj);
  },
  addMesh(obj: THREE.Object3D, kind?: string) {
    if (kind) obj.userData.kind = kind;
    scene.add(obj);
  },
  getScene() {
    return scene;
  },
  forEachSceneChild(cb: (obj: THREE.Object3D) => void) {
    for (const child of scene.children) cb(child);
  },
} as unknown as Viewer;

function run(verb: string, args: Record<string, unknown>): void {
  const result = dispatchSync(verb, args);
  if (!result.ok) {
    throw new Error(`${verb} failed: ${result.detail ?? result.error}`);
  }
}

registerStructuralHandlers(viewer);
registerOpeningHandlers(viewer);
registerSketchHandlers(viewer);

const footprint = [
  [-6, -5, 0],
  [6, -5, 0],
  [6, 5, 0],
  [-6, 5, 0],
];

run("SdSlab", { profile: footprint, thickness: 0.2, elevation: 0 });
run("SdWall", { start: { x: -6, y: -5 }, end: { x: 6, y: -5 }, height: 3 });
run("SdWall", { start: { x: 6, y: -5 }, end: { x: 6, y: 5 }, height: 3 });
run("SdWall", { start: { x: 6, y: 5 }, end: { x: -6, y: 5 }, height: 3 });
run("SdWall", { start: { x: -6, y: 5 }, end: { x: -6, y: -5 }, height: 3 });
run("SdPlane", {
  origin: [-6.5, -5.5, 3],
  xAxis: [6.5, -5.5, 3],
  yAxis: [-6.5, 0, 5.886751345948129],
});
run("SdPlane", {
  origin: [-6.5, 0, 5.886751345948129],
  xAxis: [6.5, 0, 5.886751345948129],
  yAxis: [-6.5, 5.5, 3],
});
run("SdDoor", { position: [0, -5, 0], doorType: "front" });
run("SdWindow", { position: [-3, -5, 0], windowType: "eg" });
run("SdWindow", { position: [3, -5, 0], windowType: "eg" });
run("SdWindow", { position: [-6, 0, 0], windowType: "eg" });
run("SdWindow", { position: [6, 0, 0], windowType: "eg" });

const objects = scene.children
  .map((obj) => __sceneSerializationForTests.serializeSceneObj(obj))
  .filter(Boolean);

const payload = {
  format: "web-cad.canonical-project",
  version: 2,
  meta: {
    units: "metric",
    name: "KIT FZK-Haus canonical BRep",
    sourceIfc: "samples/AC20-FZK-Haus.ifc",
    conversion: "static-parametric-brep-snapshot",
    note: "Static WEB-CAD canonical BRep/NURBS-ready project fixture generated from FZK-Haus dimensions; selector loads this project instead of dynamic raw IFC triangulation.",
  },
  canonicalGeometry: canonicalStore.exportRecords(),
  objects,
};

mkdirSync("web/public/samples", { recursive: true });
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`${OUT}: ${payload.canonicalGeometry.length} canonical records, ${objects.length} scene objects`);
