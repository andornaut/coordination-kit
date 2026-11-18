// Callers authorize inbox reads, attempts and evidence. This store performs no transport or
// question lifecycle operations; native acceptance and explicit recipient handling are distinct.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual as same } from "node:util";

import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import { type DeliveryDiagnostic, safeDeliveryDiagnostic } from "../adapters/types.ts";
import { fsyncDirectory, readJsonIfExists, writeJsonDurable } from "../durable.ts";
import type { Layout } from "../layout.ts";
import { holdLockAsync, type LockHandle } from "../lock.ts";
import { protocolRole, ProtocolStore } from "../protocol/core.ts";
import { acquireProtocolLayout, type ProtocolLayout } from "../protocol/layout.ts";
import { ProtocolMessages } from "../protocol/messages.ts";
import {
  captureProtocolSelection,
  checkProtocolSelection,
  type ProtocolSelection,
} from "../protocol/selection.ts";
import { ID_PATTERN } from "../validate.ts";
import { messageEnvelope } from "./envelope.ts";
import { MessageError } from "./errors.ts";
import { MessageLookup } from "./lookup.ts";
import { messageLayout } from "./paths.ts";
import type {
  MessageAttempt,
  MessageAttemptIndexEntry,
  MessageAttemptLease,
  MessageAttemptSource,
  MessageCompletion,
  MessageContext,
  MessageEnvelope,
  MessageEvidence,
  MessageExpectation,
  MessageInput,
  MessageOwner,
  MessageReason,
  MessageRecord,
  MessageRetention,
  MessageStatus,
  MessageSummary,
  MessageSummarySelection,
} from "./types.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STATES = new Set([
  "queued",
  "held",
  "blocked",
  "sending",
  "accepted",
  "ambiguous",
  "parent-required",
  "handled",
  "superseded",
  "retained",
]);
const REASONS = new Set([
  "owner-unavailable",
  "guarded",
  "transport-unavailable",
  "transport-busy",
  "transport-pending",
  "worker-parent-required",
  "refused",
  "lost-response",
  "interrupted",
  "retained",
  "explicit-hold",
]);
const ATTEMPT_STATES = new Set(["sending", "accepted", "blocked", "ambiguous", "parent-required"]);
const EVIDENCE = new Set(["accepted", "not-delivered", "handled", "superseded", "retained"]);

export { messageEnvelope } from "./envelope.ts";
export { MessageError } from "./errors.ts";

function requireThat(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new MessageError(code);
  }
}

function role(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.split("/").length <= 2 &&
    value.split("/").every((part) => ID_PATTERN.test(part))
  );
}

function stamp(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ownerValid(owner: unknown): owner is MessageOwner {
  return (
    isRecord(owner) &&
    (owner.harness === "codex" || owner.harness === "claude") &&
    isCanonicalUuid(owner.nativeId) &&
    (owner.parentBinding === null ||
      (owner.harness === "codex" &&
        isRecord(owner.parentBinding) &&
        role(owner.parentBinding.role) &&
        isCanonicalUuid(owner.parentBinding.nativeId) &&
        owner.parentBinding.nativeId !== owner.nativeId))
  );
}

function sourceValid(source: unknown): source is MessageAttemptSource {
  return (
    isRecord(source) &&
    ownerValid(source.owner) &&
    isCanonicalUuid(source.requestId) &&
    (source.hop === "recipient" || (source.hop === "parent" && source.owner.parentBinding !== null))
  );
}

function retentionValid(value: unknown): value is MessageRetention {
  return (
    isRecord(value) &&
    role(value.ownerRole) &&
    typeof value.reason === "string" &&
    value.reason.trim() !== "" &&
    typeof value.nextBoundary === "string" &&
    value.nextBoundary.trim() !== ""
  );
}

function reasonValid(value: unknown): boolean {
  return value === null || (typeof value === "string" && REASONS.has(value));
}

function evidenceValid(value: unknown): value is MessageEvidence {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    EVIDENCE.has(value.kind) &&
    typeof value.ref === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(value.ref) &&
    (value.source === null || sourceValid(value.source)) &&
    (value.kind === "retained" ? retentionValid(value.retention) : value.retention === null)
  );
}

