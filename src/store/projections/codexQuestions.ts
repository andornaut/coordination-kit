// The Codex thread, dependencies and native identity of each Codex-scoped question. No command
// appends `question.native-linked` or `question.native-reasked`; replay still applies both, so a
// store or journal that contains them rebuilds the same native identity and attempt.
import type { CodexQuestionInput, NativeQuestionIdentity, Projection } from "../types.ts";

export const QUESTION_CODEX_PROJECTION: Projection = {
  apply: {
    "question.answer-recorded": (db, event) => {
      if (event.payload.nativeResolution !== undefined) {
        db.prepare("UPDATE question_codex SET resolution = ? WHERE id = ?").run(
          JSON.stringify(event.payload.nativeResolution),
          event.payload.id as string,
        );
      }
    },
    "question.cancelled": (db, event) => {
      if (event.payload.nativeResolution !== undefined) {
        db.prepare("UPDATE question_codex SET resolution = ? WHERE id = ?").run(
          JSON.stringify(event.payload.nativeResolution),
          event.payload.id as string,
        );
      }
    },
    "question.native-linked": (db, event) => {
      const { id, native, thread } = event.payload;
      const { index, item, turn } = native as unknown as NativeQuestionIdentity;
      db.prepare(
        "INSERT INTO question_native_links (thread, turn, item, idx) VALUES (?, ?, ?, ?)",
      ).run(thread as string, turn, item, index);
      db.prepare("UPDATE question_codex SET native = ? WHERE id = ?").run(
        JSON.stringify(native),
        id as string,
      );
    },
    "question.native-reasked": (db, event) => {
      db.prepare(
        "UPDATE question_codex SET attempt = attempt + 1, native = 'null' WHERE id = ?",
      ).run(event.payload.id as string);
    },
    "question.opened": (db, event) => {
      const { codex, id } = event.payload;
      if (codex !== undefined) {
        const { dependsOn, thread } = codex as unknown as CodexQuestionInput;
        db.prepare("INSERT INTO question_codex (id, dependencies, thread) VALUES (?, ?, ?)").run(
          id as string,
          JSON.stringify(dependsOn),
          thread,
        );
      }
    },
  },
  ddl: `CREATE TABLE IF NOT EXISTS question_codex (
    id TEXT PRIMARY KEY,
    thread TEXT NOT NULL,
    dependencies TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    native TEXT NOT NULL DEFAULT 'null',
    resolution TEXT NOT NULL DEFAULT 'null'
  );
  CREATE TABLE IF NOT EXISTS question_native_links (
    thread TEXT NOT NULL,
    turn TEXT NOT NULL,
    item TEXT NOT NULL,
    idx INTEGER NOT NULL,
    PRIMARY KEY (thread, turn, item, idx)
  );`,
  tables: ["question_codex", "question_native_links"],
};
