// workbench-legacy-chat-input.test.ts — v1 localStorage key behavior.
//
// Direct import avoided: the module pulls @huggingface/transformers transitively
// via agent-harness.ts (same constraint as agent-harness.test.ts).
// Tests mirror the v1 key constants and core persistence logic.

import { describe, expect, test, beforeEach } from "bun:test";

// ── Mirrors from workbench-legacy-chat-input.ts ───────────────────────────────

const CONSOLE_MODE_LS_KEY = "web-cad:console-mode-v1";
const RECENT_LS_KEY        = "web-cad:recent-v1";

type ConsoleMode = "prompt" | "console";
type RecentEntry = { ts: string; label: string };

function loadConsoleMode(): ConsoleMode {
  const v = localStorage.getItem(CONSOLE_MODE_LS_KEY);
  return v === "console" ? "console" : "prompt";
}

function saveConsoleMode(m: ConsoleMode): void {
  try { localStorage.setItem(CONSOLE_MODE_LS_KEY, m); } catch {}
}

function loadRecentEntries(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_LS_KEY);
    return raw ? (JSON.parse(raw) as RecentEntry[]) : [];
  } catch { return []; }
}

function saveRecentEntry(label: string): void {
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const entries = loadRecentEntries().filter(e => e.label !== label);
  entries.unshift({ ts, label });
  try { localStorage.setItem(RECENT_LS_KEY, JSON.stringify(entries.slice(0, 5))); } catch {}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("workbench-legacy-chat-input — v1 console mode persistence", () => {
  beforeEach(() => { localStorage.clear(); });

  test("default is 'prompt' when nothing stored", () => {
    expect(loadConsoleMode()).toBe("prompt");
  });

  test("saves to CONSOLE_MODE_LS_KEY = 'web-cad:console-mode-v1'", () => {
    saveConsoleMode("console");
    expect(localStorage.getItem("web-cad:console-mode-v1")).toBe("console");
  });

  test("round-trip console → prompt", () => {
    saveConsoleMode("console");
    expect(loadConsoleMode()).toBe("console");
    saveConsoleMode("prompt");
    expect(loadConsoleMode()).toBe("prompt");
  });

  test("no legacy gemma-* key written", () => {
    saveConsoleMode("console");
    expect(localStorage.getItem("gemma-cad:console-mode-v1")).toBeNull();
    expect(localStorage.getItem("gemma-architect:console-mode-v1")).toBeNull(); // intentionally-preserved: regression test — old key should NOT be written by current code
  });
});

describe("workbench-legacy-chat-input — v1 recent entries persistence", () => {
  beforeEach(() => { localStorage.clear(); });

  test("empty array when nothing stored", () => {
    expect(loadRecentEntries()).toEqual([]);
  });

  test("saves to RECENT_LS_KEY = 'web-cad:recent-v1'", () => {
    saveRecentEntry("build a wall");
    expect(localStorage.getItem("web-cad:recent-v1")).not.toBeNull();
  });

  test("no legacy gemma-* key written", () => {
    saveRecentEntry("test");
    expect(localStorage.getItem("gemma-cad:recent-v1")).toBeNull();
    expect(localStorage.getItem("gemma-architect:recent-v1")).toBeNull(); // intentionally-preserved: regression test — old key should NOT be written by current code
  });

  test("newest entry is first (prepend behavior)", () => {
    saveRecentEntry("alpha");
    saveRecentEntry("beta");
    const entries = loadRecentEntries();
    expect(entries[0].label).toBe("beta");
    expect(entries[1].label).toBe("alpha");
  });

  test("deduplicates by label — re-added label moves to top", () => {
    saveRecentEntry("wall");
    saveRecentEntry("column");
    saveRecentEntry("wall");
    const entries = loadRecentEntries();
    expect(entries[0].label).toBe("wall");
    expect(entries.filter(e => e.label === "wall").length).toBe(1);
  });

  test("caps at 5 entries", () => {
    for (let i = 1; i <= 7; i++) saveRecentEntry(`entry-${i}`);
    expect(loadRecentEntries().length).toBe(5);
  });

  test("each entry has a ts field in HH:MM format", () => {
    saveRecentEntry("test prompt");
    const [entry] = loadRecentEntries();
    expect(entry.ts).toMatch(/^\d{2}:\d{2}$/);
  });

  test("stored JSON is an array of {ts, label} objects", () => {
    saveRecentEntry("make a room");
    const raw = localStorage.getItem(RECENT_LS_KEY)!;
    const parsed = JSON.parse(raw) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    const first = parsed[0] as Record<string, unknown>;
    expect(typeof first.ts).toBe("string");
    expect(typeof first.label).toBe("string");
    expect(first.label).toBe("make a room");
  });
});
