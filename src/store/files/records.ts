// Immutable role-owned views of the verified event stream. The journal remains complete when
// ownership is unavailable. A projection never assigns a worker from an attribution label.
import { isCanonicalUuid } from "../../core/ids.ts";
import { payloadText as text } from "../eventCodec.ts";
import { handoffHoldId } from "../projections/handoffs.ts";
import { WORK_KINDS } from "../projections/work.ts";
import { type Json, type JsonObject, type StoredEvent, StoreError } from "../types.ts";

interface FileRecord {
  readonly path: string;
  readonly data: Json;
}

interface MessageOwnership {
  readonly sender: string | null;
  readonly recipient: string | null;
}

interface VerifiedWorkerBinding {
  readonly parentRole: string;
  readonly parentNativeId: string;
  readonly workerNativeId: string;
  readonly registryRevision?: number;
  readonly evidenceSha256?: string;
}

export interface FileRecordContext {
  readonly registeredRoles: ReadonlySet<string>;
  /** Lookups supply ownership from preceding committed events when projecting a batch. */
  readonly messageOwner?: (id: string) => MessageOwnership | null;
  readonly questionOwner?: (id: string) => string | null;
  readonly holdOwner?: (id: string) => string | null;
  readonly requestOwner?: (id: string) => string | null;
  readonly workOwner?: (repository: string, id: string) => string | null;
  /** Return a binding only for independently verified participation in this exact event. */
  readonly verifiedWorker?: (
    event: StoredEvent,
    parentRole: string,
  ) => VerifiedWorkerBinding | null;
}

const COORDINATOR = "game-coordinator";
const DELIVERY_KIT = "delivery-kit";
const ROLE = /^[a-z0-9][a-z0-9-]{0,63}(?:\/[a-z0-9][a-z0-9-]{0,63})?$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const WORK_EVENTS: ReadonlySet<string> = new Set(WORK_KINDS);
const QUESTION_EVENTS = new Set([
  "question.opened",
  "question.native-linked",
  "question.native-reasked",
  "question.answer-recorded",
  "question.answered",
  "question.cancelled",
  "question.projection",
]);
const WAKE_EVENTS = new Set([
  "notice.consumed",
  "notice.released",
  "wake.claimed",
  "wake.coalesced",
  "wake.completed",
  "wake.guarded",
  "wake.rearmed",
]);

/** Encode record IDs losslessly and keep every filename below the filesystem name limit. */
function recordId(id: string | null): string | null {
  if (id === null || !RECORD_ID.test(id)) {
    return null;
  }
  const encoded = encodeURIComponent(id);
  if (encoded.length <= 235) {
    return encoded;
  }
  // The marker cannot be produced by a valid ID. Distinct leaf and directory prefixes keep
  // chunks invertible without creating a possible file/directory collision.
  const chunks = encoded.match(/(?:%[0-9A-F]{2}|[^%]){1,75}/g)!;
  const segments = chunks.map(
    (chunk, index) => `${index + 1 === chunks.length ? "z" : "x"}${chunk}`,
  );
  return ["%7E", ...segments].join("/");
}

function registered(context: FileRecordContext | undefined, input: string | null): string | null {
  return input !== null && ROLE.test(input) && context?.registeredRoles.has(input) === true
    ? input
    : null;
}

function actorOwner(
  context: FileRecordContext | undefined,
  event: StoredEvent,
  owner: string | null,
): string | null {
  return event.actor.role === owner ? registered(context, owner) : null;
}

function roleRecord(
  context: FileRecordContext | undefined,
  event: StoredEvent,
  owner: string,
  suffix: string,
  payload: JsonObject = event.payload,
  workerScoped = false,
): FileRecord {
  const base = `roles/${encodeURIComponent(owner)}`;
  const worker =
    event.actor.role === owner && event.actor.nativeId !== null
      ? context?.verifiedWorker?.(event, owner)
      : undefined;
  if (
    worker != null &&
    worker.parentRole === owner &&
    worker.workerNativeId === event.actor.nativeId &&
    isCanonicalUuid(worker.parentNativeId) &&
    isCanonicalUuid(worker.workerNativeId) &&
    worker.workerNativeId !== worker.parentNativeId
  ) {
    return {
      data: {
        ...eventData(event, payload),
        verifiedWorker: { ...worker },
      },
      path: workerScoped
        ? `${base}/workers/${worker.workerNativeId}/${suffix}`
        : `${base}/${suffix}`,
    };
  }
  return { data: eventData(event, payload), path: `${base}/${suffix}` };
}

