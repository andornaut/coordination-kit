// Questions, their decisions and holds, and the recorded answers awaiting work-file writeback.
import type { DatabaseSync } from "node:sqlite";

import { payloadText as text } from "../eventCodec.ts";
import type { JsonObject, Projection, StoredEvent } from "../types.ts";

/** Ledger hold states that no longer hold anything; an imported hold in one is history only. */
export const CLOSED_HOLD_STATES: readonly string[] = [
  "answered",
  "cancelled",
  "cleared",
  "closed",
  "released",
  "superseded",
];

/** An imported hold is open unless its recorded state is a closed one. */
export function holdOpen(state: string | null): boolean {
  return state === null || !CLOSED_HOLD_STATES.includes(state);
}

const QUESTIONS_DDL = `
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  work TEXT,
  options TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'cancelled')),
  opened_at TEXT NOT NULL,
  opened_seq INTEGER NOT NULL,
  closed_at TEXT,
  decision TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS questions_role ON questions (role, state, opened_seq);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  work TEXT NOT NULL,
  n INTEGER NOT NULL,
  question TEXT NOT NULL,
  by TEXT NOT NULL,
  at TEXT NOT NULL,
  role TEXT NOT NULL,
  supersedes TEXT,
  text TEXT NOT NULL,
  seq INTEGER NOT NULL,
  UNIQUE (work, n)
);
CREATE INDEX IF NOT EXISTS decisions_role ON decisions (role, seq);
CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  role TEXT,
  scope TEXT NOT NULL,
  work TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  ledger_state TEXT,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'released')),
  set_at TEXT NOT NULL,
  set_seq INTEGER NOT NULL,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS holds_role ON holds (role, state, set_seq);
`;

const opened = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `INSERT INTO questions (id, role, title, work, options, state, opened_at, opened_seq)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    text(p, "id"),
    text(p, "role"),
    text(p, "title"),
    text(p, "work"),
    p.options === null || p.options === undefined ? null : JSON.stringify(p.options),
    event.at,
    event.seq,
  );
};

const answered = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  const decision = `${text(p, "work")}/D${Number(p.n)}`;
  const answeredAt = text(p, "answeredAt") ?? event.at;
  db.prepare(
    `UPDATE questions SET state = 'answered', closed_at = ?, decision = ? WHERE id = ?`,
  ).run(answeredAt, decision, text(p, "id"));
  db.prepare(
    `INSERT INTO decisions (id, work, n, question, by, at, role, supersedes, text, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    decision,
    text(p, "work"),
    Number(p.n),
    text(p, "id"),
    text(p, "by"),
    answeredAt,
    text(p, "role"),
    text(p, "supersedes"),
    text(p, "text"),
    event.seq,
  );
};

const cancelled = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `UPDATE questions SET state = 'cancelled', closed_at = ?, reason = ? WHERE id = ?`,
  ).run(event.at, text(p, "reason"), text(p, "id"));
};

const holdSet = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  const scope = text(p, "scope")!;
  const work = scope.startsWith("work:") ? [{ id: scope.slice(5), repository: null }] : [];
  db.prepare(
    `INSERT INTO holds (id, role, scope, work, reason, state, set_at, set_seq)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    text(p, "id"),
    text(p, "role"),
    scope,
    JSON.stringify(work),
    text(p, "reason"),
    event.at,
    event.seq,
  );
};

/**
 * An approval-ledger hold (`store import --approval-ledger`): its recorded owner, or none, and the
 * work items it names. An open ledger state is `active`; a closed one is history, `released` with
 * no release time. Import never releases a hold; only its owner's `hold release` does.
 */
const holdImported = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  const work = (Array.isArray(p.work) ? (p.work as readonly JsonObject[]) : []).flatMap((item) =>
    typeof item.repository === "string" && typeof item.id === "string"
      ? [{ id: item.id, repository: item.repository }]
      : [],
  );
  const state = text(p, "state");
  db.prepare(
    `INSERT OR IGNORE INTO holds (id, role, scope, work, source, ledger_state, reason, state, set_at,
       set_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    text(p, "id") ?? event.key,
    text(p, "owner"),
    `work:${work.map((item) => `${item.repository}:${item.id}`).join(",")}`,
    JSON.stringify(work),
    text(p, "source"),
    state,
    text(p, "reason") ?? "",
    holdOpen(state) ? "active" : "released",
    event.at,
    event.seq,
  );
};

const holdReleased = (db: DatabaseSync, event: StoredEvent): void => {
  db.prepare(`UPDATE holds SET state = 'released', released_at = ? WHERE id = ?`).run(
    event.at,
    text(event.payload, "id"),
  );
};

/** Questions, their decisions and holds. */
export const QUESTIONS_PROJECTION: Projection = {
  apply: {
    "hold.imported": holdImported,
    "hold.released": holdReleased,
    "hold.set": holdSet,
    "question.answered": answered,
    "question.cancelled": cancelled,
    "question.opened": opened,
  },
  ddl: QUESTIONS_DDL,
  tables: ["questions", "decisions", "holds"],
};

/** Independent projection so existing schema-1 stores acquire it without rewriting their events. */
export const QUESTION_ANSWERS_PROJECTION: Projection = {
  apply: {
    "question.answer-recorded": (db, event) => {
      const p = event.payload;
      const answeredAt = text(p, "answeredAt") ?? event.at;
      db.prepare(
        `INSERT INTO question_answers (id, work, text, by, supersedes, at, seq, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        text(p, "id"),
        text(p, "work"),
        text(p, "text"),
        text(p, "by"),
        text(p, "supersedes"),
        answeredAt,
        event.seq,
      );
      db.prepare("UPDATE questions SET state = 'answered', closed_at = ? WHERE id = ?").run(
        answeredAt,
        text(p, "id"),
      );
    },
    "question.projection": (db, event) => {
      const p = event.payload;
      db.prepare("UPDATE question_answers SET status = ?, reason = ? WHERE id = ?").run(
        text(p, "status"),
        text(p, "reason"),
        text(p, "id"),
      );
    },
  },
  ddl: `CREATE TABLE IF NOT EXISTS question_answers (
    id TEXT PRIMARY KEY,
    work TEXT NOT NULL,
    text TEXT NOT NULL,
    by TEXT NOT NULL,
    supersedes TEXT,
    at TEXT NOT NULL,
    seq INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'applied')),
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS question_answers_work ON question_answers (work, seq);`,
  tables: ["question_answers"],
};
