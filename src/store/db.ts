// The coordination journal is authoritative. Projections are disposable in-memory indexes.
import { join } from "node:path";

import type { Clock } from "../core/clock.ts";
import type { Layout } from "../core/configuration/layout.ts";
import { stateRoot } from "../core/configuration/stateRoot.ts";
import { systemGit } from "../core/git.ts";
import { canonicalJson, eventHash, sha256 } from "./eventCodec.ts";
import type { FileProjection } from "./fileProjection.ts";
import { fileAuthority } from "./files/authority.ts";
import {
  type CompactionCheckpoint,
  verifyCompactionCheckpoint,
} from "./files/compaction/checkpoint.ts";
import { openFileJournal } from "./files/journal.ts";
import { fileLayoutProjection } from "./files/runtime.ts";
import { ProjectionIndex } from "./projectionIndex.ts";
import { PROJECTIONS } from "./projections.ts";
import {
  type Actor,
  type EventInput,
  GENESIS,
  type Json,
  type JsonObject,
  type StoredEvent,
  StoreError,
} from "./types.ts";

export const MEMORY = ":memory:";

/** Wake files and exported evidence still use the configured state root. */
export function storeRoot(layout: Layout): string {
  return stateRoot(layout);
}

export function storePath(layout: Layout): string {
  return join(layout.varDir, "coordination");
}

/** A legacy path is checked for pending authority only. Its bytes are never opened. */
export function legacyStorePath(layout: Layout): string {
  return join(storeRoot(layout), "coordination.db");
}

export interface AppendResult {
  readonly event: StoredEvent;
  readonly duplicate: boolean;
}

export interface VerifyResult {
  readonly events: number;
  readonly head: { readonly seq: number; readonly hash: string };
}

export interface StoreContext {
  readonly clock: Clock;
  readonly env: NodeJS.ProcessEnv;
}

export const READ_ONLY_CLOCK: Clock = () => {
  throw new StoreError("store-read-only");
};

interface EventsOptions {
  readonly afterSeq?: number;
  readonly kinds?: readonly string[];
}

function freezeJson(value: Json): void {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) {
      freezeJson(member);
    }
    Object.freeze(value);
  }
}

/** One view of a file journal, or a disposable replay used to inspect a detached snapshot. */
export class Store {
  readonly path: string;
  readonly #clock: Clock;
  readonly #files: FileProjection | undefined;
  readonly #events: StoredEvent[] = [];
  readonly #keys = new Map<string, StoredEvent>();
  readonly #kinds = new Map<string, StoredEvent[]>();
  readonly #checkpointHead: CompactionCheckpoint["head"] | undefined;
  readonly #reducedDigests = new Map<number, string>();
  #index = new ProjectionIndex();
  #writing = false;
  #closed = false;

  private constructor(
    clock: Clock,
    path: string,
    files?: FileProjection,
    checkpoint?: CompactionCheckpoint,
  ) {
    this.path = path;
    this.#clock = clock;
    this.#files = files;
    this.#checkpointHead = checkpoint?.head;
    for (const { event, reducedDigest } of checkpoint?.entries ?? []) {
      if (reducedDigest !== undefined) {
        this.#reducedDigests.set(event.seq, reducedDigest);
      }
    }
  }

  /** Open a bare journal, or create a disposable in-memory store. */
  static open(clock: Clock, path: string): Store {
    return path === MEMORY
      ? new Store(clock, path)
      : Store.openFileProjection(clock, path, {
          journal: openFileJournal(path),
          records: () => [],
        });
  }

  /** Independently validate and replay detached events, without writing a local journal. */
  static fromEvents(clock: Clock, events: readonly StoredEvent[]): Store {
    const store = Store.open(clock, MEMORY);
    store.#replay(events);
    return store;
  }

  static forLayout(
    context: StoreContext,
    layout: Layout,
    options: { readonly createMissing?: boolean } = {},
  ): Store {
    const selected = fileAuthority(systemGit(context.env), layout, legacyStorePath(layout), {
      create: options.createMissing !== false,
    });
    return selected === null
      ? Store.open(context.clock, MEMORY)
      : Store.#openSelectedFiles(context.clock, layout, selected);
  }

