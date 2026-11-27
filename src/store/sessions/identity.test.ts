import { describe, expect, it } from "vitest";

import { readRegistry } from "../../registry/store.ts";
import { ART, COORDINATOR, storeFixture, TECH, TECH_CODEX } from "../testStore.ts";
import { resolveCaller } from "./identity.ts";

describe("resolveCaller", () => {
  const registry = () => readRegistry(storeFixture().layout);

  it("binds the role whose effective harness conversation equals the harness variable", () => {
    const roles = registry();
    expect(resolveCaller(roles, { CLAUDE_CODE_SESSION_ID: TECH })).toEqual({
      nativeId: TECH,
      role: "archies-dog-walks/tech",
    });
    expect(resolveCaller(roles, { CODEX_THREAD_ID: ART })).toEqual({
      nativeId: ART,
      role: "archies-dog-walks/art",
    });
    // Both variables binding a role (a session started from another harness's shell) is
    // ambiguous; `--native-id` settles it.
    expect(() =>
      resolveCaller(roles, { CLAUDE_CODE_SESSION_ID: COORDINATOR, CODEX_THREAD_ID: ART }),
    ).toThrow("caller-ambiguous");
    expect(
      resolveCaller(
        roles,
        { CLAUDE_CODE_SESSION_ID: COORDINATOR, CODEX_THREAD_ID: ART },
        { nativeId: ART },
      ),
    ).toEqual({
      nativeId: ART,
      role: "archies-dog-walks/art",
    });
    expect(
      resolveCaller(roles, { CLAUDE_CODE_SESSION_ID: COORDINATOR, CODEX_THREAD_ID: TECH_CODEX }),
    ).toEqual({
      nativeId: COORDINATOR,
      role: "game-coordinator",
    });
  });

  it("prefers --native-id over the environment and records an unverified worker", () => {
    expect(
      resolveCaller(
        registry(),
        { CLAUDE_CODE_SESSION_ID: TECH },
        { nativeId: COORDINATOR, worker: "store-1" },
      ),
    ).toEqual({
      nativeId: COORDINATOR,
      role: "game-coordinator",
      worker: "store-1",
    });
  });

  it("refuses a wrong native ID, the wrong harness variable, an unregistered ID and no ID", () => {
    const roles = registry();
    expect(() =>
      resolveCaller(roles, { CLAUDE_CODE_SESSION_ID: TECH }, { nativeId: ART.replace("d3", "e3") }),
    ).toThrow("caller-unbound");
    // Tech's effective harness is Claude, so its Codex ID in CODEX_THREAD_ID does not bind it.
    expect(() => resolveCaller(roles, { CODEX_THREAD_ID: TECH_CODEX })).toThrow("caller-unbound");
    // Art is on Codex, so its ID in the Claude variable does not bind it either.
    expect(() => resolveCaller(roles, { CLAUDE_CODE_SESSION_ID: ART })).toThrow("caller-unbound");
    expect(() =>
      resolveCaller(roles, { CLAUDE_CODE_SESSION_ID: "00000000-0000-4000-8000-0000000000ff" }),
    ).toThrow("caller-unbound");
    expect(() => resolveCaller(roles, {})).toThrow("caller-unidentified");
    expect(() => resolveCaller(roles, {}, { nativeId: "not-a-uuid" })).toThrow("invalid-native-id");
    expect(() =>
      resolveCaller(roles, { CLAUDE_CODE_SESSION_ID: TECH }, { worker: "bad name" }),
    ).toThrow("invalid-worker");
  });

  it("refuses an ID bound to more than one role", () => {
    const { layout } = storeFixture((roles) => {
      roles["archies-dog-walks/gameplay"] = {
        ...roles["archies-dog-walks/gameplay"],
        conversations: { claude: TECH },
      };
    });
    expect(() => resolveCaller(readRegistry(layout), { CLAUDE_CODE_SESSION_ID: TECH })).toThrow(
      "caller-ambiguous",
    );
  });
});