function attemptValid(value: unknown): value is MessageAttempt {
  return (
    isRecord(value) &&
    sourceValid(value.source) &&
    typeof value.state === "string" &&
    ATTEMPT_STATES.has(value.state) &&
    stamp(value.started) &&
    (value.state === "sending" ? value.completed === null : stamp(value.completed)) &&
    reasonValid(value.reason) &&
    (value.diagnostic === undefined || safeDeliveryDiagnostic(value.diagnostic) !== undefined)
  );
}

function validRecord(value: unknown): asserts value is MessageRecord {
  requireThat(
    isRecord(value) &&
      value.schema === 1 &&
      Number.isSafeInteger(value.revision) &&
      (value.revision as number) > 0 &&
      isRecord(value.envelope) &&
      typeof value.state === "string" &&
      STATES.has(value.state) &&
      Array.isArray(value.attempts) &&
      value.attempts.every(attemptValid) &&
      Array.isArray(value.evidence) &&
      value.evidence.every(evidenceValid) &&
      (value.retention === null || retentionValid(value.retention)) &&
      reasonValid(value.reason) &&
      (value.diagnostic === undefined || safeDeliveryDiagnostic(value.diagnostic) !== undefined),
    "invalid-record",
  );
  requireThat(
    same(messageEnvelope(value.envelope as unknown as MessageInput), value.envelope),
    "invalid-record",
  );
  const last = value.attempts.at(-1) as MessageAttempt | undefined;
  requireThat(
    (value.state !== "sending" || last?.state === "sending") &&
      (value.state !== "accepted" ||
        (last?.state === "accepted" && last.source.hop === "recipient")) &&
      (value.state !== "retained" || value.retention !== null) &&
      new Set(value.attempts.map((attempt: MessageAttempt) => attempt.source.requestId)).size ===
        value.attempts.length,
    "invalid-record",
  );
}

function sourceOf(record: MessageRecord): MessageAttemptSource | null {
  return record.attempts.at(-1)?.source ?? null;
}

function guard(record: MessageRecord, expected: MessageExpectation): void {
  requireThat(
    same(record.envelope, expected.envelope) &&
      record.revision === expected.revision &&
      same(sourceOf(record), expected.source),
    "binding-conflict",
  );
}

export function messageExpectation(record: MessageRecord): MessageExpectation {
  return {
    envelope: clone(record.envelope),
    revision: record.revision,
    source: clone(sourceOf(record)),
  };
}

function attemptEntry(record: MessageRecord, position: number): MessageAttemptIndexEntry {
  return {
    id: record.envelope.id,
    latest: position === record.attempts.length - 1,
    revision: record.revision,
    state: record.state,
  };
}

function terminal(record: MessageRecord): boolean {
  return record.state === "handled" || record.state === "superseded";
}

function withoutDiagnostic(record: MessageRecord): MessageRecord {
  const copy = { ...record };
  delete copy.diagnostic;
  return copy;
}

function publicStatus(record: MessageRecord): MessageStatus {
  const { created, fromRole, id, intent, toRole } = record.envelope;
  return {
    ...(safeDeliveryDiagnostic(record.diagnostic) === undefined
      ? {}
      : { diagnostic: safeDeliveryDiagnostic(record.diagnostic)! }),
    attempts: record.attempts.length,
    created,
    fromRole,
    id,
    intent,
    nextBoundary: record.retention?.nextBoundary ?? null,
    outbox: record.attempts.map(({ diagnostic, source, state }) => ({
      ...(safeDeliveryDiagnostic(diagnostic) === undefined
        ? {}
        : { diagnostic: safeDeliveryDiagnostic(diagnostic)! }),
      hop: source.hop,
      requestId: source.requestId,
      state,
    })),
    ownerRole: record.retention?.ownerRole ?? null,
    ...(record.envelope.workerId === undefined
      ? {}
      : {
          parentRole: record.envelope.parentRole!,
          workerId: record.envelope.workerId,
        }),
    reason: record.reason,
    revision: record.revision,
    state: record.state,
    toRole,
  };
}

/**
 * Read-only operational inventory for the existing review pass; creates no message state or
 * wake. A selection limits it to one message ID or to the given recipients.
 */
export function messageSummary(
  layout: MessageContext["layout"],
  selection: MessageSummarySelection = {},
): MessageSummary {
  return new MessageStore({ layout, resolveOwner: () => null }).summary(selection);
}

