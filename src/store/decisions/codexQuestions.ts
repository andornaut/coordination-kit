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

type Reader = Pick<Store, "index">;

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

export function readCodexQuestion(store: Reader, id: string): CodexQuestion | undefined {
  const row = store.index.get("question_codex", [id]);
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
  return store.index
    .rows("questions")
    .filter((row) => {
      const codex =
        row.state === "pending" ? readCodexQuestion(store, row.id as string) : undefined;
      return codex?.dependsOn.some(
        ({ id, repository }) => id === ref.id && repository === ref.repository,
      );
    })
    .sort((a, b) => Number(a.opened_seq) - Number(b.opened_seq))
    .map((row) => row.id as string);
}
