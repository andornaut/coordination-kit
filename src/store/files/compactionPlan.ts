import { isRecord } from "../../adapters/shared/pyjson.ts";
import { canonicalJson } from "../eventCodec.ts";
import { COLLECTION_RELEASE } from "../noticesInFlight.ts";
import { GENESIS, type Json, type StoredEvent, StoreError } from "../types.ts";

const WINDOW = 100;

interface Head {
  readonly seq: number;
  readonly hash: string;
}

export interface CompactionScope {
  readonly registeredRoles: ReadonlySet<string>;
  readonly registeredGames: ReadonlySet<string>;
  readonly registryRevision: number;
  /** In-process qualification only. Each exact candidate has independently checked evidence. */
  readonly verifiedEvidence?: {
    readonly head: Head;
    readonly registryRevision: number;
    /** Exact owner-approved replacements, with current references and delivery state reconciled. */
    readonly messageIds: ReadonlySet<string>;
    /** Exact events covered by the verified state, cursors, keys and evidence checkpoint. */
    readonly routineEventSequences: ReadonlySet<number>;
  };
}

interface Tally {
  count: number;
  bodyBytes: number;
  payloadBytes: number;
  journalBytes: number;
  metadataBytes: number;
}

type StreamKind = "messages" | "routine" | "other";

type Reason =
  | "already-compacted"
  | "within-window"
  | "open-message"
  | "retained-message"
  | "ownership-unverified"
  | "close-sequence-unavailable"
  | "delivery-unresolved"
  | "open-message-reference"
  | "operational-body-reference"
  | "replacement-unverified"
  | "checkpoint-unverified"
  | "routine-source-unverified"
  | "protected-event-kind";

interface Stream {
  readonly kind: StreamKind;
  readonly source: string;
  readonly total: Tally;
  readonly outsideWindow: Tally;
  readonly eligible: Tally;
  readonly protected: readonly ({ readonly reason: Reason } & Tally)[];
}

export interface CompactionPlan {
  readonly schema: 1;
  readonly kind: "file-compaction-plan";
  readonly head: Head;
  readonly registryRevision: number;
  readonly window: number;
  readonly streams: readonly Stream[];
  /** The plan measures canonical UTF-8 objects, not reclaimable physical space. */
  readonly diskSavingsBytes: null;
}

interface Message {
  readonly original: StoredEvent;
  close?: StoredEvent;
  retained: boolean;
  invalidClose: boolean;
}

function zero(): Tally {
  return { bodyBytes: 0, count: 0, journalBytes: 0, metadataBytes: 0, payloadBytes: 0 };
}

