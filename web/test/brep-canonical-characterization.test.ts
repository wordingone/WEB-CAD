import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { dispatchSync, unregisterHandler } from "../src/commands/dispatch";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
  type CanonicalGeometryStore,
} from "../src/geometry/canonical-geometry";
import { registerBrepOpHandlers } from "../src/handlers/brep-ops";
import { registerNurbsHandlers } from "../src/handlers/nurbs";
import { registerOpeningHandlers } from "../src/handlers/openings";
import { registerStructuralHandlers } from "../src/handlers/structural";
import { linkOpToolExtrudeCanonical } from "../src/viewer/op-tool-canonical";
import { WORLD_XY } from "../src/viewer/cplane";
import type { Viewer } from "../src/viewer/viewer";

function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
}

function makeViewer(): {
  viewer: Viewer;
  scene: THREE.Scene;
  store: CanonicalGeometryStore;
  lastObject: () => THREE.Object3D | null;
} {
  const scene = new THREE.Scene();
  const store = createCanonicalGeometryStore();
  let last: THREE.Object3D | null = null;
  const viewer = {
    activeView: "top",
    activeCPlane: WORLD_XY,
    getCanonicalGeometryStore() {
      return store;
    },
    addMesh(obj: THREE.Object3D, kind?: string) {
      if (kind) obj.userData.kind = kind;
      last = obj;
      scene.add(obj);
    },
    getScene() {
      return scene;
    },
    forEachSceneChild(cb: (obj: THREE.Object3D) => void) {
      for (const child of scene.children) cb(child);
    },
  } as unknown as Viewer;
  return { viewer, scene, store, lastObject: () => last };
}

beforeEach(() => {
  for (const name of [
    "SdBox", "SdSphere", "SdCylinder", "SdCone", "SdExtrude",
    "SdWall", "SdSlab", "SdColumn", "SdBeam", "SdSpace",
    "SdFoundation", "SdCeiling", "SdSkylight", "SdRailing",
    "SdMember", "SdPlate", "SdRamp", "SdCurtainWall",
    "SdStair", "SdRoof",
    "SdDoor", "SdWindow", "SdOpening",
    "SdJoin", "SdExplode", "SdContour",
  ]) {
    unregisterHandler(name);
  }
});

