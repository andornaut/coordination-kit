// Explicit filesystem protocol operations use canonical producers and operation-scoped leases.
import { isUtf8 } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs, type ParseArgsConfig } from "node:util";

import { captureAccounting } from "../accounting/boundary.ts";
import { IntakeStore } from "../accounting/intake.ts";
import { LedgerStore } from "../accounting/store.ts";
import type { LedgerRequest } from "../accounting/types.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { type Layout, loadLayout } from "../layout.ts";
import {
  ArtifactPathError,
  assertArtifactOutputPath,
  readPromotableArtifact,
} from "../protocol/artifact-path.ts";
import { ProtocolError, ProtocolStore } from "../protocol/core.ts";
import {
  type EnrollmentContext,
  EnrollmentError,
  type EnrollmentInput,
  EnrollmentStore,
} from "../protocol/enrollment.ts";
import {
  enrollmentRequests,
  enrollmentStatus,
  type EnrollmentWorkerCensus,
  evaluateEnrollmentBoundary,
  PROTOCOL_LIFECYCLE_PHASES,
} from "../protocol/enrollment-runtime.ts";
import {
  checkProtocolLayout,
  declareProtocolWorkspace,
  type ProtocolManagement,
  resolveProtocolLayout,
  resolveProtocolManagement,
  validateProtocolRoot,
  withProtocolLayout,
} from "../protocol/layout.ts";
import { type MessageWriter, type OriginalRef, ProtocolMessages } from "../protocol/messages.ts";
import {
  activateProtocol,
  backupProtocol,
  importProtocolMigration,
  importProtocolOriginals,
  inspectProtocolMigration,
  inventoryProtocol,
  MigrationError,
  ObserverAdoptionError,
  type ObserverAdoptionInput,
  planProtocolMigration,
  recordObserverAdoption,
  restoreProtocol,
} from "../protocol/migration.ts";
import {
  ledgerStorageOptions,
  protocolFailure,
  protocolRole,
  registryRole,
  resolveProtocolBinding,
  runtimeProtocolStore,
} from "../protocol/runtime.ts";
import { enrollSelf } from "../protocol/self-enrollment.ts";
import type { ProtocolClaim } from "../protocol/types.ts";
import { type WorkContext, WorkStore } from "../protocol/work.ts";
import { UnknownRole } from "../registry/resolve.ts";
import { readRegistry } from "../registry/store.ts";
import {
  checkClaim,
  checkEnroll,
  checkMessageObserve,
  checkMessagePublish,
  checkMessageReceipt,
  checkMessageWithdraw,
  checkOriginalRef,
  checkWorkAccept,
  checkWorkPublish,
  checkWorkReceipt,
  checkWorkSubmit,
  type InputCheck,
  type InputIssue,
  type InputRule,
  locateIssue,
} from "./protocol-input.ts";
export const PROTOCOL_ROOT_OPTIONS = { "state-root": { type: "string" } } as const;
export const PROTOCOL_INPUT_OPTIONS = {
  ...PROTOCOL_ROOT_OPTIONS,
  "input-file": { type: "string" },
} as const;
/** Mutating commands take `--capture` to restore automatic accounting capture at the boundary. */
export const PROTOCOL_MUTATING_OPTIONS = {
  ...PROTOCOL_INPUT_OPTIONS,
  capture: { type: "boolean" },
} as const;
export const PROTOCOL_ROLE_OPTIONS = {
  ...PROTOCOL_ROOT_OPTIONS,
  id: { type: "string" },
  role: { type: "string" },
} as const;
export const PROTOCOL_ARTIFACT_OPTIONS = {
  ...PROTOCOL_ROOT_OPTIONS,
  file: { type: "string" },
  hash: { type: "string" },
  "output-file": { type: "string" },
} as const;
export const PROTOCOL_INBOX_OPTIONS = {
  ...PROTOCOL_ROOT_OPTIONS,
  "include-body": { type: "boolean" },
  role: { type: "string" },
  sender: { multiple: true, type: "string" },
} as const;
export const PROTOCOL_INTAKE_OPTIONS = {
  id: { type: "string" },
  owner: { type: "string" },
} as const;
export const PROTOCOL_ENROLL_SELF_OPTIONS = {
  ...PROTOCOL_ROOT_OPTIONS,
  at: { type: "string" },
  "native-id": { type: "string" },
  role: { type: "string" },
} as const;
export const PROTOCOL_BOUNDARY_OPTIONS = {
  capture: { type: "boolean" },
  "work-id": { type: "string" },
  "work-role": { type: "string" },
  worker: { type: "string" },
  ...PROTOCOL_ROOT_OPTIONS,
  at: { type: "string" },
  phase: { type: "string" },
  role: { type: "string" },
} as const;
export const PROTOCOL_PHASES = PROTOCOL_LIFECYCLE_PHASES;
type Phase = (typeof PROTOCOL_PHASES)[number];
type Values = Record<string, string | string[] | boolean | undefined>;
/** The operation step an unexpected failure is reported against. */
type Stage = "input" | "claim-check" | "store-write" | "boundary";
interface Step {
  stage: Stage;
  check: InputCheck | null;
}
class UsageError extends Error {
  readonly location: { readonly path: string; readonly rule: InputRule } | undefined;
  constructor(location?: { readonly path: string; readonly rule: InputRule }) {
    super("invalid-protocol-options");
    this.location = location;
  }
}
/** An input-file envelope failure detected before any store call. */
class InputError extends Error {
  readonly issue: InputIssue;
  constructor(issue: InputIssue) {
    super("invalid-input");
    this.issue = issue;
  }
}
class ProtocolAdmissionError extends Error {
  readonly code:
    | "enrollment-required"
    | "approved-work-required"
    | "essential-evidence-required"
    | "role-guarded";
  readonly location: { readonly path: string; readonly rule: string } | null;
  constructor(
    code:
      | "enrollment-required"
      | "approved-work-required"
      | "essential-evidence-required"
      | "role-guarded",
    location: { readonly path: string; readonly rule: string } | null = null,
  ) {
    super(code);
    this.code = code;
    this.location = location;
  }
}
const ENROLLMENT_CODES = new Set([
  "invalid-enrollment",
  "empty-enrollment",
  "enrollment-roster-required",
  "enrollment-roster-conflict",
  "enrollment-roster-mismatch",
  "enrollment-parent-mismatch",
  "enrollment-ledger-required",
  "enrollment-generation-mismatch",
  "enrollment-registry-mismatch",
  "enrollment-ledger-mismatch",
  "enrollment-binding-mismatch",
  "enrollment-unknown-scope",
  "enrollment-reference-mismatch",
  "enrollment-inspection-time",
  "enrollment-source-changed",
  "enrollment-unavailable",
  "enrollment-caller-unverified",
  "enrollment-claim-required",
]);
function options(spec: NonNullable<ParseArgsConfig["options"]>, args: string[]): Values {
  const parsed = parseArgs({ args, options: spec, strict: true, tokens: true });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind === "option") {
      if (seen.has(token.name) && spec[token.name]?.multiple !== true) {
        throw new UsageError();
      }
      seen.add(token.name);
    }
  }
  const values = parsed.values as Values;
  if (Object.values(values).some((value) => typeof value === "string" && value.trim() === "")) {
    throw new UsageError();
  }
  return values;
}
function required(values: Values, key: string): string {
  const value = values[key];
  if (typeof value !== "string") {
    throw new UsageError();
  }
  return value;
}
function input<T>(io: Io, values: Values): T {
  const data = readFileSync(resolve(io.cwd, required(values, "input-file")));
  if (!isUtf8(data)) {
    throw new UsageError();
  }
  try {
    return JSON.parse(data.toString("utf8")) as T;
  } catch {
    throw new UsageError();
  }
}
const FAILURES = new Set([
  "artifact-corrupt",
  "artifact-missing",
  "binding-changed",
  "binding-unavailable",
  "corrupt-history",
  "duplicate-object",
  "epoch-conflict",
  "invalid-artifact",
  "invalid-claim",
  "invalid-options",
  "invalid-parent",
  "invalid-role",
  "invalid-transaction",
  "invalid-writer",
  "object-conflict",
  "parent-fenced",
  "protocol-busy",
  "stale-revision",
  "stale-time",
  "transaction-conflict",
  "unsafe-path",
  "writer-action-ambiguous",
  "writer-fenced",
  "writer-reentrant",
  "artifact-size-mismatch",
  "definition-mismatch",
  "explicit-replacement-required",
  "invalid-publication",
  "invalid-receipt",
  "invalid-work",
  "no-work-publication",
  "no-worker-submission",
  "parent-publication-required",
  "protocol-unavailable",
  "publication-mismatch",
  "ready-evidence-missing",
  "receipt-exists",
  "receipt-scope-mismatch",
  "receipt-source-mismatch",
  "role-unclaimed",
  "stale-work",
  "submission-changed",
  "submission-publication-mismatch",
  "submission-scope-mismatch",
  "work-missing",
  "work-operation-conflict",
  "worker-scope-mismatch",
  "corrupt-message",
  "invalid-legacy-record",
  "invalid-message",
  "invalid-message-guards",
  "invalid-message-links",
  "invalid-message-read-view",
  "invalid-message-receipt",
  "invalid-message-transport",
  "invalid-message-withdrawal",
  "invalid-original-reference",
  "legacy-original-mismatch",
  "message-command-conflict",
  "message-conflict",
  "message-missing",
  "message-read-view-write-refused",
  "message-recipient-mismatch",
  "message-retention-required",
  "message-sender-mismatch",
  "original-reference-mismatch",
  "invalid-envelope",
  "invalid-worker-target",
  "protocol-not-configured",
  "stale-root",
]);
/** The code a store or runtime error carries, before allowlist mapping. */
function rawCode(error: unknown): string | null {
  const value = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return typeof value === "string" ? value : null;
}
function code(error: unknown): string {
  if (error instanceof MigrationError) {
    return error.code;
  }
  if (error instanceof ArtifactPathError) {
    return error.code;
  }
  if (error instanceof EnrollmentError) {
    return ENROLLMENT_CODES.has(error.code) ? error.code : "enrollment-unavailable";
  }
  if (error instanceof ProtocolAdmissionError) {
    return error.code;
  }
  const configured = protocolFailure(error);
  if (configured !== null) {
    return configured;
  }
  const value = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return typeof value === "string" && FAILURES.has(value) ? value : "protocol-operation-failed";
}
/**
 * Field and stage details for a failure. A store refusal keeps its code and gains the path of the
 * field that violates it; an otherwise unexplained failure on invalid input reports `invalid-input`
 * at the first invalid field; any other unexpected failure keeps the generic code and its stage.
 * Only codes, pointers, rule names and stages are reported, never values or exception messages.
 */