function byCreated(a: MessageRecord, b: MessageRecord): number {
  return (
    a.envelope.created.localeCompare(b.envelope.created) ||
    a.envelope.id.localeCompare(b.envelope.id)
  );
}

/** Local role inbox, independent of optional notifications or native transport availability. */
export class MessageStore {
  private readonly context: MessageContext;
  private readonly directory: string;
  private readonly layout: Layout | null;
  private readonly protocol: ProtocolLayout | null;
  private readonly selection: ProtocolSelection | null;
  private readonly canonicalMessages: ProtocolMessages | null;
  private readonly lookup: MessageLookup;
  private views = 0;

  constructor(context: MessageContext) {
    this.context = context;
    this.layout = messageLayout(context.layout);
    this.selection = this.layout === null ? null : captureProtocolSelection(this.layout);
    this.protocol = this.selection?.protocol ?? null;
    this.directory = this.protocol?.messagesDir ?? join(context.layout.reviewDir, "messages");
    this.lookup = new MessageLookup(this.directory);
    this.canonicalMessages =
      this.protocol === null
        ? null
        : new ProtocolMessages({
            store: new ProtocolStore({ directory: this.protocol.stateRoot }),
          });
  }

  private now(): string {
    const value = this.context.now?.() ?? new Date().toISOString();
    requireThat(stamp(value), "invalid-clock");
    return value;
  }

  /** A read view checks the selection on entry and exit instead of on every record. */
  private checkSelection(): void {
    if (this.layout !== null && this.views === 0) {
      checkProtocolSelection(this.layout, this.selection!);
    }
  }

  private path(id: string): string {
    this.checkSelection();
    requireThat(typeof id === "string" && ID.test(id), "invalid-id");
    return join(this.directory, `${hash(id)}.json`);
  }

  /** Hints precede the record write, so a stored attempt is always findable or uncovered. */
  private hint(record: MessageRecord): void {
    const name = hash(record.envelope.id);
    this.lookup.add("recipient", record.envelope.toRole, name);
    for (const attempt of record.attempts) {
      this.lookup.add("request", attempt.source.requestId, name);
    }
  }

  private async lock(id: string): Promise<LockHandle> {
    this.path(id);
    const generation =
      this.layout === null
        ? null
        : await acquireProtocolLayout(this.layout, this.protocol, {
            allowPending: this.selection!.management.status === "pending",
            expectedManagement: this.selection!.management,
            nonBlocking: true,
          });
    try {
      mkdirSync(this.directory, { mode: 0o700, recursive: true });
      chmodSync(this.directory, 0o700);
      fsyncDirectory(dirname(this.directory));
      const message = await holdLockAsync(join(this.directory, `${hash(id)}.lock`), {
        nonBlocking: true,
      });
      return {
        path: message.path,
        release() {
          message.release();
          generation?.release();
        },
      };
    } catch (error) {
      generation?.release();
      throw error;
    }
  }

  private save(record: MessageRecord): MessageRecord {
    this.checkOriginal(record.envelope);
    const next = { ...record, revision: record.revision + 1 };
    validRecord(next);
    const path = this.path(next.envelope.id);
    this.hint(next);
    writeJsonDurable(path, next);
    return clone(next);
  }

  private existing(expected: MessageExpectation): MessageRecord {
    const record = this.read(expected.envelope.id);
    requireThat(record !== undefined, "missing");
    guard(record, expected);
    return record;
  }

  /** Private payload read. Public callers must deliberately opt into authorized inbox access. */
  read(id: string): MessageRecord | undefined {
    return this.readView(() => {
      this.path(id);
      const record = this.load(hash(id), true);
      if (record === undefined) {
        return undefined;
      }
      requireThat(record.envelope.id === id, "binding-conflict");
      return record;
    });
  }

  /**
   * Every stored record is read and validated here, by its file base name. Without `originals`
   * the protocol original check is skipped, so callers must re-read a selected record.
   */
  private load(name: string, originals: boolean): MessageRecord | undefined {
    let record: unknown;
    try {
      record = readJsonIfExists(join(this.directory, `${name}.json`));
    } catch {
      throw new MessageError("unreadable-record");
    }
    if (record === undefined) {
      return undefined;
    }
    validRecord(record);
    requireThat(hash(record.envelope.id) === name, "binding-conflict");
    if (originals) {
      this.checkOriginal(record.envelope);
    }
    return record;
  }

