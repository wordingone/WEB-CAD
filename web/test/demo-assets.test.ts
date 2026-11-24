import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import { demoCaption, DEMO_META_URL } from "../src/agent/demo-video";

describe("recorded demo assets ship with the app", () => {
  const dir = new URL("../public/demo/", import.meta.url);
  const f = (n: string) => new URL(n, dir);
  test("video, poster and metadata exist and are the size the docs promise", () => {
    for (const n of ["demo.mp4", "demo-poster.jpg", "demo.json"]) expect(existsSync(f(n))).toBe(true);
    expect(statSync(f("demo.mp4")).size).toBeLessThan(15 * 1024 * 1024);
    expect(statSync(f("demo.mp4")).size).toBeGreaterThan(100 * 1024);
  });
  test("metadata is what the caption needs", () => {
    const m = JSON.parse(readFileSync(f("demo.json"), "utf8"));
    expect(demoCaption(m)).toContain("real session");
    expect(m.recordedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(DEMO_META_URL).toBe("demo/demo.json");
  });
});
