// The coordinator's live state for `status`, read once: every protocol role journal through a
// caching read-only store, and the request ledger through one replay. Writes are refused.
import { LedgerStore } from "../accounting/store.ts";
import type { LedgerRequest } from "../accounting/types.ts";
import type { Io } from "../io.ts";
import type { Layout } from "../layout.ts";
import { ProtocolError, ProtocolStore } from "../protocol/core.ts";
import { checkProtocolLayout, resolveProtocolLayout } from "../protocol/layout.ts";
import { ledgerStorageOptions, protocolFailure } from "../protocol/runtime.ts";
import type { ProtocolState } from "../protocol/types.ts";
import { type WorkEvaluation, type WorkPublication, WorkStore } from "../protocol/work.ts";

export interface SourceCounters {
  /** Role journal replays, by role; each role is replayed at most once per run. */
  readonly roleReads: Map<string, number>;
  ledgerReads: number;
}

export function sourceCounters(): SourceCounters {
  return { ledgerReads: 0, roleReads: new Map() };
}

/**
 * A ProtocolStore view that replays each role journal and reads each artifact at most once, and
 * refuses every write. Callers check the protocol layout before and after the whole read.
 */
class SnapshotProtocolStore extends ProtocolStore {
  readonly #roles = new Map<string, ProtocolState>();
  readonly #artifacts = new Map<string, Uint8Array>();
  readonly #counters: SourceCounters;

  constructor(directory: string, counters: SourceCounters) {
    super({ directory });
    this.#counters = counters;
  }

  override read(role: string): ProtocolState {
    let state = this.#roles.get(role);
    if (state === undefined) {
      this.#counters.roleReads.set(role, (this.#counters.roleReads.get(role) ?? 0) + 1);
      state = super.read(role);
      this.#roles.set(role, state);
    }
    return state;
  }

  override readArtifact(digest: string): Uint8Array {
    let bytes = this.#artifacts.get(digest);
    if (bytes === undefined) {
      bytes = super.readArtifact(digest);
      this.#artifacts.set(digest, bytes);
    }
    return bytes;
  }

  override claim(): Promise<never> {
    return Promise.reject(new ProtocolError("read-only"));
  }

  override transact(): Promise<never> {
    return Promise.reject(new ProtocolError("read-only"));
  }

  override withWriter(): Promise<never> {
    return Promise.reject(new ProtocolError("read-only"));
  }

  override putArtifact(): Promise<never> {
    return Promise.reject(new ProtocolError("read-only"));
  }
}

export interface PublicationRecord {
  readonly role: string;
  readonly id: string;
  readonly revision: number;
  readonly publication: WorkPublication;
  /** Null when the publication cannot be evaluated. */
  readonly evaluation: WorkEvaluation | null;
  /** Worker namespaces with submissions for this work, and whether the parent accepted one. */
  readonly workers: readonly {
    readonly role: string;
    readonly submissions: number;
    readonly accepted: boolean;
  }[];
}

export type SourceState =
  | { readonly status: "available" }
  | { readonly status: "unconfigured" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface ProtocolSnapshot {
  readonly state:
    | SourceState
    | {
        readonly status: "partial";
        readonly unavailable: readonly { readonly role: string; readonly reason: string }[];
      };
  /** Work publications by parent namespace. */
  readonly publications: ReadonlyMap<string, readonly PublicationRecord[]>;
}

export interface LedgerSnapshot {
  readonly state: SourceState;
  readonly requests: ReadonlyMap<string, LedgerRequest>;
}

function reason(error: unknown): string {
  return (
    protocolFailure(error) ??
    (error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "read-failed")
  );
}

/** The request ledger from one replay; unavailable is reported, never read as an empty ledger. */
export function readLedger(
  io: Pick<Io, "env">,
  layout: Layout,
  counters: SourceCounters,
): LedgerSnapshot {
  try {
    const { directory } = ledgerStorageOptions(layout, io);
    const projection = new LedgerStore({
      directory,
      onReplay: () => {
        counters.ledgerReads += 1;
      },
    }).read();
    return {
      requests: new Map(projection.requests.map((request) => [request.id, request])),
      state: { status: "available" },
    };
  } catch (error) {
    return { requests: new Map(), state: { reason: reason(error), status: "unavailable" } };
  }
}

/** Every role's work publications and worker submissions, each journal replayed once. */
export function readProtocol(
  layout: Layout,
  ledger: LedgerSnapshot,
  counters: SourceCounters,
): ProtocolSnapshot {
  const publications = new Map<string, PublicationRecord[]>();
  let expected;
  try {
    expected = resolveProtocolLayout(layout);
  } catch (error) {
    return { publications, state: { reason: reason(error), status: "unavailable" } };
  }
  if (expected === null) {
    return { publications, state: { status: "unconfigured" } };
  }
  const unavailable: { role: string; reason: string }[] = [];
  try {
    const store = new SnapshotProtocolStore(expected.stateRoot, counters);
    const work = new WorkStore({
      protocol: store,
      readRequest: (id) => ledger.requests.get(id),
    });
    const roles = store.listRoles({ includeWorkers: true });
    const submissions = new Map<string, { role: string; count: number }[]>();
    for (const role of roles.filter((name) => name.includes("/workers/"))) {
      try {
        const counts = new Map<string, number>();
        for (const object of store.read(role).objects) {
          if (object.collection !== "submissions") {
            continue;
          }
          const value = object.value as { workId?: unknown; parentRole?: unknown };
          if (typeof value.workId === "string" && typeof value.parentRole === "string") {
            const key = `${value.parentRole}\n${value.workId}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
        for (const [key, count] of counts) {
          submissions.set(key, [...(submissions.get(key) ?? []), { count, role }]);
        }
      } catch (error) {
        unavailable.push({ reason: reason(error), role });
      }
    }
    for (const role of roles.filter((name) => !name.includes("/workers/"))) {
      try {
        const records: PublicationRecord[] = [];
        for (const object of store.read(role).objects) {
          if (object.collection !== "work") {
            continue;
          }
          const publication = work.read(role, object.id);
          if (publication === undefined) {
            continue;
          }
          let evaluation: WorkEvaluation | null;
          try {
            evaluation = work.evaluate(role, object.id);
          } catch {
            evaluation = null;
          }
          records.push({
            evaluation,
            id: object.id,
            publication,
            revision: object.revision,
            role,
            workers: (submissions.get(`${role}\n${object.id}`) ?? []).map((entry) => ({
              accepted: publication.accepted.some(
                (accepted) => accepted.submission.role === entry.role,
              ),
              role: entry.role,
              submissions: entry.count,
            })),
          });
        }
        publications.set(role, records);
      } catch (error) {
        unavailable.push({ reason: reason(error), role });
      }
    }
    checkProtocolLayout(layout, expected);
  } catch (error) {
    return { publications: new Map(), state: { reason: reason(error), status: "unavailable" } };
  }
  return {
    publications,
    state: unavailable.length === 0 ? { status: "available" } : { status: "partial", unavailable },
  };
}