  private originals(): ProtocolMessages | null {
    this.checkSelection();
    return this.canonicalMessages;
  }

  private readView<T>(read: () => T): T {
    if (this.views > 0) {
      return read();
    }
    const messages = this.originals();
    this.views++;
    let value: T;
    try {
      value = messages === null ? read() : messages.withReadView(read);
    } finally {
      this.views--;
    }
    this.checkSelection();
    return value;
  }

  /** Transport records are projections of this original after explicit protocol activation. */
  original(fromRole: string, id: string): MessageEnvelope | null {
    const originals = this.originals();
    if (originals === null) {
      return null;
    }
    const ref = originals.find(protocolRole(fromRole), id);
    requireThat(ref !== null, "protocol-original-required");
    return originals.read(ref).envelope;
  }

  private checkOriginal(envelope: MessageEnvelope): void {
    const canonical = this.original(envelope.fromRole, envelope.id);
    requireThat(canonical === null || same(canonical, envelope), "protocol-original-conflict");
  }

  /** Explicit recipient inbox read returns full original payloads, never abbreviated bodies. */
  inbox(toRole: string): readonly MessageRecord[] {
    requireThat(role(toRole), "invalid-role");
    return this.readView(() => this.recipients([toRole]));
  }

  /**
   * Reads only the hinted records of these recipients plus any record without a recipient hint.
   * An uncovered record is read, hinted and kept only when it belongs to a selected recipient.
   */
  private recipients(toRoles: readonly string[]): readonly MessageRecord[] {
    this.checkSelection();
    const stored = this.stored();
    const covered = this.lookup.covered();
    const selected = new Set(toRoles);
    const names = new Set<string>();
    for (const toRole of selected) {
      for (const name of this.lookup.hinted("recipient", toRole)) {
        if (stored.has(name)) {
          names.add(name);
        }
      }
    }
    for (const name of stored) {
      if (!covered.has(name)) {
        names.add(name);
      }
    }
    const records: MessageRecord[] = [];
    for (const name of [...names].sort()) {
      const record = this.load(name, true);
      if (record === undefined) {
        continue;
      }
      if (!covered.has(name)) {
        this.hint(record);
      }
      if (selected.has(record.envelope.toRole)) {
        records.push(record);
      }
    }
    return records.sort(byCreated);
  }

  /**
   * Point-in-time recipient listing: one scan and its protocol lookups share one read view, and
   * each status comes from the scanned record without a second read.
   */
  inboxStatus(
    toRole: string,
  ): readonly { readonly record: MessageRecord; readonly status: MessageStatus }[] {
    return this.readView(() =>
      this.inbox(toRole).map((record) => ({ record, status: this.publicRecord(record) })),
    );
  }

  private records(): readonly MessageRecord[] {
    return this.readView(() => this.readRecords());
  }

  /**
   * One scan mapping every attempt request ID to its records, restoring any missing request hint.
   * It skips the per-record protocol original check, so callers must re-read a selected record
   * through `read`.
   */
  attemptIndex(): ReadonlyMap<string, readonly MessageAttemptIndexEntry[]> {
    const index = new Map<string, MessageAttemptIndexEntry[]>();
    for (const record of this.readRecords(false)) {
      this.hint(record);
      record.attempts.forEach((attempt, position) => {
        const entries = index.get(attempt.source.requestId) ?? [];
        entries.push(attemptEntry(record, position));
        index.set(attempt.source.requestId, entries);
      });
    }
    return index;
  }

  /**
   * Request lookup for one consumer drain: it reads only the records hinted for a request ID. A
   * request with no verified hinted record falls back to one `attemptIndex` scan per lookup,
   * so an absent or stale hint costs a scan, never a different answer.
   */
  attemptLookup(): {
    readonly get: (requestId: string) => readonly MessageAttemptIndexEntry[];
  } {
    let index: ReadonlyMap<string, readonly MessageAttemptIndexEntry[]> | undefined;
    return {
      get: (requestId) => {
        const entries = this.hintedAttempts(requestId);
        if (entries.length > 0) {
          return entries;
        }
        index ??= this.attemptIndex();
        return index.get(requestId) ?? [];
      },
    };
  }

