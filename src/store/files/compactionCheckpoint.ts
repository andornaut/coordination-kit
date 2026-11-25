import { isRecord } from "../../core/pyjson.ts";
import { canonicalJson, eventHash, normalizeLinks, sha256 } from "../eventCodec.ts";
import {
  GENESIS,
  type JsonObject,
  type MessageLink,
  type StoredEvent,
  StoreError,
} from "../types.ts";
import { type CompactionScope, planFileCompaction } from "./compactionPlan.ts";

export interface CheckpointHead {
  readonly seq: number;
  readonly hash: string;
}

interface CheckpointEntry {
  /** The original envelope and key. A reduced entry keeps the original event hash. */
  readonly event: StoredEvent;
  readonly reducedDigest?: string;
}

export interface CompactionCheckpoint {
  readonly schema: 2;
  readonly anchor: CheckpointHead;
  readonly head: CheckpointHead;
  readonly registryRevision: number;
  readonly predecessor?: CheckpointSelection;
  readonly entries: readonly CheckpointEntry[];
}

/** Persist separately from the byte payload, after an independent source check. */
export interface CheckpointReceipt {
  readonly head: CheckpointHead;
  readonly digest: string;
}

export interface CheckpointSelection extends CheckpointReceipt {
  readonly id: string;
}

export interface CheckpointPredecessor {
  readonly checkpoint: CompactionCheckpoint;
  readonly selection: CheckpointSelection;
}

const INITIAL_HEAD: CheckpointHead = { hash: GENESIS, seq: 0 };
const MESSAGE_FIELDS = ["bodySha256", "createdAt", "from", "id", "intent", "links", "to", "worker"];
const REDUCTIONS: Readonly<Record<string, { field: string; keep: readonly string[] }>> = {
  "bus.event": {
    field: "detail",
    keep: ["at", "game", "id", "key", "kind", "schema", "sha", "status", "type", "work"],
  },
  "msg.imported": {
    field: "body",
    keep: [
      ...MESSAGE_FIELDS,
      "closedAt",
      "deliveredAt",
      "evidence",
      "legacy",
      "retention",
      "state",
      "supersededBy",
      "unconfirmed",
      "work",
    ],
  },
  "msg.sent": { field: "body", keep: MESSAGE_FIELDS },
  "session.started": { field: "cwd", keep: ["harness", "nativeId", "role", "version"] },
};

function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function headOf(event: CheckpointHead): CheckpointHead {
  return { hash: event.hash, seq: event.seq };
}

function sameHead(left: CheckpointHead, right: CheckpointHead): boolean {
  return left.seq === right.seq && left.hash === right.hash;
}

function verifyEvents(
  initial: CheckpointHead,
  keys: Set<string>,
  events: readonly StoredEvent[],
): CheckpointHead {
  let head = initial;
  for (const event of events) {
    const { hash, ...draft } = event;
    if (
      event.seq !== head.seq + 1 ||
      event.prevHash !== head.hash ||
      eventHash(draft) !== hash ||
      event.key === "" ||
      keys.has(event.key)
    ) {
      throw new StoreError("checkpoint-source-chain");
    }
    keys.add(event.key);
    head = headOf(event);
  }
  return head;
}

function messageIdentity(payload: JsonObject, body: string): boolean {
  const { bodySha256, intent, links } = payload;
  return (
    bodySha256 === sha256(body) &&
    (intent === "queue" || intent === "unblock") &&
    Array.isArray(links) &&
    links.every(
      (link: unknown) =>
        isRecord(link) &&
        typeof link.kind === "string" &&
        typeof link.ref === "string" &&
        Object.keys(link).length === 2,
    ) &&
    canonicalJson(links) === canonicalJson(normalizeLinks(links as readonly MessageLink[]))
  );
}

function reduce(event: StoredEvent): CheckpointEntry {
  const rule = REDUCTIONS[event.kind];
  if (rule === undefined) {
    throw new StoreError("checkpoint-reduction-unsupported");
  }
  const { field, keep } = rule;
  const { [field]: removed, ...payload } = event.payload;
  if (
    Object.keys(event).sort().join(",") !== "actor,at,hash,key,kind,payload,prevHash,seq" ||
    Object.keys(event.actor).some(
      (key) => key !== "nativeId" && key !== "role" && key !== "worker",
    ) ||
    (typeof removed !== "string" && !(field === "detail" && removed === null)) ||
    Object.keys(payload).some((key) => !keep.includes(key)) ||
    (field === "body" && (typeof removed !== "string" || !messageIdentity(payload, removed))) ||
    (typeof removed === "string" && canonicalJson(payload).includes(JSON.stringify(removed)))
  ) {
    throw new StoreError("checkpoint-payload-unqualified");
  }
  const reduced = { ...event, payload };
  return { event: reduced, reducedDigest: digest(reduced) };
}

