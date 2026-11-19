import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { claudeFixture, RECIPIENT } from "../../review/fixtures.ts";
import { readWakeFile, wakeFilePath, wakeText, WakeWatcher, writeWakeFile } from "./wakeFile.ts";

const WAKE = { count: 2, role: "game-coordinator" };

describe("wake files", () => {
  it("lives under var/ without an active protocol and advances seq atomically", () => {
    const { layout } = claudeFixture();
    const path = wakeFilePath(layout, RECIPIENT);
    expect(path).toBe(join(layout.varDir, "wake", `${RECIPIENT}.json`));
    expect(readWakeFile(path)).toBe("absent");
    expect(writeWakeFile(layout, RECIPIENT, WAKE)).toBe(1);
    expect(writeWakeFile(layout, RECIPIENT, { ...WAKE, count: 3 })).toBe(2);
    expect(readWakeFile(path)).toEqual({ count: 3, role: "game-coordinator", seq: 2 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      count: 3,
      role: "game-coordinator",
      schema: 1,
      seq: 2,
    });
    expect(wakeText({ count: 3, role: "game-coordinator", seq: 2 })).toBe(
      "3 new messages for game-coordinator: run coordination-kit inbox",
    );
  });

  it("refuses an invalid wake and a torn file whose seq is unknown", () => {
    const { layout } = claudeFixture();
    expect(() =>
      writeWakeFile(layout, RECIPIENT, { count: 0, role: "game-coordinator" }),
    ).toThrow();
    expect(() => writeWakeFile(layout, RECIPIENT, { count: 1, role: "../x" })).toThrow();
    expect(() => writeWakeFile(layout, "not-a-uuid", WAKE)).toThrow();
    const path = wakeFilePath(layout, RECIPIENT);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"schema":1,"seq":');
    expect(readWakeFile(path)).toBe("invalid");
    expect(() => writeWakeFile(layout, RECIPIENT, WAKE)).toThrow(/unreadable/);
    for (const value of [
      { count: 1, role: "game-coordinator", schema: 1, seq: 0 },
      { count: 1, role: "game-coordinator", schema: 2, seq: 1 },
      { count: 1, extra: true, role: "game-coordinator", schema: 1, seq: 1 },
      { count: 1.5, role: "game-coordinator", schema: 1, seq: 1 },
    ]) {
      writeFileSync(path, JSON.stringify(value));
      expect(readWakeFile(path)).toBe("invalid");
    }
  });
});

describe("WakeWatcher", () => {
  it("announces each seq increase once, coalescing increases between polls", () => {
    const { layout } = claudeFixture();
    const path = wakeFilePath(layout, RECIPIENT);
    const watcher = new WakeWatcher(() => path);
    expect(existsSync(path)).toBe(false);
    expect(watcher.poll()).toBeUndefined();
    writeWakeFile(layout, RECIPIENT, WAKE);
    expect(watcher.poll()).toEqual({ ...WAKE, seq: 1 });
    expect(watcher.poll()).toBeUndefined();
    writeWakeFile(layout, RECIPIENT, WAKE);
    writeWakeFile(layout, RECIPIENT, { ...WAKE, count: 5 });
    expect(watcher.poll()).toEqual({ count: 5, role: "game-coordinator", seq: 3 });
    expect(watcher.poll()).toBeUndefined();
  });

  it("announces a wake present at startup once and never announces a lower seq", () => {
    const { layout } = claudeFixture();
    const path = wakeFilePath(layout, RECIPIENT);
    writeWakeFile(layout, RECIPIENT, WAKE);
    writeWakeFile(layout, RECIPIENT, WAKE);
    const watcher = new WakeWatcher(() => path);
    expect(watcher.poll()).toEqual({ ...WAKE, seq: 2 });
    expect(watcher.poll()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ count: 1, role: "game-coordinator", schema: 1, seq: 1 }));
    expect(watcher.poll()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ count: 1, role: "game-coordinator", schema: 1, seq: 2 }));
    expect(watcher.poll()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ count: 1, role: "game-coordinator", schema: 1, seq: 3 }));
    expect(watcher.poll()).toMatchObject({ seq: 3 });
  });

  it("survives a missing, torn or unlocatable file", () => {
    const { layout } = claudeFixture();
    const path = wakeFilePath(layout, RECIPIENT);
    let locatable = false;
    const watcher = new WakeWatcher(() => {
      if (!locatable) {
        throw new Error("protocol selection unavailable");
      }
      return path;
    });
    expect(watcher.poll()).toBeUndefined();
    locatable = true;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{");
    expect(watcher.poll()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ count: 1, role: "game-coordinator", schema: 1, seq: 4 }));
    // The first readable wake is announced.
    expect(watcher.poll()).toMatchObject({ seq: 4 });
    writeFileSync(path, '{"count":1,"role":"game-');
    expect(watcher.poll()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ count: 1, role: "game-coordinator", schema: 1, seq: 5 }));
    expect(watcher.poll()).toMatchObject({ seq: 5 });
  });
});