function located(error: unknown, step: Step, mapped: string) {
  if (error instanceof InputError) {
    return { code: "invalid-input", path: error.issue.path, rule: error.issue.rule };
  }
  if (error instanceof ProtocolAdmissionError) {
    return { code: mapped, ...(error.location ?? {}) };
  }
  const check = step.check;
  if (mapped === "protocol-operation-failed") {
    const issue = check?.issues[0];
    return issue === undefined
      ? { code: mapped, stage: step.stage }
      : { code: "invalid-input", path: issue.path, rule: issue.rule };
  }
  const raw = rawCode(error);
  const issue = check === null || raw === null ? undefined : locateIssue(check, raw);
  return { code: mapped, ...(issue === undefined ? {} : { path: issue.path, rule: issue.rule }) };
}
function handler(
  spec: NonNullable<ParseArgsConfig["options"]>,
  action: (io: Io, layout: Layout, values: Values, step: Step) => unknown | Promise<unknown>,
): Handler {
  return async (io, root, args) => {
    let values: Values;
    try {
      values = options(spec, args);
    } catch {
      io.err('{"error":{"code":"invalid-protocol-options"},"ok":false}\n');
      return EXIT_USAGE;
    }
    const step: Step = { check: null, stage: "input" };
    try {
      const result = await action(io, loadLayout(root), values, step);
      io.out(`${JSON.stringify(result)}\n`);
      return EXIT_OK;
    } catch (error) {
      if (error instanceof UsageError) {
        const usage = { error: { code: "invalid-protocol-options", ...error.location }, ok: false };
        io.err(`${JSON.stringify(usage)}\n`);
        return EXIT_USAGE;
      }
      const details = error instanceof MigrationError ? error.details : undefined;
      const { code: reported, ...location } = located(error, step, code(error));
      const failure = {
        error: {
          ...(error instanceof ProtocolError && error.actionMayHaveCommitted
            ? { actionMayHaveCommitted: true }
            : {}),
          ...(error instanceof ObserverAdoptionError
            ? { actionMayHaveCommitted: true, reconcileKey: error.reconcileKey }
            : {}),
          code: reported,
          ...(details === undefined ? {} : { details }),
          ...location,
        },
        ok: false,
      };
      io.err(`${JSON.stringify(failure)}\n`);
      return EXIT_INVALID;
    }
  };
}
/** Parse an input file and record its shape check for error reporting. */
function checked<T>(io: Io, values: Values, step: Step, check: (value: unknown) => InputCheck): T {
  const value = input<unknown>(io, values);
  step.check = check(value);
  return value as T;
}
function selected(layout: Layout, values: Values) {
  const management = resolveProtocolManagement(layout);
  const expected = management.status === "pending" ? null : resolveProtocolLayout(layout);
  const requested =
    typeof values["state-root"] === "string"
      ? validateProtocolRoot(layout, values["state-root"])
      : undefined;
  if (expected !== null) {
    if (requested !== undefined && requested !== expected.stateRoot) {
      throw new ProtocolError("stale-root");
    }
    return { expected, management, root: expected.stateRoot };
  }
  if (requested === undefined) {
    throw new ProtocolError("protocol-not-configured");
  }
  inspectProtocolMigration(layout, requested);
  return { expected, management, root: requested };
}
function store(io: Io, layout: Layout, root: string) {
  const active =
    resolveProtocolManagement(layout).status === "pending"
      ? null
      : runtimeProtocolStore(layout, io);
  if (active !== null) {
    return active;
  }
  return new ProtocolStore({
    directory: root,
    resolveBinding: (role, binding) => resolveProtocolBinding(layout, io, role, binding),
  });
}
function work(protocol: ProtocolStore, layout: Layout, directory?: string) {
  let requests: Map<string, LedgerRequest>;
  try {
    requests = enrollmentRequests(directory ?? ledgerStorageOptions(layout).directory);
  } catch {
    requests = new Map();
  }
  return new WorkStore({ protocol, readRequest: (id) => requests.get(id) });
}
function repairLease(management: ProtocolManagement) {
  return { allowPending: true, expectedManagement: management };
}
function scopeInput(layout: Layout, chosen: ReturnType<typeof selected>) {
  const plan = chosen.expected === null ? inspectProtocolMigration(layout, chosen.root) : null;
  return {
    generation: chosen.expected?.generation ?? 1,
    phase: chosen.expected === null ? ("prepared" as const) : ("active" as const),
    stateRoot: chosen.root,
    workspaceId: chosen.expected?.workspaceId ?? plan!.workspaceId,
  };
}
/** Read only known filesystem publications; unavailable human history remains an explicit gap. */
function boundary(
  layout: Layout,
  protocol: ProtocolStore,
  role: string,
  phase: Phase,
  at: string,
  atPath?: string,
) {
  if (!PROTOCOL_PHASES.includes(phase)) {
    throw new UsageError();
  }
  if (!Number.isFinite(Date.parse(at))) {
    const value: unknown = at;
    const rule = value === undefined ? "required" : typeof value === "string" ? "format" : "type";
    throw new UsageError(atPath === undefined ? undefined : { path: atPath, rule });
  }
  const namespace = protocolRole(layout, role);
  let accounting: unknown;
  let pending: unknown;
  try {
    const storage = ledgerStorageOptions(layout);
    const ledger = new LedgerStore(storage);
    const report = ledger.report({ at, owner: role });
    accounting = {
      coverage: report.coverage,
      coverageState: report.coverageState,
      open: report.open,
      protectedQuestions: report.protectedQuestions,
      revision: report.revision,
      status: "available",
      unassigned: report.unassigned,
      untriaged: report.untriaged,
    };
    pending = new IntakeStore({ directory: join(storage.directory, "intake") })
      .pending(ledger.history(), [role])
      .map((offer) => ({
        commandId: `intake-${offer.id}`,
        id: offer.id,
        requiredOwner: offer.actor,
      }));
  } catch {
    accounting = { status: "unavailable" };
    pending = null;
  }
  const senders = protocol.listRoles({ includeWorkers: true });
  const inbox = new ProtocolMessages({ store: protocol }).inbox({
    includeBody: false,
    recipientRole: namespace,
    senders,
  });
  const report = work(protocol, layout).report({ roles: [namespace] });
  return {
    accounting,
    at,
    inbox,
    pendingIntake: pending,
    phase,
    role,
    scope: { nativeHistory: "not-collected", publishedSenders: senders, roles: [namespace] },
    work: report,
  };
}
async function mutating<T>(
  io: Io,
  layout: Layout,
  values: Values,
  step: Step,
  key: "context" | "writer",
  writer: WorkContext | MessageWriter,
  phase: Phase,
  action: (protocol: ProtocolStore) => Promise<T>,
) {
  const selection = selected(layout, values);
  if (step.check?.fatal) {
    throw new InputError(step.check.fatal);
  }
  step.stage = "claim-check";
  const role = registryRole(writer.role.split("/workers/")[0]!);
  if (selection.expected !== null && values.capture === true) {
    step.stage = "boundary";
    await captureAccounting(
      layout,
      {},
      phase === "startup" || phase === "resume" ? phase : "review",
      "message",
      [role],
    );
  }
  return withProtocolLayout(
    layout,
    selection.expected,
    async () => {
      step.stage = "claim-check";
      const protocol = store(io, layout, selection.root);
      try {
        protocolRole(layout, role);
      } catch (error) {
        if (error instanceof UnknownRole) {
          throw new InputError({ code: "invalid-input", path: `/${key}/role`, rule: "unknown" });
        }
        throw error;
      }
      step.stage = "boundary";
      const before = boundary(layout, protocol, role, phase, writer.at, `/${key}/at`);
      step.stage = "store-write";
      const result = await action(protocol);
      step.stage = "boundary";
      return {
        boundary: { after: boundary(layout, protocol, role, phase, writer.at), before },
        result,
      };
    },
    repairLease(selection.management),
  );
}
export const protocolStatus = handler(PROTOCOL_ROOT_OPTIONS, (_io, layout, values) => {
  const management = resolveProtocolManagement(layout);
  if (management.status === "pending" && values["state-root"] === undefined) {
    return {
      management,
      nextAction: "qualify readers, stage migration and publish enrollment",
      readerUpgradeRequired: true,
      status: "pending",
    };
  }
  const active = management.status === "pending" ? null : resolveProtocolLayout(layout);
  if (active === null && values["state-root"] === undefined) {
    return { legacyCompatibility: true, protocol: null, status: "not-configured" };
  }
  const chosen = selected(layout, values);
  return {
    protocol: { ...active, stateRoot: chosen.root },
    status: active === null ? "prepared" : "active",
  };
});
export const protocolInventory = handler({}, (_io, layout) => inventoryProtocol(layout));
export const protocolDryRun = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  planProtocolMigration(layout, input(io, values)),
);
export const protocolImport = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  importProtocolMigration(layout, input(io, values)),
);
export const protocolImportOriginals = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  importProtocolOriginals(layout, input(io, values)),
);
export const protocolBackup = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  backupProtocol(layout, input(io, values)),
);
export const protocolRestore = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  restoreProtocol(layout, input(io, values)),
);
export const protocolActivate = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  activateProtocol(layout, input(io, values)),
);
export const protocolClaim = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values, step) => {
  const value = checked<ProtocolClaim>(io, values, step, checkClaim);
  const chosen = selected(layout, values);
  return withProtocolLayout(
    layout,
    chosen.expected,
    () => {
      step.stage = "store-write";
      return store(io, layout, chosen.root).claim(value);
    },
    repairLease(chosen.management),
  );
});
export const protocolRoleRead = handler(PROTOCOL_ROLE_OPTIONS, (io, layout, values) => {
  const chosen = selected(layout, values);
  const state = store(io, layout, chosen.root).read(required(values, "role"));
  checkProtocolManagementRead(layout, chosen);
  if (values.id !== undefined) {
    const object = state.objects.find(
      (value) => value.id === required(values, "id") && value.collection === "intake",
    );
    if (
      !object ||
      typeof object.value !== "object" ||
      object.value === null ||
      Array.isArray(object.value) ||
      !("kind" in object.value) ||
      object.value.kind !== "observer-adoption"
    ) {
      throw new UsageError();
    }
    return object;
  }
  return {
    ...state,
    objects: state.objects.map((value) => ({
      collection: value.collection,
      id: value.id,
      revision: value.revision,
    })),
  };
});
export const protocolWorkPublish = handler(
  PROTOCOL_MUTATING_OPTIONS,
  (io, layout, values, step) => {
    const value = checked<{
      context: WorkContext;
      input: Parameters<WorkStore["publish"]>[1];
    }>(io, values, step, checkWorkPublish);
    return mutating(io, layout, values, step, "context", value.context, "before-work", (protocol) =>
      work(protocol, layout, join(selected(layout, values).root, "accounting")).publish(
        value.context,
        value.input,
      ),
    );
  },
);
export const protocolWorkSubmit = handler(PROTOCOL_MUTATING_OPTIONS, (io, layout, values, step) => {
  const value = checked<{
    context: WorkContext;
    input: Parameters<WorkStore["submit"]>[1];
  }>(io, values, step, checkWorkSubmit);
  return mutating(
    io,
    layout,
    values,
    step,
    "context",
    value.context,
    "worker-publication",
    (protocol) => work(protocol, layout).submit(value.context, value.input),
  );
});
export const protocolWorkAccept = handler(PROTOCOL_MUTATING_OPTIONS, (io, layout, values, step) => {
  const value = checked<{
    context: WorkContext;
    input: Parameters<WorkStore["accept"]>[1];
  }>(io, values, step, checkWorkAccept);
  return mutating(io, layout, values, step, "context", value.context, "parent-review", (protocol) =>
    work(protocol, layout).accept(value.context, value.input),
  );
});
export const protocolWorkReceipt = handler(
  PROTOCOL_MUTATING_OPTIONS,
  (io, layout, values, step) => {
    const value = checked<{
      context: WorkContext;
      input: Parameters<WorkStore["receipt"]>[1];
    }>(io, values, step, checkWorkReceipt);
    return mutating(io, layout, values, step, "context", value.context, "integration", (protocol) =>
      work(protocol, layout).receipt(value.context, value.input),
    );
  },
);
export const protocolWorkRead = handler(PROTOCOL_ROLE_OPTIONS, (io, layout, values) => {
  const chosen = selected(layout, values);
  const reader = work(store(io, layout, chosen.root), layout, join(chosen.root, "accounting"));
  const result =
    values.id === undefined
      ? reader.report({ roles: [required(values, "role")] })
      : reader.read(required(values, "role"), required(values, "id"));
  checkProtocolManagementRead(layout, chosen);
  return result;
});
type MessageOperation = "publish" | "receipt" | "withdraw" | "observeTransport";
const MESSAGE_CHECKS: Record<MessageOperation, (value: unknown) => InputCheck> = {
  observeTransport: checkMessageObserve,
  publish: checkMessagePublish,
  receipt: checkMessageReceipt,
  withdraw: checkMessageWithdraw,
};
function message(operation: MessageOperation): Handler {
  return handler(PROTOCOL_MUTATING_OPTIONS, (io, layout, values, step) => {
    const value = checked<{
      writer: MessageWriter;
      input: unknown;
    }>(io, values, step, MESSAGE_CHECKS[operation]);
    return mutating(
      io,
      layout,
      values,
      step,
      "writer",
      value.writer,
      operation === "publish" ? "intake" : "review",
      async (protocol) => {
        const messages = new ProtocolMessages({ store: protocol });
        switch (operation) {
          case "publish":
            return messages.publish(
              value.writer,
              value.input as Parameters<ProtocolMessages["publish"]>[1],
            );
          case "receipt":
            return messages.receipt(
              value.writer,
              value.input as Parameters<ProtocolMessages["receipt"]>[1],
            );
          case "withdraw":
            return messages.withdraw(
              value.writer,
              value.input as Parameters<ProtocolMessages["withdraw"]>[1],
            );
          case "observeTransport":
            return messages.observeTransport(
              value.writer,
              value.input as Parameters<ProtocolMessages["observeTransport"]>[1],
            );
          default:
            throw new UsageError();
        }
      },
    );
  });
}
export const protocolMessagePublish = message("publish");
export const protocolMessageReceipt = message("receipt");
export const protocolMessageWithdraw = message("withdraw");
export const protocolMessageObserve = message("observeTransport");
export const protocolInbox = handler(PROTOCOL_INBOX_OPTIONS, (io, layout, values) => {
  const chosen = selected(layout, values);
  const senders = values.sender;
  if (!Array.isArray(senders) || senders.length === 0) {
    throw new UsageError();
  }
  const result = new ProtocolMessages({ store: store(io, layout, chosen.root) }).inbox({
    includeBody: values["include-body"] === true,
    recipientRole: required(values, "role"),
    senders,
  });
  checkProtocolManagementRead(layout, chosen);
  return result;
});
export const protocolOriginal = handler(
  { ...PROTOCOL_INPUT_OPTIONS, "include-body": { type: "boolean" } },
  (io, layout, values, step) => {
    const chosen = selected(layout, values);
    const reader = new ProtocolMessages({ store: store(io, layout, chosen.root) });
    const reference = checked<OriginalRef>(io, values, step, checkOriginalRef);
    step.stage = "store-write";
    const value = reader.read(reference);
    checkProtocolManagementRead(layout, chosen);
    if (values["include-body"] === true) {
      return value;
    }
    const envelope: Record<string, unknown> = { ...value.envelope };
    delete envelope.body;
    return { ...value, envelope };
  },
);
export const protocolIntake = handler(PROTOCOL_INTAKE_OPTIONS, (_io, layout, values) => {
  const owner = required(values, "owner");
  if (!Object.hasOwn(readRegistry(layout).roles, owner)) {
    throw new UsageError();
  }
  const storage = ledgerStorageOptions(layout);
  const ledger = new LedgerStore(storage);
  const offers = new IntakeStore({ directory: join(storage.directory, "intake") }).pending(
    ledger.history(),
    [owner],
  );
  return {
    offers:
      values.id === undefined
        ? offers
        : offers.filter((offer) => offer.id === required(values, "id")),
    owner,
    status: "available",
  };
});
async function selectedWorkerCensus(
  io: Io,
  layout: Layout,
  protocol: ProtocolStore,
  role: string,
  binding: EnrollmentContext["binding"],
  command: string,
): Promise<EnrollmentWorkerCensus[]> {
  const match = /^(.*)\/workers\/([^/]+)\/([1-9][0-9]*)$/u.exec(role);
  if (!match) {
    return [];
  }
  if (!protocol.listRoles({ includeWorkers: true }).includes(role)) {
    throw new ProtocolError("binding-unavailable");
  }
  const parent = protocol.read(match[1]!);
  const child = protocol.read(role);
  if (
    parent.epoch !== Number(match[3]) ||
    parent.binding === null ||
    !isDeepStrictEqual(child.binding, binding) ||
    !(await resolveProtocolBinding(layout, io, role, binding)) ||
    !isDeepStrictEqual(parent, protocol.read(match[1]!))
  ) {
    throw new ProtocolError("binding-unavailable");
  }
  const evidence = await protocol.putArtifact(
    Buffer.from(
      JSON.stringify({
        binding,
        command,
        parent: parent.binding,
        parentEpoch: parent.epoch,
        role,
        source: "supported-binding-verification",
      }),
    ),
  );
  return [
    {
      evidence,
      parentBinding: parent.binding,
      parentEpoch: parent.epoch,
      parentRole: match[1]!,
      status: "partial",
      workers: [
        { id: binding.nativeId, lineageVerified: true, parentNativeId: parent.binding.nativeId },
      ],
    },
  ];
}
/** Locate why referenced work is not reviewed; diagnostics never replace the admission code. */
function workGap(protocol: ProtocolStore, root: string, values: Values, subject: string) {
  try {
    const requests = enrollmentRequests(join(root, "accounting"));
    const role = typeof values["work-role"] === "string" ? values["work-role"] : subject;
    return new WorkStore({ protocol, readRequest: (id) => requests.get(id) }).authorizationGap(
      role,
      required(values, "work-id"),
    );
  } catch {
    return null;
  }
}
export const protocolBoundary = handler(
  PROTOCOL_BOUNDARY_OPTIONS,
  async (io, layout, values, step) => {
    const chosen = selected(layout, values);
    const role = required(values, "role");
    const phase = required(values, "phase") as Phase;
    if (!PROTOCOL_PHASES.includes(phase)) {
      throw new UsageError();
    }
    step.stage = "boundary";
    if (chosen.expected !== null && values.capture === true) {
      await captureAccounting(
        layout,
        {},
        phase === "startup" || phase === "resume" ? phase : "review",
        "message",
        [role],
      );
    }
    return withProtocolLayout(
      layout,
      chosen.expected,
      async () => {
        const protocol = store(io, layout, chosen.root);
        if (chosen.management.required !== null) {
          const namespace = protocolRole(layout, role);
          let subject = namespace;
          if (values.worker !== undefined) {
            const parent = protocol.read(namespace);
            subject = `${namespace}/workers/${required(values, "worker")}/${parent.epoch}`;
          }
          let census: EnrollmentWorkerCensus[] = [];
          if (values.worker !== undefined) {
            step.stage = "claim-check";
            if (!protocol.listRoles({ includeWorkers: true }).includes(subject)) {
              throw new ProtocolError("binding-unavailable");
            }
            const child = protocol.read(subject);
            if (child.binding === null) {
              throw new ProtocolError("binding-unavailable");
            }
            census = await selectedWorkerCensus(
              io,
              layout,
              protocol,
              subject,
              child.binding,
              `boundary:${phase}:${required(values, "at")}`,
            );
          }
          step.stage = "boundary";
          const checked = evaluateEnrollmentBoundary(layout, protocol, {
            ...scopeInput(layout, chosen),
            boundary: phase,
            census,
            role: subject,
            ...(values["work-id"] === undefined ? {} : { workId: required(values, "work-id") }),
            ...(values["work-role"] === undefined
              ? {}
              : { workRole: required(values, "work-role") }),
          });
          if (!checked.admission.allowed) {
            const reason = checked.admission.reason!;
            throw new ProtocolAdmissionError(
              reason,
              reason === "approved-work-required" && values["work-id"] !== undefined
                ? workGap(protocol, chosen.root, values, subject)
                : null,
            );
          }
          return {
            enrollment: checked,
            ...boundary(layout, protocol, role, phase, required(values, "at")),
          };
        }
        return boundary(layout, protocol, role, phase, required(values, "at"));
      },
      repairLease(chosen.management),
    );
  },
);
export const protocolArtifactPut = handler(
  PROTOCOL_ARTIFACT_OPTIONS,
  (io, layout, values, step) => {
    const chosen = selected(layout, values);
    const raw = required(values, "file");
    const path = raw.startsWith("/") ? raw : `${io.cwd}/${raw}`;
    return withProtocolLayout(
      layout,
      chosen.expected,
      () => {
        const bytes = readPromotableArtifact(path);
        step.stage = "store-write";
        return store(io, layout, chosen.root).putArtifact(bytes);
      },
      repairLease(chosen.management),
    );
  },
);
export const protocolArtifactRead = handler(PROTOCOL_ARTIFACT_OPTIONS, (io, layout, values) => {
  const chosen = selected(layout, values);
  const hash = required(values, "hash");
  const value = store(io, layout, chosen.root).readArtifact(hash);
  checkProtocolManagementRead(layout, chosen);
  const raw = required(values, "output-file");
  const path = assertArtifactOutputPath(raw.startsWith("/") ? raw : `${io.cwd}/${raw}`);
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
  return { hash, size: value.length };
});
function checkProtocolManagementRead(layout: Layout, chosen: ReturnType<typeof selected>) {
  if (JSON.stringify(resolveProtocolManagement(layout)) !== JSON.stringify(chosen.management)) {
    throw new ProtocolError("protocol-generation-conflict");
  }
  if (chosen.management.status !== "pending") {
    checkProtocolLayout(layout, chosen.expected);
  }
}
export const protocolDeclare = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  declareProtocolWorkspace(layout, input(io, values)),
);
export const protocolEnrollmentReport = handler(PROTOCOL_ROOT_OPTIONS, (io, layout, values) => {
  const chosen = selected(layout, values);
  const checked = enrollmentStatus(
    layout,
    store(io, layout, chosen.root),
    scopeInput(layout, chosen),
  );
  checkProtocolManagementRead(layout, chosen);
  return checked;
});
export const protocolEnroll = handler(PROTOCOL_INPUT_OPTIONS, async (io, layout, values, step) => {
  const chosen = selected(layout, values);
  const value = checked<{
    context: EnrollmentContext;
    input: EnrollmentInput;
  }>(io, values, step, checkEnroll);
  if (step.check?.fatal) {
    throw new InputError(step.check.fatal);
  }
  return withProtocolLayout(
    layout,
    chosen.expected,
    async () => {
      step.stage = "claim-check";
      const protocol = store(io, layout, chosen.root);
      const base = scopeInput(layout, chosen);
      const census = await selectedWorkerCensus(
        io,
        layout,
        protocol,
        value.context.role,
        value.context.binding,
        value.context.id,
      );
      // Only the enrolling role's own inputs are rechecked; other roles may enroll concurrently.
      const own = { ...base, census, role: value.context.role };
      step.stage = "boundary";
      const { scope } = enrollmentStatus(layout, protocol, own);
      step.stage = "store-write";
      const event = await new EnrollmentStore({ protocol }).publish(
        value.context,
        value.input,
        scope,
      );
      step.stage = "boundary";
      return { event, ...enrollmentStatus(layout, protocol, own) };
    },
    repairLease(chosen.management),
  );
});
export const protocolEnrollSelf = handler(PROTOCOL_ENROLL_SELF_OPTIONS, (io, layout, values) => {
  const chosen = selected(layout, values);
  const role = required(values, "role");
  const at = required(values, "at");
  if (!Number.isFinite(Date.parse(at))) {
    throw new UsageError();
  }
  return withProtocolLayout(
    layout,
    chosen.expected,
    () =>
      enrollSelf(io, layout, store(io, layout, chosen.root), scopeInput(layout, chosen), {
        at,
        role,
        ...(values["native-id"] === undefined ? {} : { nativeId: required(values, "native-id") }),
      }),
    repairLease(chosen.management),
  );
});
export const protocolObserverAdoption = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) => {
  const chosen = selected(layout, values);
  return recordObserverAdoption(
    layout,
    store(io, layout, chosen.root),
    input<ObserverAdoptionInput>(io, values),
  );
});
