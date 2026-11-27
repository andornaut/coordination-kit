import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../core/cli/io.ts";
import { holdLock } from "../core/files/lock.ts";
import { bundledSkill, MANAGED_SKILLS, syncProjectSkills } from "./managedSkills.ts";
import { skillsInstall, skillsSync } from "./skills.ts";

const SKILLS = ".agents/skills";
const MANIFEST = `${SKILLS}/.coordination-kit.json`;
const LIFECYCLE = `${SKILLS}/coordination-lifecycle/SKILL.md`;
const HANDOFF = `${SKILLS}/coordination-handoff/SKILL.md`;
const RECOVERY = `${SKILLS}/coordination-recovery/SKILL.md`;
const STATUS = `${SKILLS}/coordination-status/SKILL.md`;

function put(path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function sha(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), "managed-skills-"));
  const root = join(scratch, "project");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const io: Io = { cwd: root, env: {}, err: () => {}, out: () => {} };
  return { io, root, scratch };
}

async function cli(handler: Handler, io: Io, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await handler(
    { ...io, err: (value) => (err += value), out: (value) => (out += value) },
    io.cwd,
    args,
  );
  return { code, err, json: out === "" ? null : (JSON.parse(out) as unknown) };
}

function sync(io: Io, ...args: string[]) {
  return cli(skillsSync, io, "--harness", "codex", "--scope", "project", ...args);
}

function versionedBundle(
  io: Io,
  directory: string,
  overrides: Partial<Record<keyof typeof MANAGED_SKILLS, string>>,
) {
  const entry = join(directory, "dist", "cli.js");
  for (const [key, name] of Object.entries(MANAGED_SKILLS)) {
    const bytes = overrides[key as keyof typeof MANAGED_SKILLS] ?? bundledSkill(io, name);
    put(join(directory, "skills", name, "SKILL.md"), bytes);
  }
  return { ...io, entry };
}

