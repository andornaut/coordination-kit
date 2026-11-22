// Read the coordinator's status projections in one consistent, read-only snapshot.
import type { DatabaseSync } from "node:sqlite";

import type { Layout } from "../layout.ts";
import { StateRootError } from "../stateRoot.ts";
import { Store } from "../store/db.ts";
import { unreadMessages } from "../store/messageWake.ts";
import { type HoldView, listHolds, listQuestions, type QuestionView } from "../store/questions.ts";
import { readRequests, type RequestRecord } from "../store/requests.ts";
import type { UnreadMessage } from "../store/types.ts";
import { readWorkRecords, type WorkRecord } from "../store/work.ts";
import { type DeployPoint, storedDeployPoint } from "./delivery.ts";

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
  readonly questions: readonly QuestionView[];
  readonly holds: readonly HoldView[];
  readonly unread: readonly UnreadMessage[];
  readonly deployments: ReadonlyMap<string, readonly DeployPoint[]>;
}

function empty(state: StoreSourceState): StoreWorkSnapshot {
  return {
    deployments: new Map(),
    holds: [],
    questions: [],
    records: new Map(),
    requests: new Map(),
    state,
    unread: [],
  };
}

/** Successful runner deployments and historical COMPLETE events, grouped by game. */
function readDeployments(db: DatabaseSync): ReadonlyMap<string, readonly DeployPoint[]> {
  const rows = db
    .prepare(
      `SELECT game, at, sha, type, work FROM bus_events
     WHERE sha IS NOT NULL AND status = 'ok'
       AND ((kind = 'deploy' AND type = 'deploy_success') OR (kind = 'runner' AND type = 'complete'))
     ORDER BY seq`,
    )
    .all() as unknown as (Parameters<typeof storedDeployPoint>[0] & { game: string })[];
  const byGame = new Map<string, DeployPoint[]>();
  for (const row of rows) {
    const points = byGame.get(row.game) ?? [];
    points.push(storedDeployPoint(row));
    byGame.set(row.game, points);
  }
  return byGame;
}

/**
 * The store's work records and imported requests, read through a read-only connection: nothing is created or migrated.
 * No store file is `absent`; a store without the work tables has no records.
 */
export function readStoreWork(layout: Layout): StoreWorkSnapshot {
  let store: Store | null = null;
  try {
    store = Store.readLayout(layout);
    if (store === null) {
      return empty({ status: "absent" });
    }
    const { db } = store;
    db.exec("BEGIN");
    const present = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
      name: string;
    }[];
    const tables = new Set(present.map(({ name }) => name));
    const snapshot: StoreWorkSnapshot = {
      deployments: tables.has("bus_events") ? readDeployments(db) : new Map(),
      holds: tables.has("holds") ? listHolds({ db }, { states: ["active"] }) : [],
      questions: tables.has("questions") ? listQuestions({ db }) : [],
      records: ["work", "work_evidence", "work_retained"].every((name) => tables.has(name))
        ? readWorkRecords(db)
        : new Map(),
      requests: new Map(readRequests(db).map((request) => [request.id, request])),
      state: { status: "available" },
      unread: tables.has("messages") ? unreadMessages({ db }, null) : [],
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    return empty({
      reason: error instanceof StateRootError ? error.message : "store-unreadable",
      status: "unavailable",
    });
  } finally {
    store?.close();
  }
}
