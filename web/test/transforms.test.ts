// Transforms (T4 Phase 2) acceptance tests.
//
// Strategy: TransformControls itself needs a real DOM/canvas/camera triplet
// to function (it attaches pointer listeners to a domElement). For the
// test, we exercise the chain-emission logic separately by constructing a
// minimal binder-clone — same captured-pre/captured-post delta math, same
// fragment grammar, but synchronous and decoupled from the gizmo widget.
// This validates the contract without requiring WebGL.

import { describe, test, expect, beforeEach } from "bun:test";
import * as THREE from "three";
import { dispatchSync, registerHandler, unregisterHandler } from "../src/commands/dispatch";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import { inspectCanonicalGeometry } from "../src/geometry/canonical-introspection";
import { registerDatumHandlers } from "../src/handlers/datum";
import { registerOpeningHandlers } from "../src/handlers/openings";
import { registerSketchHandlers } from "../src/handlers/sketch";
import { registerStructuralHandlers } from "../src/handlers/structural";
import { registerTransformHandlers } from "../src/handlers/transforms";
import { WORLD_XY } from "../src/viewer/cplane";
import type { Brep, BrepFace, BrepShell } from "../src/nurbs/nurbs-brep";
import { BREP_DEFAULT_TOLERANCE } from "../src/nurbs/nurbs-brep";
import { Interval, Plane } from "../src/nurbs/nurbs-primitives";
import type { PlaneSurface } from "../src/nurbs/nurbs-surfaces";
import type { Surface } from "../src/nurbs/nurbs-surfaces";
import {
  resetSelectionState,
  resetFilters,
  setSelected,
  getSelected,
  clearSelected,
} from "../src/viewer/selection-state";
import {
  ptHandleCoordSubmit,
  ptHandlePoint,
  ptStartTool,
} from "../src/viewer/transforms";
import { makeTestViewer, addBoxBrep } from "./test-helpers";

beforeEach(() => {
  resetSelectionState();
  resetFilters();
  for (const name of [
    "SdMove",
    "SdScale",
    "SdRotate",
    "SdCopy",
    "SdArrayLinear",
    "SdArrayGrid",
    "SdArrayPolar",
    "SdArrayAlongCurve",
    "SdArray",
    "SdBoolean",
    "SdBooleanUnion",
    "SdBooleanDifference",
    "SdBooleanIntersection",
    "SdFillet",
    "SdChamfer",
    "SdShell",
    "SdSectionBox",
    "SdClippingPlane",
    "SdPoint",
    "SdLine",
    "SdRectangle",
    "SdPolyline",
    "SdArc",
    "SdCircle",
    "SdPolygon",
    "SdCurve",
    "SdSpline",
    "SdWall",
    "SdCurveWall",
    "SdSlab",
    "SdColumn",
    "SdBeam",
    "SdRoof",
    "SdSpace",
    "SdFoundation",
    "SdCeiling",
    "SdCurtainWall",
    "SdSkylight",
    "SdRamp",
    "SdRailing",
    "SdStair",
    "SdDoor",
    "SdWindow",
    "SdOpening",
    "SdRefGrid",
    "SdLevel",
    "SdDatum",
  ]) {
    unregisterHandler(name);
  }
});

const canonicalSurface: Surface = {
  kind: "sum",
  basepoint: { x: 0, y: 0, z: 0 },
  curveU: {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to: { x: 2, y: 0, z: 0 },
    domain: { min: 0, max: 2 },
  },
  curveV: {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to: { x: 0, y: 0, z: 3 },
    domain: { min: 0, max: 3 },
  },
};

function makeCanonicalTransformViewer() {
  const scene = new THREE.Scene();
  const store = createCanonicalGeometryStore();
  let active: THREE.Object3D | null = null;
  const added: THREE.Object3D[] = [];
  const viewer = {
    getActiveObject() {
      return active;
    },
    addMesh(obj: THREE.Object3D, kind?: string) {
      if (kind) obj.userData.kind = kind;
      scene.add(obj);
      added.push(obj);
      active = obj;
      return obj;
    },
    getScene() {
      return scene;
    },
    getCanonicalGeometryStore() {
      return store;
    },
    selectObject(obj: THREE.Object3D | null) {
      active = obj;
    },
  };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 3), new THREE.MeshStandardMaterial());
  mesh.userData.kind = "brep";
  mesh.userData.creator = "box";
  const record = store.create({
    kind: "surface",
    surface: canonicalSurface,
    source: "command",
    createdBy: "SdBox",
  });
  store.linkObject(mesh, record.id);
  scene.add(mesh);
  active = mesh;
  return { viewer, scene, store, mesh, record, added };
}

function planeFace(origin: [number, number, number], normal: [number, number, number], extent: number): BrepFace {
  const surf: PlaneSurface = {
    kind: "plane",
    plane: Plane.fromPointNormal(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: normal[0], y: normal[1], z: normal[2] },
    ),
    uDomain: Interval.create(0, 1),
    vDomain: Interval.create(0, 1),
    uExtent: Interval.create(-extent, extent),
    vExtent: Interval.create(-extent, extent),
  };
  return {
    surface: surf,
    outerLoop: { curves: [], orientation: true },
    innerLoops: [],
    orientation: true,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

function axisBoxBrep(xMin: number, xMax: number, yMin: number, yMax: number, zMin: number, zMax: number): Brep {
  const cx = (xMin + xMax) / 2;
  const cy = (yMin + yMax) / 2;
  const cz = (zMin + zMax) / 2;
  const hx = (xMax - xMin) / 2;
  const hy = (yMax - yMin) / 2;
  const hz = (zMax - zMin) / 2;
  const faces: BrepFace[] = [
    planeFace([xMin, cy, cz], [-1, 0, 0], Math.max(hy, hz)),
    planeFace([xMax, cy, cz], [1, 0, 0], Math.max(hy, hz)),
    planeFace([cx, yMin, cz], [0, -1, 0], Math.max(hx, hz)),
    planeFace([cx, yMax, cz], [0, 1, 0], Math.max(hx, hz)),
    planeFace([cx, cy, zMin], [0, 0, -1], Math.max(hx, hy)),
    planeFace([cx, cy, zMax], [0, 0, 1], Math.max(hx, hy)),
  ];
  const p000 = { x: xMin, y: yMin, z: zMin };
  const p100 = { x: xMax, y: yMin, z: zMin };
  const p110 = { x: xMax, y: yMax, z: zMin };
  const p010 = { x: xMin, y: yMax, z: zMin };
  const p001 = { x: xMin, y: yMin, z: zMax };
  const p101 = { x: xMax, y: yMin, z: zMax };
  const p111 = { x: xMax, y: yMax, z: zMax };
  const p011 = { x: xMin, y: yMax, z: zMax };
  const edge = (from: typeof p000, to: typeof p000, faceIndex1: number, faceIndex2: number) => ({
    curve: {
      kind: "line" as const,
      from,
      to,
      domain: { min: 0, max: Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) },
    },
    faceIndex1,
    faceIndex2,
    tolerance: BREP_DEFAULT_TOLERANCE,
  });
  const edges = [
    edge(p000, p100, 2, 4),
    edge(p100, p110, 1, 4),
    edge(p010, p110, 3, 4),
    edge(p000, p010, 0, 4),
    edge(p001, p101, 2, 5),
    edge(p101, p111, 1, 5),
    edge(p011, p111, 3, 5),
    edge(p001, p011, 0, 5),
    edge(p000, p001, 0, 2),
    edge(p100, p101, 1, 2),
    edge(p110, p111, 1, 3),
    edge(p010, p011, 0, 3),
  ];
  const vertex = (point: typeof p000, edgeIndices: number[]) => ({ point, edgeIndices, tolerance: BREP_DEFAULT_TOLERANCE });
  const vertices = [
    vertex(p000, [0, 3, 8]),
    vertex(p100, [0, 1, 9]),
    vertex(p110, [1, 2, 10]),
    vertex(p010, [2, 3, 11]),
    vertex(p001, [4, 7, 8]),
    vertex(p101, [4, 5, 9]),
    vertex(p111, [5, 6, 10]),
    vertex(p011, [6, 7, 11]),
  ];
  const shell: BrepShell = { faces, edges, vertices, isClosed: true };
  return { shells: [shell] };
}

