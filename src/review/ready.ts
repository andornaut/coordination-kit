import type { Store } from "../store/db.ts";
import type { WorkRef } from "../store/types.ts";

export interface ReadyHandoff extends WorkRef {
  readonly owner: string | null;
  readonly parent: (WorkRef & { readonly owner: string | null }) | null;
  readonly readyAt: string;
}

/** Use the current work projection and its exact parent link, even if the parent is unrecorded. */
export function readReadyHandoffs(store: Store): ReadyHandoff[] {
  const rows = store.index
    .rows("work")
    .filter((row) => row.state === "ready" && row.ready_at != null)
    .sort((a, b) => {
      for (const key of ["ready_at", "repository", "id"]) {
        if (a[key] !== b[key]) {
          return (a[key] as string) < (b[key] as string) ? -1 : 1;
        }
      }
      return 0;
    });
  return rows.map((row) => ({
    id: row.id as string,
    owner: (row.owner as string | null) ?? null,
    parent:
      typeof row.parent_id !== "string" || typeof row.parent_repository !== "string"
        ? null
        : {
            id: row.parent_id,
            owner:
              (store.index.get("work", [row.parent_repository, row.parent_id])?.owner as
                string | null) ?? null,
            repository: row.parent_repository,
          },
    readyAt: row.ready_at as string,
    repository: row.repository as string,
  }));
}
