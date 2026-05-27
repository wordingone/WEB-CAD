import { describe, expect, test } from "bun:test";
import {
  createSceneAutosavePayload,
  readSceneAutosavePayload,
} from "../src/io/scene-store";

describe("scene-store canonical autosave payloads", () => {
  test("stores display objects and canonical geometry records together", () => {
    const objects = [{ uuid: "display-1" }];
    const canonicalGeometry = [{ id: "cg_0001", kind: "curve" }];

    const payload = createSceneAutosavePayload(objects, canonicalGeometry);

    expect(payload).toEqual({
      version: 2,
      objects,
      canonicalGeometry,
    });
    expect(readSceneAutosavePayload(payload)).toEqual(payload);
  });

  test("reads legacy array autosaves as object-only payloads", () => {
    const legacy = [{ uuid: "display-1" }];

    expect(readSceneAutosavePayload(legacy)).toEqual({
      version: 2,
      objects: legacy,
      canonicalGeometry: [],
    });
  });

  test("rejects malformed autosave payloads", () => {
    expect(readSceneAutosavePayload(null)).toBeNull();
    expect(readSceneAutosavePayload({ canonicalGeometry: [] })).toBeNull();
  });
});
