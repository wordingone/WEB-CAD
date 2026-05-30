// Tests for buildSceneContext() — specifically the fallback path (KG empty)
// that reads window.__viewer.scene.children for non-IFC scenes.
// Isolated from agent-harness.ts to avoid @huggingface/transformers import.

import { beforeEach, describe, expect, test } from "bun:test";
import { buildSceneContext } from "../src/agent/agent-scene-context";

type SceneChild = {
  type: string;
  name?: string;
  visible?: boolean;
  userData?: Record<string, unknown>;
  position?: { x: number; y: number; z: number };
};

function setViewerScene(children: SceneChild[]): void {
  (window as unknown as Record<string, unknown>).__viewer = {
    scene: { children },
  };
}

beforeEach(() => {
  // Clear viewer so KG fallback path is reached (KG will be empty in test env)
  delete (window as unknown as Record<string, unknown>).__viewer;
});

describe("buildSceneContext — fallback path visibility", () => {
  test("returns empty-workspace string when no viewer", () => {
    const ctx = buildSceneContext();
    expect(ctx).toMatch(/empty/i);
  });

  test("visible object has no [hidden] marker", () => {
    setViewerScene([
      { type: "Mesh", name: "Box", visible: true, userData: { creator: "SdBox" }, position: { x: 0, y: 0, z: 0 } },
    ]);
    const ctx = buildSceneContext();
    expect(ctx).toContain("Box");
    expect(ctx).not.toContain("[hidden]");
  });

  test("hidden object (visible=false) gets [hidden] marker", () => {
    setViewerScene([
      { type: "Mesh", name: "HiddenBox", visible: false, userData: { creator: "SdBox" }, position: { x: 1, y: 0, z: 0 } },
    ]);
    const ctx = buildSceneContext();
    expect(ctx).toContain("HiddenBox");
    expect(ctx).toContain("[hidden]");
  });

  test("mixed visibility: one hidden, one visible", () => {
    setViewerScene([
      { type: "Mesh", name: "BoxA", visible: true,  userData: { creator: "SdBox" }, position: { x: 0, y: 0, z: 0 } },
      { type: "Mesh", name: "BoxB", visible: false, userData: { creator: "SdBox" }, position: { x: 2, y: 0, z: 0 } },
    ]);
    const ctx = buildSceneContext();
    expect(ctx).toContain("BoxA");
    expect(ctx).toContain("BoxB");
    expect(ctx).toContain("[hidden]");
    // BoxA entry must NOT be tagged hidden (entries are semicolon-separated; match only within BoxA's segment)
    const boxASegment = ctx.split(";").find((s) => s.includes("BoxA")) ?? "";
    expect(boxASegment).not.toContain("[hidden]");
  });

  test("object with visible=undefined (default) treated as visible", () => {
    setViewerScene([
      { type: "Mesh", name: "DefaultBox", userData: { creator: "SdBox" }, position: { x: 0, y: 0, z: 0 } },
    ]);
    const ctx = buildSceneContext();
    expect(ctx).toContain("DefaultBox");
    expect(ctx).not.toContain("[hidden]");
  });

  test("scaffolding objects (no userData.creator) are excluded", () => {
    setViewerScene([
      { type: "Mesh", name: "GridHelper", visible: true, userData: {} },
      { type: "Mesh", name: "Box", visible: true, userData: { creator: "SdBox" } },
    ]);
    const ctx = buildSceneContext();
    expect(ctx).not.toContain("GridHelper");
    expect(ctx).toContain("Box");
  });

  test("2 objects total count in output", () => {
    setViewerScene([
      { type: "Mesh", name: "A", visible: true,  userData: { creator: "SdBox" } },
      { type: "Mesh", name: "B", visible: false, userData: { creator: "SdBox" } },
    ]);
    const ctx = buildSceneContext();
    expect(ctx).toContain("2 object(s)");
  });
});