function eventData(event: StoredEvent, payload: JsonObject = event.payload): JsonObject {
  return {
    actor: {
      nativeId: event.actor.nativeId,
      role: event.actor.role,
      ...(event.actor.worker === undefined ? {} : { worker: event.actor.worker }),
    },
    at: event.at,
    hash: event.hash,
    key: event.key,
    kind: event.kind,
    payload,
    prevHash: event.prevHash,
    seq: event.seq,
  };
}

function quarantine(event: StoredEvent, reason: string, part?: JsonObject): FileRecord {
  return {
    data: {
      ...eventData(event, part),
      quarantine: reason,
    },
    path: `legacy/quarantine/${event.seq}.json`,
  };
}

interface Owners {
  readonly messages: Map<string, MessageOwnership>;
  readonly questions: Map<string, string | null>;
  readonly holds: Map<string, string | null>;
  readonly requests: Map<string, string | null>;
  readonly work: Map<string, string | null>;
}

function lookup<T>(
  seen: ReadonlyMap<string, T | null>,
  key: string,
  previous: () => T | null | undefined,
): T | null {
  return (seen.has(key) ? seen.get(key) : previous()) ?? null;
}

function disposition(
  context: FileRecordContext | undefined,
  event: StoredEvent,
  recipient: string,
  pathId: string,
  payload: JsonObject,
): FileRecord {
  return roleRecord(
    context,
    event,
    recipient,
    `messages/dispositions/${pathId}/${event.seq}.json`,
    payload,
  );
}

function originalMessage(
  context: FileRecordContext | undefined,
  owners: Owners,
  event: StoredEvent,
  id: string,
  pathId: string,
): FileRecord[] {
  const { payload } = event;
  const imported = event.kind === "msg.imported";
  const from = text(payload, "from");
  const to = text(payload, "to");
  const sender = imported ? registered(context, from) : actorOwner(context, event, from);
  const recipient = registered(context, to);
  if (owners.messages.has(id)) {
    throw new StoreError("filesystem-record-conflict");
  }
  if (!imported && sender === null) {
    owners.messages.set(id, { recipient: null, sender: null });
    return [quarantine(event, "message-sender-unverified")];
  }
  owners.messages.set(id, { recipient, sender });
  const original =
    sender === null
      ? quarantine(event, "message-sender-unverified")
      : roleRecord(context, event, sender, `messages/originals/${pathId}.json`);
  if (recipient === null) {
    return sender === null
      ? [original]
      : [original, quarantine(event, "message-recipient-unverified", { id, to })];
  }
  const record: Record<string, Json> = imported ? { ...payload } : { from, id, state: "sent", to };
  delete record.body;
  return [original, disposition(context, event, recipient, pathId, record)];
}

function inboxRead(
  context: FileRecordContext | undefined,
  owners: Owners,
  event: StoredEvent,
): FileRecord[] {
  const role = actorOwner(context, event, text(event.payload, "role"));
  const { delivered } = event.payload;
  if (role === null || !Array.isArray(delivered)) {
    return [quarantine(event, "inbox-recipient-unverified")];
  }
  const records: FileRecord[] = [];
  const confirmed = new Set<string>();
  const unresolved: Json[] = [];
  for (const id of delivered as readonly Json[]) {
    if (typeof id === "string") {
      const pathId = recordId(id);
      if (
        pathId !== null &&
        lookup(owners.messages, id, () => context?.messageOwner?.(id))?.recipient === role
      ) {
        if (!confirmed.has(id)) {
          confirmed.add(id);
          records.push(disposition(context, event, role, pathId, { id, state: "delivered" }));
        }
        continue;
      }
    }
    unresolved.push(id);
  }
  records.push(
    roleRecord(context, event, role, `inbox/reads/${event.seq}.json`, {
      delivered: [...confirmed],
      role,
    }),
  );
  if (unresolved.length > 0) {
    records.push(quarantine(event, "inbox-original-unverified", { delivered: unresolved, role }));
  }
  return records;
}