describe("skills sync", () => {
  it("adopts identical bytes in place and leaves unrelated skills and the other harness alone", async () => {
    const { io, root } = fixture();
    const lifecycle = bundledSkill(io, MANAGED_SKILLS.lifecycle);
    put(join(root, LIFECYCLE), lifecycle);
    put(join(root, SKILLS, "unrelated", "SKILL.md"), "User skill.");
    const stat = lstatSync(join(root, LIFECYCLE));
    const result = await sync(io);
    expect(result).toMatchObject({
      code: EXIT_OK,
      json: {
        harness: "codex",
        manifest: MANIFEST,
        schema: 1,
        skills: [
          { action: "installed", skill: "handoff" },
          { action: "adopted", sha256: sha(lifecycle), skill: "lifecycle" },
          { action: "installed", skill: "recovery" },
          { action: "installed", skill: "status" },
        ],
        status: "synced",
      },
    });
    expect(lstatSync(join(root, LIFECYCLE)).ino).toBe(stat.ino);
    expect(lstatSync(join(root, LIFECYCLE)).mtimeMs).toBe(stat.mtimeMs);
    expect(readFileSync(join(root, SKILLS, "unrelated", "SKILL.md"), "utf8")).toBe("User skill.");
    expect(existsSync(join(root, SKILLS, "agent-cleanup"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(
      await cli(skillsInstall, io, "agent-cleanup", "--harness", "claude", "--scope", "project"),
    ).toMatchObject({ code: EXIT_OK, json: { installed: true } });
    const manifest = lstatSync(join(root, MANIFEST));
    expect(await sync(io)).toMatchObject({
      code: EXIT_OK,
      json: { skills: Array.from({ length: 4 }, () => ({ action: "unchanged" })) },
    });
    expect(lstatSync(join(root, MANIFEST)).ino).toBe(manifest.ino);
  });

  it("preflights every skill and changes differing files only with the reviewed exact digest", async () => {
    const { io, root } = fixture();
    const localHandoff = "Local handoff.";
    const localStatus = "Local status.";
    put(join(root, HANDOFF), localHandoff);
    put(join(root, STATUS), localStatus);
    const first = await sync(io, "--adopt", `handoff=${"0".repeat(64)}`);
    expect(first).toMatchObject({
      code: EXIT_INVALID,
      json: {
        conflicts: [
          { path: HANDOFF, reason: "adoption-digest-mismatch", sha256: sha(localHandoff) },
          { path: STATUS, reason: "unmanaged-bytes", sha256: sha(localStatus) },
        ],
        status: "conflict",
      },
    });
    expect(first.err).toContain(`--adopt handoff=${sha(localHandoff)}`);
    expect(existsSync(join(root, MANIFEST))).toBe(false);
    expect(existsSync(join(root, LIFECYCLE))).toBe(false);
    expect(readFileSync(join(root, HANDOFF), "utf8")).toBe(localHandoff);
    expect(readFileSync(join(root, STATUS), "utf8")).toBe(localStatus);
    const approved = [
      "--adopt",
      `handoff=${sha(localHandoff)}`,
      "--adopt",
      `status=${sha(localStatus)}`,
    ];
    expect(await sync(io, ...approved)).toMatchObject({
      code: EXIT_OK,
      json: { status: "synced" },
    });
    expect(await sync(io, ...approved)).toMatchObject({
      code: EXIT_OK,
      json: { status: "synced" },
    });
    expect(readFileSync(join(root, STATUS))).toEqual(bundledSkill(io, MANAGED_SKILLS.status));
  });

  it("updates prior managed bytes and resumes an intent with one file already replaced", async () => {
    const { io, root, scratch } = fixture();
    expect(syncProjectSkills(io, root, "codex").status).toBe("synced");
    const second = versionedBundle(io, join(scratch, "bundle"), {
      handoff: "Second handoff.",
      recovery: "Second recovery.",
    });
    const handoffBefore = sha(readFileSync(join(root, HANDOFF)));
    const recoveryBefore = sha(readFileSync(join(root, RECOVERY)));
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as {
      skills: Record<string, { previous?: string; sha256: string }>;
    };
    manifest.skills.handoff = { previous: handoffBefore, sha256: sha("Second handoff.") };
    manifest.skills.recovery = { previous: recoveryBefore, sha256: sha("Second recovery.") };
    put(join(root, MANIFEST), JSON.stringify(manifest));
    put(join(root, HANDOFF), "Second handoff.");

    expect(syncProjectSkills(second, root, "codex")).toMatchObject({
      skills: [
        { action: "unchanged", skill: "handoff" },
        { action: "unchanged", skill: "lifecycle" },
        { action: "updated", skill: "recovery" },
        { action: "unchanged", skill: "status" },
      ],
      status: "synced",
    });
    const finished = readFileSync(join(root, MANIFEST), "utf8");
    expect(finished).not.toContain("previous");
    expect(readFileSync(join(root, RECOVERY), "utf8")).toBe("Second recovery.");
    const third = versionedBundle(second, join(scratch, "third"), {
      lifecycle: "Third lifecycle.",
    });
    expect(syncProjectSkills(third, root, "codex")).toMatchObject({
      skills: [
        { action: "unchanged", skill: "handoff" },
        { action: "updated", skill: "lifecycle" },
        { action: "unchanged", skill: "recovery" },
        { action: "unchanged", skill: "status" },
      ],
      status: "synced",
    });
    expect(readFileSync(join(root, LIFECYCLE), "utf8")).toBe("Third lifecycle.");
  });

  it("refuses symlink entries and malformed manifests without touching the destinations", async () => {
    const { io, root, scratch } = fixture();
    const original = join(scratch, "outside.md");
    put(original, "Outside.");
    mkdirSync(dirname(join(root, HANDOFF)), { recursive: true });
    symlinkSync(original, join(root, HANDOFF));
    expect(await sync(io, "--adopt", `handoff=${sha("Outside.")}`)).toMatchObject({
      code: EXIT_INVALID,
      json: { conflicts: [{ path: HANDOFF, reason: "not-regular-file" }] },
    });
    expect(readFileSync(original, "utf8")).toBe("Outside.");
    expect(existsSync(join(root, MANIFEST))).toBe(false);
    put(
      join(root, MANIFEST),
      JSON.stringify({ schema: 1, skills: { "../outside": { sha256: sha("Outside.") } } }),
    );
    expect(await sync(io)).toMatchObject({
      code: EXIT_INVALID,
      json: { conflicts: [{ path: MANIFEST, reason: "invalid-manifest" }] },
    });
    const outside = join(scratch, "other-harness");
    mkdirSync(outside);
    symlinkSync(outside, join(root, ".claude"), "dir");
    expect(syncProjectSkills(io, root, "claude")).toMatchObject({
      conflicts: [{ path: ".claude", reason: "not-directory" }],
      status: "conflict",
    });
    expect(existsSync(join(outside, "skills"))).toBe(false);
  });

  it("rejects invalid adoption and returns a conflict while another sync holds the checkout", async () => {
    const { io, root } = fixture();
    const adopt = `status=${sha("example")}`;
    expect(await sync(io, "--adopt", adopt, "--adopt", adopt)).toMatchObject({ code: EXIT_USAGE });
    expect(await sync(io, "--adopt", `agent-cleanup=${sha("example")}`)).toMatchObject({
      code: EXIT_USAGE,
    });
    const lock = holdLock(root, { readOnly: true });
    try {
      expect(syncProjectSkills(io, root, "codex")).toMatchObject({
        conflicts: [{ path: MANIFEST, reason: "sync-in-progress" }],
        status: "conflict",
      });
    } finally {
      lock.release();
    }
    expect(existsSync(join(root, SKILLS))).toBe(false);
  });
});