  private stored(): Set<string> {
    try {
      return this.lookup.stored();
    } catch {
      throw new MessageError("unreadable-inbox");
    }
  }

  private hintedAttempts(requestId: string): MessageAttemptIndexEntry[] {
    this.checkSelection();
    const entries: MessageAttemptIndexEntry[] = [];
    for (const name of this.lookup.hinted("request", requestId).sort()) {
      const record = this.load(name, false);
      record?.attempts.forEach((attempt, position) => {
        if (attempt.source.requestId === requestId) {
          entries.push(attemptEntry(record, position));
        }
      });
    }
    return entries;
  }

  private readRecords(originals = true): readonly MessageRecord[] {
    this.checkSelection();
    const stored = this.stored();
    const covered = this.lookup.covered();
    const records: MessageRecord[] = [];
    for (const name of stored) {
      const record = this.load(name, originals);
      if (record !== undefined) {
        if (!covered.has(name)) {
          this.hint(record);
        }
        records.push(record);
      }
    }
    return records.sort(byCreated);
  }

  status(id: string): MessageStatus | undefined {
    return this.readView(() => {
      const record = this.read(id);
      return record === undefined ? undefined : this.publicRecord(record);
    });
  }

  private publicRecord(record: MessageRecord): MessageStatus {
    const status = publicStatus(record);
    const originals = this.originals();
    if (originals === null) {
      return status;
    }
    const ref = originals.find(protocolRole(record.envelope.fromRole), record.envelope.id);
    requireThat(ref !== null, "protocol-original-required");
    const receipt = originals.latestRecipientReceipt(ref);
    return {
      ...status,
      protocol: {
        disposition: receipt?.value.disposition ?? null,
        handlingAttestation: receipt === null ? "unattested" : "attested",
      },
    };
  }

  summary(selection: MessageSummarySelection = {}): MessageSummary {
    try {
      return this.readView(() => {
        let records: readonly MessageRecord[];
        if (selection.id !== undefined) {
          const record = this.read(selection.id);
          records = record === undefined ? [] : [record];
        } else if (selection.recipients !== undefined) {
          records = this.recipients(selection.recipients);
        } else {
          records = this.records();
        }
        const messages = records.map((record) => this.publicRecord(record));
        const counts = Object.fromEntries([...STATES].map((state) => [state, 0])) as Record<
          MessageRecord["state"],
          number
        >;
        for (const message of messages) {
          counts[message.state]++;
        }
        return { counts, messages, schema: 1, status: "available" };
      });
    } catch {
      return {
        counts: null,
        messages: null,
        reason: "unreadable-inbox",
        schema: 1,
        status: "unavailable",
      };
    }
  }

  async enqueue(input: MessageInput): Promise<MessageRecord> {
    const envelope = messageEnvelope(input);
    this.checkOriginal(envelope);
    const existing = this.read(envelope.id);
    if (existing !== undefined) {
      requireThat(same(existing.envelope, envelope), "id-conflict");
      return existing;
    }
    const lock = await this.lock(envelope.id);
    try {
      const previous = this.read(envelope.id);
      if (previous !== undefined) {
        requireThat(same(previous.envelope, envelope), "id-conflict");
        return previous;
      }
      return this.save({
        attempts: [],
        envelope,
        evidence: [],
        reason: null,
        retention: null,
        revision: 0,
        schema: 1,
        state: "queued",
      });
    } finally {
      lock.release();
    }
  }

  private interrupted(record: MessageRecord): MessageRecord {
    const last = record.attempts.at(-1);
    requireThat(last?.state === "sending", "invalid-transition");
    return this.save({
      ...record,
      attempts: [
        ...record.attempts.slice(0, -1),
        {
          ...last,
          completed: this.now(),
          reason: "interrupted",
          state: "ambiguous",
        },
      ],
      reason: "interrupted",
      state: "ambiguous",
    });
  }

  async recover(expected: MessageExpectation): Promise<MessageRecord> {
    const lock = await this.lock(expected.envelope.id);
    try {
      const record = this.existing(expected);
      return record.state === "sending" ? this.interrupted(record) : record;
    } finally {
      lock.release();
    }
  }