function regularHoldOwner(
  context: FileRecordContext | undefined,
  owners: Owners,
  event: StoredEvent,
  id: string,
): string | null {
  if (event.kind === "hold.set") {
    const owner = actorOwner(context, event, text(event.payload, "role"));
    owners.holds.set(id, owner);
    return owner;
  }
  if (event.kind === "hold.imported") {
    const owner = registered(context, text(event.payload, "owner"));
    owners.holds.set(id, owner);
    return owner;
  }
  return registered(
    context,
    lookup(owners.holds, id, () => context?.holdOwner?.(id)),
  );
}

function workRecord(
  context: FileRecordContext | undefined,
  owners: Owners,
  event: StoredEvent,
  id: string,
  pathId: string,
): FileRecord {
  const repository = text(event.payload, "repository");
  const pathRepository = recordId(repository);
  if (repository === null || pathRepository === null) {
    return quarantine(event, "work-repository-unverified");
  }
  const key = JSON.stringify([repository, id]);
  const known = lookup(owners.work, key, () => context?.workOwner?.(repository, id));
  const declared = text(event.payload, "owner");
  let owner: string | null;
  switch (event.kind) {
    case "work.started":
    case "work.finished":
      owner = actorOwner(context, event, declared);
      if (owner !== null) {
        owners.work.set(key, owner);
      }
      break;
    case "work.retained":
      owner = registered(context, known ?? declared);
      break;
    default:
      owner =
        event.payload.source === "approval-ledger"
          ? registered(context, known)
          : actorOwner(context, event, known ?? event.actor.role);
      break;
  }
  return owner === null
    ? quarantine(event, "work-owner-unverified")
    : roleRecord(
        context,
        event,
        owner,
        `work/${pathRepository}/${pathId}/${event.seq}.json`,
        event.payload,
        true,
      );
}

function questionRecords(
  context: FileRecordContext | undefined,
  owners: Owners,
  event: StoredEvent,
  id: string,
  pathId: string,
): FileRecord[] {
  const declared = text(event.payload, "role");
  const expected =
    event.kind === "question.opened"
      ? declared
      : lookup(owners.questions, id, () => context?.questionOwner?.(id));
  const owner = actorOwner(context, event, expected);
  if (event.kind === "question.opened") {
    owners.questions.set(id, owner);
  }
  if (owner === null || (declared !== null && declared !== owner)) {
    return [quarantine(event, "question-owner-unverified")];
  }
  const records = [roleRecord(context, event, owner, `questions/${pathId}/${event.seq}.json`)];
  if (event.kind === "question.answered") {
    const work = recordId(text(event.payload, "work"));
    const { n } = event.payload;
    if (work === null || typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) {
      records.push(quarantine(event, "decision-reference-unverified"));
    } else {
      records.push(roleRecord(context, event, owner, `decisions/${work}/D${n}/${event.seq}.json`));
    }
  }
  return records;
}

function coordinatorRecord(event: StoredEvent, directory: string): FileRecord {
  return { data: eventData(event), path: `coordinator/${directory}/${event.seq}.json` };
}