// Mirror of TransformBinder.onDragEnd's chain emission. Kept in lockstep
// with src/transforms.ts; if those change shape, these tests need to be
// updated.
function emitChainFragment(
  mode: "translate" | "rotate" | "scale",
  before: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 },
  after: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 },
): string {
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  if (mode === "translate") {
    const dx = round(after.position.x - before.position.x);
    const dy = round(after.position.y - before.position.y);
    const dz = round(after.position.z - before.position.z);
    if (dx === 0 && dy === 0 && dz === 0) return "";
    return `.translate([${dx}, ${dy}, ${dz}])`;
  }
  if (mode === "rotate") {
    const dq = before.quaternion.clone().invert().multiply(after.quaternion);
    const angle = 2 * Math.acos(Math.max(-1, Math.min(1, dq.w)));
    const s = Math.sqrt(1 - dq.w * dq.w);
    let ax = 0, ay = 0, az = 1;
    if (s >= 1e-4) { ax = dq.x / s; ay = dq.y / s; az = dq.z / s; }
    const deg = round((angle * 180) / Math.PI);
    if (deg === 0) return "";
    return `.rotate(${deg}, [0, 0, 0], [${round(ax)}, ${round(ay)}, ${round(az)}])`;
  }
  // scale
  const sx = round(after.scale.x / before.scale.x);
  const sy = round(after.scale.y / before.scale.y);
  const sz = round(after.scale.z / before.scale.z);
  const factor = round((sx + sy + sz) / 3);
  if (factor === 1) return "";
  return `.scale(${factor})`;
}

describe("Phase 2 — transform gizmo chain emission", () => {
  test("G + drag 5 units +X commits .translate([5, 0, 0])", () => {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(6, 0.2, 3),
      new THREE.MeshStandardMaterial(),
    );
    const before = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    wall.position.x += 5;
    const after = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    const frag = emitChainFragment("translate", before, after);
    expect(frag).toBe(".translate([5, 0, 0])");
  });

  test("R + drag 90deg around Z commits .rotate(90, [0,0,0], [0,0,1])", () => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 0.2, 3), new THREE.MeshStandardMaterial());
    const before = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    wall.quaternion.premultiply(q);
    const after = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    const frag = emitChainFragment("rotate", before, after);
    expect(frag).toContain(".rotate(90");
    // Axis should be Z (or close to it under rounding).
    expect(frag).toContain("[0, 0, 1]");
  });

  test("S + drag 2x commits .scale(2)", () => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 0.2, 3), new THREE.MeshStandardMaterial());
    const before = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    wall.scale.multiplyScalar(2);
    const after = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    const frag = emitChainFragment("scale", before, after);
    expect(frag).toBe(".scale(2)");
  });

  test("No-op drag (same before/after) emits empty fragment", () => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 0.2, 3), new THREE.MeshStandardMaterial());
    const before = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    const after = before; // unchanged
    expect(emitChainFragment("translate", before, after)).toBe("");
    expect(emitChainFragment("rotate", before, after)).toBe("");
    expect(emitChainFragment("scale", before, after)).toBe("");
  });

  test("Del removes selection from scene + IFC entity count drops", () => {
    const v = makeTestViewer();
    const wall = addBoxBrep(v, 6, 0.2, 3);
    const initialIfc = v.ifcEntityCount;
    const initialChildCount = v.scene.children.length;
    // Select it.
    setSelected({
      topology: "brep",
      uuid: wall.uuid,
      object: wall,
      transformTarget: wall,
    });
    expect(getSelected()).not.toBeNull();
    // Delete via the helper API.
    const removed = v.removeMesh(wall);
    expect(removed).toBe(true);
    clearSelected();
    expect(v.ifcEntityCount).toBe(initialIfc - 1);
    expect(v.scene.children.length).toBeLessThan(initialChildCount);
    expect(getSelected()).toBeNull();
  });
});