function add(tally: Tally, bytes: Tally): void {
  tally.count += bytes.count;
  tally.bodyBytes += bytes.bodyBytes;
  tally.payloadBytes += bytes.payloadBytes;
  tally.journalBytes += bytes.journalBytes;
  tally.metadataBytes += bytes.metadataBytes;
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function terminal(state: Json | undefined): boolean {
  return state === "handled" || state === "superseded";
}

function routineSource(scope: CompactionScope, event: StoredEvent): string | null {
  const { actor, kind, payload } = event;
  if (
    kind === "session.started" &&
    typeof actor.role === "string" &&
    scope.registeredRoles.has(actor.role) &&
    actor.role === payload.role &&
    typeof actor.nativeId === "string" &&
    actor.nativeId === payload.nativeId
  ) {
    return `session:${actor.role}`;
  }
  const game = text(payload.game);
  return kind === "bus.event" &&
    game !== null &&
    scope.registeredGames.has(game) &&
    actor.role === "delivery-kit" &&
    payload.type === "scheduled-status" &&
    payload.kind === "runner" &&
    payload.status === null &&
    payload.sha === null &&
    payload.work === null
    ? `runner:${game}`
    : null;
}

interface DeliveryAttempt {
  readonly event: StoredEvent;
  outcome?: Json;
  consumed?: boolean;
}

function unresolvedDelivery(events: readonly StoredEvent[]): ReadonlySet<string> {
  const wakes = new Map<string, DeliveryAttempt>();
  const reminders = new Map<string, DeliveryAttempt>();
  const coalesced: StoredEvent[] = [];
  for (const event of events) {
    const { kind, payload } = event;
    const wake = text(payload.wake);
    if (wake !== null) {
      if (kind === "wake.claimed") {
        wakes.set(wake, { event });
      } else if (kind === "wake.coalesced") {
        coalesced.push(event);
      } else if (kind === "wake.completed") {
        const claim = wakes.get(wake);
        if (claim && claim.event.payload.role === payload.role && payload.outcome !== undefined) {
          claim.outcome = payload.outcome;
        }
      }
    }
    const id = text(payload.id);
    if (id !== null) {
      if (kind === "reminder.claimed") {
        reminders.set(id, { event });
      } else if (kind === "reminder.settled") {
        const claim = reminders.get(id);
        if (claim && payload.outcome !== undefined) {
          claim.outcome = payload.outcome;
        }
      } else if (kind === "notice.consumed" || kind === "notice.released") {
        const claim = wakes.get(id) ?? reminders.get(id);
        if (
          claim !== undefined &&
          typeof payload.conversation === "string" &&
          claim.event.payload.role === payload.role &&
          (claim.event.payload.conversation ?? claim.event.payload.nativeId) ===
            payload.conversation &&
          (kind === "notice.consumed" ||
            (claim.event.kind === "wake.claimed" &&
              claim.outcome === "accepted" &&
              payload.claimSeq === claim.event.seq &&
              payload.reason === COLLECTION_RELEASE))
        ) {
          claim.consumed = true;
        }
      }
    }
  }
  const referenced = new Set<string>();
  const addIds = (values: Json | undefined, idsOfRecords = false) => {
    if (Array.isArray(values)) {
      for (const value of values) {
        const id: unknown = idsOfRecords && isRecord(value) ? value.id : value;
        if (typeof id === "string") {
          referenced.add(id);
        }
      }
    }
  };
  const wakeUnresolved = (claim: DeliveryAttempt | undefined) =>
    claim === undefined ||
    (!claim.consumed &&
      claim.outcome !== "guarded" &&
      claim.outcome !== "failed" &&
      !(claim.outcome === "accepted" && claim.event.payload.harness === "claude"));
  for (const claim of wakes.values()) {
    if (wakeUnresolved(claim)) {
      addIds(claim.event.payload.messages);
    }
  }
  for (const { payload } of coalesced) {
    if (wakeUnresolved(wakes.get(text(payload.wake)!))) {
      addIds(payload.messages);
    }
  }
  for (const { consumed, event, outcome } of reminders.values()) {
    if (!consumed && outcome !== "refused") {
      addIds(event.payload.originals, true);
    }
  }
  return referenced;
}

function openReferences(
  messages: ReadonlyMap<string, Message>,
  unresolved: ReadonlySet<string>,
): ReadonlySet<string> {
  const pending = [...messages]
    .filter(
      ([id, { close, invalidClose, original }]) =>
        close === undefined ||
        invalidClose ||
        unresolved.has(id) ||
        original.payload.unconfirmed === true,
    )
    .map(([id]) => id);
  const referenced = new Set<string>();
  while (pending.length > 0) {
    const links = messages.get(pending.pop()!)?.original.payload.links;
    if (!Array.isArray(links)) {
      continue;
    }
    for (const link of links) {
      if (
        isRecord(link) &&
        link.kind === "message" &&
        typeof link.ref === "string" &&
        !referenced.has(link.ref)
      ) {
        referenced.add(link.ref);
        pending.push(link.ref);
      }
    }
  }
  return referenced;
}

type MutableStream = Omit<Stream, "protected"> & { readonly reasons: Map<Reason, Tally> };

/** Plan against one verified filesystem replay in commit order, with no writes or lookups. */
export function planFileCompaction(
  events: readonly StoredEvent[],
  scope: CompactionScope,
  alreadyReduced: ReadonlySet<number> = new Set(),
): CompactionPlan {
  let head: Head = { hash: GENESIS, seq: 0 };
  const messages = new Map<string, Message>();
  const reviewOriginals = new Set<string>();
  for (const event of events) {
    if (event.seq !== head.seq + 1 || event.prevHash !== head.hash) {
      throw new StoreError("compaction-snapshot-order");
    }
    head = { hash: event.hash, seq: event.seq };
    const { actor, kind, payload } = event;
    const id = text(payload.id);
    const reviewOriginal = kind === "review.brief" ? text(payload.messageId) : null;
    if (reviewOriginal !== null) {
      reviewOriginals.add(reviewOriginal);
    }
    if ((kind === "msg.sent" || kind === "msg.imported") && id !== null) {
      if (messages.has(id)) {
        throw new StoreError("compaction-duplicate-original");
      }
      messages.set(id, {
        invalidClose: false,
        original: event,
        retained: payload.state === "retained",
      });
      continue;
    }
    const found = id === null ? undefined : messages.get(id);
    if (found === undefined) {
      continue;
    }
    if (kind === "msg.retained") {
      found.retained = true;
      if (found.close !== undefined) {
        found.invalidClose = true;
      }
    } else if (kind === "msg.closed") {
      if (actor.role !== found.original.payload.to || !terminal(payload.state) || found.close) {
        found.invalidClose = true;
      } else {
        found.close = event;
      }
    }
  }

  const proof = scope.verifiedEvidence;
  const verification =
    proof?.head.seq === head.seq &&
    proof.head.hash === head.hash &&
    proof.registryRevision === scope.registryRevision
      ? proof
      : undefined;
  const unresolved = unresolvedDelivery(events);
  const referenced = openReferences(messages, unresolved);
  const streams = new Map<string, MutableStream>();
  const ranks = new Map<string, number>();

  function outside(kind: StreamKind, source: string): boolean {
    const key = `${kind}/${source}`;
    const rank = (ranks.get(key) ?? 0) + 1;
    ranks.set(key, rank);
    return rank > WINDOW;
  }

  function report(
    kind: StreamKind,
    source: string,
    event: StoredEvent,
    aged: boolean,
    reason: Reason | null,
  ): void {
    const key = `${kind}/${source}`;
    const stream = streams.get(key) ?? {
      eligible: zero(),
      kind,
      outsideWindow: zero(),
      reasons: new Map<Reason, Tally>(),
      source,
      total: zero(),
    };
    streams.set(key, stream);
    const journalBytes = Buffer.byteLength(canonicalJson(event));
    const payloadBytes = Buffer.byteLength(canonicalJson(event.payload));
    const bytes = {
      bodyBytes:
        kind === "messages" && typeof event.payload.body === "string"
          ? Buffer.byteLength(event.payload.body)
          : 0,
      count: 1,
      journalBytes,
      metadataBytes: journalBytes - payloadBytes,
      payloadBytes,
    };
    add(stream.total, bytes);
    if (aged) {
      add(stream.outsideWindow, bytes);
    }
    if (reason === null) {
      add(stream.eligible, bytes);
    } else {
      const tally = stream.reasons.get(reason) ?? zero();
      add(tally, bytes);
      stream.reasons.set(reason, tally);
    }
  }

  for (const [id, message] of [...messages].sort(
    ([, a], [, b]) => (b.close?.seq ?? 0) - (a.close?.seq ?? 0),
  )) {
    const { close, invalidClose, original, retained } = message;
    const sender = text(original.payload.from);
    const recipient = text(original.payload.to);
    const source =
      recipient !== null && scope.registeredRoles.has(recipient) ? recipient : "unknown";
    const ownershipKnown =
      recipient !== null &&
      scope.registeredRoles.has(recipient) &&
      sender !== null &&
      scope.registeredRoles.has(sender) &&
      (original.kind === "msg.imported" || sender === original.actor.role);
    const aged =
      close !== undefined && !invalidClose && ownershipKnown && outside("messages", source);
    let reason: Reason | null = null;
    if (alreadyReduced.has(original.seq)) {
      reason = "already-compacted";
    } else if (!ownershipKnown) {
      reason = "ownership-unverified";
    } else if (invalidClose || (close === undefined && terminal(original.payload.state))) {
      reason = "close-sequence-unavailable";
    } else if (original.payload.unconfirmed === true || unresolved.has(id)) {
      reason = "delivery-unresolved";
    } else if (close === undefined) {
      reason = retained ? "retained-message" : "open-message";
    } else if (referenced.has(id)) {
      reason = "open-message-reference";
    } else if (
      reviewOriginals.has(id) ||
      (original.kind === "msg.imported" &&
        original.payload.legacy != null &&
        /\bcomplete\b/i.test(text(original.payload.body) ?? ""))
    ) {
      reason = "operational-body-reference";
    } else if (!aged) {
      reason = "within-window";
    } else if (verification?.messageIds.has(id) !== true) {
      reason = "replacement-unverified";
    }
    report("messages", source, original, aged, reason);
  }

  for (const event of [...events].reverse()) {
    const id = text(event.payload.id);
    if (event.kind === "msg.sent" || event.kind === "msg.imported") {
      if (id === null) {
        report("messages", "unknown", event, false, "ownership-unverified");
      }
      continue;
    }
    const source = routineSource(scope, event);
    if (source === null) {
      const knownStream =
        event.kind === "session.started" ||
        (event.kind === "bus.event" && event.payload.type === "scheduled-status");
      report(
        "other",
        event.kind,
        event,
        false,
        alreadyReduced.has(event.seq)
          ? "already-compacted"
          : knownStream
            ? "routine-source-unverified"
            : "protected-event-kind",
      );
      continue;
    }
    const aged = outside("routine", source);
    const reason = alreadyReduced.has(event.seq)
      ? "already-compacted"
      : !aged
        ? "within-window"
        : verification?.routineEventSequences.has(event.seq) === true
          ? null
          : "checkpoint-unverified";
    report("routine", source, event, aged, reason);
  }

  return {
    diskSavingsBytes: null,
    head,
    kind: "file-compaction-plan",
    registryRevision: scope.registryRevision,
    schema: 1,
    streams: [...streams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, stream]) => {
        const { reasons, ...rest } = stream;
        return {
          ...rest,
          protected: [...reasons]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([reason, tally]) => ({ reason, ...tally })),
        };
      }),
    window: WINDOW,
  };
}
