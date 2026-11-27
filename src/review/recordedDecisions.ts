import type { Store } from "../store/db.ts";
import type { CodexQuestion } from "../store/decisions/codexQuestions.ts";
import { listQuestions, type QuestionOption } from "../store/decisions/questions.ts";

export interface RecordedDecisions {
  readonly pending: readonly {
    readonly id: string;
    readonly role: string;
    readonly work: string | null;
    readonly codex?: CodexQuestion;
    readonly title?: string;
    readonly options?: readonly QuestionOption[] | null;
  }[];
  readonly recorded: readonly {
    readonly role: string;
    readonly count: number;
    readonly latest: {
      readonly id: string;
      readonly question: string;
      readonly work: string;
    };
  }[];
}

/** Store references only. A local record carries no assertion about the recipient's visible UI. */
export function recordedDecisions(store: Store): RecordedDecisions {
  const pending = listQuestions(store, { states: ["pending"] })
    .map(({ codex, id, options, role, title, work }) => ({
      ...(codex === undefined ? {} : { codex, options, title }),
      id,
      role,
      work,
    }))
    .sort((left, right) => left.role.localeCompare(right.role));
  const byRole = new Map<
    string,
    { count: number; seq: number; latest: RecordedDecisions["recorded"][number]["latest"] }
  >();
  for (const row of store.index.rows("decisions")) {
    const role = row.role as string;
    const seq = Number(row.seq);
    const previous = byRole.get(role);
    const latest =
      previous !== undefined && previous.seq > seq
        ? previous.latest
        : { id: row.id as string, question: row.question as string, work: row.work as string };
    byRole.set(role, {
      count: (previous?.count ?? 0) + 1,
      latest,
      seq: Math.max(previous?.seq ?? 0, seq),
    });
  }
  return {
    pending,
    recorded: [...byRole.keys()].sort().map((role) => {
      const { count, latest } = byRole.get(role)!;
      return { count, latest, role };
    }),
  };
}
