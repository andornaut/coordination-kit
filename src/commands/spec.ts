// Every command's options: the one source for argument parsing and for the help text, so a flag a
// command accepts always appears in `coordination-kit --help`.
import {
  LEDGER_BOUNDARY_OPTIONS,
  LEDGER_COVERAGE_OPTIONS,
  LEDGER_ID_OPTIONS,
  LEDGER_INPUT_OPTIONS,
  LEDGER_REPORT_OPTIONS,
} from "./accounting.ts";
import { DOCTOR_OPTIONS } from "./doctor.ts";
import { GRAPH_INDEX_OPTIONS, GRAPH_OPTIONS, GRAPH_WHY_OPTIONS } from "./graph.ts";
import {
  MESSAGE_DISPATCH_OPTIONS,
  MESSAGE_RECONCILE_OPTIONS,
  MESSAGE_RETIRE_SPOOL_OPTIONS,
  MESSAGE_SEND_OPTIONS,
  MESSAGE_STATUS_OPTIONS,
} from "./messages.ts";
import {
  PROTOCOL_ARTIFACT_OPTIONS,
  PROTOCOL_BOUNDARY_OPTIONS,
  PROTOCOL_ENROLL_SELF_OPTIONS,
  PROTOCOL_INBOX_OPTIONS,
  PROTOCOL_INPUT_OPTIONS,
  PROTOCOL_INTAKE_OPTIONS,
  PROTOCOL_MUTATING_OPTIONS,
  PROTOCOL_PHASES,
  PROTOCOL_ROLE_OPTIONS,
  PROTOCOL_ROOT_OPTIONS,
} from "./protocol.ts";
import {
  DECISION_LIST_OPTIONS,
  HOLD_LIST_OPTIONS,
  HOLD_RELEASE_OPTIONS,
  HOLD_SET_OPTIONS,
  QUESTION_ANSWER_OPTIONS,
  QUESTION_CANCEL_OPTIONS,
  QUESTION_LIST_OPTIONS,
  QUESTION_OPEN_OPTIONS,
} from "./questions.ts";
import {
  EVENTS_FLUSH_OPTIONS,
  EVENTS_INGEST_OPTIONS,
  REVIEW_DELIVER_OPTIONS,
  REVIEW_SHOW_OPTIONS,
} from "./runner.ts";
import { STATUS_OPTIONS } from "./status.ts";
import {
  INBOX_OPTIONS,
  MSG_DONE_OPTIONS,
  MSG_HISTORY_OPTIONS,
  MSG_RETAIN_OPTIONS,
  MSG_SEND_OPTIONS,
  MSG_STATUS_OPTIONS,
  STORE_CUTOVER_OPTIONS,
  STORE_EXPORT_OPTIONS,
  STORE_IMPORT_OPTIONS,
  STORE_REBUILD_OPTIONS,
} from "./store.ts";
import { type CommandSpec, formSynopsis, usageText } from "./usage.ts";
import {
  WORK_BLOCK_OPTIONS,
  WORK_CHECK_OPTIONS,
  WORK_EVIDENCE_OPTIONS,
  WORK_OPTIONS,
  WORK_READ_OPTIONS,
  WORK_START_OPTIONS,
  WORK_WRITE_OPTIONS,
} from "./work.ts";
export type { CommandSpec, Options } from "./usage.ts";
export const BINARY = "coordination-kit";
/** The placeholder each string option shows in help. */
const VALUES: Readonly<Record<string, string>> = {
  at: "ISO_TIMESTAMP",
  body: "TEXT",
  "body-file": "FILE",
  by: "user|ROLE",
  conversation: "UUID",
  disposition: "handled|superseded|retained",
  evidence: "REF",
  "expected-revision": "N",
  from: "ROLE",
  game: "ID",
  harness: "claude|codex|default",
  "history-cursor": "CURSOR",
  id: "SAFE_ID",
  "input-file": "FILE",
  intent: "queue|unblock",
  limit: "N",
  link: "KIND=REF",
  "native-id": "ID",
  "next-boundary": "TEXT",
  "options-file": "FILE",
  owner: "ROLE",
  "owner-role": "ROLE",
  parent: "ROLE|UUID",
  phase: "startup|resume|handoff|review",
  "poll-seconds": "SECONDS",
  "queue-id": "ID",
  reason: "TEXT",
  recipient: "ROLE|UUID",
  "revision-scope": "ledger|records",
  role: "ROLE",
  since: "ISO_TIMESTAMP",
  slot: "ISO_TIMESTAMP",
  snapshot: "UUID",
  "state-dir": "STATE/unblock",
  "superseded-by": "ID",
  supersedes: "D<N>",
  text: "TEXT",
  title: "TEXT",
  to: "ROLE",
  work: "WORK_ID",
  worker: "NAME",
};
/** Help groups, in help order. */
export const GROUPS = {
  decisions: "questions, holds and decisions (owner writes fenced by the registry)",
  graph: "decision graph",
  harness: "harness (claude, codex)",
  inbox: "inbox (recipient)",
  ledger: "request accounting",
  message: "legacy durable role messages",
  msg: "store messages (caller identified by the registry fence)",
  protocol: "explicit filesystem work protocol",
  review: "runner seam (delivery-kit)",
  status: "cross-repository status",
  store: "coordination store maintenance",
  work: "repository work files",
} as const;
export interface GroupedSpec extends CommandSpec {
  readonly group: keyof typeof GROUPS;
}
const GAME = { game: { type: "string" } } as const;
const SCOPE = {
  game: { multiple: true, type: "string" },
  role: { multiple: true, type: "string" },
} as const;
const INBOX = {
  ...GAME,
  parent: { multiple: true, type: "string" },
  recipient: { type: "string" },
} as const;
const READY = {
  forms: [["game?", "role?"]],
  group: "harness",
  options: SCOPE,
  summary:
    "probe whether this harness can deliver now; prints one JSON line, exits 0 when ready, 1 when not",
} as const satisfies GroupedSpec;
/** Commands by their words: a noun group and its verb. */
export const SPECS = {
  "claude channel": {
    forms: [["game?", "conversation?", "state-dir?", "poll-seconds?"]],
    group: "harness",
    options: {
      conversation: { type: "string" },
      game: { multiple: true, type: "string" },
      "poll-seconds": { type: "string" },
      "state-dir": { multiple: true, type: "string" },
    },
    summary: "the stdio server the Claude recipient session starts; delivers the channel spool",
  },
  "claude ready": READY,
  "codex ready": READY,
  "decision list": {
    forms: [["work?", "role?"]],
    group: "decisions",
    options: DECISION_LIST_OPTIONS,
    summary: "list decision records in recording order",
  },
  "events flush": {
    forms: [["game"]],
    group: "review",
    options: EVENTS_FLUSH_OPTIONS,
    summary: "flush the game's event outbox; prints one typed JSON result line",
  },
  "events ingest": {
    forms: [["game"]],
    group: "review",
    options: EVENTS_INGEST_OPTIONS,
    summary:
      "ingest the game's runner event log into the store from its cursor; prints one typed JSON result line",
  },
  graph: {
    forms: [["work?", "depth?", "format?"]],
    group: "graph",
    options: GRAPH_OPTIONS,
    summary: "print the decision graph, or one work item's neighbourhood, as JSON or DOT",
    values: { depth: "N", format: "json|dot", work: "[REPOSITORY:]WORK_ID" },
  },
  "graph index": {
    forms: [[]],
    group: "graph",
    options: GRAPH_INDEX_OPTIONS,
    summary: "rebuild the derived edges index from the registered repositories and the store",
  },
  "graph why": {
    forms: [["decision"]],
    group: "graph",
    options: GRAPH_WHY_OPTIONS,
    summary: "print a decision's supersedes chain with each item's approval reference",
    values: { decision: "[REPOSITORY:]WORK_ID/Dn" },
  },
  "harness doctor": {
    forms: [["game", "role?"], ["role"]],
    group: "harness",
    options: DOCTOR_OPTIONS,
    summary: "diagnose explicitly selected roles without sending or activating",
  },
  "harness ready": {
    forms: [["game?", "role?"]],
    group: "harness",
    options: SCOPE,
    summary: "probe each selected role's effective harness without sending or activating",
  },
  "harness select": {
    forms: [
      ["harness", "expected-revision", "game", "role?"],
      ["harness", "expected-revision", "role"],
    ],
    group: "harness",
    options: {
      ...SCOPE,
      "expected-revision": { type: "string" },
      harness: { type: "string" },
    },
    summary: "atomically select harness overrides for an explicit scope without activating roles",
  },
  "hold list": {
    forms: [["role?", "state?"]],
    group: "decisions",
    options: HOLD_LIST_OPTIONS,
    summary: "list holds in setting order",
    values: { state: "active|released" },
  },
  "hold release": {
    forms: [["id", "native-id?", "worker?"]],
    group: "decisions",
    options: HOLD_RELEASE_OPTIONS,
    summary: "release your own hold",
  },
  "hold set": {
    forms: [["id", "scope", "reason", "native-id?", "worker?"]],
    group: "decisions",
    options: HOLD_SET_OPTIONS,
    summary: "set a hold owned by your role",
    values: { scope: "work:WORK_ID|role|game:ID" },
  },
  inbox: {
    forms: [["include-body?", "all?", "native-id?", "worker?"]],
    group: "msg",
    options: INBOX_OPTIONS,
    summary: "list your undelivered and open store messages and record them delivered",
  },
  "inbox ack": {
    forms: [["game", "snapshot", "queue-id", "disposition", "reason?", "recipient?", "parent?"]],
    group: "inbox",
    options: {
      ...INBOX,
      disposition: { type: "string" },
      "queue-id": { multiple: true, type: "string" },
      reason: { type: "string" },
      snapshot: { type: "string" },
    },
    summary: "acknowledge inbox queue items from a snapshot",
  },
  "inbox snapshot": {
    forms: [["game", "recipient?", "parent?", "history-cursor?", "capture?"]],
    group: "inbox",
    options: { ...INBOX, capture: { type: "boolean" }, "history-cursor": { type: "string" } },
    summary: "capture the recipient's inbox snapshot",
  },
  "ledger apply": {
    forms: [["input-file", "revision-scope?"]],
    group: "ledger",
    options: LEDGER_INPUT_OPTIONS,
    summary: "apply one explicit revision-checked request accounting transaction",
  },
  "ledger boundary": {
    forms: [["role", "phase"]],
    group: "ledger",
    options: LEDGER_BOUNDARY_OPTIONS,
    summary: "capture a scoped accounting boundary and report independent readiness",
  },
  "ledger coverage": {
    forms: [["owner?"]],
    group: "ledger",
    options: LEDGER_COVERAGE_OPTIONS,
    summary: "show declared accounting coverage and gaps",
  },
  "ledger history": {
    forms: [["id"]],
    group: "ledger",
    options: LEDGER_ID_OPTIONS,
    summary: "show immutable request accounting transitions",
  },
  "ledger intake": {
    forms: [["input-file", "revision-scope?"]],
    group: "ledger",
    options: LEDGER_INPUT_OPTIONS,
    summary: "register a request with explicit provenance and revision",
  },
  "ledger reconcile": {
    forms: [["input-file", "revision-scope?"]],
    group: "ledger",
    options: LEDGER_INPUT_OPTIONS,
    summary: "record an explicit accounting reconciliation transaction",
  },
  "ledger report": {
    forms: [["at", "owner?"]],
    group: "ledger",
    options: LEDGER_REPORT_OPTIONS,
    summary: "report accounting state at an explicit cutoff",
  },
  "ledger show": {
    forms: [["id"]],
    group: "ledger",
    options: LEDGER_ID_OPTIONS,
    summary: "show one current request accounting record",
  },
  "message dispatch": {
    forms: [["id"]],
    group: "message",
    options: MESSAGE_DISPATCH_OPTIONS,
    summary: "explicitly attempt guarded delivery of a stored message",
    values: { id: "UUID" },
  },
  "message reconcile": {
    forms: [
      ["id", "receipt"],
      [
        "id",
        "expected-revision",
        "disposition",
        "evidence",
        "reason?",
        "owner-role?",
        "next-boundary?",
      ],
    ],
    group: "message",
    options: MESSAGE_RECONCILE_OPTIONS,
    summary: "reconcile exact receipt or explicit handling and retention evidence",
    values: { disposition: "accepted|handled|superseded|retained", id: "UUID" },
  },
  "message retire-spool": {
    forms: [["recipient", "dry-run?"]],
    group: "message",
    options: MESSAGE_RETIRE_SPOOL_OPTIONS,
    summary: "move Claude spool entries of handled or superseded messages to claude-retired",
  },
  "message send": {
    forms: [["from", "recipient", "id", "body-file", "intent?", "parent?", "capture?"]],
    group: "message",
    options: MESSAGE_SEND_OPTIONS,
    summary: "store an exact message locally without waking a recipient",
    values: { id: "UUID", parent: "ROLE" },
  },
  "message status": {
    forms: [
      ["id", "include-body?", "include-retention?"],
      ["recipient", "include-body?", "include-retention?"],
    ],
    group: "message",
    options: MESSAGE_STATUS_OPTIONS,
    summary: "read local message metadata or the exact original body",
    values: { id: "UUID", recipient: "ROLE" },
  },
  "msg done": {
    forms: [["ID", "work?", "superseded-by?", "evidence?", "native-id?", "worker?"]],
    group: "msg",
    options: MSG_DONE_OPTIONS,
    summary: "close your own message as handled, or superseded with --superseded-by, in one write",
  },
  "msg history": {
    forms: [
      ["role?", "since?", "limit?"],
      ["include-body", "role?", "since?", "limit?", "native-id?", "worker?"],
    ],
    group: "msg",
    options: MSG_HISTORY_OPTIONS,
    summary:
      "read message events in order; bodies only with --include-body, to their sender, recipient or game-coordinator",
  },
  "msg retain": {
    forms: [["ID", "reason", "next-boundary", "owner?", "native-id?", "worker?"]],
    group: "msg",
    options: MSG_RETAIN_OPTIONS,
    summary: "retain your own open message with an owner, reason and next review boundary",
  },
  "msg send": {
    forms: [
      ["to", "body-file", "intent?", "id?", "link?", "native-id?", "worker?"],
      ["to", "body", "intent?", "id?", "link?", "native-id?", "worker?"],
    ],
    group: "msg",
    options: MSG_SEND_OPTIONS,
    summary: "store a message, then attempt one guarded wake of the recipient",
    values: { id: "UUID" },
  },
  "msg status": {
    forms: [["ID"]],
    group: "msg",
    options: MSG_STATUS_OPTIONS,
    summary: "read one store message's metadata",
  },
  "protocol activate": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol activate operation; no native delivery or owner activation",
  },
  "protocol artifact-put": {
    forms: [["file", "hash?", "output-file?", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_ARTIFACT_OPTIONS,
    summary: "Explicit protocol artifact-put operation; no native delivery or owner activation",
  },
  "protocol artifact-read": {
    forms: [["hash", "output-file", "file?", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_ARTIFACT_OPTIONS,
    summary: "Explicit protocol artifact-read operation; no native delivery or owner activation",
  },
  "protocol backup": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol backup operation; no native delivery or owner activation",
  },
  "protocol boundary": {
    forms: [
      ["role", "phase", "at", "work-id?", "work-role?", "worker?", "state-root?", "capture?"],
    ],
    group: "protocol",
    options: PROTOCOL_BOUNDARY_OPTIONS,
    summary: "Explicit protocol boundary operation; no native delivery or owner activation",
    values: { phase: PROTOCOL_PHASES.join("|") },
  },
  "protocol claim": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol claim operation; no native delivery or owner activation",
  },
  "protocol declare": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "declare supported canonical protocol evidence; no provider activation",
  },
  "protocol dry-run": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol dry-run operation; no native delivery or owner activation",
  },
  "protocol enroll": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "enroll supported canonical protocol evidence; no provider activation",
  },
  "protocol enroll-self": {
    forms: [["role", "at", "native-id?", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_ENROLL_SELF_OPTIONS,
    summary:
      "enroll the caller's own registered role from its journal, binding and canonical references",
    values: { "native-id": "ID" },
  },
  "protocol enrollment-report": {
    forms: [["state-root?"]],
    group: "protocol",
    options: PROTOCOL_ROOT_OPTIONS,
    summary: "enrollment-report supported canonical protocol evidence; no provider activation",
  },
  "protocol import": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol import operation; no native delivery or owner activation",
  },
  "protocol import-originals": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol import-originals operation; no native delivery or owner activation",
  },
  "protocol inbox": {
    forms: [["role", "sender", "include-body?", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INBOX_OPTIONS,
    summary: "Explicit protocol inbox operation; no native delivery or owner activation",
  },
  "protocol intake": {
    forms: [["owner", "id?"]],
    group: "protocol",
    options: PROTOCOL_INTAKE_OPTIONS,
    summary: "Explicit protocol intake operation; no native delivery or owner activation",
  },
  "protocol inventory": {
    forms: [[]],
    group: "protocol",
    options: {},
    summary: "Explicit protocol inventory operation; no native delivery or owner activation",
  },
  "protocol message-observe": {
    forms: [["input-file", "state-root?", "capture?"]],
    group: "protocol",
    options: PROTOCOL_MUTATING_OPTIONS,
    summary: "Explicit protocol message-observe operation; no native delivery or owner activation",
  },
  "protocol message-original": {
    forms: [["input-file", "include-body?", "state-root?"]],
    group: "protocol",
    options: { ...PROTOCOL_INPUT_OPTIONS, "include-body": { type: "boolean" } },
    summary: "Explicit protocol message-original operation; no native delivery or owner activation",
  },
  "protocol message-publish": {
    forms: [["input-file", "state-root?", "capture?"]],
    group: "protocol",
    options: PROTOCOL_MUTATING_OPTIONS,
    summary: "Explicit protocol message-publish operation; no native delivery or owner activation",
  },
  "protocol message-receipt": {
    forms: [["input-file", "state-root?", "capture?"]],
    group: "protocol",
    options: PROTOCOL_MUTATING_OPTIONS,
    summary: "Explicit protocol message-receipt operation; no native delivery or owner activation",
  },
  "protocol message-withdraw": {
    forms: [["input-file", "state-root?", "capture?"]],
    group: "protocol",
    options: PROTOCOL_MUTATING_OPTIONS,
    summary: "Explicit protocol message-withdraw operation; no native delivery or owner activation",
  },
  "protocol observer-adoption": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "observer-adoption supported canonical protocol evidence; no provider activation",
  },
  "protocol restore": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol restore operation; no native delivery or owner activation",
  },
  "protocol role": {
    forms: [["role", "id?", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_ROLE_OPTIONS,
    summary: "Explicit protocol role operation; no native delivery or owner activation",
  },
  "protocol status": {
    forms: [["state-root?"]],
    group: "protocol",
    options: PROTOCOL_ROOT_OPTIONS,
    summary: "Explicit protocol status operation; no native delivery or owner activation",
  },
  "protocol work-accept": {
    forms: [["input-file", "state-root?", "capture?"]],
    group: "protocol",
    options: PROTOCOL_MUTATING_OPTIONS,
    summary: "Explicit protocol work-accept operation; no native delivery or owner activation",
  },
  "protocol work-publish": {
    forms: [["input-file", "state-root?", "capture?"]],
    group: "protocol",
    options: PROTOCOL_MUTATING_OPTIONS,
    summary: "Explicit protocol work-publish operation; no native delivery or owner activation",
  },
  "protocol work-read": {
    forms: [["role", "id?", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_ROLE_OPTIONS,
    summary: "Explicit protocol work-read operation; no native delivery or owner activation",
  },
  "protocol work-receipt": {
    forms: [["input-file", "state-root?", "capture?"]],
    group: "protocol",
    options: PROTOCOL_MUTATING_OPTIONS,
    summary: "Explicit protocol work-receipt operation; no native delivery or owner activation",
  },
  "protocol work-submit": {
    forms: [["input-file", "state-root?", "capture?"]],
    group: "protocol",
    options: PROTOCOL_MUTATING_OPTIONS,
    summary: "Explicit protocol work-submit operation; no native delivery or owner activation",
  },
  "question answer": {
    forms: [["id", "work", "text", "by?", "supersedes?", "native-id?", "worker?"]],
    group: "decisions",
    options: QUESTION_ANSWER_OPTIONS,
    summary:
      "close your own question with a decision record and append its line, unstaged, to the work file on main",
  },
  "question cancel": {
    forms: [["id", "reason", "native-id?", "worker?"]],
    group: "decisions",
    options: QUESTION_CANCEL_OPTIONS,
    summary: "cancel your own pending question",
  },
  "question list": {
    forms: [["role?", "state?"]],
    group: "decisions",
    options: QUESTION_LIST_OPTIONS,
    summary: "list questions in opening order",
    values: { state: "pending|answered|cancelled" },
  },
  "question open": {
    forms: [["title", "id?", "work?", "options-file?", "native-id?", "worker?"]],
    group: "decisions",
    options: QUESTION_OPEN_OPTIONS,
    summary: "record a pending prompt owned by your role; the ID defaults to q-<role>-<n>",
  },
  "review deliver": {
    forms: [["game", "slot", "capture?"]],
    group: "review",
    options: REVIEW_DELIVER_OPTIONS,
    summary: "deliver the scheduled review for one slot once; prints one typed JSON result line",
  },
  "review show": {
    forms: [["game?", "slot?"]],
    group: "review",
    options: REVIEW_SHOW_OPTIONS,
    summary: "print a stored review brief's full record: the slot's, else the latest",
  },
  status: {
    forms: [["scope?", "since?", "state?", "audit?", "verify-since?", "format?"]],
    group: "status",
    options: STATUS_OPTIONS,
    summary:
      "read-only status of each registered repository's work items with protocol, ledger and delivery evidence",
    values: {
      format: "json|markdown",
      scope: "all|GAME|KIT|ROLE",
      since: "ISO_TIMESTAMP",
      state: "STATE",
      "verify-since": "ISO_TIMESTAMP",
    },
  },
  "store cutover": {
    forms: [["dry-run"], ["apply", "native-id?", "worker?"]],
    group: "store",
    options: STORE_CUTOVER_OPTIONS,
    summary:
      "switch to the store: fence legacy writers, import, record the cutover and wake; --dry-run writes nothing",
  },
  "store export": {
    forms: [["since"]],
    group: "store",
    options: STORE_EXPORT_OPTIONS,
    summary: "list sends, closes and retentions recorded after a time, for rollback re-recording",
  },
  "store import": {
    forms: [
      ["from-legacy", "dry-run?", "native-id?", "worker?"],
      ["approval-ledger", "dry-run?", "native-id?", "worker?"],
    ],
    group: "store",
    options: STORE_IMPORT_OPTIONS,
    summary:
      "import the legacy message stores, or map the approval ledger to work records; --dry-run writes nothing",
    values: { "approval-ledger": "FILE" },
  },
  "store rebuild": {
    forms: [[]],
    group: "store",
    options: STORE_REBUILD_OPTIONS,
    summary: "verify the event hash chain and recreate every projection from the events",
  },
  "work block": {
    forms: [["ID", "reason", "owner?", "native-id?", "worker?"]],
    group: "work",
    options: WORK_BLOCK_OPTIONS,
    summary: "record your work item blocked, with a reason and the role that can clear it",
  },
  "work check": {
    forms: [["decisions?"]],
    group: "work",
    options: WORK_CHECK_OPTIONS,
    summary:
      "validate docs/design index tables and docs/work front matter in the --root repository",
  },
  "work evidence": {
    forms: [["ID", "stage", "sha", "ref?", "native-id?", "worker?"]],
    group: "work",
    options: WORK_EVIDENCE_OPTIONS,
    summary: "record a stage commit of your work item, with an optional reference",
    values: {
      ref: "REF",
      sha: "SHA",
      stage: "implemented|merged|verified|published|deployed",
    },
  },
  "work finish": {
    forms: [["ID", "native-id?", "worker?"]],
    group: "work",
    options: WORK_WRITE_OPTIONS,
    summary: "record your work item finished; its work file must be done on main",
  },
  "work history": {
    forms: [["ID"]],
    group: "work",
    options: WORK_READ_OPTIONS,
    summary: "print a work item's store events in order",
  },
  "work ready": {
    forms: [["ID", "native-id?", "worker?"]],
    group: "work",
    options: WORK_WRITE_OPTIONS,
    summary: "record your started work item ready for integration",
  },
  "work report": {
    forms: [[]],
    group: "work",
    options: WORK_OPTIONS,
    summary: "print each work item's milestone, with live protocol state when a coordinator is set",
  },
  "work show": {
    forms: [["ID"]],
    group: "work",
    options: WORK_READ_OPTIONS,
    summary: "print a work item's owner, work-file status, store record and covering holds",
  },
  "work start": {
    forms: [["ID", "parent?", "native-id?", "worker?"]],
    group: "work",
    options: WORK_START_OPTIONS,
    summary: "start your work item: approved on main and not held; --parent links a parent item",
    values: { parent: "REPOSITORY:WORK_ID" },
  },
  "work unblock": {
    forms: [["ID", "native-id?", "worker?"]],
    group: "work",
    options: WORK_WRITE_OPTIONS,
    summary: "clear your work item's open block",
  },
} as const satisfies Readonly<Record<string, GroupedSpec>>;
export type Command = keyof typeof SPECS;
/** One `coordination-kit COMMAND ...` line per accepted form. */
export function synopsis(command: Command): string[] {
  return formSynopsis(VALUES, command, SPECS[command]);
}
/** The usage line a command prints with a usage error. */
export function commandUsage(command: Command): string {
  return usageText(BINARY, synopsis(command));
}