  /** A qualified pre-dispatch refusal does not create a native attempt or release a hold. */
  async block(
    expected: MessageExpectation,
    reason: MessageReason,
    diagnostic?: DeliveryDiagnostic,
  ): Promise<MessageRecord> {
    requireThat(reasonValid(reason) && reason !== null, "invalid-reason");
    const lock = await this.lock(expected.envelope.id);
    try {
      const record = this.existing(expected);
      const last = record.attempts.at(-1);
      requireThat(
        ["queued", "blocked", "parent-required"].includes(record.state) &&
          (last === undefined || ["blocked", "parent-required"].includes(last.state)),
        "retry-not-permitted",
      );
      return this.save({
        ...withoutDiagnostic(record),
        ...(safeDeliveryDiagnostic(diagnostic) === undefined
          ? {}
          : { diagnostic: safeDeliveryDiagnostic(diagnostic)! }),
        reason,
        state: "blocked",
      });
    } finally {
      lock.release();
    }
  }

  async beginAttempt(
    expected: MessageExpectation,
    hop: "recipient" | "parent" = "recipient",
  ): Promise<MessageAttemptLease> {
    const lock = await this.lock(expected.envelope.id);
    try {
      const record = this.existing(expected);
      if (record.state === "sending") {
        this.interrupted(record);
        throw new MessageError("ambiguous-attempt");
      }
      const last = record.attempts.at(-1);
      requireThat(
        ["queued", "blocked", "parent-required"].includes(record.state) &&
          (last === undefined || ["blocked", "parent-required"].includes(last.state)),
        "retry-not-permitted",
      );
      requireThat(hop === "recipient" || hop === "parent", "invalid-hop");
      let owner: MessageOwner | null;
      try {
        owner = await this.context.resolveOwner(record.envelope.toRole, clone(record.envelope));
      } catch {
        owner = null;
      }
      const workerId = record.envelope.workerId;
      if (
        !ownerValid(owner) ||
        (workerId !== undefined &&
          (owner.harness !== "codex" ||
            owner.nativeId !== workerId ||
            owner.parentBinding?.role !== record.envelope.parentRole))
      ) {
        this.save({ ...record, reason: "owner-unavailable", state: "blocked" });
        throw new MessageError("owner-unavailable");
      }
      requireThat(hop !== "parent" || owner.parentBinding !== null, "parent-binding-required");
      const binding: MessageOwner = {
        harness: owner.harness,
        nativeId: owner.nativeId,
        parentBinding:
          owner.parentBinding === null
            ? null
            : {
                nativeId: owner.parentBinding.nativeId,
                role: owner.parentBinding.role,
              },
      };
      const parentRequired = record.attempts.some(
        (attempt) =>
          attempt.state === "parent-required" &&
          attempt.source.hop === "recipient" &&
          same(attempt.source.owner, binding),
      );
      requireThat(!parentRequired || hop === "parent", "parent-hop-required");
      const source: MessageAttemptSource = { hop, owner: binding, requestId: randomUUID() };
      const attempt: MessageAttempt = {
        completed: null,
        reason: null,
        source,
        started: this.now(),
        state: "sending",
      };
      const sending = this.save({
        ...withoutDiagnostic(record),
        attempts: [...record.attempts, attempt],
        reason: null,
        state: "sending",
      });
      return this.lease(lock, sending, source);
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  private lease(
    lock: LockHandle,
    record: MessageRecord,
    source: MessageAttemptSource,
  ): MessageAttemptLease {
    let open = true;
    const expected = messageExpectation(record);
    return {
      close: () => {
        if (open) {
          try {
            this.interrupted(this.existing(expected));
          } finally {
            open = false;
            lock.release();
          }
        }
      },
      complete: (receipt: MessageCompletion) => {
        requireThat(open, "closed-attempt");
        requireThat(same(receipt.source, source), "binding-conflict");
        requireThat(
          ["accepted", "blocked", "ambiguous", "parent-required"].includes(receipt.state) &&
            reasonValid(receipt.reason) &&
            (receipt.state === "accepted" || receipt.reason !== null),
          "invalid-receipt",
        );
        const current = this.existing(expected);
        const state =
          receipt.state === "accepted" && source.hop === "parent"
            ? "parent-required"
            : receipt.state;
        const result = this.save({
          ...withoutDiagnostic(current),
          attempts: [
            ...current.attempts.slice(0, -1),
            {
              ...current.attempts.at(-1)!,
              ...(safeDeliveryDiagnostic(receipt.diagnostic) === undefined
                ? {}
                : { diagnostic: safeDeliveryDiagnostic(receipt.diagnostic)! }),
              completed: this.now(),
              reason: receipt.reason,
              state: receipt.state,
            },
          ],
          ...(safeDeliveryDiagnostic(receipt.diagnostic) === undefined
            ? {}
            : { diagnostic: safeDeliveryDiagnostic(receipt.diagnostic)! }),
          reason: receipt.reason,
          state,
        });
        open = false;
        lock.release();
        return result;
      },
      envelope: clone(record.envelope),
      source: clone(source),
    };
  }

  async reconcile(expected: MessageExpectation, evidence: MessageEvidence): Promise<MessageRecord> {
    requireThat(evidenceValid(evidence), "invalid-evidence");
    const lock = await this.lock(expected.envelope.id);
    try {
      const record = this.existing(expected);
      if (this.protocol !== null && ["handled", "superseded", "retained"].includes(evidence.kind)) {
        const originals = this.originals()!;
        const ref = originals.find(protocolRole(record.envelope.fromRole), record.envelope.id);
        requireThat(ref !== null, "protocol-original-required");
        const receipt = originals.latestRecipientReceipt(ref);
        requireThat(
          receipt !== null &&
            receipt.value.disposition === evidence.kind &&
            evidence.ref === `protocol-receipt:${receipt.reference.hash}` &&
            same(receipt.value.retention, evidence.retention),
          "protocol-recipient-receipt-required",
        );
      }
      requireThat(same(evidence.source, expected.source), "binding-conflict");
      if (same(record.evidence.at(-1), evidence)) {
        return record;
      }
      requireThat(!terminal(record) && record.state !== "sending", "invalid-transition");
      let state: MessageRecord["state"] =
        evidence.kind === "not-delivered" ? "queued" : evidence.kind;
      let attempts = record.attempts;
      if (evidence.kind === "not-delivered" || evidence.kind === "accepted") {
        const last = attempts.at(-1);
        requireThat(last?.state !== "parent-required", "parent-hop-required");
        requireThat(
          last !== undefined &&
            last.state !== "accepted" &&
            (evidence.kind !== "accepted" || last.state === "ambiguous"),
          "invalid-transition",
        );
        attempts = [
          ...attempts.slice(0, -1),
          {
            ...last,
            completed: this.now(),
            reason: evidence.kind === "not-delivered" ? "refused" : null,
            state: evidence.kind === "not-delivered" ? "blocked" : "accepted",
          },
        ];
        if (evidence.kind === "accepted" && last.source.hop === "parent") {
          state = "parent-required";
        }
      }
      const preserveHold =
        (record.state === "held" || record.state === "retained") &&
        (evidence.kind === "not-delivered" || evidence.kind === "accepted");
      return this.save({
        ...record,
        attempts,
        evidence: [...record.evidence, clone(evidence)],
        reason: preserveHold ? record.reason : evidence.kind === "retained" ? "retained" : null,
        retention: preserveHold ? record.retention : evidence.retention,
        state: preserveHold ? record.state : state,
      });
    } finally {
      lock.release();
    }
  }

  async hold(expected: MessageExpectation, retention: MessageRetention): Promise<MessageRecord> {
    requireThat(retentionValid(retention), "invalid-retention");
    const lock = await this.lock(expected.envelope.id);
    try {
      const record = this.existing(expected);
      requireThat(!terminal(record) && record.state !== "sending", "invalid-transition");
      return this.save({
        ...record,
        reason: "explicit-hold",
        retention: clone(retention),
        state: "held",
      });
    } finally {
      lock.release();
    }
  }

  async release(expected: MessageExpectation): Promise<MessageRecord> {
    const lock = await this.lock(expected.envelope.id);
    try {
      const record = this.existing(expected);
      requireThat(record.state === "held" || record.state === "retained", "invalid-transition");
      const last = record.attempts.at(-1);
      const state =
        last?.state === "accepted"
          ? last.source.hop === "parent"
            ? "parent-required"
            : "accepted"
          : last?.state === "ambiguous"
            ? "ambiguous"
            : last?.state === "parent-required"
              ? "parent-required"
              : "queued";
      return this.save({ ...record, reason: null, retention: null, state });
    } finally {
      lock.release();
    }
  }
}