describe("Phase 3 — create-mode click-to-place", () => {
  test("Line tool: click(0,0) + click(5,0) creates new edge with polyline chain", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const initialChildren = v.scene.children.length;
    // Line tool needs 2 clicks. First click — no mesh yet.
    const r1 = emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "line" });
    expect(r1).toBeNull();
    const r2 = emitClickWorld(v as any, { x: 5, y: 0 }, { tool: "line" });
    expect(r2).not.toBeNull();
    expect(v.scene.children.length).toBeGreaterThan(initialChildren);
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    expect(seq[0]).toContain("drawPolyline([[0, 0], [5, 0]])");
    expect(seq[0]).toContain('.sketchOnPlane("XY")');
  });

  test("Wall tool: click(0,0) + click(6,0) creates 6m wall along X with proper translate", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "wall" });
    const r = emitClickWorld(v as any, { x: 6, y: 0 }, { tool: "wall" });
    expect(r).not.toBeNull();
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    // Per tier1-conventions: makeBox(length, thickness, height).rotate(0).translate([midX, midY, 0])
    expect(seq[0]).toContain("makeBox(6, 0.2, 3)");
    expect(seq[0]).toContain("translate([3, 0, 0])");
  });

  test("Wall-curve tool commits through SdCurveWall and links to canonical NURBS BRep faces", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const store = createCanonicalGeometryStore();
    (v as unknown as { getCanonicalGeometryStore: () => typeof store }).getCanonicalGeometryStore = () => store;
    registerStructuralHandlers(v as never);

    emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "wall-curve" });
    emitClickWorld(v as any, { x: 2, y: 1 }, { tool: "wall-curve" });
    const result = emitClickWorld(v as any, { x: 4, y: 0, z: 0 }, { tool: "wall-curve", commit: true });

    expect(result).not.toBeNull();
    const mesh = result?.mesh as THREE.Mesh;
    const canonical = store.resolveObject(mesh);
    expect(canonical?.kind).toBe("brep");
    if (canonical?.kind !== "brep") throw new Error("expected canonical BRep");
    expect(canonical.createdBy).toBe("SdCurveWall");
    expect(canonical.brep.shells[0].faces.length).toBeGreaterThan(0);
    expect(canonical.brep.shells[0].faces.every((face) => face.surface.kind === "nurbs")).toBe(true);
    expect(getCreateSequence()[0]).toContain("SdCurveWall");
  });

  test("Ramp tool links click-created display solid to a canonical BRep", async () => {
    const { emitClickWorld, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const store = createCanonicalGeometryStore();
    (v as unknown as { getCanonicalGeometryStore: () => typeof store }).getCanonicalGeometryStore = () => store;

    emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "ramp" });
    const result = emitClickWorld(v as any, { x: 6, y: 0 }, { tool: "ramp" });

    expect(result).not.toBeNull();
    const canonical = result?.mesh ? store.resolveObject(result.mesh) : undefined;
    expect(canonical?.kind).toBe("brep");
    if (canonical?.kind !== "brep") throw new Error("expected canonical BRep");
    expect(canonical.createdBy).toBe("create-ramp");
    expect(canonical.brep.shells[0].faces).toHaveLength(6);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
  });

  test("Curtainwall tool links visible group and join shell to one canonical BRep", async () => {
    const { emitClickWorld, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const store = createCanonicalGeometryStore();
    (v as unknown as { getCanonicalGeometryStore: () => typeof store }).getCanonicalGeometryStore = () => store;

    emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "curtainwall" });
    const result = emitClickWorld(v as any, { x: 6, y: 0 }, { tool: "curtainwall" });

    expect(result).not.toBeNull();
    const group = result?.mesh;
    const shell = group?.userData.joinableShell as THREE.Mesh | undefined;
    expect(group).toBeInstanceOf(THREE.Group);
    expect(shell).toBeInstanceOf(THREE.Mesh);
    const groupRecord = group ? store.resolveObject(group) : undefined;
    const shellRecord = shell ? store.resolveObject(shell) : undefined;
    expect(groupRecord?.kind).toBe("brep");
    expect(shellRecord).toBe(groupRecord);
    if (groupRecord?.kind !== "brep") throw new Error("expected canonical BRep");
    expect(groupRecord.createdBy).toBe("create-curtainwall");
    expect(groupRecord.brep.shells[0].faces).toHaveLength(6);
    expect(groupRecord.brep.shells[0].isClosed).toBe(true);
  });

  test("Box-like structural create tools link click-created display solids to canonical BReps", async () => {
    const { emitClickWorld, clearCreateSequence, resetPending } = await import("../src/tools/index");

    for (const [tool, first, second, createdBy] of [
      ["wall", { x: 0, y: 0 }, { x: 4, y: 0 }, "create-wall"],
      ["slab", { x: 0, y: 0 }, { x: 4, y: 3 }, "create-slab"],
      ["beam", { x: 0, y: 0 }, { x: 4, y: 0 }, "create-beam"],
      ["space", { x: 0, y: 0 }, { x: 4, y: 3 }, "create-space"],
      ["foundation", { x: 0, y: 0 }, { x: 4, y: 3 }, "create-foundation"],
      ["ceiling", { x: 0, y: 0 }, { x: 4, y: 3 }, "create-ceiling"],
      ["skylight", { x: 0, y: 0 }, { x: 2, y: 1 }, "create-skylight"],
      ["railing", { x: 0, y: 0 }, { x: 3, y: 0 }, "create-railing"],
    ] as const) {
      clearCreateSequence();
      resetPending();
      const v = makeTestViewer();
      const store = createCanonicalGeometryStore();
      (v as unknown as { getCanonicalGeometryStore: () => typeof store }).getCanonicalGeometryStore = () => store;

      emitClickWorld(v as any, first, { tool });
      const result = emitClickWorld(v as any, second, { tool });

      expect(result).not.toBeNull();
      const canonical = result?.mesh ? store.resolveObject(result.mesh) : undefined;
      expect(canonical?.kind).toBe("brep");
      if (canonical?.kind !== "brep") throw new Error(`expected canonical BRep for ${tool}`);
      expect(canonical.createdBy).toBe(createdBy);
      expect(canonical.brep.shells[0].faces).toHaveLength(6);
      expect(canonical.brep.shells[0].isClosed).toBe(true);
    }
  });

  test("Column tool links single-click display solid to a canonical BRep", async () => {
    const { emitClickWorld, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const store = createCanonicalGeometryStore();
    (v as unknown as { getCanonicalGeometryStore: () => typeof store }).getCanonicalGeometryStore = () => store;

    const result = emitClickWorld(v as any, { x: 2, y: 3 }, { tool: "column" });

    expect(result).not.toBeNull();
    const canonical = result?.mesh ? store.resolveObject(result.mesh) : undefined;
    expect(canonical?.kind).toBe("brep");
    if (canonical?.kind !== "brep") throw new Error("expected canonical BRep for column");
    expect(canonical.createdBy).toBe("create-column");
    expect(canonical.brep.shells[0].faces).toHaveLength(6);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
  });

  test("Grid and datum tools link click-created reference lines to canonical curves", async () => {
    const { emitClickWorld, clearCreateSequence, resetPending } = await import("../src/tools/index");

    for (const [tool, createdBy] of [
      ["grid", "create-grid-line"],
      ["datum", "create-reference-line"],
    ] as const) {
      clearCreateSequence();
      resetPending();
      const v = makeTestViewer();
      const store = createCanonicalGeometryStore();
      (v as unknown as { getCanonicalGeometryStore: () => typeof store }).getCanonicalGeometryStore = () => store;

      emitClickWorld(v as any, { x: 1, y: 2 }, { tool });
      const result = emitClickWorld(v as any, { x: 4, y: 6 }, { tool });

      expect(result).not.toBeNull();
      const canonical = result?.mesh ? store.resolveObject(result.mesh) : undefined;
      expect(canonical?.kind).toBe("curve");
      if (canonical?.kind !== "curve") throw new Error(`expected canonical curve for ${tool}`);
      expect(canonical.createdBy).toBe(createdBy);
      expect(canonical.curve.kind).toBe("line");
      if (canonical.curve.kind !== "line") throw new Error(`expected line curve for ${tool}`);
      expect(canonical.curve.from).toEqual({ x: 0, y: -2.5, z: 0 });
      expect(canonical.curve.to).toEqual({ x: 0, y: 2.5, z: 0 });
      expect(canonical.curve.domain.max).toBeCloseTo(5);
      expect(canonical.metadata).toMatchObject({
        worldStart: { x: 1, y: 2, z: 0 },
        worldEnd: { x: 4, y: 6, z: 0 },
      });
    }
  });

  test("Level tool links click-created level plane to a canonical surface", async () => {
    const { emitClickWorld, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const store = createCanonicalGeometryStore();
    (v as unknown as { getCanonicalGeometryStore: () => typeof store }).getCanonicalGeometryStore = () => store;

    const result = emitClickWorld(v as any, { x: 2, y: 3, z: 4 }, { tool: "level" });

    expect(result).not.toBeNull();
    const canonical = result?.mesh ? store.resolveObject(result.mesh) : undefined;
    expect(canonical?.kind).toBe("surface");
    if (canonical?.kind !== "surface") throw new Error("expected canonical surface for level");
    expect(canonical.createdBy).toBe("create-level");
    expect(canonical.surface.kind).toBe("plane");
    if (canonical.surface.kind !== "plane") throw new Error("expected plane surface for level");
    expect(canonical.surface.uDomain).toEqual({ min: -10, max: 10 });
    expect(canonical.surface.vDomain).toEqual({ min: -10, max: 10 });
    expect(canonical.metadata).toMatchObject({
      creator: "IfcLevel",
      elevation: 4,
      extent: 20,
    });
  });

  test("Door, window, and opening tools link click-created display meshes to canonical BRep envelopes", async () => {
    const { emitClickWorld, clearCreateSequence, resetPending } = await import("../src/tools/index");

    for (const [tool, createdBy] of [
      ["door", "create-door"],
      ["window", "create-window"],
      ["opening", "create-opening"],
    ] as const) {
      clearCreateSequence();
      resetPending();
      const v = makeTestViewer();
      const store = createCanonicalGeometryStore();
      (v as unknown as { getCanonicalGeometryStore: () => typeof store }).getCanonicalGeometryStore = () => store;

      const result = emitClickWorld(v as any, { x: 2, y: 1 }, { tool });

      expect(result).not.toBeNull();
      const canonical = result?.mesh ? store.resolveObject(result.mesh) : undefined;
      expect(canonical?.kind).toBe("brep");
      if (canonical?.kind !== "brep") throw new Error(`expected canonical BRep for ${tool}`);
      expect(canonical.createdBy).toBe(createdBy);
      expect(canonical.brep.shells[0].faces).toHaveLength(6);
      expect(canonical.brep.shells[0].isClosed).toBe(true);
    }
  });

  test("ARCH palette create-mode tools commit through their Sd command handlers when registered", async () => {
    const { emitClickWorld, clearCreateSequence, resetPending } = await import("../src/tools/index");

    const cases: Array<{
      tool: string;
      clicks: Array<{ x: number; y: number; z?: number }>;
      expectedCreatedBy: string | RegExp;
      commitLast?: boolean;
    }> = [
      { tool: "wall", clicks: [{ x: 0, y: 0 }, { x: 4, y: 0 }], expectedCreatedBy: "SdWall" },
      { tool: "slab", clicks: [{ x: 0, y: 0 }, { x: 4, y: 3 }], expectedCreatedBy: "SdSlab" },
      { tool: "column", clicks: [{ x: 2, y: 2 }], expectedCreatedBy: "SdColumn" },
      { tool: "beam", clicks: [{ x: 0, y: 0 }, { x: 4, y: 0 }], expectedCreatedBy: "SdBeam" },
      { tool: "roof", clicks: [{ x: 0, y: 0 }, { x: 6, y: 5 }], expectedCreatedBy: /^SdRoof/ },
      { tool: "space", clicks: [{ x: 0, y: 0 }, { x: 4, y: 3 }], expectedCreatedBy: "SdSpace" },
      { tool: "foundation", clicks: [{ x: 0, y: 0 }, { x: 4, y: 3 }], expectedCreatedBy: "SdFoundation" },
      { tool: "ceiling", clicks: [{ x: 0, y: 0 }, { x: 4, y: 3 }], expectedCreatedBy: "SdCeiling" },
      { tool: "grid", clicks: [{ x: 0, y: 0 }, { x: 5, y: 0 }], expectedCreatedBy: "SdRefGrid" },
      { tool: "level", clicks: [{ x: 0, y: 0, z: 3 }], expectedCreatedBy: "SdLevel" },
      { tool: "datum", clicks: [{ x: 0, y: 0 }, { x: 4, y: 0 }], expectedCreatedBy: "SdDatum" },
      { tool: "stair", clicks: [{ x: 0, y: 0 }, { x: 4, y: 3 }], expectedCreatedBy: /^SdStair/ },
      { tool: "stair-polyline", clicks: [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 0 }], expectedCreatedBy: /^SdStair/, commitLast: true },
      { tool: "stair-curve", clicks: [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 0 }], expectedCreatedBy: /^SdStair/, commitLast: true },
      { tool: "door", clicks: [{ x: 2, y: 1 }], expectedCreatedBy: "SdDoor" },
      { tool: "window", clicks: [{ x: 2, y: 1 }], expectedCreatedBy: "SdWindow" },
      { tool: "ramp", clicks: [{ x: 0, y: 0 }, { x: 4, y: 0 }], expectedCreatedBy: "SdRamp" },
      { tool: "railing", clicks: [{ x: 0, y: 0 }, { x: 3, y: 0 }], expectedCreatedBy: "SdRailing" },
      { tool: "curtainwall", clicks: [{ x: 0, y: 0 }, { x: 6, y: 0 }], expectedCreatedBy: "SdCurtainWall" },
      { tool: "skylight", clicks: [{ x: 0, y: 0 }, { x: 2, y: 1 }], expectedCreatedBy: "SdSkylight" },
      { tool: "opening", clicks: [{ x: 2, y: 1 }], expectedCreatedBy: "SdOpening" },
    ];

    for (const spec of cases) {
      clearCreateSequence();
      resetPending();
      const viewer = makeTestViewer();
      const store = createCanonicalGeometryStore();
      (viewer as unknown as { getCanonicalGeometryStore: () => typeof store }).getCanonicalGeometryStore = () => store;
      (viewer as unknown as { activeView: string; activeCPlane: typeof WORLD_XY }).activeView = "top";
      (viewer as unknown as { activeView: string; activeCPlane: typeof WORLD_XY }).activeCPlane = WORLD_XY;
      (viewer as unknown as { forEachSceneChild: (cb: (obj: THREE.Object3D) => void) => void }).forEachSceneChild = (cb) => {
        viewer.scene.children.forEach(cb);
      };
      const baseAddMesh = viewer.addMesh.bind(viewer);
      (viewer as unknown as { addMesh: (obj: THREE.Object3D, kind?: string) => THREE.Object3D }).addMesh = (obj, kind) => {
        if (kind) obj.userData.kind = kind;
        if (obj instanceof THREE.Mesh) return baseAddMesh(obj, (kind ?? "brep") as "brep" | "compound" | "mesh");
        viewer.scene.add(obj);
        return obj;
      };
      registerStructuralHandlers(viewer as never);
      registerOpeningHandlers(viewer as never);
      registerDatumHandlers(viewer as never);

      let result: { mesh: THREE.Object3D } | null = null;
      for (let i = 0; i < spec.clicks.length; i++) {
        result = emitClickWorld(viewer as any, spec.clicks[i], { tool: spec.tool, commit: spec.commitLast === true && i === spec.clicks.length - 1 }) as { mesh: THREE.Object3D } | null;
      }

      expect(result, spec.tool).not.toBeNull();
      const createdBy = new Set<string>();
      result?.mesh.traverse((obj) => {
        const canonical = store.resolveObjectOrAncestor(obj);
        if (canonical?.createdBy) createdBy.add(canonical.createdBy);
      });
      const direct = result ? store.resolveObjectOrAncestor(result.mesh) : undefined;
      if (direct?.createdBy) createdBy.add(direct.createdBy);
      expect([...createdBy].length, spec.tool).toBeGreaterThan(0);
      const matched = [...createdBy].some((value) => (
        typeof spec.expectedCreatedBy === "string"
          ? value === spec.expectedCreatedBy
          : spec.expectedCreatedBy.test(value)
      ));
      expect(matched, `${spec.tool}: ${[...createdBy].join(",")}`).toBe(true);
      if (spec.tool.startsWith("stair")) {
        expect(result?.mesh.userData.dispatchVerb, spec.tool).toBe("SdStair");
      }
    }
  });

  test("Stair and roof tools link click-created compound subcomponents to canonical BReps", async () => {
    const { emitClickWorld, clearCreateSequence, resetPending } = await import("../src/tools/index");

    for (const [tool, createdBy] of [
      ["stair", "create-stair-component"],
      ["roof", "create-roof-component"],
    ] as const) {
      clearCreateSequence();
      resetPending();
      const v = makeTestViewer();
      const store = createCanonicalGeometryStore();
      (v as unknown as { getCanonicalGeometryStore: () => typeof store }).getCanonicalGeometryStore = () => store;

      emitClickWorld(v as any, { x: 0, y: 0 }, { tool });
      const result = emitClickWorld(v as any, { x: 4, y: 3 }, { tool });

      expect(result).not.toBeNull();
      const linkedRecords = new Set<string>();
      result?.mesh.traverse((child) => {
        const canonical = store.resolveObject(child);
        if (!canonical) return;
        expect(canonical.kind).toBe("brep");
        if (canonical.kind !== "brep") throw new Error(`expected canonical BRep for ${tool} subcomponent`);
        expect(canonical.createdBy).toBe(createdBy);
        expect(canonical.brep.shells[0].faces.length).toBeGreaterThan(0);
        if (tool === "stair" && canonical.metadata?.derivation === "parametric-stair-flight-profile") {
          expect(canonical.metadata).toMatchObject({
            conversion: "extruded-stair-flight-profile-brep",
          });
          expect(canonical.brep.shells[0].isClosed).toBe(true);
          expect(canonical.brep.shells[0].edges.every((edge) => edge.faceIndex2 !== null)).toBe(true);
          expect(canonical.brep.shells[0].vertices.every((vertex) => vertex.edgeIndices.length === 3)).toBe(true);
        } else if (canonical.metadata?.derivation === "parametric-box-primitive") {
          expect(canonical.metadata).toMatchObject({
            conversion: "extruded-rectangular-solid-brep",
          });
          expect(canonical.brep.shells[0].isClosed).toBe(true);
          expect(canonical.brep.shells[0].faces).toHaveLength(6);
          expect(canonical.brep.shells[0].faces.every((face) => face.surface.kind === "nurbs")).toBe(true);
          expect(canonical.brep.shells[0].edges.every((edge) => edge.faceIndex2 !== null)).toBe(true);
          expect(canonical.brep.shells[0].vertices.every((vertex) => vertex.edgeIndices.length === 3)).toBe(true);
        } else if (canonical.metadata?.derivation === "parametric-planar-panel") {
          expect(canonical.metadata).toMatchObject({
            conversion: "trimmed-planar-nurbs-brep",
          });
          expect(canonical.brep.shells[0].isClosed).toBe(false);
          expect(canonical.brep.shells[0].faces).toHaveLength(1);
          expect(canonical.brep.shells[0].faces.every((face) => face.surface.kind === "nurbs")).toBe(true);
          expect(canonical.brep.shells[0].edges.every((edge) => edge.faceIndex2 === null)).toBe(true);
          expect(canonical.brep.shells[0].vertices.every((vertex) => vertex.edgeIndices.length === 2)).toBe(true);
        } else if (canonical.metadata?.derivation === "parametric-gable-cap-solid") {
          expect(canonical.metadata).toMatchObject({
            conversion: "extruded-triangular-nurbs-brep",
          });
          expect(canonical.brep.shells[0].isClosed).toBe(true);
          expect(canonical.brep.shells[0].faces).toHaveLength(5);
          expect(canonical.brep.shells[0].faces.every((face) => face.surface.kind === "nurbs")).toBe(true);
          expect(canonical.brep.shells[0].edges.every((edge) => edge.faceIndex2 !== null)).toBe(true);
          expect(canonical.brep.shells[0].vertices.every((vertex) => vertex.edgeIndices.length === 3)).toBe(true);
        } else {
          expect(canonical.metadata).toMatchObject({
            derivation: "planarized-command-mesh",
            conversion: "merged-coplanar-planar-nurbs-brep",
          });
          expect(canonical.brep.shells[0].faces.every((face) => face.surface.kind === "nurbs")).toBe(true);
          expect(canonical.brep.shells[0].faces.every((face) => {
            const curve = face.outerLoop.curves[0] as { points?: unknown[] };
            return !Array.isArray(curve.points) || curve.points.length !== 4;
          })).toBe(true);
        }
        linkedRecords.add(canonical.id);
      });
      expect(linkedRecords.size).toBeGreaterThan(0);
      if (tool === "stair") {
        expect([...linkedRecords].some((id) => store.require(id).metadata?.derivation === "parametric-stair-flight-profile")).toBe(true);
      }
      if (tool === "roof") {
        expect([...linkedRecords].some((id) => store.require(id).metadata?.derivation === "parametric-box-primitive")).toBe(true);
        expect([...linkedRecords].some((id) => store.require(id).metadata?.derivation === "parametric-gable-cap-solid")).toBe(true);
        expect([...linkedRecords].every((id) => {
          const derivation = store.require(id).metadata?.derivation;
          return derivation !== "planarized-command-mesh" && derivation !== "parametric-planar-panel";
        })).toBe(true);
      }
    }
  });

  test("Rect tool: click(0,0) + click(4,3) creates a 4x3 rect", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "rect" });
    const r = emitClickWorld(v as any, { x: 4, y: 3 }, { tool: "rect" });
    expect(r).not.toBeNull();
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    expect(seq[0]).toContain("drawRectangle(4, 3)");
    expect(seq[0]).toContain("translate([2, 1.5, 0])");
  });

  test("Circle tool: click(2,2) center + click(5,2) → radius 3 cylinder", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    emitClickWorld(v as any, { x: 2, y: 2 }, { tool: "circle" });
    const r = emitClickWorld(v as any, { x: 5, y: 2 }, { tool: "circle" });
    expect(r).not.toBeNull();
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    expect(seq[0]).toContain("makeCylinder(3,");
    expect(seq[0]).toContain("translate([2, 2, 0])");
  });

  test("CAD draw palette create-mode tools link committed objects to canonical curves/points", async () => {
    const { emitClickWorld, clearCreateSequence, resetPending } = await import("../src/tools/index");

    const cases: Array<{
      tool: string;
      clicks: Array<{ x: number; y: number; z?: number }>;
      commit?: boolean;
      expectedKind: "curve" | "point";
      expectedCurveKind?: "line" | "polyline" | "arc" | "nurbs";
      expectedCreatedBy: string;
    }> = [
      { tool: "line", clicks: [{ x: 0, y: 0 }, { x: 4, y: 0 }], expectedKind: "curve", expectedCurveKind: "nurbs", expectedCreatedBy: "SdLine" },
      { tool: "rect", clicks: [{ x: 0, y: 0 }, { x: 4, y: 3 }], expectedKind: "curve", expectedCurveKind: "polyline", expectedCreatedBy: "SdRectangle" },
      { tool: "circle", clicks: [{ x: 2, y: 2 }, { x: 5, y: 2 }], expectedKind: "curve", expectedCurveKind: "arc", expectedCreatedBy: "SdCircle" },
      { tool: "polygon", clicks: [{ x: 0, y: 0 }, { x: 2, y: 0 }], expectedKind: "curve", expectedCurveKind: "polyline", expectedCreatedBy: "SdPolygon" },
      { tool: "arc", clicks: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }], expectedKind: "curve", expectedCurveKind: "arc", expectedCreatedBy: "SdArc" },
      { tool: "polyline", clicks: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }], commit: true, expectedKind: "curve", expectedCurveKind: "polyline", expectedCreatedBy: "SdPolyline" },
      { tool: "curve", clicks: [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 0 }], commit: true, expectedKind: "curve", expectedCurveKind: "nurbs", expectedCreatedBy: "SdCurve" },
      { tool: "spline", clicks: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: -1 }, { x: 3, y: 0 }], commit: true, expectedKind: "curve", expectedCurveKind: "nurbs", expectedCreatedBy: "SdSpline" },
      { tool: "point", clicks: [{ x: 7, y: 8 }], expectedKind: "point", expectedCreatedBy: "SdPoint" },
    ];

    for (const spec of cases) {
      clearCreateSequence();
      resetPending();
      const viewer = makeTestViewer();
      const store = createCanonicalGeometryStore();
      (viewer as unknown as { getCanonicalGeometryStore: () => typeof store }).getCanonicalGeometryStore = () => store;
      registerSketchHandlers(viewer as never);
      let result: { mesh: THREE.Object3D } | null = null;
      for (let i = 0; i < spec.clicks.length; i++) {
        result = emitClickWorld(viewer as any, spec.clicks[i], {
          tool: spec.tool,
          commit: spec.commit === true && i === spec.clicks.length - 1,
        }) as { mesh: THREE.Object3D } | null;
      }
      expect(result, spec.tool).not.toBeNull();
      const canonical = result ? store.resolveObject(result.mesh) : undefined;
      expect(canonical?.kind, spec.tool).toBe(spec.expectedKind);
      if (canonical?.kind === "curve") {
        expect(spec.expectedCurveKind, spec.tool).toBeDefined();
        expect(canonical.curve.kind, spec.tool).toBe(spec.expectedCurveKind!);
        expect(canonical.createdBy).toBe(spec.expectedCreatedBy);
      } else if (canonical?.kind === "point") {
        expect(canonical.createdBy).toBe(spec.expectedCreatedBy);
      }
    }
  });

  test("Door tool: single click emits cut chain", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const r = emitClickWorld(v as any, { x: 1, y: 0 }, { tool: "door" });
    expect(r).not.toBeNull();
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    expect(seq[0]).toContain("door:");
    expect(seq[0]).toContain("makeBox(0.914, 0.2, 2.032)");
  });

  test("Window tool: single click emits cut chain at sill height", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const r = emitClickWorld(v as any, { x: 1, y: 0 }, { tool: "window" });
    expect(r).not.toBeNull();
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    expect(seq[0]).toContain("window:");
    expect(seq[0]).toContain("translate([1, 0, 1])");
  });

  test("Switching tools resets pending click buffer", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    // Start a wall (1st click)
    emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "wall" });
    // Switch tool — reset.
    resetPending();
    // Now circle tool: 2 clicks, both should land cleanly on circle.
    emitClickWorld(v as any, { x: 1, y: 1 }, { tool: "circle" });
    const r = emitClickWorld(v as any, { x: 2, y: 1 }, { tool: "circle" });
    expect(r).not.toBeNull();
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    expect(seq[0]).toContain("makeCylinder(1,"); // radius=1 from (1,1)→(2,1)
  });

  test("Section and clip palette tools commit the same Sd commands used by agents", async () => {
    const { emitClickWorld, clearCreateSequence, resetPending } = await import("../src/tools/index");
    const dispatched: Array<{ verb: string; args: Record<string, unknown> }> = [];

    registerHandler("SdSectionBox", (args) => {
      dispatched.push({ verb: "SdSectionBox", args });
      return { ok: true };
    });
    registerHandler("SdClippingPlane", (args) => {
      dispatched.push({ verb: "SdClippingPlane", args });
      return { ok: true };
    });

    clearCreateSequence();
    resetPending();
    let viewer = makeTestViewer();
    const sectionFirst = emitClickWorld(viewer as any, { x: -2, y: -1 }, { tool: "section" });
    const sectionResult = emitClickWorld(viewer as any, { x: 3, y: 4 }, { tool: "section" }) as {
      mesh: THREE.Object3D;
      chain: string;
      dispatchOnCommit?: { verb: string; args: Record<string, unknown> };
    } | null;

    expect(sectionFirst).toBeNull();
    expect(sectionResult).not.toBeNull();
    expect(sectionResult?.mesh.userData).toMatchObject({ kind: "section-box", creator: "SdSectionBox" });
    expect(sectionResult?.chain).toBe("SdSectionBox({min:[-2,-1,-0.1],max:[3,4,6]})");
    expect(sectionResult?.dispatchOnCommit).toEqual({
      verb: "SdSectionBox",
      args: { min: [-2, -1, -0.1], max: [3, 4, 6] },
    });

    clearCreateSequence();
    resetPending();
    viewer = makeTestViewer();
    const clipResult = emitClickWorld(viewer as any, { x: 1, y: 2, z: 0.5 }, { tool: "clip" }) as {
      mesh: THREE.Object3D;
      chain: string;
      dispatchOnCommit?: { verb: string; args: Record<string, unknown> };
    } | null;

    expect(clipResult).not.toBeNull();
    expect(clipResult?.mesh.userData).toMatchObject({ kind: "clip-plane", creator: "SdClippingPlane" });
    expect(clipResult?.dispatchOnCommit?.verb).toBe("SdClippingPlane");
    expect(clipResult?.dispatchOnCommit?.args).toMatchObject({
      origin: [1, 2, 1.7],
      normal: [0, 0, -1],
    });
    expect(typeof clipResult?.dispatchOnCommit?.args.label).toBe("string");
    expect(clipResult?.chain).toContain("SdClippingPlane({origin:[1,2,1.7],normal:[0,0,-1],label:");

    expect(dispatched.map((entry) => entry.verb)).toEqual(["SdSectionBox", "SdClippingPlane"]);
    expect(dispatched[0].args).toEqual({ min: [-2, -1, -0.1], max: [3, 4, 6] });
    expect(dispatched[1].args).toMatchObject({ origin: [1, 2, 1.7], normal: [0, 0, -1] });
  });

  test("emitClickWorld does not directly own op-tool clicks such as extrude", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/tools/index");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const r = emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "extrude" });
    expect(r).toBeNull();
    expect(getCreateSequence().length).toBe(0);
  });
});