/** Build a deterministic candidate from the complete, independently adjudicated source. */
export function prepareCompactionCheckpoint(
  tail: readonly StoredEvent[],
  scope: CompactionScope,
  cutoverAnchor?: CheckpointHead,
  previous?: CheckpointPredecessor,
): { readonly checkpoint: CompactionCheckpoint; readonly receipt: CheckpointReceipt } {
  const prefix = previous && verifyCompactionCheckpoint(previous.checkpoint, previous.selection);
  const head = prefix
    ? verifyCompactionTail(prefix, tail)
    : verifyEvents(INITIAL_HEAD, new Set(), tail);
  const events = prefix ? [...prefix.entries.map(({ event }) => event), ...tail] : tail;
  const first = events[0] === undefined ? INITIAL_HEAD : headOf(events[0]);
  const anchor = headOf(cutoverAnchor ?? prefix?.anchor ?? first);
  const sourceAnchor = anchor.seq === 0 ? INITIAL_HEAD : events[anchor.seq - 1];
  if (
    sourceAnchor === undefined ||
    !sameHead(anchor, sourceAnchor) ||
    (prefix !== undefined && !sameHead(anchor, prefix.anchor))
  ) {
    throw new StoreError("checkpoint-anchor-mismatch");
  }
  const evidence = scope.verifiedEvidence;
  if (
    evidence === undefined ||
    !sameHead(head, evidence.head) ||
    scope.registryRevision !== evidence.registryRevision
  ) {
    throw new StoreError("checkpoint-evidence-mismatch");
  }
  const count = evidence.messageIds.size + evidence.routineEventSequences.size;
  const reduced = new Set(
    prefix?.entries
      .filter(({ reducedDigest }) => reducedDigest !== undefined)
      .map(({ event }) => event.seq),
  );
  const plan = planFileCompaction(events, scope, reduced);
  const eligible = plan.streams.reduce((sum, stream) => sum + stream.eligible.count, 0);
  if (count === 0 || eligible !== count) {
    throw new StoreError("checkpoint-selection-unqualified");
  }

  const entries: CheckpointEntry[] = [];
  for (const event of events) {
    const id = event.payload.id;
    const message =
      (event.kind === "msg.sent" || event.kind === "msg.imported") &&
      typeof id === "string" &&
      evidence.messageIds.has(id);
    const routine = evidence.routineEventSequences.has(event.seq);
    if (reduced.has(event.seq)) {
      entries.push(prefix!.entries[event.seq - 1]!);
    } else if (message || routine) {
      if (event.seq === (anchor.seq || first.seq)) {
        throw new StoreError("checkpoint-anchor-protected");
      }
      entries.push(reduce(event));
    } else {
      entries.push({ event });
    }
  }

  const checkpoint: CompactionCheckpoint = {
    anchor,
    entries,
    head,
    ...(previous === undefined ? {} : { predecessor: previous.selection }),
    registryRevision: scope.registryRevision,
    schema: 2,
  };
  return { checkpoint, receipt: { digest: digest(checkpoint), head } };
}

/** Qualify supplied checkpoint bytes against a fresh read of the same full source. */
export function verifyCompactionSource(
  checkpoint: unknown,
  receipt: CheckpointReceipt,
  events: readonly StoredEvent[],
  scope: CompactionScope,
  cutoverAnchor?: CheckpointHead,
  previous?: CheckpointPredecessor,
): CompactionCheckpoint {
  const expected = prepareCompactionCheckpoint(events, scope, cutoverAnchor, previous);
  if (
    receipt.digest !== expected.receipt.digest ||
    !sameHead(receipt.head, expected.receipt.head)
  ) {
    throw new StoreError("checkpoint-proof-mismatch");
  }
  return verifyCompactionCheckpoint(checkpoint, receipt);
}

/** Only accept the complete canonical commitment from an independently qualified receipt. */
export function verifyCompactionCheckpoint(
  value: unknown,
  receipt: CheckpointReceipt,
): CompactionCheckpoint {
  if (!isRecord(value) || value.schema !== 2 || digest(value) !== receipt.digest) {
    throw new StoreError("checkpoint-digest-mismatch");
  }
  // Qualification validated every entry against the source, and the trusted digest binds them.
  const checkpoint = value as unknown as CompactionCheckpoint;
  if (!sameHead(checkpoint.head, receipt.head)) {
    throw new StoreError("checkpoint-proof-mismatch");
  }
  return checkpoint;
}

/** Verify the ordinary append-only tail against a previously verified checkpoint. */
function verifyCompactionTail(
  checkpoint: CompactionCheckpoint,
  tail: readonly StoredEvent[],
): CheckpointHead {
  return verifyEvents(
    checkpoint.head,
    new Set(checkpoint.entries.map(({ event }) => event.key)),
    tail,
  );
}
