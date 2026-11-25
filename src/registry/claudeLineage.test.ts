import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { claudeProjectsDir, clearPredecessor, clearSuccessor } from "./claudeLineage.ts";

const OLD = "00000000-0000-4000-8000-0000000000a1";
const NEW = "00000000-0000-4000-8000-0000000000a2";
const OTHER = "00000000-0000-4000-8000-0000000000a3";
/** The most transcript bytes read for the header. */
const HEADER_LIMIT = 64 * 1024;

type Entry = { type: string; id: string; via: string };

function derived(sessionId: string, ...sessions: Entry[]): Record<string, unknown> {
  return { sessionId, sessions, type: "derived-from", v: 1 };
}

const clear: Entry = { id: OLD, type: "claude_code_session", via: "clear" };
const user = { message: { content: "hello", role: "user" }, type: "user" };

/** A projects directory holding `lines` as NEW's transcript in one project. */
function projects(lines: readonly (string | Record<string, unknown>)[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ck-lineage-"));
  mkdirSync(join(dir, "project-a"));
  writeFileSync(
    join(dir, "project-a", `${NEW}.jsonl`),
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"),
  );
  return dir;
}

describe("clearPredecessor", () => {
  it.each<[string, readonly (string | Record<string, unknown>)[], string | null]>([
    ["a clear header", [derived(NEW, clear), user], OLD],
    ["a header that ends the file", [derived(NEW, clear)], OLD],
    [
      "unparsable lines and unknown types",
      ["{not json", { type: "summary" }, derived(NEW, clear), user],
      OLD,
    ],
    ["via fork", [derived(NEW, { ...clear, via: "fork" }), user], null],
    ["via resume", [derived(NEW, { ...clear, via: "resume" }), user], null],
    ["another session type", [derived(NEW, { ...clear, type: "codex_thread" }), user], null],
    ["an invalid predecessor ID", [derived(NEW, { ...clear, id: "not-a-uuid" }), user], null],
    ["the caller as its own predecessor", [derived(NEW, { ...clear, id: NEW }), user], null],
    ["a record for another session", [derived(OLD, clear), user], null],
    ["two sessions in the record", [derived(NEW, clear, clear), user], null],
    ["two derived-from records", [derived(NEW, clear), derived(NEW, clear), user], null],
    ["a record after the first user record", [user, derived(NEW, clear)], null],
    [
      "a record after the first assistant record",
      [{ type: "assistant" }, derived(NEW, clear)],
      null,
    ],
    [
      "a long transcript after a short header",
      [derived(NEW, clear), user, { pad: "x".repeat(HEADER_LIMIT) }],
      OLD,
    ],
    ["no derived-from record", [user], null],
    [
      "a header longer than the limit",
      [{ pad: "x".repeat(HEADER_LIMIT), type: "summary" }, derived(NEW, clear), user],
      null,
    ],
  ])("reads %s", (_, lines, expected) => {
    expect(clearPredecessor(projects(lines), NEW)).toBe(expected);
  });

  it("requires exactly one transcript for the ID", () => {
    const dir = projects([derived(NEW, clear), user]);
    expect(clearPredecessor(join(dir, "absent"), NEW)).toBeNull();
    expect(clearPredecessor(dir, OLD)).toBeNull();
    mkdirSync(join(dir, "project-b"));
    writeFileSync(join(dir, "project-b", `${NEW}.jsonl`), JSON.stringify(derived(NEW, clear)));
    expect(clearPredecessor(dir, NEW)).toBeNull();
  });
});

describe("clearSuccessor", () => {
  /** A projects directory with OLD's transcript in project-a, modified at `oldAt` seconds. */
  function lineage(oldAt = 1_000): {
    dir: string;
    add(project: string, id: string, at?: number): void;
  } {
    const dir = mkdtempSync(join(tmpdir(), "ck-lineage-"));
    const add = (project: string, id: string, at?: number) => {
      mkdirSync(join(dir, project), { recursive: true });
      const path = join(dir, project, `${id}.jsonl`);
      const lines = id === OLD ? [user] : [derived(id, clear), user];
      writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
      if (at !== undefined) {
        utimesSync(path, at, at);
      }
    };
    add("project-a", OLD, oldAt);
    return { add, dir };
  }

  it("finds a successor in another project directory", () => {
    const { add, dir } = lineage();
    add("project-b", NEW, 2_000);
    expect(clearSuccessor(dir, OLD)).toBe(NEW);
  });

  it("ignores a transcript modified before the predecessor's", () => {
    const { add, dir } = lineage();
    add("project-b", OTHER, 999);
    expect(clearSuccessor(dir, OLD)).toBeNull();
    add("project-c", NEW, 1_000);
    expect(clearSuccessor(dir, OLD)).toBe(NEW);
  });

  it("stays unresolved for two successors in different project directories", () => {
    const { add, dir } = lineage();
    add("project-b", NEW, 2_000);
    add("project-c", OTHER, 2_000);
    expect(clearSuccessor(dir, OLD)).toBeNull();
  });

  it("needs exactly one predecessor transcript", () => {
    const { add, dir } = lineage();
    add("project-b", NEW, 2_000);
    add("project-c", OLD, 1_000);
    expect(clearSuccessor(dir, OLD)).toBeNull();
    expect(clearSuccessor(join(dir, "absent"), OLD)).toBeNull();
  });
});

describe("claudeProjectsDir", () => {
  it.each<[NodeJS.ProcessEnv, string | null]>([
    [{ CLAUDE_CONFIG_DIR: "/config", HOME: "/synthetic/home" }, "/config/projects"],
    [{ HOME: "/synthetic/home" }, "/synthetic/home/.claude/projects"],
    [{ CLAUDE_CONFIG_DIR: "", HOME: "/synthetic/home" }, "/synthetic/home/.claude/projects"],
    [{ CLAUDE_CONFIG_DIR: "config", HOME: "/synthetic/home" }, null],
    [{ HOME: "synthetic/home" }, null],
    [{}, null],
  ])("resolves %j", (env, expected) => {
    expect(claudeProjectsDir(env)).toBe(expected);
  });
});
