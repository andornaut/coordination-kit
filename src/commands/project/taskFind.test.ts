import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { loadLayout } from "../../core/configuration/layout.ts";
import { TEST_CONTEXT, writeFixtureJson } from "../../core/testFixtures.ts";
import { Store, storePath } from "../../store/db.ts";
import { openQuestion, setHold } from "../../store/decisions/questions.ts";
import { approveProjectTask, proposeProjectTask } from "../../store/projects/tasks.ts";
import { taskFind } from "./tasks.ts";

const MAINTAINER = {
  nativeId: "00000000-0000-4000-8000-000000000001",
  role: "maintainer",
};
const BUILDER = {
  nativeId: "00000000-0000-4000-8000-000000000002",
  role: "builder",
};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ck-task-find-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  writeFixtureJson(join(root, "coordination-kit.json"), {
    project: { id: "product", roles: [MAINTAINER.role, BUILDER.role] },
    review: "off",
    schema: 1,
  });
  const layout = loadLayout(root);
  const ask = async (...args: string[]) => {
    let out = "";
    let err = "";
    const code = await taskFind(
      { cwd: root, env: {}, err: (text) => (err += text), out: (text) => (out += text) },
      root,
      args,
    );
    return { code, err, result: out === "" ? null : JSON.parse(out) };
  };
  return { ask, layout };
}

it("distinguishes a fresh project from an invalid owner without creating state", async () => {
  const { ask, layout } = fixture();
  expect(await ask("new work")).toEqual({
    code: 0,
    err: "",
    result: { match: null, matches: [], schema: 1, status: "no-match" },
  });
  expect(await ask("new work", "--owner", "unknown")).toEqual({
    code: 1,
    err: "coordination-kit: project-owner-unconfigured\n",
    result: null,
  });
  expect(existsSync(layout.varDir)).toBe(false);
});

it("reports candidate context and narrows an ambiguous title by owner", async () => {
  const { ask, layout } = fixture();
  const store = Store.forLayout(TEST_CONTEXT, layout);
  try {
    proposeProjectTask(store, MAINTAINER, {
      id: "task-0001",
      owner: MAINTAINER.role,
      scope: "Check imports.",
      title: "Fix inputs",
    });
    proposeProjectTask(store, MAINTAINER, {
      dependsOn: ["task-0001"],
      id: "task-0002",
      owner: BUILDER.role,
      scope: "Check exports.",
      title: "Fix inputs",
    });
    approveProjectTask(store, MAINTAINER, "task-0002", {
      kind: "user-decision",
      ref: "fixture:approved",
    });
    setHold(store, BUILDER, { id: "builder-held", reason: "Waiting for input", scope: "role" });
    openQuestion(store, MAINTAINER, {
      id: "other-question",
      title: "Choose an import rule",
      work: "task-0001",
    });
    openQuestion(store, MAINTAINER, {
      id: "pending-question",
      title: "Choose an export rule",
      work: "task-0002",
    });
  } finally {
    store.close();
  }
  const before = readFileSync(storePath(layout));
  expect(await ask("fix inputs")).toMatchObject({
    code: 0,
    result: {
      match: "title",
      matches: [{ id: "task-0001" }, { id: "task-0002" }],
      status: "ambiguous",
    },
  });
  expect(await ask("fix inputs", "--owner", BUILDER.role)).toMatchObject({
    code: 0,
    result: {
      match: "title",
      matches: [
        {
          approval: { ref: "fixture:approved" },
          candidate: null,
          dependsOn: ["task-0001"],
          holds: [{ id: "builder-held" }],
          id: "task-0002",
          landingEvidence: null,
          mergedSha: null,
          owner: BUILDER.role,
          questions: [{ id: "pending-question" }],
          reviewApproval: null,
          state: "approved",
        },
      ],
      status: "match",
    },
  });
  expect(await ask("task-0002")).toMatchObject({ result: { match: "id", status: "match" } });
  expect(readFileSync(storePath(layout))).toEqual(before);
});

it("reports an unavailable store instead of an empty task list", async () => {
  const { ask, layout } = fixture();
  mkdirSync(layout.varDir);
  const path = storePath(layout);
  writeFileSync(path, "invalid database");
  expect(await ask("fix inputs")).toEqual({
    code: 1,
    err: "",
    result: { match: null, matches: [], schema: 1, status: "unavailable" },
  });
  expect(readFileSync(path, "utf8")).toBe("invalid database");
});