function eventRecords(
  context: FileRecordContext | undefined,
  owners: Owners,
  event: StoredEvent,
): FileRecord[] {
  const { kind, payload } = event;
  const id = text(payload, "id");
  const pathId = recordId(id);
  const sequence = `${event.seq}.json`;
  if (kind === "inbox.read") {
    return inboxRead(context, owners, event);
  }
  if (kind === "session.started" || WAKE_EVENTS.has(kind)) {
    const role = text(payload, "role");
    const owner =
      kind === "session.started" ? actorOwner(context, event, role) : registered(context, role);
    return owner === null
      ? [quarantine(event, "session-or-wake-role-unverified")]
      : [
          roleRecord(
            context,
            event,
            owner,
            `${kind === "session.started" ? "sessions" : "inbox/wakes"}/${sequence}`,
          ),
        ];
  }
  if (kind === "review.brief" || kind === "bus.complete" || kind === "bus.event") {
    return event.actor.role === DELIVERY_KIT
      ? [coordinatorRecord(event, kind === "review.brief" ? "reviews" : "delivery")]
      : [quarantine(event, "delivery-actor-unverified")];
  }
  if (kind === "store.retired") {
    return event.actor.role === COORDINATOR
      ? [coordinatorRecord(event, "cutover")]
      : [quarantine(event, "coordinator-actor-unverified")];
  }
  if (id === null || pathId === null) {
    return [quarantine(event, "record-id-unverified")];
  }
  switch (kind) {
    case "msg.sent":
    case "msg.imported":
      return originalMessage(context, owners, event, id, pathId);
    case "msg.closed":
    case "msg.retained": {
      const expected = lookup(owners.messages, id, () => context?.messageOwner?.(id));
      const recipient = actorOwner(context, event, expected?.recipient ?? null);
      return recipient === null
        ? [quarantine(event, "message-original-or-recipient-unverified")]
        : [disposition(context, event, recipient, pathId, payload)];
    }
    case "hold.set":
    case "hold.imported":
    case "hold.released": {
      const owner = regularHoldOwner(context, owners, event, id);
      const handoff = text(payload, "handoff");
      const pathHandoff = recordId(handoff);
      if (
        kind === "hold.released" &&
        event.actor.role === COORDINATOR &&
        owner !== null &&
        handoff !== null &&
        pathHandoff !== null &&
        handoffHoldId(handoff, owner) === id
      ) {
        return [coordinatorRecord(event, `handoffs/${pathHandoff}/hold-releases`)];
      }
      return owner === null || (kind === "hold.released" && event.actor.role !== owner)
        ? [quarantine(event, "hold-owner-unverified")]
        : [roleRecord(context, event, owner, `holds/${pathId}/${sequence}`)];
    }
    case "hold.policy-set":
    case "hold.policy-released":
      return event.actor.role === COORDINATOR && payload.issuer === COORDINATOR
        ? [coordinatorRecord(event, `holds/${pathId}`)]
        : [quarantine(event, "policy-issuer-unverified")];
    case "reminder.claimed":
    case "reminder.settled":
      return event.actor.role === COORDINATOR
        ? [coordinatorRecord(event, `reminders/${pathId}`)]
        : [quarantine(event, "coordinator-actor-unverified")];
    case "handoff.opened":
    case "handoff.state":
      return event.actor.role === COORDINATOR
        ? [coordinatorRecord(event, `handoffs/${pathId}`)]
        : [quarantine(event, "coordinator-actor-unverified")];
    case "handoff.ready":
    case "handoff.active":
      return actorOwner(context, event, text(payload, "role")) !== null
        ? [coordinatorRecord(event, `handoffs/${pathId}`)]
        : [quarantine(event, "handoff-participant-unverified")];
    case "request.imported":
    case "request.closed": {
      const owner =
        kind === "request.imported"
          ? registered(context, text(payload, "owner"))
          : actorOwner(
              context,
              event,
              lookup(owners.requests, id, () => context?.requestOwner?.(id)),
            );
      if (kind === "request.imported") {
        owners.requests.set(id, owner);
      }
      return owner === null
        ? [quarantine(event, "request-owner-unverified")]
        : [roleRecord(context, event, owner, `requests/${pathId}/${sequence}`)];
    }
    default:
      if (WORK_EVENTS.has(kind)) {
        return [workRecord(context, owners, event, id, pathId)];
      }
      if (QUESTION_EVENTS.has(kind)) {
        return questionRecords(context, owners, event, id, pathId);
      }
      return [quarantine(event, "event-kind-unrecognised")];
  }
}

/** Project a verified, ordered journal or a batch with prior ownership supplied by the caller. */
export function fileRecords(
  events: readonly StoredEvent[],
  context?: FileRecordContext,
): readonly FileRecord[] {
  const owners: Owners = {
    holds: new Map(),
    messages: new Map(),
    questions: new Map(),
    requests: new Map(),
    work: new Map(),
  };
  const paths = new Set<string>();
  const records: FileRecord[] = [];
  let previous = 0;
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= previous) {
      throw new StoreError("filesystem-event-order");
    }
    previous = event.seq;
    for (const record of eventRecords(context, owners, event)) {
      if (paths.has(record.path)) {
        throw new StoreError("filesystem-record-conflict");
      }
      paths.add(record.path);
      records.push(record);
    }
  }
  return records;
}