describe("canonical geometry transform instances", () => {
  test("precision transform palette commits dispatch SdMove/SdRotate/SdScale instead of owning local mutation", () => {
    const scene = new THREE.Scene();
    const viewer = {
      getScene: () => scene,
      setGumballEnabled: () => {},
    };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    scene.add(mesh);
    setSelected({ topology: "brep", uuid: mesh.uuid, object: mesh, transformTarget: mesh });
    const calls: Array<{ verb: string; args: Record<string, unknown> }> = [];

    registerHandler("SdMove", (args) => {
      calls.push({ verb: "SdMove", args });
      return { moved: true };
    });
    registerHandler("SdRotate", (args) => {
      calls.push({ verb: "SdRotate", args });
      return { rotated: true };
    });
    registerHandler("SdScale", (args) => {
      calls.push({ verb: "SdScale", args });
      return { scaled: true };
    });

    ptStartTool("move");
    ptHandlePoint(viewer as never, new THREE.Vector3(1, 2, 0));
    ptHandlePoint(viewer as never, new THREE.Vector3(4, 6, 0));

    ptStartTool("rotate");
    ptHandlePoint(viewer as never, new THREE.Vector3(0, 0, 0));
    ptHandlePoint(viewer as never, new THREE.Vector3(0, 0, 1));
    ptHandleCoordSubmit(viewer as never, "45");

    ptStartTool("scale-1d");
    ptHandlePoint(viewer as never, new THREE.Vector3(0, 0, 0));
    ptHandleCoordSubmit(viewer as never, "2");

    expect(calls).toEqual([
      { verb: "SdMove", args: { target: mesh.uuid, delta: [3, 4, 0] } },
      { verb: "SdRotate", args: { target: mesh.uuid, pivot: [0, 0, 0], angle: 45, axis: [0, 0, 1] } },
      { verb: "SdScale", args: { target: mesh.uuid, pivot: [0, 0, 0], factor: 2, mode: "1d", axis: "x" } },
    ]);
  });

  test("SdMove edits the linked object transform without replacing its canonical surface", () => {
    const { viewer, scene, store, mesh, record } = makeCanonicalTransformViewer();
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdMove", { x: 4, y: 5, z: 6 });

    expect(result.ok).toBe(true);
    expect(store.resolveObject(mesh)).toBe(record);
    const snapshot = inspectCanonicalGeometry(store, scene.children);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.objectLinks).toHaveLength(1);
    expect(snapshot.objectLinks[0].canonicalGeometryId).toBe(record.id);
    expect(snapshot.objectLinks[0].position).toEqual([4, 5, 6]);
    expect(snapshot.objectLinks[0].worldMatrix).toEqual(mesh.matrixWorld.elements.slice());
  });

  test("SdRotate and SdScale support precision palette base-point semantics by target id", () => {
    const { viewer, mesh } = makeCanonicalTransformViewer();
    registerTransformHandlers(viewer as never);
    mesh.position.set(2, 0, 0);

    const rotated = dispatchSync("SdRotate", {
      target: mesh.uuid,
      pivot: [0, 0, 0],
      angle: 90,
      axis: [0, 0, 1],
    });

    expect(rotated.ok).toBe(true);
    expect(mesh.position.x).toBeCloseTo(0, 5);
    expect(mesh.position.y).toBeCloseTo(2, 5);

    const scaled = dispatchSync("SdScale", {
      target: mesh.uuid,
      pivot: [0, 0, 0],
      factor: 2,
      mode: "2d",
      axis: "xy",
    });

    expect(scaled.ok).toBe(true);
    expect(mesh.position.x).toBeCloseTo(0, 5);
    expect(mesh.position.y).toBeCloseTo(4, 5);
    expect(mesh.scale.x).toBeCloseTo(2, 5);
    expect(mesh.scale.y).toBeCloseTo(2, 5);
    expect(mesh.scale.z).toBeCloseTo(1, 5);
  });

  test("SdCopy creates a second object instance linked to the same canonical geometry", () => {
    const { viewer, scene, store, mesh, record, added } = makeCanonicalTransformViewer();
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdCopy", { target: mesh.uuid, x: 7, y: 0, z: 0 });

    expect(result.ok).toBe(true);
    expect(added).toHaveLength(1);
    const clone = added[0];
    expect(clone).not.toBe(mesh);
    expect(store.resolveObject(clone)).toBe(record);
    expect(clone.position.x).toBe(7);

    const snapshot = inspectCanonicalGeometry(store, scene.children);
    const links = snapshot.objectLinks.filter((link) => link.canonicalGeometryId === record.id);
    expect(links).toHaveLength(2);
    expect(snapshot.linkedRecordIds).toEqual([record.id]);
    expect(snapshot.unlinkedRecordIds).toEqual([]);
  });

  test("SdArray preserves canonical geometry links across generated instances", () => {
    const { viewer, scene, store, mesh, record, added } = makeCanonicalTransformViewer();
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdArray", {
      target: mesh.uuid,
      cols: 3,
      rows: 2,
      spacing: [10, 0, 0],
      spacingY: [0, 20, 0],
    });

    expect(result.ok).toBe(true);
    expect(added).toHaveLength(6);
    for (const obj of added) {
      expect(store.resolveObject(obj)).toBe(record);
    }

    const snapshot = inspectCanonicalGeometry(store, scene.children);
    const links = snapshot.objectLinks.filter((link) => link.canonicalGeometryId === record.id);
    expect(links).toHaveLength(7);
    expect(links.map((link) => link.position).sort()).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 20, 0],
      [10, 0, 0],
      [10, 20, 0],
      [20, 0, 0],
      [20, 20, 0],
    ]);
  });

  test("SdArrayLinear creates N-1 copies with pushBatchAction for undo", () => {
    const { viewer, scene, store, mesh, record, added } = makeCanonicalTransformViewer();
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdArrayLinear", {
      target: mesh.uuid,
      count: 4,
      dx: 2,
      dy: 0,
      dz: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("SdArrayLinear failed");
    const r = result.result as { created: number; ids: string[] };
    expect(r.created).toBe(3); // count-1 copies
    expect(r.ids).toHaveLength(3);
    expect(added).toHaveLength(3);

    // Original still in scene
    expect(scene.getObjectByProperty("uuid", mesh.uuid)).toBeDefined();

    // Each copy is in scene at the right X position
    for (let i = 0; i < 3; i++) {
      const copy = scene.getObjectByProperty("uuid", r.ids[i]);
      expect(copy).toBeDefined();
      expect((copy as THREE.Object3D).position.x).toBeCloseTo(2 * (i + 1), 5);
    }

    // Each copy propagates canonical link from source
    for (const id of r.ids) {
      const copyObj = scene.getObjectByProperty("uuid", id);
      const canonical = store.resolveObject(copyObj!);
      expect(canonical).toBe(record);
    }
  });

  test("SdArrayGrid creates (rows×cols − 1) copies with pushBatchAction", () => {
    const { viewer, scene, store, mesh, record, added } = makeCanonicalTransformViewer();
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdArrayGrid", {
      target: mesh.uuid,
      rows: 2,
      cols: 3,
      dx: 2,
      dy: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("SdArrayGrid failed");
    const r = result.result as { created: number; rows: number; cols: number };
    expect(r.created).toBe(5); // 2×3 − 1 = 5
    expect(added).toHaveLength(5);

    // Original still in scene
    expect(scene.getObjectByProperty("uuid", mesh.uuid)).toBeDefined();
  });

  test("SdArrayPolar creates count-1 copies with pushBatchAction", () => {
    const { viewer, scene, store, mesh, record, added } = makeCanonicalTransformViewer();
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdArrayPolar", {
      target: mesh.uuid,
      count: 4,
      cx: 0,
      cy: 0,
      angle: 360,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("SdArrayPolar failed");
    const r = result.result as { created: number; count: number };
    expect(r.created).toBe(3); // count-1
    expect(added).toHaveLength(3);

    // Original still in scene
    expect(scene.getObjectByProperty("uuid", mesh.uuid)).toBeDefined();
  });

  test("SdArrayAlongCurve creates one command-level path array while preserving canonical links", () => {
    const { viewer, scene, store, mesh, record, added } = makeCanonicalTransformViewer();
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdArrayAlongCurve", {
      target: mesh.uuid,
      path: [[0, 0, 0], [10, 0, 0]],
      count: 3,
    });

    expect(result.ok).toBe(true);
    expect(added).toHaveLength(3);
    for (const obj of added) {
      expect(store.resolveObject(obj)).toBe(record);
      expect(obj.userData.creator).toBe("array-along-curve");
    }
    expect(added.map((obj) => obj.position.x)).toEqual([0, 5, 10]);

    const snapshot = inspectCanonicalGeometry(store, scene.children);
    const links = snapshot.objectLinks.filter((link) => link.canonicalGeometryId === record.id);
    expect(links).toHaveLength(4);
  });

  test("SdBooleanUnion links transformed display operands to a world-space canonical BRep result", () => {
    const scene = new THREE.Scene();
    const store = createCanonicalGeometryStore();
    const added: THREE.Object3D[] = [];
    const viewer = {
      getScene() {
        return scene;
      },
      getActiveObject() {
        return null;
      },
      addMesh(obj: THREE.Object3D, kind?: string) {
        if (kind) obj.userData.kind = kind;
        scene.add(obj);
        added.push(obj);
      },
      getCanonicalGeometryStore() {
        return store;
      },
    };
    const geomA = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);
    const geomB = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);
    const a = new THREE.Mesh(geomA, new THREE.MeshStandardMaterial());
    const b = new THREE.Mesh(geomB, new THREE.MeshStandardMaterial());
    b.position.x = 1;
    a.userData.kind = "brep";
    b.userData.kind = "brep";
    scene.add(a, b);
    const recordA = store.create({ kind: "brep", brep: axisBoxBrep(0, 1, 0, 1, 0, 1), source: "command", createdBy: "SdBox" });
    const recordB = store.create({ kind: "brep", brep: axisBoxBrep(0, 1, 0, 1, 0, 1), source: "command", createdBy: "SdBox" });
    store.linkObject(a, recordA.id);
    store.linkObject(b, recordB.id);
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdBooleanUnion", { a: a.uuid, b: b.uuid });

    expect(result.ok).toBe(true);
    expect((result as { result?: { displaySource?: string } }).result?.displaySource).toBe("canonical-brep");
    expect(added).toHaveLength(1);
    const output = added[0];
    expect(output.userData.booleanDisplaySource).toBe("canonical-brep");
    const canonical = store.resolveObject(output);
    expect(canonical?.kind).toBe("brep");
    if (canonical?.kind !== "brep") throw new Error("expected canonical BRep");
    expect(canonical.createdBy).toBe("boolean-union");
    expect(canonical.metadata).toMatchObject({
      operation: "boolean-union",
      operands: [recordA.id, recordB.id],
    });
    const faceCount = canonical.brep.shells.reduce((total, shell) => total + shell.faces.length, 0);
    expect(faceCount).toBeLessThan(12);
  });

  test("SdBooleanUnion creates display geometry from canonical BReps without operand BufferGeometry", () => {
    const scene = new THREE.Scene();
    const store = createCanonicalGeometryStore();
    const added: THREE.Object3D[] = [];
    const viewer = {
      getScene() {
        return scene;
      },
      getActiveObject() {
        return null;
      },
      addMesh(obj: THREE.Object3D, kind?: string) {
        if (kind) obj.userData.kind = kind;
        scene.add(obj);
        added.push(obj);
      },
      getCanonicalGeometryStore() {
        return store;
      },
    };
    const a = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    const b = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    b.position.x = 1;
    a.userData.kind = "brep";
    b.userData.kind = "brep";
    scene.add(a, b);
    const recordA = store.create({ kind: "brep", brep: axisBoxBrep(0, 1, 0, 1, 0, 1), source: "command", createdBy: "SdBox" });
    const recordB = store.create({ kind: "brep", brep: axisBoxBrep(0, 1, 0, 1, 0, 1), source: "command", createdBy: "SdBox" });
    store.linkObject(a, recordA.id);
    store.linkObject(b, recordB.id);
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdBooleanUnion", { a: a.uuid, b: b.uuid });

    expect(result.ok).toBe(true);
    expect((result as { result?: { displaySource?: string } }).result?.displaySource).toBe("canonical-brep");
    expect(added).toHaveLength(1);
    const output = added[0];
    expect(output).toBeInstanceOf(THREE.Mesh);
    const mesh = output as THREE.Mesh;
    expect(mesh.geometry.getAttribute("position")?.count).toBeGreaterThan(0);
    expect(mesh.userData.booleanDisplaySource).toBe("canonical-brep");
    const canonical = store.resolveObject(output);
    expect(canonical?.kind).toBe("brep");
    if (canonical?.kind !== "brep") throw new Error("expected canonical BRep");
    expect(canonical.createdBy).toBe("boolean-union");
    expect(canonical.metadata).toMatchObject({
      operation: "boolean-union",
      operands: [recordA.id, recordB.id],
      displaySource: "canonical-brep",
    });
  });

  test("SdBooleanUnion resolves child display operands through canonical parent BReps", () => {
    const scene = new THREE.Scene();
    const store = createCanonicalGeometryStore();
    const added: THREE.Object3D[] = [];
    const viewer = {
      getScene() {
        return scene;
      },
      getActiveObject() {
        return null;
      },
      addMesh(obj: THREE.Object3D, kind?: string) {
        if (kind) obj.userData.kind = kind;
        scene.add(obj);
        added.push(obj);
      },
      getCanonicalGeometryStore() {
        return store;
      },
    };
    const parentA = new THREE.Group();
    const parentB = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial());
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial());
    b.position.x = 1;
    a.userData.kind = "brep";
    b.userData.kind = "brep";
    parentA.add(a);
    parentB.add(b);
    scene.add(parentA, parentB);
    const recordA = store.create({ kind: "brep", brep: axisBoxBrep(0, 1, 0, 1, 0, 1), source: "command", createdBy: "SdBox" });
    const recordB = store.create({ kind: "brep", brep: axisBoxBrep(0, 1, 0, 1, 0, 1), source: "command", createdBy: "SdBox" });
    store.linkObject(parentA, recordA.id);
    store.linkObject(parentB, recordB.id);
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdBooleanUnion", { a: a.uuid, b: b.uuid });

    expect(result.ok).toBe(true);
    expect(added).toHaveLength(1);
    const output = added[0];
    const canonical = store.resolveObject(output);
    expect(canonical?.kind).toBe("brep");
    if (canonical?.kind !== "brep") throw new Error("expected canonical BRep");
    expect(canonical.createdBy).toBe("boolean-union");
    expect(canonical.metadata).toMatchObject({
      operation: "boolean-union",
      operands: [recordA.id, recordB.id],
    });
    const faceCount = canonical.brep.shells.reduce((total, shell) => total + shell.faces.length, 0);
    expect(faceCount).toBeLessThan(12);
  });

  test("SdBooleanDifference refuses mesh-derived fallback when canonical BRep operands cannot be solved", () => {
    const scene = new THREE.Scene();
    const store = createCanonicalGeometryStore();
    const added: THREE.Object3D[] = [];
    const viewer = {
      getScene() {
        return scene;
      },
      getActiveObject() {
        return null;
      },
      addMesh(obj: THREE.Object3D, kind?: string) {
        if (kind) obj.userData.kind = kind;
        scene.add(obj);
        added.push(obj);
      },
      getCanonicalGeometryStore() {
        return store;
      },
    };
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    b.position.x = 0.25;
    a.userData.kind = "brep";
    b.userData.kind = "brep";
    scene.add(a, b);
    const brepA = axisBoxBrep(-0.5, 0.5, -0.5, 0.5, -0.5, 0.5);
    brepA.shells[0].faces[0].surface = {
      kind: "sum",
      curveU: { kind: "line", from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, domain: Interval.create(0, 1) },
      curveV: { kind: "line", from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 1 }, domain: Interval.create(0, 1) },
      basepoint: { x: 0, y: 0, z: 0 },
    };
    const recordA = store.create({ kind: "brep", brep: brepA, source: "command", createdBy: "SdBox" });
    const recordB = store.create({ kind: "brep", brep: axisBoxBrep(-0.5, 0.5, -0.5, 0.5, -0.5, 0.5), source: "command", createdBy: "SdBox" });
    store.linkObject(a, recordA.id);
    store.linkObject(b, recordB.id);
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdBooleanDifference", { outer: a.uuid, inner: b.uuid });

    expect(result.ok).toBe(true);
    expect((result as { result?: { error?: string } }).result?.error).toContain("canonical BRep failed");
    expect((result as { result?: { error?: string } }).result?.error).toContain("requires planar breps");
    expect(added).toHaveLength(0);
    expect(scene.children).toContain(a);
    expect(scene.children).toContain(b);
    expect(store.exportRecords().filter((record) => record.createdBy === "boolean-difference")).toHaveLength(0);
  });

  test("SdFillet edge chamfer creates native canonical BRep output", () => {
    const scene = new THREE.Scene();
    const store = createCanonicalGeometryStore();
    const added: THREE.Object3D[] = [];
    const viewer = {
      getScene() {
        return scene;
      },
      getActiveObject() {
        return null;
      },
      addMesh(obj: THREE.Object3D, kind?: string) {
        if (kind) obj.userData.kind = kind;
        scene.add(obj);
        added.push(obj);
      },
      getCanonicalGeometryStore() {
        return store;
      },
    };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.userData.kind = "brep";
    mesh.userData.creator = "box";
    scene.add(mesh);
    const record = store.create({ kind: "brep", brep: axisBoxBrep(-0.5, 0.5, -0.5, 0.5, -0.5, 0.5), source: "command", createdBy: "SdBox" });
    store.linkObject(mesh, record.id);
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdFillet", { target: mesh.uuid, edgeId: 0, radius: 0.05 });

    expect(result.ok).toBe(true);
    expect(added).toHaveLength(1);
    const output = added[0];
    const canonical = store.resolveObject(output);
    expect(canonical?.kind).toBe("brep");
    if (canonical?.kind !== "brep") throw new Error("expected canonical BRep");
    expect(canonical.createdBy).toBe("SdFillet");
    expect(canonical.metadata).toMatchObject({
      operation: "edge-chamfer",
      source: record.id,
      derivation: "canonical-brep-edge-chamfer",
      conversion: "native-trimmed-nurbs-brep",
      displaySource: "canonical-brep",
    });
    const faceCount = canonical.brep.shells.reduce((total, shell) => total + shell.faces.length, 0);
    expect(faceCount).toBe(7);
    expect(canonical.brep.shells[0].faces.every((face) => face.surface.kind === "nurbs")).toBe(true);
    expect(canonical.brep.shells[0].edges.length).toBeGreaterThan(0);
    expect(canonical.brep.shells[0].edges.every((edge) => edge.faceIndex2 !== null)).toBe(true);
    expect(canonical.brep.shells[0].vertices.length).toBeGreaterThan(0);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
    expect(canonical.displayMesh?.derivation).toBe("tessellated-brep");
  });

  test("SdFillet edge chamfer resolves child display targets through canonical parent BReps", () => {
    const scene = new THREE.Scene();
    const store = createCanonicalGeometryStore();
    const added: THREE.Object3D[] = [];
    const viewer = {
      getScene() {
        return scene;
      },
      getActiveObject() {
        return null;
      },
      addMesh(obj: THREE.Object3D, kind?: string) {
        if (kind) obj.userData.kind = kind;
        scene.add(obj);
        added.push(obj);
      },
      getCanonicalGeometryStore() {
        return store;
      },
    };
    const parent = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.userData.kind = "brep";
    mesh.userData.creator = "box";
    parent.add(mesh);
    scene.add(parent);
    const record = store.create({ kind: "brep", brep: axisBoxBrep(-0.5, 0.5, -0.5, 0.5, -0.5, 0.5), source: "command", createdBy: "SdBox" });
    store.linkObject(parent, record.id);
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdFillet", { target: mesh.uuid, edgeId: 0, radius: 0.05 });

    expect(result.ok).toBe(true);
    expect(added).toHaveLength(1);
    const canonical = store.resolveObject(added[0]);
    expect(canonical?.kind).toBe("brep");
    if (canonical?.kind !== "brep") throw new Error("expected canonical BRep");
    expect(canonical.metadata).toMatchObject({
      operation: "edge-chamfer",
      source: record.id,
      derivation: "canonical-brep-edge-chamfer",
      conversion: "native-trimmed-nurbs-brep",
      displaySource: "canonical-brep",
    });
  });

  test("SdFillet all-edge box chamfer creates native canonical BRep output", () => {
    const scene = new THREE.Scene();
    const store = createCanonicalGeometryStore();
    const added: THREE.Object3D[] = [];
    const viewer = {
      getScene() {
        return scene;
      },
      getActiveObject() {
        return null;
      },
      addMesh(obj: THREE.Object3D, kind?: string) {
        if (kind) obj.userData.kind = kind;
        scene.add(obj);
        added.push(obj);
      },
      getCanonicalGeometryStore() {
        return store;
      },
    };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.userData.kind = "brep";
    mesh.userData.creator = "box";
    scene.add(mesh);
    const record = store.create({ kind: "brep", brep: axisBoxBrep(-0.5, 0.5, -0.5, 0.5, -0.5, 0.5), source: "command", createdBy: "SdBox" });
    store.linkObject(mesh, record.id);
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdFillet", { target: mesh.uuid, radius: 0.05 });

    expect(result.ok).toBe(true);
    expect(added).toHaveLength(1);
    const canonical = store.resolveObject(added[0]);
    expect(canonical?.kind).toBe("brep");
    if (canonical?.kind !== "brep") throw new Error("expected canonical BRep");
    expect(canonical.createdBy).toBe("SdFillet");
    expect(canonical.metadata).toMatchObject({
      operation: "all-edge-fillet",
      source: record.id,
      derivation: "canonical-brep-all-edge-chamfer",
      conversion: "native-trimmed-nurbs-brep",
      displaySource: "canonical-brep",
    });
    expect(canonical.brep.shells.reduce((total, shell) => total + shell.faces.length, 0)).toBe(26);
    expect(canonical.brep.shells[0].faces.every((face) => face.surface.kind === "nurbs")).toBe(true);
    const triangularOuterCount = canonical.brep.shells[0].faces.filter((face) => {
      const curve = face.outerLoop.curves[0] as { points?: unknown[] };
      return Array.isArray(curve.points) && curve.points.length === 4;
    }).length;
    expect(triangularOuterCount).toBe(8);
    expect(canonical.brep.shells[0].edges.length).toBeGreaterThan(0);
    expect(canonical.brep.shells[0].edges.every((edge) => edge.faceIndex2 !== null)).toBe(true);
    expect(canonical.brep.shells[0].vertices.length).toBeGreaterThan(0);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
  });

  test("SdFillet unsupported shapes fail explicitly instead of creating mesh-derived canonical fallbacks", () => {
    const scene = new THREE.Scene();
    const store = createCanonicalGeometryStore();
    const added: THREE.Object3D[] = [];
    const viewer = {
      getScene() {
        return scene;
      },
      getActiveObject() {
        return null;
      },
      addMesh(obj: THREE.Object3D, kind?: string) {
        if (kind) obj.userData.kind = kind;
        scene.add(obj);
        added.push(obj);
      },
      getCanonicalGeometryStore() {
        return store;
      },
    };
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), new THREE.MeshStandardMaterial());
    mesh.userData.kind = "brep";
    mesh.userData.creator = "sphere";
    scene.add(mesh);
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdFillet", { target: mesh.uuid, radius: 0.05 });

    expect(result.ok).toBe(true);
    expect((result as { result?: { error?: string } }).result?.error).toContain("Mesh-derived fallback is disabled");
    expect(added).toHaveLength(0);
    expect(scene.children).toContain(mesh);
    expect(store.exportRecords().filter((record) => record.createdBy === "SdFillet")).toHaveLength(0);
  });
});

