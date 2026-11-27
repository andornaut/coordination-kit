// Questions, their decisions and holds, and the recorded answers awaiting work-file writeback.
import { payloadText as text } from "../eventCodec.ts";
import type { Cell, ProjectionIndex, ProjectionRow } from "../projectionIndex.ts";
import { ensure, type JsonObject, type Projection, type StoredEvent } from "../types.ts";

/** Ledger hold states that no longer hold anything; an imported hold in one is history only. */
const CLOSED_HOLD_STATES: readonly string[] = [
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

export function updateQuestionRow(
  index: ProjectionIndex,
  table: string,
  id: Cell,
  changes: ProjectionRow,
): void {
  const previous = index.get(table, [id]);
  if (previous !== undefined) {
    index.put(table, [id], { ...previous, ...changes });
  }
}

const opened = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  const id = text(p, "id");
  ensure(index.get("questions", [id]) === undefined, "duplicate-question");
  index.put("questions", [id], {
    closed_at: null,
    decision: null,
    id,
    opened_at: event.at,
    opened_seq: event.seq,
    options: p.options == null ? null : JSON.stringify(p.options),
    reason: null,
    role: text(p, "role"),
    state: "pending",
    title: text(p, "title"),
    work: text(p, "work"),
  });
};

const answered = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  const decision = `${text(p, "work")}/D${Number(p.n)}`;
  const answeredAt = text(p, "answeredAt") ?? event.at;
  ensure(index.get("decisions", [decision]) === undefined, "duplicate-decision");
  updateQuestionRow(index, "questions", text(p, "id"), {
    closed_at: answeredAt,
    decision,
    state: "answered",
  });
  index.put("decisions", [decision], {
    at: answeredAt,
    by: text(p, "by"),
    id: decision,
    n: Number(p.n),
    question: text(p, "id"),
    role: text(p, "role"),
    seq: event.seq,
    supersedes: text(p, "supersedes"),
    text: text(p, "text"),
    work: text(p, "work"),
  });
};

const cancelled = (index: ProjectionIndex, event: StoredEvent): void => {
  updateQuestionRow(index, "questions", text(event.payload, "id"), {
    closed_at: event.at,
    reason: text(event.payload, "reason"),
    state: "cancelled",
  });
};

const holdSet = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  const id = text(p, "id");
  const scope = text(p, "scope")!;
  const work = scope.startsWith("work:") ? [{ id: scope.slice(5), repository: null }] : [];
  ensure(index.get("holds", [id]) === undefined, "duplicate-hold");
  index.put("holds", [id], {
    id,
    ledger_state: null,
    reason: text(p, "reason"),
    released_at: null,
    role: text(p, "role"),
    scope,
    set_at: event.at,
    set_seq: event.seq,
    source: null,
    state: "active",
    work: JSON.stringify(work),
  });
};

const holdImported = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  const id = text(p, "id") ?? event.key;
  if (index.get("holds", [id]) !== undefined) {
    return;
  }
  const work = (Array.isArray(p.work) ? (p.work as readonly JsonObject[]) : []).flatMap((item) =>
    typeof item.repository === "string" && typeof item.id === "string"
      ? [{ id: item.id, repository: item.repository }]
      : [],
  );
  const state = text(p, "state");
  index.put("holds", [id], {
    id,
    ledger_state: state,
    reason: text(p, "reason") ?? "",
    released_at: null,
    role: text(p, "owner"),
    scope: `work:${work.map((item) => `${item.repository}:${item.id}`).join(",")}`,
    set_at: event.at,
    set_seq: event.seq,
    source: text(p, "source"),
    state: holdOpen(state) ? "active" : "released",
    work: JSON.stringify(work),
  });
};

export const QUESTIONS_PROJECTION: Projection = {
  apply: {
    "hold.imported": holdImported,
    "hold.released": (index, event) => {
      updateQuestionRow(index, "holds", text(event.payload, "id"), {
        released_at: event.at,
        state: "released",
      });
    },
    "hold.set": holdSet,
    "question.answered": answered,
    "question.cancelled": cancelled,
    "question.opened": opened,
  },
  tables: ["questions", "decisions", "holds"],
};

export const QUESTION_ANSWERS_PROJECTION: Projection = {
  apply: {
    "question.answer-recorded": (index, event) => {
      const p = event.payload;
      const id = text(p, "id");
      const answeredAt = text(p, "answeredAt") ?? event.at;
      ensure(index.get("question_answers", [id]) === undefined, "duplicate-question-answer");
      index.put("question_answers", [id], {
        at: answeredAt,
        by: text(p, "by"),
        id,
        reason: null,
        seq: event.seq,
        status: "pending",
        supersedes: text(p, "supersedes"),
        text: text(p, "text"),
        work: text(p, "work"),
      });
      updateQuestionRow(index, "questions", id, { closed_at: answeredAt, state: "answered" });
    },
    "question.projection": (index, event) => {
      const p = event.payload;
      updateQuestionRow(index, "question_answers", text(p, "id"), {
        reason: text(p, "reason"),
        status: text(p, "status"),
      });
    },
  },
  tables: ["question_answers"],
};
