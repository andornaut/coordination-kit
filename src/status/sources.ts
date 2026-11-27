// Read the coordinator's status projections in one consistent, read-only snapshot.
import type { Layout } from "../core/configuration/layout.ts";
import { StateRootError } from "../core/configuration/stateRoot.ts";
import { Store } from "../store/db.ts";
import type { HoldView } from "../store/decisions/policyHolds.ts";
import { listHolds, listQuestions, type QuestionView } from "../store/decisions/questions.ts";
import { unreadMessages } from "../store/messages/wakeEvidence.ts";
import type { ProjectionIndex } from "../store/projectionIndex.ts";
import type { UnreadMessage } from "../store/types.ts";
import { readRequests, type RequestRecord } from "../store/work-records/requests.ts";
import { readWorkRecords, type WorkRecord } from "../store/work-records/work.ts";
import { type DeployPoint, storedDeployPoint } from "./delivery.ts";

type StoreSourceState =
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
function readDeployments(index: ProjectionIndex): ReadonlyMap<string, readonly DeployPoint[]> {
  const rows = [...index.rows("bus_events")].sort(
    (left, right) => Number(left.seq) - Number(right.seq),
  );
  const byGame = new Map<string, DeployPoint[]>();
  for (const { at, game, kind, sha, status, type, work } of rows) {
    if (
      status !== "ok" ||
      !(
        (kind === "deploy" && type === "deploy_success") ||
        (kind === "runner" && type === "complete")
      ) ||
      typeof sha !== "string"
    ) {
      continue;
    }
    const gameId = game as string;
    const points = byGame.get(gameId) ?? [];
    points.push(storedDeployPoint({ at: at as string, sha, type, work: work as string | null }));
    byGame.set(gameId, points);
  }
  return byGame;
}

/**
 * Read work records and imported requests from one snapshot without creating or migrating state.
 */
export function readStoreWork(env: NodeJS.ProcessEnv, layout: Layout): StoreWorkSnapshot {
  let store: Store | null = null;
  try {
    store = Store.readLayout({ env }, layout);
    if (store === null) {
      return empty({ status: "absent" });
    }
    const { index } = store;
    return {
      deployments: readDeployments(index),
      holds: listHolds(store, { states: ["active"] }),
      questions: listQuestions(store),
      records: readWorkRecords(store),
      requests: new Map(readRequests(index).map((request) => [request.id, request])),
      state: { status: "available" },
      unread: unreadMessages(store, null),
    };
  } catch (error) {
    return empty({
      reason: error instanceof StateRootError ? error.message : "store-unreadable",
      status: "unavailable",
    });
  } finally {
    store?.close();
  }
}