describe("SdShell — hollow a solid to a thin-walled shell (#254)", () => {
  function makeShellViewer() {
    const scene = new THREE.Scene();
    const store = createCanonicalGeometryStore();
    const added: THREE.Object3D[] = [];
    const viewer = {
      getScene() { return scene; },
      getActiveObject() { return null; },
      addMesh(obj: THREE.Object3D, kind?: string) {
        if (kind) obj.userData.kind = kind;
        scene.add(obj);
        added.push(obj);
      },
      getCanonicalGeometryStore() { return store; },
    };
    return { scene, store, added, viewer };
  }

  test("shells a canonical axis-aligned box — 2-shell BRep with 12 total faces", () => {
    const { scene, store, added, viewer } = makeShellViewer();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.userData.kind = "brep";
    scene.add(mesh);
    const record = store.create({ kind: "brep", brep: axisBoxBrep(-0.5, 0.5, -0.5, 0.5, -0.5, 0.5), source: "command", createdBy: "SdBox" });
    store.linkObject(mesh, record.id);
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdShell", { target: mesh.uuid, thickness: 0.1 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("SdShell failed");
    const r = result.result as { modified: string; thickness: number };
    expect(typeof r.modified).toBe("string");
    expect(r.thickness).toBeCloseTo(0.1, 5);

    expect(added).toHaveLength(1);
    const output = added[0];
    expect(scene.children).not.toContain(mesh); // original removed

    const canonical = store.resolveObject(output);
    expect(canonical?.kind).toBe("brep");
    if (canonical?.kind !== "brep") throw new Error("expected BRep");
    expect(canonical.createdBy).toBe("SdShell");
    expect(canonical.metadata).toMatchObject({
      operation: "shell",
      source: record.id,
      derivation: "canonical-brep-shell",
      conversion: "native-trimmed-nurbs-brep",
      displaySource: "canonical-brep",
    });
    expect(canonical.brep.shells.length).toBe(2); // outer + inner
    const totalFaces = canonical.brep.shells.reduce((n, s) => n + s.faces.length, 0);
    expect(totalFaces).toBe(12); // 6 outer + 6 inner
    expect(canonical.displayMesh?.derivation).toBe("tessellated-brep");
  });

  test("rejects thickness equal to half the smallest dimension", () => {
    const { scene, store, viewer } = makeShellViewer();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.userData.kind = "brep";
    scene.add(mesh);
    const record = store.create({ kind: "brep", brep: axisBoxBrep(-0.5, 0.5, -0.5, 0.5, -0.5, 0.5), source: "command", createdBy: "SdBox" });
    store.linkObject(mesh, record.id);
    registerTransformHandlers(viewer as never);

    // thickness = 0.5 = exactly half of 1.0 smallest dim → must fail
    const result = dispatchSync("SdShell", { target: mesh.uuid, thickness: 0.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected dispatch ok");
    expect((result.result as { error?: string }).error).toBeTruthy();
  });

  test("rejects non-positive thickness before touching scene", () => {
    const { viewer } = makeShellViewer();
    registerTransformHandlers(viewer as never);
    const result = dispatchSync("SdShell", { target: "fake-uuid", thickness: -0.1 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected dispatch ok");
    expect((result.result as { error?: string }).error).toMatch(/positive/);
  });

  test("rejects missing target at schema level (ArgValidationError)", () => {
    const { viewer } = makeShellViewer();
    registerTransformHandlers(viewer as never);
    const result = dispatchSync("SdShell", { thickness: 0.1 });
    // target is required in schema — validation rejects before handler runs
    expect(result.ok).toBe(false);
    expect((result as { error?: string }).error).toBe("ArgValidationError");
  });
});