  static readLayout(context: Pick<StoreContext, "env">, layout: Layout): Store | null {
    const selected = fileAuthority(systemGit(context.env), layout, legacyStorePath(layout));
    return selected === null ? null : Store.#openSelectedFiles(READ_ONLY_CLOCK, layout, selected);
  }

  static #openSelectedFiles(
    clock: Clock,
    layout: Layout,
    { path, receipt }: NonNullable<ReturnType<typeof fileAuthority>>,
  ): Store {
    const store = Store.openFileProjection(clock, path, fileLayoutProjection(layout, path));
    const { hash, seq } = receipt.head;
    if (seq !== 0 && store.eventAt(seq)?.hash !== hash) {
      throw new StoreError("migration-file-origin-mismatch");
    }
    return store;
  }

  static openFileProjection(clock: Clock, path: string, files: FileProjection): Store {
    const proof = files.checkpoint;
    const checkpoint = proof && verifyCompactionCheckpoint(proof.value, proof.receipt);
    const store = new Store(clock, path, files, checkpoint);
    if (checkpoint !== undefined) {
      store.#replay(
        checkpoint.entries.map(({ event }) => event),
        true,
      );
      store.#verifyCheckpointHead();
    }
    store.#replay(files.journal.events(checkpoint?.head.seq));
    return store;
  }

  get index(): ProjectionIndex {
    this.#ensureOpen();
    return this.#index;
  }

  get fileBacked(): boolean {
    return this.#files !== undefined;
  }

  compactedEventSequences(): ReadonlySet<number> {
    return new Set(this.#reducedDigests.keys());
  }

  close(): void {
    this.#closed = true;
  }

  #ensureOpen(): void {
    if (this.#closed) {
      throw new StoreError("store-closed");
    }
  }

  now(): string {
    return this.#clock().toISOString();
  }

  /** Recheck a long-lived view before acting on work that may have changed during native I/O. */
  refresh(): void {
    this.#ensureOpen();
    if (!this.#writing && this.#files !== undefined) {
      this.#files.assertCurrent?.();
      this.#replay(this.#files.journal.events(this.head().seq));
      this.#files.assertCurrent?.();
    }
  }

  /** Nested operations join the outer transaction and its journal writer lock. */
  transaction<T>(body: () => T): T {
    this.#ensureOpen();
    if (this.#clock === READ_ONLY_CLOCK) {
      throw new StoreError("store-read-only");
    }
    if (this.#writing) {
      return body();
    }
    const files = this.#files;
    if (files === undefined) {
      return this.#transaction(body);
    }
    return files.journal.withWriter((writer) => {
      this.#replay(writer.events(this.head().seq));
      const before = this.head().seq;
      return this.#transaction(() => {
        const result = body();
        if (result instanceof Promise) {
          throw new StoreError("async-store-transaction");
        }
        const events = this.events({ afterSeq: before });
        if (events.length > 0) {
          writer.commit(events, files.records(this.#index, before, events, this));
        }
        return result;
      });
    });
  }

  #transaction<T>(body: () => T): T {
    const index = this.#index;
    const length = this.#events.length;
    this.#writing = true;
    try {
      return index.transaction(body);
    } catch (error) {
      while (this.#events.length > length) {
        const event = this.#events.pop()!;
        this.#keys.delete(event.key);
        this.#kinds.get(event.kind)!.pop();
      }
      this.#index = index;
      throw error;
    } finally {
      this.#writing = false;
    }
  }

  #verifyCheckpointHead(): void {
    const head = this.#checkpointHead;
    if (head !== undefined && head.seq > 0 && this.eventAt(head.seq)?.hash !== head.hash) {
      throw new StoreError("checkpoint-proof-mismatch");
    }
  }

  #authentic(event: StoredEvent, allowReduced: boolean): boolean {
    const reducedDigest = allowReduced ? this.#reducedDigests.get(event.seq) : undefined;
    return reducedDigest === undefined
      ? eventHash(event) === event.hash
      : sha256(canonicalJson(event)) === reducedDigest;
  }

  #replay(events: readonly StoredEvent[], allowReduced = false): void {
    if (events.length === 0) {
      return;
    }
    this.#transaction(() => {
      let { hash: prevHash, seq } = this.head();
      for (const event of events) {
        if (
          event.seq !== seq + 1 ||
          event.prevHash !== prevHash ||
          !this.#authentic(event, allowReduced)
        ) {
          throw new StoreError("chain-broken", `at seq ${event.seq}`);
        }
        this.#insert(event);
        seq = event.seq;
        prevHash = event.hash;
      }
    });
  }

  head(): { readonly seq: number; readonly hash: string } {
    this.#ensureOpen();
    const last = this.#events.at(-1);
    return last === undefined ? { hash: GENESIS, seq: 0 } : { hash: last.hash, seq: last.seq };
  }

  eventByKey(key: string): StoredEvent | undefined {
    this.#ensureOpen();
    return this.#keys.get(key);
  }

  event(key: string): StoredEvent | undefined {
    return this.eventByKey(key);
  }

  eventAt(seq: number): StoredEvent | undefined {
    this.#ensureOpen();
    return this.#events[seq - 1];
  }

  append(input: EventInput): AppendResult {
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(input.kind) || input.key === "") {
      throw new StoreError("invalid-event");
    }
    return this.transaction(() => {
      const existing = this.eventByKey(input.key);
      if (existing !== undefined) {
        return { duplicate: true, event: existing };
      }
      const head = this.head();
      const payload = JSON.parse(canonicalJson(input.payload)) as JsonObject;
      const actor: Actor = {
        nativeId: input.actor.nativeId,
        role: input.actor.role,
        ...(input.actor.worker === undefined ? {} : { worker: input.actor.worker }),
      };
      const draft = {
        actor,
        at: input.at ?? this.now(),
        key: input.key,
        kind: input.kind,
        payload,
        prevHash: head.hash,
        seq: head.seq + 1,
      };
      const event: StoredEvent = { ...draft, hash: eventHash(draft) };
      this.#insert(event);
      return { duplicate: false, event };
    });
  }

  #insert(event: StoredEvent): void {
    if (this.#keys.has(event.key)) {
      throw new StoreError("duplicate-event-key", `at seq ${event.seq}`);
    }
    freezeJson(event.payload);
    Object.freeze(event.actor);
    Object.freeze(event);
    this.#events.push(event);
    this.#keys.set(event.key, event);
    const kind = this.#kinds.get(event.kind);
    if (kind === undefined) {
      this.#kinds.set(event.kind, [event]);
    } else {
      kind.push(event);
    }
    this.#project(this.#index, event);
  }

  #project(index: ProjectionIndex, event: StoredEvent): void {
    let projected = event;
    if (this.#reducedDigests.has(event.seq)) {
      if (event.kind === "session.started") {
        return;
      }
      if (event.kind === "msg.sent" || event.kind === "msg.imported") {
        projected = { ...event, payload: { ...event.payload, body: "" } };
      }
    }
    for (const projection of PROJECTIONS) {
      projection.apply[projected.kind]?.(index, projected);
    }
  }

  /** Events in sequence order after the cursor, optionally of the given kinds. */
  events({ afterSeq = 0, kinds = [] }: EventsOptions = {}): StoredEvent[] {
    this.#ensureOpen();
    if (kinds.length === 0) {
      return this.#events.slice(Math.max(0, Math.floor(afterSeq)));
    }
    return [...new Set(kinds)]
      .flatMap((kind) => this.#kinds.get(kind)?.filter(({ seq }) => seq > afterSeq) ?? [])
      .sort((a, b) => a.seq - b.seq);
  }

  verify(): VerifyResult {
    this.#verifyCheckpointHead();
    let prev = GENESIS;
    let seq = 0;
    for (const event of this.events()) {
      if (event.seq !== seq + 1 || event.prevHash !== prev || !this.#authentic(event, true)) {
        throw new StoreError("chain-broken", `at seq ${event.seq}`);
      }
      prev = event.hash;
      seq = event.seq;
    }
    return { events: seq, head: { hash: prev, seq } };
  }

  rebuild(): VerifyResult {
    return this.transaction(() => {
      const verified = this.verify();
      const index = new ProjectionIndex();
      for (const event of this.#events) {
        this.#project(index, event);
      }
      this.#index = index;
      return verified;
    });
  }
}
