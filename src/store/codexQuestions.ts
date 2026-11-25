import type { SQLInputValue } from "node:sqlite";

import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import type { Store } from "./db.ts";
import {
  type Actor,
  type CodexQuestionInput,
  type NativeQuestionIdentity,
  StoreError,
  type WorkRef,
} from "./types.ts";
import { checkRef } from "./work.ts";

type Reader = Pick<Store, "db">;
type Row = Record<string, SQLInputValue>;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface CodexQuestion extends CodexQuestionInput {
  readonly attempt: number;
  readonly native: NativeQuestionIdentity | null;
  readonly resolution: {
    readonly outcome: "answered" | "cancelled";
    readonly reply: { readonly turn: string; readonly item: string } | null;
  } | null;
}

export type NativeQuestionProof =
  | { readonly status: "unknown"; readonly reason: string }
  | {
      readonly status: "observed" | "pending" | "cancelled" | "closed-without-answer";
      readonly thread: string;
      readonly native: NativeQuestionIdentity;
    }
  | {
      readonly status: "answered";
      readonly thread: string;
      readonly native: NativeQuestionIdentity;
      readonly reply: { readonly turn: string; readonly item: string };
    };

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

export function nativeQuestionIdentity(input: NativeQuestionIdentity): NativeQuestionIdentity {
  const { index, item, turn } = input;
  if (!TOKEN.test(turn) || !TOKEN.test(item) || !Number.isSafeInteger(index) || index < 0) {
    throw new StoreError("invalid-native-question");
  }
  return { index, item, turn };
}

export function sameNativeQuestion(
  a: NativeQuestionIdentity | null,
  b: NativeQuestionIdentity,
): boolean {
  return a?.turn === b.turn && a.item === b.item && a.index === b.index;
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

export function requireNativeProof(
  codex: CodexQuestion,
  native: NativeQuestionIdentity,
  proof: NativeQuestionProof | undefined,
  expected?: "answered" | "cancelled" | "closed-without-answer",
): Exclude<NativeQuestionProof, { readonly status: "unknown" }> {
  if (proof === undefined || proof.status === "unknown") {
    throw new StoreError("native-question-unverified");
  }
  if (
    proof.thread !== codex.thread ||
    !sameNativeQuestion(proof.native, native) ||
    (expected !== undefined && proof.status !== expected)
  ) {
    throw new StoreError("native-question-proof-mismatch");
  }
  if (
    proof.status === "answered" &&
    (!TOKEN.test(proof.reply.turn) ||
      !TOKEN.test(proof.reply.item) ||
      (native.turn === proof.reply.turn && native.item === proof.reply.item))
  ) {
    throw new StoreError("native-question-proof-mismatch");
  }
  return proof;
}

export function nativeQuestionUnused(
  store: Reader,
  thread: string,
  native: NativeQuestionIdentity,
): boolean {
  return (
    store.db
      .prepare(
        "SELECT 1 FROM question_native_links WHERE thread = ? AND turn = ? AND item = ? AND idx = ?",
      )
      .get(thread, native.turn, native.item, native.index) === undefined
  );
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
