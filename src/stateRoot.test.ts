import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadLayout } from "./layout.ts";
import { stateRoot, StateRootError } from "./stateRoot.ts";
import { storePath } from "./store/db.ts";
import { makeFixture, stateRootFixture } from "./testFixtures.ts";

function layout() {
  return loadLayout(makeFixture().root);
}

function configure(value: unknown) {
  const current = layout();
  mkdirSync(current.varDir, { recursive: true });
  writeFileSync(join(current.varDir, "work-protocol.json"), JSON.stringify(value));
  return current;
}

describe("stateRoot", () => {
  it("reads the 3.0 stateRoot-only configuration", () => {
    const current = layout();
    const root = stateRootFixture(current);
    expect(stateRoot(current)).toBe(root);
    expect(storePath(current)).toBe(join(root, "coordination.db"));
  });

  it("still reads the 2.1 configuration, read-only, without the fence or workspace record", () => {
    const current = layout();
    const root = stateRootFixture(current, { legacy: true });
    expect(stateRoot(current)).toBe(root);
  });

  it("uses var/ without a configuration", () => {
    const current = layout();
    expect(stateRoot(current)).toBe(current.varDir);
  });

  it("refuses a malformed configuration and a root inside a repository", () => {
    for (const value of [
      { schema: 2 },
      { schema: 2, stateRoot: "relative/path" },
      { schema: 3, stateRoot: "/abs" },
      { extra: true, schema: 2, stateRoot: "/abs" },
      [],
    ]) {
      expect(() => stateRoot(configure(value)), JSON.stringify(value)).toThrow(
        new StateRootError("invalid-state-root-config"),
      );
    }
    const inside = configure({ schema: 2, stateRoot: "/placeholder" });
    writeFileSync(
      join(inside.varDir, "work-protocol.json"),
      JSON.stringify({ schema: 2, stateRoot: join(inside.root, "state") }),
    );
    expect(() => stateRoot(inside)).toThrow(new StateRootError("state-root-excluded"));
  });
});
