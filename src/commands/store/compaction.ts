import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { Handler } from "../../core/cli/io.ts";
import { isRecord } from "../../core/encoding/pyjson.ts";
import { fsyncDirectory, readJson } from "../../core/files/durable.ts";
import { withLock } from "../../core/files/lock.ts";
import { systemGit } from "../../core/git.ts";
import { isCanonicalUuid, uuid5 } from "../../core/ids.ts";
import { registry, type StoreServiceContext } from "../../store/context.ts";
import { storePath, storeRoot } from "../../store/db.ts";
import { canonicalJson, REF, sha256 } from "../../store/eventCodec.ts";
import { fileAuthority } from "../../store/files/authority.ts";
import type { CheckpointHead } from "../../store/files/compaction/checkpoint.ts";
import {
  fileCheckpointCandidate,
  fileCheckpointJournal,
  type PreparedFileCheckpoint,
  prepareFileCheckpoint,
  readFileCheckpointSource,
  selectFileCheckpoint,
} from "../../store/files/compaction/generation.ts";
import type { CompactionScope } from "../../store/files/compaction/plan.ts";
import {
  assertFileJournalReservation,
  cancelFileJournalReservation,
  type FileJournalReservation,
  type FileJournalReservationRequest,
  readFileJournalFence,
  readFileJournalReservation,
  reserveFileJournal,
} from "../../store/files/journal.ts";
import { MESSAGE_ID } from "../../store/messages/messages.ts";
import { resolveCaller } from "../../store/sessions/identity.ts";
import { requirePermission } from "../../store/sessions/permissions.ts";
import { ROLE, type StoredEvent, StoreError } from "../../store/types.ts";
import { callerOf, required, text, type Values } from "../args.ts";
import { storeVerb } from "./context.ts";

export const COMPACTION_PREPARE_OPTIONS = {
  evidence: { type: "string" },
  id: { type: "string" },
  "native-id": { type: "string" },
  receipt: { type: "string" },
  restore: { type: "string" },
} as const;

export const COMPACTION_ACTIVATE_OPTIONS = {
  ...COMPACTION_PREPARE_OPTIONS,
  approval: { type: "string" },
} as const;

export const COMPACTION_RESERVATION_OPTIONS = {
  "head-hash": { type: "string" },
  "head-seq": { type: "string" },
  id: { type: "string" },
  "native-id": { type: "string" },
  "registry-revision": { type: "string" },
} as const;

export const COMPACTION_CANCEL_OPTIONS = {
  ...COMPACTION_RESERVATION_OPTIONS,
  nonce: { type: "string" },
} as const;

const HEX = /^[a-f0-9]{64}$/;

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function canonicalPath(path: string, parent = path): string {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(parent) !== parent) {
    throw new StoreError("compaction-path-invalid");
  }
  return path;
}

function externalPath(path: string, ...roots: string[]): string {
  if (roots.some((root) => contains(root, path) || contains(path, root))) {
    throw new StoreError("compaction-path-overlap");
  }
  return path;
}

function independentRestore(path: string): void {
  if (
    !lstatSync(path).isDirectory() ||
    readdirSync(path, { recursive: true, withFileTypes: true }).some(
      (entry) =>
        !entry.isDirectory() &&
        (!entry.isFile() || lstatSync(resolve(entry.parentPath, entry.name)).nlink !== 1),
    )
  ) {
    throw new StoreError("compaction-restore-not-independent");
  }
}

function regularJson(path: string): unknown {
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file?.isFile() || file.nlink !== 1 || realpathSync(path) !== path) {
    throw new StoreError("compaction-record-path-invalid");
  }
  return readJson(path);
}

