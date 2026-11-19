// The coordinator's live state for `status`: the store's work records and imported requests,
// read once through a read-only connection.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { Layout } from "../layout.ts";
import { storePath } from "../store/db.ts";
import { readRequests, type RequestRecord } from "../store/requests.ts";
import { readWorkRecords, type WorkRecord } from "../store/work.ts";

export type StoreSourceState =
  | { readonly status: "available" }
  | { readonly status: "absent" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface StoreWorkSnapshot {
  readonly state: StoreSourceState;
  /** Work records keyed `repository\nid`. */
  readonly records: ReadonlyMap<string, WorkRecord>;
  /** Requests imported from the retired request ledger, by ID. */
  readonly requests: ReadonlyMap<string, RequestRecord>;
}

/**
 * The store's work records and imported requests, read through a read-only connection: nothing is created or migrated.
 * No store file is `absent`; a store without the work tables has no records.
 */
export function readStoreWork(layout: Layout): StoreWorkSnapshot {
  let path: string;
  try {
    path = storePath(layout);
  } catch (error) {
    return {
      records: new Map(),
      requests: new Map(),
      state: {
        reason: error instanceof Error ? error.message : "store-path-unavailable",
        status: "unavailable",
      },
    };
  }
  if (!existsSync(path)) {
    return { records: new Map(), requests: new Map(), state: { status: "absent" } };
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
    const present = db
      .prepare(
        `SELECT count(*) AS n FROM sqlite_master
         WHERE type = 'table' AND name IN ('work', 'work_evidence', 'work_retained')`,
      )
      .get() as { n: number };
    return {
      records: Number(present.n) === 3 ? readWorkRecords(db) : new Map(),
      requests: new Map(readRequests(db).map((request) => [request.id, request])),
      state: { status: "available" },
    };
  } catch {
    return {
      records: new Map(),
      requests: new Map(),
      state: { reason: "store-unreadable", status: "unavailable" },
    };
  } finally {
    db?.close();
  }
}
