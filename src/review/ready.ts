import type { Store } from "../store/db.ts";
import type { WorkRef } from "../store/types.ts";

export interface ReadyHandoff extends WorkRef {
  readonly owner: string | null;
  readonly parent: (WorkRef & { readonly owner: string | null }) | null;
  readonly readyAt: string;
}

/** Use the current work projection and its exact parent link, even if the parent is unrecorded. */
export function readReadyHandoffs(store: Store): ReadyHandoff[] {
  const rows = store.db
    .prepare(
      `SELECT w.repository, w.id, w.owner, w.ready_at, w.parent_repository, w.parent_id,
              p.owner AS parent_owner
       FROM work w LEFT JOIN work p ON p.repository = w.parent_repository AND p.id = w.parent_id
       WHERE w.state = 'ready' AND w.ready_at IS NOT NULL
       ORDER BY w.ready_at, w.repository, w.id`,
    )
    .all() as {
    id: string;
    owner: string | null;
    parent_id: string | null;
    parent_owner: string | null;
    parent_repository: string | null;
    ready_at: string;
    repository: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    owner: row.owner,
    parent:
      row.parent_id === null || row.parent_repository === null
        ? null
        : { id: row.parent_id, owner: row.parent_owner, repository: row.parent_repository },
    readyAt: row.ready_at,
    repository: row.repository,
  }));
}