function writeReceipt(path: string, value: unknown): void {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StoreError("compaction-receipt-exists");
    }
    throw error;
  }
  try {
    writeFileSync(fd, `${canonicalJson(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function reference(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function messageProof(input: unknown, events: readonly StoredEvent[]): string {
  if (
    !isRecord(input) ||
    Object.keys(input).sort().join(",") !== "closeSeq,id,owner,replacement" ||
    !positive(input.closeSeq) ||
    !reference(input.id, MESSAGE_ID) ||
    !reference(input.owner, ROLE) ||
    !reference(input.replacement, REF)
  ) {
    throw new StoreError("compaction-message-evidence-invalid");
  }
  const close = events[input.closeSeq - 1];
  if (
    close?.seq !== input.closeSeq ||
    close.kind !== "msg.closed" ||
    close.actor.role !== input.owner ||
    close.payload.id !== input.id ||
    (close.payload.state !== "handled" && close.payload.state !== "superseded") ||
    !Array.isArray(close.payload.evidence) ||
    !close.payload.evidence.includes(input.replacement)
  ) {
    throw new StoreError("compaction-message-replacement-unverified");
  }
  return input.id;
}

function evidence(path: string, events: readonly StoredEvent[]) {
  const value = regularJson(path);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "head,messages,registryRevision,routineEventSequences,schema" ||
    value.schema !== 1 ||
    !isRecord(value.head) ||
    Object.keys(value.head).sort().join(",") !== "hash,seq" ||
    !positive(value.head.seq) ||
    !reference(value.head.hash, HEX) ||
    !positive(value.registryRevision) ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.routineEventSequences) ||
    !value.routineEventSequences.every(positive)
  ) {
    throw new StoreError("compaction-evidence-invalid");
  }
  const messageIds = new Set(value.messages.map((record: unknown) => messageProof(record, events)));
  const routineEventSequences = new Set(value.routineEventSequences);
  if (
    messageIds.size !== value.messages.length ||
    routineEventSequences.size !== value.routineEventSequences.length
  ) {
    throw new StoreError("compaction-evidence-duplicate");
  }
  return {
    digest: sha256(canonicalJson(value)),
    selectors: {
      head: { hash: value.head.hash, seq: value.head.seq },
      messageIds,
      registryRevision: value.registryRevision,
      routineEventSequences,
    },
  };
}

function maintainer(context: StoreServiceContext, values: Values) {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, callerOf(values));
  requirePermission(context.layout, roles, actor, "store:maintain");
  return roles;
}

function files(context: StoreServiceContext) {
  const { layout } = context;
  const source = fileAuthority(systemGit(context.env), layout, storePath(layout));
  if (source.kind !== "files") {
    throw new StoreError("compaction-file-authority-required");
  }
  return source;
}

function maintenanceLock<T>(
  context: StoreServiceContext,
  values: Values,
  action: (roles: ReturnType<typeof maintainer>) => T,
): T {
  maintainer(context, values);
  return withLock(context.layout.registryLock, () => action(maintainer(context, values)), {
    readOnly: true,
    timeoutSeconds: 5,
  });
}

function expectedReservation(values: Values): FileJournalReservationRequest {
  const id = required(values, "id");
  const hash = required(values, "head-hash");
  const sequence = required(values, "head-seq");
  const revision = required(values, "registry-revision");
  const seq = Number(sequence);
  const registryRevision = Number(revision);
  if (
    !isCanonicalUuid(id) ||
    !HEX.test(hash) ||
    String(seq) !== sequence ||
    !positive(seq) ||
    String(registryRevision) !== revision ||
    !positive(registryRevision)
  ) {
    throw new StoreError("compaction-reservation-invalid");
  }
  return { head: { hash, seq }, id, registryRevision };
}

function reservationCommand(cancel: boolean): Handler {
  return storeVerb(
    cancel ? "store compaction-cancel" : "store compaction-reserve",
    cancel ? COMPACTION_CANCEL_OPTIONS : COMPACTION_RESERVATION_OPTIONS,
    (context, values) =>
      maintenanceLock(context, values, ({ revision }) => {
        const reservation = expectedReservation(values);
        const { baseline, path } = fileCheckpointJournal(files(context).path);
        if (cancel) {
          const nonce = required(values, "nonce");
          const acquired = { ...reservation, nonce };
          cancelFileJournalReservation(path, acquired, baseline);
          return { ...acquired, reserved: false, schema: 1 };
        }
        if (revision !== reservation.registryRevision) {
          throw new StoreError("compaction-registry-changed");
        }
        return { ...reserveFileJournal(path, reservation, baseline), reserved: true, schema: 1 };
      }),
  );
}

export const compactionReserve = reservationCommand(false);
export const compactionCancel = reservationCommand(true);

function operation(context: StoreServiceContext, values: Values) {
  const { layout } = context;
  const source = files(context);
  const { path, receipt: cutover } = source;
  const excluded = [layout.root, storeRoot(layout)];
  const restored = externalPath(canonicalPath(required(values, "restore")), ...excluded);
  const file = required(values, "receipt");
  externalPath(canonicalPath(file, dirname(file)), ...excluded, restored);
  const proofPath = required(values, "evidence");
  independentRestore(restored);
  if (
    readFileJournalReservation(restored) !== undefined ||
    readFileJournalReservation(fileCheckpointJournal(restored).path) !== undefined
  ) {
    throw new StoreError("compaction-restore-reserved");
  }
  const restoredSource = readFileCheckpointSource(restored);
  const initial = evidence(proofPath, restoredSource.events);
  function scope(): CompactionScope {
    const current = evidence(proofPath, restoredSource.events);
    const { revision, roles } = maintainer(context, values);
    if (current.digest !== initial.digest || current.selectors.registryRevision !== revision) {
      throw new StoreError("compaction-evidence-changed");
    }
    return {
      registeredGames: new Set(Object.keys(layout.config.games)),
      registeredRoles: new Set(Object.keys(roles)),
      registryRevision: revision,
      verifiedEvidence: current.selectors,
    };
  }
  const { head, registryRevision } = initial.selectors;
  return {
    binding: { head, registryRevision },
    cutover,
    file,
    initial,
    path,
    restored,
    restoredSource,
    scope,
  };
}

function receiptMetadata(
  { cutover, initial, restored }: ReturnType<typeof operation>,
  id: string,
  { digest, head }: { readonly digest: string; readonly head: CheckpointHead },
  restoreDigest: string,
  reservation?: FileJournalReservation,
) {
  const metadata = {
    cutoverId: cutover.id,
    digest,
    evidenceDigest: initial.digest,
    head,
    registryRevision: initial.selectors.registryRevision,
    restoreDigest,
    restored,
    schema: 1 as const,
  };
  if (reservation === undefined) {
    return { ...metadata, id };
  }
  const bound = { ...metadata, reservationId: reservation.id, reservationNonce: reservation.nonce };
  return { ...bound, id: uuid5(reservation.nonce, canonicalJson(bound)) };
}

export const compactionPrepare: Handler = storeVerb(
  "store compaction-prepare",
  COMPACTION_PREPARE_OPTIONS,
  (context, values) =>
    maintenanceLock(context, values, () => {
      const input = operation(context, values);
      const { path } = fileCheckpointJournal(input.path);
      if (readFileJournalFence(path) !== undefined) {
        throw new StoreError("compaction-source-already-fenced");
      }
      const id = text(values, "id");
      if (id !== undefined && !isCanonicalUuid(id)) {
        throw new StoreError("compaction-reservation-invalid");
      }
      const current = id === undefined ? undefined : readFileJournalReservation(path);
      if (id !== undefined && current === undefined) {
        throw new StoreError("compaction-reservation-required");
      }
      const reservation =
        id === undefined || current === undefined
          ? undefined
          : { ...input.binding, id, nonce: current.nonce };
      const prepared = prepareFileCheckpoint(
        input.path,
        input.restored,
        input.scope(),
        input.cutover.head,
        reservation,
      );
      input.scope();
      assertFileJournalReservation(path, reservation);
      const record = receiptMetadata(
        input,
        prepared.id,
        prepared.receipt,
        prepared.restoreDigest,
        reservation,
      );
      writeReceipt(input.file, record);
      return record;
    }),
);

export const compactionActivate: Handler = storeVerb(
  "store compaction-activate",
  COMPACTION_ACTIVATE_OPTIONS,
  (context, values) => {
    const id = required(values, "id");
    const approval = required(values, "approval");
    if (!isCanonicalUuid(id) || !reference(approval, REF)) {
      throw new StoreError("compaction-activation-invalid");
    }
    return maintenanceLock(context, values, () => {
      const input = operation(context, values);
      const saved = regularJson(input.file);
      if (!isRecord(saved) || !reference(saved.restoreDigest, HEX)) {
        throw new StoreError("compaction-receipt-invalid");
      }
      const candidate = fileCheckpointCandidate(
        input.restoredSource,
        input.scope(),
        input.cutover.head,
      );
      const { reservationId, reservationNonce } = saved;
      const reservation =
        isCanonicalUuid(reservationId) && isCanonicalUuid(reservationNonce)
          ? { ...input.binding, id: reservationId, nonce: reservationNonce }
          : undefined;
      // Reserved IDs are version 5; legacy prepare issued random version 4 IDs.
      if ((id[14] === "5") !== (reservation !== undefined)) {
        throw new StoreError("compaction-receipt-mismatch");
      }
      const record = receiptMetadata(
        input,
        id,
        candidate.receipt,
        saved.restoreDigest,
        reservation,
      );
      if (id !== record.id || canonicalJson(saved) !== canonicalJson(record)) {
        throw new StoreError("compaction-receipt-mismatch");
      }
      const prepared: PreparedFileCheckpoint = {
        ...candidate,
        id,
        restoreDigest: saved.restoreDigest,
      };
      selectFileCheckpoint(
        input.path,
        input.restored,
        prepared,
        input.scope,
        input.cutover.head,
        reservation,
      );
      return { ...record, approval };
    });
  },
);
