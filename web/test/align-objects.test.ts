import { beforeEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import { getDictionary } from "../src/commands/dictionary";
import { dispatchSync, registerHandler, unregisterHandler } from "../src/commands/dispatch";
import { clearCommandSession, startCommandSession } from "../src/commands/command-session";
import { registerTransformHandlers } from "../src/handlers/transforms";
import { alignToolCommandMode } from "../src/tools/index";
import { addToMultiSelected, clearMultiSelected, clearSelected } from "../src/viewer/selection-state";

beforeEach(() => {
  unregisterHandler("SdAlignObjects");
  clearCommandSession();
  clearSelected();
  clearMultiSelected();
});

describe("SdAlignObjects", () => {
  test("SdAlignObjects is in dictionary", () => {
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdAlignObjects");
    expect(entry).toBeDefined();
    expect(entry?.topology_role).toBe("transform");
  });

  test("dispatches with mode=left", async () => {
    let called: Record<string, unknown> | null = null;
    registerHandler("SdAlignObjects", (args) => {
      called = args;
      return { ok: true };
    });
    const s = await startCommandSession({
      command: "SdAlignObjects",
      parameters: { mode: "left" },
      metadata: { source: "agent" },
    });
    expect(s.status).toBe("success");
    expect((called as any)?.mode).toBe("left");
  });

  test("dispatches with mode=right", async () => {
    let called: Record<string, unknown> | null = null;
    registerHandler("SdAlignObjects", (args) => {
      called = args;
      return { ok: true };
    });
    const s = await startCommandSession({
      command: "SdAlignObjects",
      parameters: { mode: "right" },
      metadata: { source: "agent" },
    });
    expect(s.status).toBe("success");
    expect((called as any)?.mode).toBe("right");
  });

  test("dispatches with mode=center-h", async () => {
    let called: Record<string, unknown> | null = null;
    registerHandler("SdAlignObjects", (args) => {
      called = args;
      return { ok: true };
    });
    const s = await startCommandSession({
      command: "SdAlignObjects",
      parameters: { mode: "center-h" },
      metadata: { source: "agent" },
    });
    expect(s.status).toBe("success");
    expect((called as any)?.mode).toBe("center-h");
  });

  test("dispatches with mode=dist-v", async () => {
    let called: Record<string, unknown> | null = null;
    registerHandler("SdAlignObjects", (args) => {
      called = args;
      return { ok: true };
    });
    const s = await startCommandSession({
      command: "SdAlignObjects",
      parameters: { mode: "dist-v" },
      metadata: { source: "agent" },
    });
    expect(s.status).toBe("success");
    expect((called as any)?.mode).toBe("dist-v");
  });

  test("has correct synonyms for align variations", () => {
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdAlignObjects");
    expect(entry?.synonyms).toContain("align left");
    expect(entry?.synonyms).toContain("align right");
    expect(entry?.synonyms).toContain("distribute horizontal");
  });

  test("palette ids normalize to the same modes accepted by SdAlignObjects", () => {
    expect(alignToolCommandMode("align-left")).toBe("left");
    expect(alignToolCommandMode("align-center-h")).toBe("center-h");
    expect(alignToolCommandMode("dist-v")).toBe("dist-v");
    expect(alignToolCommandMode("right")).toBe("right");
  });

  test("SdAlignObjects mode=left mutates the selected objects through the same align implementation", () => {
    const scene = new THREE.Scene();
    const viewer = {
      getScene: () => scene,
      getActiveObject: () => null,
      addMesh: (obj: THREE.Object3D) => {
        scene.add(obj);
        return obj;
      },
      getCanonicalGeometryStore: () => ({ resolveObjectOrAncestor: () => null }),
    };
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    a.position.x = 0;
    b.position.x = 5;
    scene.add(a, b);
    addToMultiSelected({ topology: "mesh", uuid: a.uuid, object: a, transformTarget: a });
    addToMultiSelected({ topology: "mesh", uuid: b.uuid, object: b, transformTarget: b });
    registerTransformHandlers(viewer as never);

    const result = dispatchSync("SdAlignObjects", { mode: "left" });

    expect(result.ok).toBe(true);
    expect(a.position.x).toBeCloseTo(0);
    expect(b.position.x).toBeCloseTo(0);
  });
});
