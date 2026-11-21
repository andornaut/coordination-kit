import type { Store } from "../store/db.ts";

export interface RecordedDecisions {
  readonly pending: readonly {
    readonly id: string;
    readonly role: string;
    readonly work: string | null;
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
  const pending = store.db
    .prepare(
      "SELECT id, role, work FROM questions WHERE state = 'pending' ORDER BY role, opened_seq",
    )
    .all() as unknown as RecordedDecisions["pending"];
  const rows = store.db
    .prepare(
      `SELECT d.role, grouped.count, d.id, d.question, d.work
       FROM (SELECT role, count(*) AS count, max(seq) AS latest FROM decisions GROUP BY role) grouped
       JOIN decisions d ON d.seq = grouped.latest ORDER BY d.role`,
    )
    .all() as { role: string; count: number; id: string; question: string; work: string }[];
  return {
    pending,
    recorded: rows.map(({ count, id, question, role, work }) => ({
      count,
      latest: { id, question, work },
      role,
    })),
  };
}
