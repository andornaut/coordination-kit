// The Codex thread, dependencies and native identity of each Codex-scoped question. Historical
// native links and reasks still rebuild the same native identity and attempt.
import type { ProjectionIndex } from "../projectionIndex.ts";
import {
  type CodexQuestionInput,
  ensure,
  type NativeQuestionIdentity,
  type Projection,
  type StoredEvent,
} from "../types.ts";
import { updateQuestionRow } from "./questions.ts";

function resolution(index: ProjectionIndex, event: StoredEvent): void {
  if (event.payload.nativeResolution !== undefined) {
    updateQuestionRow(index, "question_codex", event.payload.id as string, {
      resolution: JSON.stringify(event.payload.nativeResolution),
    });
  }
}

export const QUESTION_CODEX_PROJECTION: Projection = {
  apply: {
    "question.answer-recorded": resolution,
    "question.cancelled": resolution,
    "question.native-linked": (index, event) => {
      const { id, native, thread } = event.payload;
      const { index: idx, item, turn } = native as unknown as NativeQuestionIdentity;
      const key = [thread as string, turn, item, idx];
      ensure(
        index.get("question_native_links", key) === undefined,
        "duplicate-native-question-link",
      );
      index.put("question_native_links", key, { idx, item, thread: thread as string, turn });
      updateQuestionRow(index, "question_codex", id as string, { native: JSON.stringify(native) });
    },
    "question.native-reasked": (index, event) => {
      const id = event.payload.id as string;
      const previous = index.get("question_codex", [id]);
      if (previous !== undefined) {
        index.put("question_codex", [id], {
          ...previous,
          attempt: Number(previous.attempt) + 1,
          native: "null",
        });
      }
    },
    "question.opened": (index, event) => {
      const { codex, id } = event.payload;
      if (codex !== undefined) {
        const { dependsOn, thread } = codex as unknown as CodexQuestionInput;
        index.put("question_codex", [id as string], {
          attempt: 1,
          dependencies: JSON.stringify(dependsOn),
          id: id as string,
          native: "null",
          resolution: "null",
          thread,
        });
      }
    },
  },
  tables: ["question_codex", "question_native_links"],
};
