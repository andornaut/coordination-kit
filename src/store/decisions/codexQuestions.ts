import type { SQLInputValue } from "node:sqlite";

import { isCanonicalUuid } from "../../core/ids.ts";
import type { Store } from "../db.ts";
import {
  type Actor,
  type CodexQuestionInput,
  type NativeQuestionIdentity,
  StoreError,
  type WorkRef,
} from "../types.ts";
import { checkRef } from "../work-records/work.ts";

type Reader = Pick<Store, "db">;
type Row = Record<string, SQLInputValue>;

export interface CodexQuestion extends CodexQuestionInput {
  readonly attempt: number;
  readonly native: NativeQuestionIdentity | null;
  readonly resolution: {
    readonly outcome: "answered" | "cancelled";
    readonly reply: { readonly turn: string; readonly item: string } | null;
  } | null;
}

export function normalizeCodexQuestion(
  actor: Actor,
  input: CodexQuestionInput,
): CodexQuestionInput {
  if (!isCanonicalUuid(input.thread) || input.thread !== actor.nativeId) {
    throw new StoreError("question-thread-mismatch");
  }
  const dependsOn = input.dependsOn.map(checkRef);
  const unique = new Set(dependsOn.map(({ id, repository }) => `${repository}:${id}`));
  if (dependsOn.length > 32 || unique.size !== dependsOn.length) {
    throw new StoreError("invalid-question-dependencies");
  }
  return { dependsOn, thread: input.thread };
}

function hasCodexQuestions(store: Reader): boolean {
  return (
    store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'question_codex'")
      .get() !== undefined
  );
}

export function readCodexQuestion(store: Reader, id: string): CodexQuestion | undefined {
  if (!hasCodexQuestions(store)) {
    return undefined;
  }
  const row = store.db.prepare("SELECT * FROM question_codex WHERE id = ?").get(id) as
    Row | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    attempt: Number(row.attempt),
    dependsOn: JSON.parse(row.dependencies as string) as WorkRef[],
    native: JSON.parse(row.native as string) as NativeQuestionIdentity | null,
    resolution: JSON.parse(row.resolution as string) as CodexQuestion["resolution"],
    thread: row.thread as string,
  };
}

/** Work fencing uses only explicitly named repository and work pairs, regardless of work owner. */
export function dependentQuestions(store: Reader, ref: WorkRef): string[] {
  if (!hasCodexQuestions(store)) {
    return [];
  }
  return store.db
    .prepare(
      `SELECT q.id FROM questions q JOIN question_codex c ON c.id = q.id
     WHERE q.state = 'pending' AND EXISTS (
       SELECT 1 FROM json_each(c.dependencies) AS dependency
       WHERE json_extract(dependency.value, '$.id') = ?
         AND json_extract(dependency.value, '$.repository') = ?
     ) ORDER BY q.opened_seq`,
    )
    .all(ref.id, ref.repository)
    .map((row) => row.id as string);
}