describe("BRep canonical migration characterization", () => {
  test("analytic solid primitive commands keep display meshes while linking closed canonical BReps", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);

    for (const [verb, args, creator] of [
      ["SdSphere", { radius: 2 }, "sphere"],
      ["SdCylinder", { radius: 0.75, height: 3 }, "cylinder"],
      ["SdCone", { radius: 0.75, height: 3 }, "cone"],
    ] as const) {
      const result = dispatchSync(verb, args);
      expect(result.ok).toBe(true);

      const obj = lastObject();
      expect(obj).toBeInstanceOf(THREE.Mesh);
      const mesh = obj as THREE.Mesh;
      expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
      expect(mesh.userData.kind).toBe("brep");
      expect(mesh.userData.creator).toBe(creator);
      expect(mesh.userData.nurbsSurface).toBeUndefined();
      expect(mesh.userData.nurbsKind).toBeUndefined();
      const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
      expect(typeof canonicalId).toBe("string");
      const canonical = store.require(canonicalId as string);
      expect(canonical.kind).toBe("brep");
      expect(canonical.createdBy).toBe(verb);
      if (canonical.kind !== "brep") throw new Error("expected canonical brep");
      expect(canonical.brep.shells).toHaveLength(1);
      const shell = canonical.brep.shells[0];
      expect(shell.isClosed).toBe(true);
      expect(shell.faces[0].surface.kind).toBe("rev");
      if (verb === "SdSphere") {
        expect(shell.faces).toHaveLength(1);
        expect(shell.edges).toHaveLength(0);
      } else if (verb === "SdCylinder") {
        expect(shell.faces.map((face) => face.surface.kind)).toEqual(["rev", "plane", "plane"]);
        expect(shell.edges).toHaveLength(2);
        expect(shell.edges.every((edge) => edge.faceIndex2 !== null)).toBe(true);
      } else {
        expect(shell.faces.map((face) => face.surface.kind)).toEqual(["rev", "plane"]);
        expect(shell.edges).toHaveLength(1);
        expect(shell.edges.every((edge) => edge.faceIndex2 !== null)).toBe(true);
      }
    }
  });

  test("SdBox keeps its display mesh while linking a canonical extruded BRep", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);

    const result = dispatchSync("SdBox", { width: 2, depth: 3, height: 4 });
    expect(result.ok).toBe(true);

    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Mesh);
    const mesh = obj as THREE.Mesh;
    expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(mesh.userData.kind).toBe("brep");
    expect(mesh.userData.creator).toBe("box");
    expect(mesh.userData.nurbsSurface).toBeUndefined();
    expect(mesh.userData.nurbsKind).toBeUndefined();
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("brep");
    expect(canonical.createdBy).toBe("SdBox");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    expect(canonical.brep.shells).toHaveLength(1);
    expect(canonical.brep.shells[0].faces).toHaveLength(6);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
  });

  test("SdExtrude links profile extrusion output to a canonical BRep", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);

    const result = dispatchSync("SdExtrude", {
      profile: [[0, 0], [2, 0], [2, 1], [0, 1]],
      distance: 3,
    });
    expect(result.ok).toBe(true);

    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Mesh);
    const mesh = obj as THREE.Mesh;
    expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(mesh.userData.kind).toBe("brep");
    expect(mesh.userData.creator).toBe("extrude");
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("brep");
    expect(canonical.createdBy).toBe("SdExtrude");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    expect(canonical.brep.shells).toHaveLength(1);
    expect(canonical.brep.shells[0].faces).toHaveLength(6);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
  });

  test("SdExtrude resolves selected profiles from canonical curves before display BufferGeometry", () => {
    const { viewer, scene, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);
    const profile = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    profile.name = "canonical-rect-profile";
    scene.add(profile);
    const record = store.create({
      kind: "curve",
      curve: {
        kind: "polyline",
        points: [
          { x: 0, y: 0, z: 0 },
          { x: 2, y: 0, z: 0 },
          { x: 2, y: 1, z: 0 },
          { x: 0, y: 1, z: 0 },
          { x: 0, y: 0, z: 0 },
        ],
        parameters: [0, 2, 3, 5, 6],
      },
      source: "command",
      createdBy: "test-profile",
      displayMesh: { revision: 1, generatedAt: 0, vertexCount: 0, derivation: "tessellated-curve" },
    });
    store.linkObject(profile, record.id);

    const result = dispatchSync("SdExtrude", {
      object_id: "canonical-rect-profile",
      distance: 3,
    });
    expect(result.ok).toBe(true);

    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Mesh);
    const canonical = obj ? store.resolveObject(obj) : undefined;
    expect(canonical?.kind).toBe("brep");
    if (canonical?.kind !== "brep") throw new Error("expected canonical brep");
    expect(canonical.createdBy).toBe("SdExtrude");
    expect(canonical.brep.shells[0].faces).toHaveLength(6);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
  });

  test("simple structural commands keep display meshes while linking canonical extruded BReps", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerStructuralHandlers(viewer);

    for (const [verb, args] of [
      ["SdWall", { length: 4, height: 3 }],
      ["SdSlab", { width: 4, depth: 3, thickness: 0.2 }],
      ["SdColumn", { position: [1, 2, 0], height: 4 }],
    ] as const) {
      const result = dispatchSync(verb, args);
      expect(result.ok).toBe(true);
      const obj = lastObject();
      expect(obj).toBeInstanceOf(THREE.Mesh);
      expect(obj?.userData.nurbsSurface).toBeUndefined();
      expect(obj?.userData.nurbsKind).toBeUndefined();
      const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
      expect(typeof canonicalId).toBe("string");
      const canonical = store.require(canonicalId as string);
      expect(canonical.kind).toBe("brep");
      expect(canonical.createdBy).toBe(verb);
      if (canonical.kind !== "brep") throw new Error("expected canonical brep");
      expect(canonical.brep.shells).toHaveLength(1);
      expect(canonical.brep.shells[0].faces).toHaveLength(6);
      expect(canonical.brep.shells[0].isClosed).toBe(true);
    }
  });

  test("pitched walls keep their gable display mesh while linking a canonical extruded BRep", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerStructuralHandlers(viewer);

    const result = dispatchSync("SdWall", {
      length: 6,
      topProfile: "pitched",
      eaveHeight: 3,
      ridgeHeight: 1.5,
    });
    expect(result.ok).toBe(true);

    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Mesh);
    expect(obj?.userData.topProfile).toBe("pitched");
    const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("brep");
    expect(canonical.createdBy).toBe("SdWall");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    expect(canonical.brep.shells).toHaveLength(1);
    expect(canonical.brep.shells[0].faces).toHaveLength(7);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
    const apexFace = canonical.brep.shells[0].faces.find((face) => (
      face.surface.kind === "sum"
      && face.surface.curveU.kind === "line"
      && face.surface.curveU.to.z === 4.5
    ));
    expect(apexFace).toBeDefined();
  });

  test("additional box-like structural commands link canonical extruded BReps", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerStructuralHandlers(viewer);

    for (const [verb, args] of [
      ["SdBeam", { start: [0, 0], end: [4, 0] }],
      ["SdSpace", { width: 4, depth: 3 }],
      ["SdFoundation", { width: 4, depth: 3 }],
      ["SdCeiling", { width: 4, depth: 3 }],
      ["SdSkylight", { width: 1.2, depth: 0.8 }],
      ["SdRailing", { start: [0, 0], end: [3, 0] }],
      ["SdMember", { length: 2, profile: [[0, 0], [1, 0], [1, 0.5], [0, 0.5]] }],
      ["SdPlate", { thickness: 0.1, profile: [[0, 0], [1, 0], [1, 1], [0, 1]] }],
    ] as const) {
      const result = dispatchSync(verb, args);
      expect(result.ok).toBe(true);
      const obj = lastObject();
      expect(obj).toBeInstanceOf(THREE.Mesh);
      const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
      expect(typeof canonicalId).toBe("string");
      const canonical = store.require(canonicalId as string);
      expect(canonical.kind).toBe("brep");
      expect(canonical.createdBy).toBe(verb);
      if (canonical.kind !== "brep") throw new Error("expected canonical brep");
      expect(canonical.brep.shells).toHaveLength(1);
      expect(canonical.brep.shells[0].faces).toHaveLength(6);
      expect(canonical.brep.shells[0].isClosed).toBe(true);
    }
  });

  test("SdRamp links its existing display solid to a canonical extruded BRep", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerStructuralHandlers(viewer);

    const result = dispatchSync("SdRamp", { start: [0, 0], end: [6, 0] });

    expect(result.ok).toBe(true);
    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Mesh);
    expect(obj?.userData.kind).toBe("brep");
    expect(obj?.userData.creator).toBe("ramp");
    const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("brep");
    expect(canonical.createdBy).toBe("SdRamp");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    expect(canonical.metadata).toMatchObject({ creator: "ramp", levelId: "level/0" });
    expect(canonical.brep.shells).toHaveLength(1);
    expect(canonical.brep.shells[0].faces).toHaveLength(6);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
    const zValues = canonical.brep.shells[0].vertices.map((vertex) => vertex.point.z).sort((a, b) => a - b);
    expect(zValues[0]).toBeCloseTo(0.175);
    expect(zValues[zValues.length - 1]).toBeCloseTo(0.325);
  });

  test("SdCurtainWall links visible group and join shell to one canonical envelope BRep", () => {
    const { viewer, scene, store } = makeViewer();
    registerStructuralHandlers(viewer);

    const result = dispatchSync("SdCurtainWall", { start: [0, 0], end: [6, 0] });

    expect(result.ok).toBe(true);
    const group = scene.children.find((obj) => obj.userData.creator === "curtainwall" && obj instanceof THREE.Group);
    expect(group).toBeInstanceOf(THREE.Group);
    const shell = scene.children.find((obj) => obj.userData.creator === "curtainwall" && obj.userData.isJoinShell);
    expect(shell).toBeInstanceOf(THREE.Mesh);
    expect(shell?.visible).toBe(false);

    const groupRecord = group ? store.resolveObject(group) : undefined;
    const shellRecord = shell ? store.resolveObject(shell) : undefined;
    expect(groupRecord?.kind).toBe("brep");
    expect(shellRecord).toBe(groupRecord);
    if (groupRecord?.kind !== "brep") throw new Error("expected canonical brep");
    expect(groupRecord.createdBy).toBe("SdCurtainWall");
    expect(groupRecord.metadata).toMatchObject({ creator: "curtainwall", levelId: "level/0" });
    expect(groupRecord.brep.shells).toHaveLength(1);
    expect(groupRecord.brep.shells[0].faces).toHaveLength(6);
    expect(groupRecord.brep.shells[0].isClosed).toBe(true);
  });

  test("compound structural commands link displayed subcomponents to canonical BReps", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerStructuralHandlers(viewer);

    for (const [verb, args, createdBy] of [
      ["SdStair", { start: [0, 0], end: [4, 3] }, "SdStairComponent"],
      ["SdRoof", { footprint: [[-2, -1.5], [2, 1.5]], roofType: "pitched" }, "SdRoofComponent"],
    ] as const) {
      const result = dispatchSync(verb, args);
      expect(result.ok).toBe(true);
      const obj = lastObject();
      expect(obj).toBeInstanceOf(THREE.Group);

      const linkedRecords = new Set<string>();
      obj?.traverse((child) => {
        const canonical = store.resolveObject(child);
        if (!canonical) return;
        expect(canonical.kind).toBe("brep");
        if (canonical.kind !== "brep") throw new Error(`expected canonical brep for ${verb} subcomponent`);
        expect(canonical.createdBy).toBe(createdBy);
        expect(canonical.metadata).toMatchObject({ derivation: "planarized-display-mesh" });
        expect(canonical.brep.shells[0].faces.length).toBeGreaterThan(0);
        linkedRecords.add(canonical.id);
      });
      expect(linkedRecords.size).toBeGreaterThan(0);
    }
  });

  test("opening commands link display objects to canonical BRep envelopes", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerOpeningHandlers(viewer);

    for (const [verb, args] of [
      ["SdDoor", { position: [0, 0], doorType: "interior" }],
      ["SdWindow", { position: [2, 0], windowType: "eg" }],
      ["SdOpening", { position: [4, 0] }],
    ] as const) {
      const result = dispatchSync(verb, args);
      expect(result.ok).toBe(true);
      const obj = lastObject();
      expect(obj).toBeInstanceOf(THREE.Object3D);
      const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
      expect(typeof canonicalId).toBe("string");
      const canonical = store.require(canonicalId as string);
      expect(canonical.kind).toBe("brep");
      expect(canonical.createdBy).toBe(verb);
      if (canonical.kind !== "brep") throw new Error("expected canonical brep");
      expect(canonical.brep.shells).toHaveLength(1);
      expect(canonical.brep.shells[0].faces).toHaveLength(6);
      expect(canonical.brep.shells[0].isClosed).toBe(true);
    }
  });

  test("join and explode preserve canonical BRep edit results", () => {
    const { viewer, scene, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);
    registerBrepOpHandlers(viewer);

    expect(dispatchSync("SdBox", { width: 1, depth: 1, height: 1 }).ok).toBe(true);
    const first = lastObject();
    expect(first).toBeInstanceOf(THREE.Mesh);
    expect(dispatchSync("SdBox", { width: 1, depth: 1, height: 1 }).ok).toBe(true);
    const second = lastObject();
    expect(second).toBeInstanceOf(THREE.Mesh);
    second?.position.set(2, 0, 0);
    second?.updateMatrixWorld(true);

    const joinResult = dispatchSync("SdJoin", { targets: [first?.uuid, second?.uuid] });
    expect(joinResult.ok).toBe(true);
    if (!joinResult.ok) throw new Error("expected join to succeed");
    const joined = scene.getObjectByProperty("uuid", (joinResult.result as { created: string }).created);
    expect(joined).toBeInstanceOf(THREE.Mesh);
    const joinedCanonicalId = joined?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof joinedCanonicalId).toBe("string");
    const joinedCanonical = store.require(joinedCanonicalId as string);
    expect(joinedCanonical.kind).toBe("brep");
    expect(joinedCanonical.createdBy).toBe("SdJoin");
    if (joinedCanonical.kind !== "brep") throw new Error("expected joined canonical brep");
    expect(joinedCanonical.brep.shells).toHaveLength(2);

    const explodeResult = dispatchSync("SdExplode", { target: joined?.uuid });
    expect(explodeResult.ok).toBe(true);
    if (!explodeResult.ok) throw new Error("expected explode to succeed");
    const explodedResult = explodeResult.result as { exploded: string[]; faceCount: number; source: string };
    expect(explodedResult.source).toBe("canonical-brep");
    expect(explodedResult.faceCount).toBe(12);
    const explodedIds = explodedResult.exploded;
    expect(explodedIds).toHaveLength(12);
    const exploded = scene.getObjectByProperty("uuid", explodedIds[0]);
    expect(exploded).toBeInstanceOf(THREE.Mesh);
    const explodedCanonicalId = exploded?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof explodedCanonicalId).toBe("string");
    const explodedCanonical = store.require(explodedCanonicalId as string);
    expect(explodedCanonical.kind).toBe("brep");
    expect(explodedCanonical.createdBy).toBe("SdExplode");
    if (explodedCanonical.kind !== "brep") throw new Error("expected exploded canonical brep");
    expect(explodedCanonical.brep.shells).toHaveLength(1);
    expect(explodedCanonical.brep.shells[0].faces).toHaveLength(1);
    expect(explodedCanonical.brep.shells[0].isClosed).toBe(false);
    let maxX = -Infinity;
    for (const id of explodedIds) {
      const faceObj = scene.getObjectByProperty("uuid", id) as THREE.Mesh | undefined;
      expect(faceObj).toBeInstanceOf(THREE.Mesh);
      const position = faceObj?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      expect(position?.count).toBeGreaterThanOrEqual(3);
      for (let i = 0; position && i < position.count; i++) maxX = Math.max(maxX, position.getX(i));
      const record = faceObj ? store.resolveObject(faceObj) : undefined;
      expect(record?.kind).toBe("brep");
      if (record?.kind !== "brep") throw new Error("expected exploded face canonical brep");
      expect(record.createdBy).toBe("SdExplode");
      expect(record.metadata?.operation).toBe("explode-face");
      expect(record.brep.shells[0].faces).toHaveLength(1);
      expect(record.brep.shells[0].isClosed).toBe(false);
      expect(record.brep.shells[0].edges.length).toBeGreaterThanOrEqual(4);
      expect(record.brep.shells[0].vertices.length).toBe(record.brep.shells[0].edges.length);
      expect(record.brep.shells[0].edges.every((edge) => edge.faceIndex1 === 0 && edge.faceIndex2 === null)).toBe(true);
      expect(record.brep.shells[0].vertices.every((vertex) => vertex.edgeIndices.length === 2)).toBe(true);
    }
    expect(maxX).toBeGreaterThan(1.5);
  });

  test("join resolves child mesh targets through canonical BRep ancestors", () => {
    const { viewer, scene, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);
    registerBrepOpHandlers(viewer);

    expect(dispatchSync("SdBox", { width: 1, depth: 1, height: 1 }).ok).toBe(true);
    const first = lastObject() as THREE.Mesh;
    const firstRecord = store.resolveObject(first);
    if (firstRecord?.kind !== "brep") throw new Error("expected first canonical brep");
    expect(dispatchSync("SdBox", { width: 1, depth: 1, height: 1 }).ok).toBe(true);
    const second = lastObject() as THREE.Mesh;
    const secondRecord = store.resolveObject(second);
    if (secondRecord?.kind !== "brep") throw new Error("expected second canonical brep");
    second.position.set(2, 0, 0);
    second.updateMatrixWorld(true);

    const firstGroup = new THREE.Group();
    const secondGroup = new THREE.Group();
    scene.remove(first);
    scene.remove(second);
    firstGroup.add(first);
    secondGroup.add(second);
    scene.add(firstGroup, secondGroup);
    store.unlinkObject(first);
    store.unlinkObject(second);
    store.linkObject(firstGroup, firstRecord.id);
    store.linkObject(secondGroup, secondRecord.id);

    const joinResult = dispatchSync("SdJoin", { targets: [first.uuid, second.uuid] });
    expect(joinResult.ok).toBe(true);
    if (!joinResult.ok) throw new Error("expected join to succeed");
    const joined = scene.getObjectByProperty("uuid", (joinResult.result as { created: string }).created);
    const joinedCanonical = joined ? store.resolveObject(joined) : undefined;
    expect(joinedCanonical?.kind).toBe("brep");
    if (joinedCanonical?.kind !== "brep") throw new Error("expected joined canonical brep");
    expect(joinedCanonical.brep.shells).toHaveLength(2);
    expect(joinedCanonical.metadata).toMatchObject({
      operands: [firstRecord.id, secondRecord.id],
    });
  });

  test("SdJoin creates display geometry from canonical BReps without operand BufferGeometry", () => {
    const { viewer, scene, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);
    registerBrepOpHandlers(viewer);

    expect(dispatchSync("SdBox", { width: 1, depth: 1, height: 1 }).ok).toBe(true);
    const first = lastObject() as THREE.Mesh;
    expect(dispatchSync("SdBox", { width: 1, depth: 1, height: 1 }).ok).toBe(true);
    const second = lastObject() as THREE.Mesh;
    second.position.set(2, 0, 0);
    second.updateMatrixWorld(true);
    first.geometry = new THREE.BufferGeometry();
    second.geometry = new THREE.BufferGeometry();

    const joinResult = dispatchSync("SdJoin", { targets: [first.uuid, second.uuid] });

    expect(joinResult.ok).toBe(true);
    if (!joinResult.ok) throw new Error("expected join to succeed");
    expect((joinResult.result as { displaySource?: string }).displaySource).toBe("canonical-brep");
    const joined = scene.getObjectByProperty("uuid", (joinResult.result as { created: string }).created);
    expect(joined).toBeInstanceOf(THREE.Mesh);
    const position = (joined as THREE.Mesh).geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    expect(position?.count).toBeGreaterThan(0);
    const joinedRecord = joined ? store.resolveObject(joined) : undefined;
    expect(joinedRecord?.kind).toBe("brep");
    if (joinedRecord?.kind !== "brep") throw new Error("expected joined canonical brep");
    expect(joinedRecord.metadata?.displaySource).toBe("canonical-brep");
    expect(joinedRecord.brep.shells).toHaveLength(2);
  });

  test("joining exploded BRep faces welds coincident boundary edges into a closed shell", () => {
    const { viewer, scene, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);
    registerBrepOpHandlers(viewer);

    expect(dispatchSync("SdBox", { width: 2, depth: 2, height: 2 }).ok).toBe(true);
    const box = lastObject();
    expect(box).toBeInstanceOf(THREE.Mesh);
    const explodeResult = dispatchSync("SdExplode", { target: box?.uuid });
    expect(explodeResult.ok).toBe(true);
    if (!explodeResult.ok) throw new Error("expected explode to succeed");
    const explodedIds = (explodeResult.result as { exploded: string[] }).exploded;
    expect(explodedIds).toHaveLength(6);

    const joinResult = dispatchSync("SdJoin", { targets: explodedIds });

    expect(joinResult.ok).toBe(true);
    if (!joinResult.ok) throw new Error("expected join to succeed");
    const joined = scene.getObjectByProperty("uuid", (joinResult.result as { created: string }).created);
    expect(joined).toBeInstanceOf(THREE.Mesh);
    const joinedRecord = joined ? store.resolveObject(joined) : undefined;
    expect(joinedRecord?.kind).toBe("brep");
    if (joinedRecord?.kind !== "brep") throw new Error("expected joined canonical brep");
    expect(joinedRecord.metadata?.topology).toBe("welded-coincident-boundary-edges");
    expect(joinedRecord.brep.shells).toHaveLength(1);
    const shell = joinedRecord.brep.shells[0];
    expect(shell.faces).toHaveLength(6);
    expect(shell.edges).toHaveLength(12);
    expect(shell.vertices).toHaveLength(8);
    expect(shell.isClosed).toBe(true);
    expect(shell.edges.every((edge) => edge.faceIndex2 !== null)).toBe(true);
    expect(shell.vertices.every((vertex) => vertex.edgeIndices.length === 3)).toBe(true);
  });

  test("SdContour stitches BRep face intersections into linked canonical contour loops", () => {
    const { viewer, scene, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);
    registerBrepOpHandlers(viewer);

    expect(dispatchSync("SdBox", { width: 2, depth: 2, height: 2 }).ok).toBe(true);
    const box = lastObject();
    expect(box).toBeInstanceOf(THREE.Mesh);
    const before = new Set(scene.children.map((child) => child.uuid));

    const contourResult = dispatchSync("SdContour", { target: box?.uuid, interval: 0, count: 1 });

    expect(contourResult.ok).toBe(true);
    if (!contourResult.ok) throw new Error("expected contour to succeed");
    const result = contourResult.result as { source: string; created: string[]; sliceCount: number; contourLevels: number[] };
    expect(result.source).toBe("canonical-brep");
    expect(result.sliceCount).toBe(1);
    expect(result.contourLevels).toHaveLength(1);
    expect(result.created).toHaveLength(1);

    const created = scene.children.filter((child) => !before.has(child.uuid));
    expect(created).toHaveLength(1);
    for (const obj of created) {
      expect(obj).toBeInstanceOf(THREE.Line);
      expect(obj.userData.kind).toBe("curve");
      expect(obj.userData.creator).toBe("contour");
      const record = store.resolveObject(obj);
      expect(record?.kind).toBe("curve");
      if (record?.kind !== "curve") throw new Error("expected contour canonical curve");
      expect(record.createdBy).toBe("SdContour");
      expect(record.metadata?.operation).toBe("contour");
      expect(record.metadata?.closed).toBe(true);
      expect(record.metadata?.segmentCount).toBe(4);
      expect(record.curve.kind).toBe("polyline");
      if (record.curve.kind !== "polyline") throw new Error("expected polyline contour");
      expect(record.curve.points).toHaveLength(5);
      expect(record.curve.points.every((point) => Math.abs(point.z - result.contourLevels[0]) < 1e-9)).toBe(true);
      expect(record.curve.points[0]).toEqual(record.curve.points[record.curve.points.length - 1]);
    }
  });

  test("SdContour works after joining boxes and rebuilding the joined BRep to NURBS faces", () => {
    const { viewer, scene, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);
    registerBrepOpHandlers(viewer);

    expect(dispatchSync("SdBox", { width: 1, depth: 1, height: 1 }).ok).toBe(true);
    const first = lastObject();
    expect(first).toBeInstanceOf(THREE.Mesh);
    expect(dispatchSync("SdBox", { width: 1, depth: 1, height: 1 }).ok).toBe(true);
    const second = lastObject();
    expect(second).toBeInstanceOf(THREE.Mesh);
    second?.position.set(2, 0, 0);
    second?.updateMatrixWorld(true);

    const joinResult = dispatchSync("SdJoin", { targets: [first?.uuid, second?.uuid] });
    expect(joinResult.ok).toBe(true);
    if (!joinResult.ok) throw new Error("expected join to succeed");
    const joined = scene.getObjectByProperty("uuid", (joinResult.result as { created: string }).created);
    expect(joined).toBeInstanceOf(THREE.Mesh);

    const rebuildResult = dispatchSync("SdRebuild", { target: joined?.uuid });
    expect(rebuildResult.ok).toBe(true);
    if (!rebuildResult.ok) throw new Error("expected rebuild to succeed");
    const rebuilt = scene.getObjectByProperty("uuid", (rebuildResult.result as { rebuilt: string }).rebuilt);
    expect(rebuilt).toBeInstanceOf(THREE.Mesh);

    const contourResult = dispatchSync("SdContour", { target: rebuilt?.uuid, interval: 0, count: 1 });

    expect(contourResult.ok).toBe(true);
    if (!contourResult.ok) throw new Error("expected contour to succeed");
    const result = contourResult.result as { source: string; created: string[]; sliceCount: number };
    expect(result.source).toBe("canonical-brep");
    expect(result.sliceCount).toBe(1);
    expect(result.created.length).toBeGreaterThan(0);
  });

  test("SdRebuild replaces a canonical BRep with NURBS-form face surfaces", () => {
    const { viewer, scene, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);
    registerBrepOpHandlers(viewer);

    expect(dispatchSync("SdBox", { width: 2, depth: 2, height: 2 }).ok).toBe(true);
    const box = lastObject();
    expect(box).toBeInstanceOf(THREE.Mesh);
    const sourceRecord = box ? store.resolveObject(box) : undefined;
    expect(sourceRecord?.kind).toBe("brep");
    if (sourceRecord?.kind !== "brep") throw new Error("expected source BRep");
    expect(sourceRecord.brep.shells[0].faces.some((face) => face.surface.kind !== "nurbs")).toBe(true);

    const rebuildResult = dispatchSync("SdRebuild", { target: box?.uuid });

    expect(rebuildResult.ok).toBe(true);
    if (!rebuildResult.ok) throw new Error("expected rebuild to succeed");
    const result = rebuildResult.result as { rebuilt: string; original: string; source: string; surfaceKind: string; originalFaces: number; rebuiltFaces: number };
    expect(result.source).toBe("canonical-brep");
    expect(result.surfaceKind).toBe("nurbs");
    expect(result.original).toBe(box!.uuid);
    expect(result.originalFaces).toBe(6);
    expect(result.rebuiltFaces).toBe(6);
    expect(scene.getObjectByProperty("uuid", box!.uuid)).toBeUndefined();
    const rebuilt = scene.getObjectByProperty("uuid", result.rebuilt);
    expect(rebuilt).toBeInstanceOf(THREE.Mesh);
    const rebuiltRecord = rebuilt ? store.resolveObject(rebuilt) : undefined;
    expect(rebuiltRecord?.kind).toBe("brep");
    if (rebuiltRecord?.kind !== "brep") throw new Error("expected rebuilt BRep");
    expect(rebuiltRecord.createdBy).toBe("SdRebuild");
    expect(rebuiltRecord.metadata?.operation).toBe("rebuild-nurbs");
    expect(rebuiltRecord.metadata?.source).toBe(sourceRecord.id);
    expect(rebuiltRecord.brep.shells).toHaveLength(1);
    expect(rebuiltRecord.brep.shells[0].faces).toHaveLength(6);
    expect(rebuiltRecord.brep.shells[0].faces.every((face) => face.surface.kind === "nurbs")).toBe(true);
    const rebuiltPosition = (rebuilt as THREE.Mesh).geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(rebuiltPosition.count).toBeGreaterThan(0);
  });

  test("top-level handler registration delegates BRep tools to the canonical BRep-op module only", () => {
    const registerHandlers = source("register-handlers.ts");

    expect(registerHandlers).toContain("registerBrepOpHandlers(viewer)");
    expect(registerHandlers.match(/registerHandler\("Sd(?:Explode|Join|Rebuild|Contour)"/g) ?? []).toHaveLength(0);
    expect(registerHandlers).not.toContain("full NURBS reparameterisation deferred");
  });

  test("op-tool extrude meshes can link to canonical BReps from retained footprints", () => {
    const { viewer, store } = makeViewer();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1, 3).translate(1, 0.5, 1.5),
      new THREE.MeshStandardMaterial(),
    );
    mesh.userData.kind = "brep";
    mesh.userData.creator = "extrude";
    mesh.userData.footprintPts = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 0, y: 1 },
    ];

    expect(linkOpToolExtrudeCanonical(viewer, mesh, 3)).toBe(true);

    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("brep");
    expect(canonical.createdBy).toBe("SdExtrude");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    expect(canonical.brep.shells).toHaveLength(1);
    expect(canonical.brep.shells[0].faces).toHaveLength(6);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
  });

  test("project save/open uses canonical WEB-CAD project snapshots with legacy import compatibility", () => {
    const shell = source("shell/shell.ts");

    expect(shell).toContain('PROJECT_FILE_EXTENSION = ".webcad"');
    expect(shell).toContain('PROJECT_FILE_FORMAT = "web-cad.canonical-project"');
    expect(shell).toContain("version: PROJECT_FILE_VERSION");
    expect(shell).toContain("canonicalGeometry: w.__viewer?.exportCanonicalGeometry?.() ?? []");
    expect(shell).toContain("__viewer?.exportScene?.()");
    expect(shell).toContain("w.__viewer?.clearScene?.()");
    expect(shell).toContain("w.__viewer?.importCanonicalGeometry?.(parsed.canonicalGeometry)");
    expect(shell).toContain("__viewer?.importScene?.(parsed.objects)");
    expect(shell).toContain('PROJECT_FILE_ACCEPT = ".webcad,.json,.gemarch"');
    expect(shell).toContain("picker.accept = PROJECT_FILE_ACCEPT");
    expect(shell).toContain("saveProjectFile");
  });

  test("viewer scene persistence uses canonical display source with mesh fallback serialization", () => {
    const viewer = source("viewer/viewer.ts");

    expect(viewer).toContain("exportScene(): SerializedSceneObj[]");
    expect(viewer).toContain("exportCanonicalGeometry(): CanonicalGeometry[]");
    expect(viewer).toContain("importCanonicalGeometry(records: unknown[]): number");
    expect(viewer).toContain("inspectCanonicalGeometry(): CanonicalGeometrySnapshot");
    expect(viewer).toContain("geometry?: { position: number[]; normal?: number[]; index?: number[] }");
    expect(viewer).toContain('displaySource?: "canonical" | "serialized-geometry"');
    expect(viewer).toContain('s.displaySource = "canonical"');
    expect(viewer).toContain("geometryFromCanonical(canonical)");
    expect(viewer).toContain("const geo = mesh.geometry as THREE.BufferGeometry");
    expect(viewer).toContain("const geo = new THREE.BufferGeometry()");
    expect(viewer).toContain("_deserializeSceneObj");
  });

  test("IFC export resolves canonical NURBS surfaces across scene hierarchies while retaining mesh fallback", () => {
    const domEvents = source("dom-events.ts");

    expect(domEvents).toContain("function sceneElementsForExport(): IfcSceneElement[]");
    expect(domEvents).toContain("canonicalSurfaces.push(...canonicalGeometryToIfcNurbsSurfaces(viewer.getCanonicalGeometryForObject(child), child.matrixWorld))");
    expect(domEvents).toContain("const g = mesh.geometry as THREE.BufferGeometry");
    expect(domEvents).toContain("const pos = g.attributes.position?.array as Float32Array | undefined");
    expect(domEvents).toContain("mesh: { vertices: new Float32Array(verts), indices: new Uint32Array(idx) }");
  });

  test("3DM export prefers canonical NURBS surfaces while retaining mesh fallback", () => {
    const exporters = source("io/exporters.ts");

    expect(exporters).toContain("export async function export3dm(object: THREE.Object3D, options: Export3dmOptions = {}): Promise<Uint8Array>");
    expect(exporters).toContain("canonicalGeometryToIfcNurbsSurfaces(canonical, mesh.matrixWorld)");
    expect(exporters).not.toContain("mesh.userData.nurbsSurface");
    expect(exporters).not.toContain("canonicalOrSidecar");
    expect(exporters).toContain("file.objects().addSurface(ns)");
    expect(exporters).toContain("object.traverse((child) =>");
    expect(exporters).toContain("const geom = mesh.geometry as THREE.BufferGeometry");
    expect(exporters).toContain("const rhinoMesh: any = new rh.Mesh()");
    expect(exporters).toContain("file.objects().add(rhinoMesh)");
  });

  test("live OBJ and STL export dispatch passes the canonical geometry resolver", () => {
    const domEvents = source("dom-events.ts");

    expect(domEvents).toContain("const buf = exportStl(stlSrc, {");
    expect(domEvents).toContain("const text = exportObj(obj, {");
    expect(domEvents).toContain("getCanonicalGeometryForObject: (target) => viewer.getCanonicalGeometryForObject(target)");
    expect(domEvents).not.toContain("obj.userData.nurbsSurface");
    expect(domEvents).not.toContain("canonicalOrSidecar");
  });

  test("imported mesh objects are linked into canonical BRep records at scene entry", () => {
    const domEvents = source("dom-events.ts");
    const viewerScene = source("viewer/viewer-scene.ts");

    expect(domEvents).toContain("scene.object.userData.importFormat = scene.format");
    expect(domEvents).toContain("scene.object.userData.importFilename = filename");
    expect(viewerScene).toContain("linkPlanarizedMeshImportBrep(v.getCanonicalGeometryStore(), m, \"mesh-import\"");
    expect(viewerScene).toContain("linkPlanarizedMeshImportBrep(v.getCanonicalGeometryStore(), mesh, String(mesh.userData.creator)");
    expect(viewerScene).toContain("format: importFormat ?? (mesh.userData.ifcClass ? \"ifc\" : undefined)");
    expect(viewerScene).toContain("filename: importFilename");
  });

  test("active mesh fallback export data prefers canonical geometry over display buffers", () => {
    const viewerScene = source("viewer/viewer-scene.ts");

    expect(viewerScene).toContain("appendCanonical(v.getCanonicalGeometryForObject(v.currentMesh)");
    expect(viewerScene).toContain("appendCanonical(v.getCanonicalGeometryForObject(child), child.matrixWorld");
  });

  test("op-tool UI boolean path routes through canonical command handlers", () => {
    const opTool = source("viewer/op-tool.ts");

    expect(opTool).toContain('op === "union" ? "SdBooleanUnion"');
    expect(opTool).toContain(': op === "difference" ? "SdBooleanDifference"');
    expect(opTool).toContain(': "SdBooleanIntersection"');
    expect(opTool).toContain("const result = dispatchSync(verb, args)");
    expect(opTool).toContain('dispatchSync("SdExtrude", { object_id: phase.profile.uuid, distance: h2 })');
    expect(opTool).toContain("function tryAutoExtrudeClosedSketchForBoolean");
    expect(opTool).toContain('dispatchSync("SdExtrude", { object_id: profile.uuid, distance: 3.0 })');
    expect(opTool).not.toContain("linkOpToolExtrudeCanonical(viewer, extruded, 3.0)");
  });

  test("structural and create-mode canonical checks resolve through ancestors", () => {
    for (const path of ["handlers/structural.ts", "tools/index.ts"]) {
      const src = source(path);
      expect(src).not.toContain(".resolveObject(");
      expect(src).toContain(".resolveObjectOrAncestor(");
    }
  });

  test("sketch command handlers do not read NURBS sidecars for canonical curve creation", () => {
    const src = source("handlers/sketch.ts");
    expect(src).not.toContain("mesh.userData.nurbsCurve");
    expect(src).toContain("lineNurbsCurveFromLocalEndpoints");
  });
});
