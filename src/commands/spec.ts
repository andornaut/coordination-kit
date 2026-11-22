// Every command's options: the one source for argument parsing and for the help text, so a flag a
// command accepts always appears in `coordination-kit --help`.
import { DOCTOR_OPTIONS } from "./doctor.ts";
import { GRAPH_INDEX_OPTIONS, GRAPH_OPTIONS, GRAPH_WHY_OPTIONS } from "./graph.ts";
import {
  MIGRATION_ACTIVATE_OPTIONS,
  MIGRATION_PREPARE_OPTIONS,
  MIGRATION_STATUS_OPTIONS,
} from "./migration.ts";
import {
  DECISION_LIST_OPTIONS,
  HOLD_LIST_OPTIONS,
  HOLD_RELEASE_OPTIONS,
  HOLD_SET_OPTIONS,
  POLICY_HOLD_RELEASE_OPTIONS,
  POLICY_HOLD_SET_OPTIONS,
  QUESTION_ANSWER_OPTIONS,
  QUESTION_ATTACH_OPTIONS,
  QUESTION_CANCEL_OPTIONS,
  QUESTION_LIST_OPTIONS,
  QUESTION_OPEN_OPTIONS,
  QUESTION_PROJECT_OPTIONS,
} from "./questions.ts";
import {
  REMINDER_CHECK_OPTIONS,
  REMINDER_CLAIM_OPTIONS,
  REMINDER_LIST_OPTIONS,
  REMINDER_SETTLE_OPTIONS,
} from "./reminders.ts";
import { REQUEST_CLOSE_OPTIONS } from "./requests.ts";
import { EVENTS_INGEST_OPTIONS, REVIEW_DELIVER_OPTIONS, REVIEW_SHOW_OPTIONS } from "./runner.ts";
import {
  HANDOFF_OPEN_OPTIONS,
  HANDOFF_ROLE_OPTIONS,
  HANDOFF_SHOW_OPTIONS,
  HANDOFF_STATE_OPTIONS,
  SESSION_START_OPTIONS,
} from "./session.ts";
import { STATUS_OPTIONS } from "./status.ts";
import {
  INBOX_OPTIONS,
  MSG_DONE_OPTIONS,
  MSG_HISTORY_OPTIONS,
  MSG_RETAIN_OPTIONS,
  MSG_SEND_OPTIONS,
  MSG_STATUS_OPTIONS,
  STORE_COMPACTION_PLAN_OPTIONS,
  STORE_EXPORT_OPTIONS,
  STORE_IMPORT_OPTIONS,
  STORE_REBUILD_OPTIONS,
  STORE_RETIRE_OPTIONS,
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
  approval: "REF",
  at: "ISO_TIMESTAMP",
  body: "TEXT",
  "body-file": "FILE",
  by: "user|ROLE",
  conversation: "UUID",
  "depends-on": "REPOSITORY:WORK_ID",
  evidence: "REF",
  "expected-revision": "N",
  game: "ID",
  harness: "claude|codex|default",
  id: "SAFE_ID",
  intent: "queue|unblock",
  limit: "N",
  link: "KIND=REF",
  "native-id": "ID",
  "next-boundary": "TEXT",
  option: "LABEL",
  "option-json": "JSON",
  owner: "ROLE",
  parent: "ROLE|UUID",
  "poll-seconds": "SECONDS",
  reason: "TEXT",
  role: "ROLE",
  since: "ISO_TIMESTAMP",
  slot: "ISO_TIMESTAMP",
  "superseded-by": "ID",
  supersedes: "D<N>",
  text: "TEXT",
  title: "TEXT",
  to: "ROLE",
  work: "WORK_ID",
  worker: "NAME",
};
/** Help groups, in help order. */
/* eslint-disable sort-keys -- Group order is the public help order. */
export const GROUPS = {
  msg: "store messages (caller identified by the registry fence)",
  store: "coordination store maintenance",
  decisions: "questions, holds and decisions (owner writes fenced by the registry)",
  session: "sessions and harness handoffs (writes fenced by the registry)",
  reminder: "coordination reminder ledger",
  request: "imported requests (owner closes, fenced by the registry)",
  harness: "harness (claude, codex)",
  review: "runner seam (delivery-kit)",
  status: "cross-repository status",
  work: "repository work files",
  graph: "decision graph",
} as const;
/* eslint-enable sort-keys */
export interface GroupedSpec extends CommandSpec {
  readonly group: keyof typeof GROUPS;
}
const SCOPE = {
  game: { multiple: true, type: "string" },
  role: { multiple: true, type: "string" },
} as const;
const READY = {
  forms: [["game?", "role?"]],
  group: "harness",
  options: SCOPE,
  summary:
    "probe whether this harness can deliver now; prints one JSON line, exits 0 when ready, 1 when not",
} as const satisfies GroupedSpec;
/** Commands by their words: a noun group and its verb. */
/* eslint-disable sort-keys -- Specification order is the public command help order. */
export const SPECS = {
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
  inbox: {
    forms: [
      ["include-body?", "all?", "native-id?", "worker?"],
      ["peek", "native-id?", "worker?"],
    ],
    group: "msg",
    options: INBOX_OPTIONS,
    summary: "collect messages, or list unread metadata with --peek without recording delivery",
  },
  "msg done": {
    forms: [["ID", "work?", "superseded-by?", "evidence?", "native-id?", "worker?"]],
    group: "msg",
    options: MSG_DONE_OPTIONS,
    summary: "close your own message as handled, or superseded with --superseded-by, in one write",
  },
  "msg retain": {
    forms: [
      ["ID", "reason", "next-boundary", "owner?", "native-id?", "worker?"],
      ["ID", "reason", "until", "owner?", "native-id?", "worker?"],
      ["ID", "reason", "next-review", "owner?", "native-id?", "worker?"],
    ],
    group: "msg",
    options: MSG_RETAIN_OPTIONS,
    summary: "retain your own open message with an owner, reason and next review boundary",
    values: { until: "ISO_TIMESTAMP" },
  },
  "msg status": {
    forms: [["ID"], ["ID", "include-body", "native-id?", "worker?"]],
    group: "msg",
    options: MSG_STATUS_OPTIONS,
    summary:
      "read exact message and wake metadata, or include its body as sender, recipient or game-coordinator",
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
  "store import": {
    forms: [["approval-ledger", "dry-run?", "native-id?", "worker?"]],
    group: "store",
    options: STORE_IMPORT_OPTIONS,
    summary: "map the approval ledger to work records; --dry-run writes nothing",
    values: { "approval-ledger": "FILE" },
  },
  "store export": {
    forms: [["since"]],
    group: "store",
    options: STORE_EXPORT_OPTIONS,
    summary: "list sends, closes and retentions recorded after a time, for rollback re-recording",
  },
  "store rebuild": {
    forms: [[]],
    group: "store",
    options: STORE_REBUILD_OPTIONS,
    summary: "verify the event hash chain and recreate every projection from the events",
  },
  "store compaction-plan": {
    forms: [[]],
    group: "store",
    options: STORE_COMPACTION_PLAN_OPTIONS,
    summary:
      "report filesystem history windows, measured bytes and protected records without writing",
  },
  "store retire": {
    forms: [["dry-run"], ["apply", "native-id?", "worker?"]],
    group: "store",
    options: STORE_RETIRE_OPTIONS,
    summary:
      "import open ledger requests and archive the retired protocol state; --dry-run writes nothing",
  },
  "store migration-status": {
    forms: [[]],
    group: "store",
    options: MIGRATION_STATUS_OPTIONS,
    summary: "read the current authority and any prepared or pending cutover receipt",
  },
  "store migration-prepare": {
    forms: [["backup", "restore", "native-id?"]],
    group: "store",
    options: MIGRATION_PREPARE_OPTIONS,
    summary: "compare the candidate against an independently restored SQLite backup",
    values: { backup: "ABSOLUTE_FILE", restore: "ABSOLUTE_FILE" },
  },
  "store migration-activate": {
    forms: [["id", "native-id?"]],
    group: "store",
    options: MIGRATION_ACTIVATE_OPTIONS,
    summary: "freeze the legacy source and select the exact verified file candidate",
    values: { id: "RECEIPT_ID" },
  },
  "question open": {
    forms: [
      ["title", "id?", "work?", "option?", "depends-on?", "native-id?", "worker?"],
      ["title", "id?", "work?", "option-json", "depends-on?", "native-id?", "worker?"],
    ],
    group: "decisions",
    options: QUESTION_OPEN_OPTIONS,
    summary: "record a pending prompt owned by your role; the ID defaults to q-<role>-<n>",
  },
  "question attach": {
    forms: [["id", "turn", "item", "index", "native-id?"]],
    group: "decisions",
    options: QUESTION_ATTACH_OPTIONS,
    summary: "attach exact rendered Codex question identity for your recorded question",
    values: { index: "N", item: "ID", turn: "ID" },
  },
  "question reconcile": {
    forms: [["id", "native-id?"]],
    group: "decisions",
    options: QUESTION_PROJECT_OPTIONS,
    summary: "read exact Codex question evidence and native form capability",
  },
  "question reask": {
    forms: [["id", "native-id?"]],
    group: "decisions",
    options: QUESTION_PROJECT_OPTIONS,
    summary: "prepare the same recorded question after verified native closure without an answer",
  },
  "question answer": {
    forms: [["id", "work", "text", "by?", "supersedes?", "native-id?", "worker?"]],
    group: "decisions",
    options: QUESTION_ANSWER_OPTIONS,
    summary: "record your own question's answer, then attempt the Markdown writeback on main",
  },
  "question project": {
    forms: [["id", "native-id?", "worker?"]],
    group: "decisions",
    options: QUESTION_PROJECT_OPTIONS,
    summary: "retry the Markdown writeback for your recorded answer",
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
  "hold set": {
    forms: [["id", "scope", "reason", "native-id?", "worker?"]],
    group: "decisions",
    options: HOLD_SET_OPTIONS,
    summary: "set a hold owned by your role",
    values: { scope: "work:WORK_ID|role|game:ID" },
  },
  "hold policy-set": {
    forms: [["id", "scope", "reason", "approval", "native-id?"]],
    group: "decisions",
    options: POLICY_HOLD_SET_OPTIONS,
    summary: "record an explicit user policy hold as game-coordinator",
    values: { scope: "role:ROLE|game:GAME|work:REPOSITORY:WORK_ID" },
  },
  "hold policy-release": {
    forms: [["id", "approval", "native-id?"]],
    group: "decisions",
    options: POLICY_HOLD_RELEASE_OPTIONS,
    summary: "release an exact coordinator-issued user policy hold",
  },
  "hold release": {
    forms: [["id", "native-id?", "worker?"]],
    group: "decisions",
    options: HOLD_RELEASE_OPTIONS,
    summary: "release your own hold",
  },
  "hold list": {
    forms: [["role?", "state?"]],
    group: "decisions",
    options: HOLD_LIST_OPTIONS,
    summary: "list holds in setting order",
    values: { state: "active|released" },
  },
  "decision list": {
    forms: [["work?", "role?"]],
    group: "decisions",
    options: DECISION_LIST_OPTIONS,
    summary: "list decision records in recording order",
  },
  "session start": {
    forms: [["native-id?", "worker?"]],
    group: "session",
    options: SESSION_START_OPTIONS,
    summary: "record your session start and print your binding, checkpoint and open counts",
  },
  "handoff open": {
    forms: [["scope", "to", "id?", "native-id?", "worker?"]],
    group: "session",
    options: HANDOFF_OPEN_OPTIONS,
    summary: "open a handoff for roles or all (game-coordinator only)",
    values: { id: "ID", scope: "ROLE|all", to: "claude|codex" },
  },
  "handoff ready": {
    forms: [["id?", "native-id?", "worker?"]],
    group: "session",
    options: HANDOFF_ROLE_OPTIONS,
    summary: "record your role ready from its source binding and set its handoff hold",
  },
  "handoff state": {
    forms: [["STATE", "id", "native-id?", "worker?"]],
    group: "session",
    options: HANDOFF_STATE_OPTIONS,
    summary: "move a handoff to prepared, sent, completed or cancelled (game-coordinator only)",
    values: { id: "ID" },
  },
  "handoff active": {
    forms: [["id?", "native-id?", "worker?"]],
    group: "session",
    options: HANDOFF_ROLE_OPTIONS,
    summary: "record your role active from its target binding and release its handoff hold",
  },
  "handoff show": {
    forms: [["id?"]],
    group: "session",
    options: HANDOFF_SHOW_OPTIONS,
    summary: "print a handoff, else the latest, with per-role times and its holds",
    values: { id: "ID" },
  },
  "reminder check": {
    forms: [["id", "native-id?"]],
    group: "reminder",
    options: REMINDER_CHECK_OPTIONS,
    summary: "verify an unsettled claim and its exact idle Codex recipient",
  },
  "reminder claim": {
    forms: [["role", "original", "native-id?"]],
    group: "reminder",
    options: REMINDER_CLAIM_OPTIONS,
    summary: "claim exact unread originals for one coordinator reminder",
    values: { original: "ID" },
  },
  "reminder list": {
    forms: [[]],
    group: "reminder",
    options: REMINDER_LIST_OPTIONS,
    summary: "list unread originals with eligible exact wake evidence",
  },
  "reminder settle": {
    forms: [["id", "outcome", "reason", "native-id?"]],
    group: "reminder",
    options: REMINDER_SETTLE_OPTIONS,
    summary: "record a submitted, refused or uncertain reminder disposition",
    values: { outcome: "submitted|refused|uncertain", reason: "CODE" },
  },
  "request close": {
    forms: [["id", "reason", "work?", "native-id?", "worker?"]],
    group: "request",
    options: REQUEST_CLOSE_OPTIONS,
    summary: "close your own imported request, optionally naming the work item that carries it",
  },
  "claude ready": READY,
  "codex ready": READY,
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
  "claude channel": {
    forms: [["game?", "conversation?", "poll-seconds?"]],
    group: "harness",
    options: {
      conversation: { type: "string" },
      game: { multiple: true, type: "string" },
      "poll-seconds": { type: "string" },
    },
    summary:
      "the stdio server the Claude recipient session starts; emits one notification per wake",
  },
  "review deliver": {
    forms: [["game", "slot"]],
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
  "events ingest": {
    forms: [["game"]],
    group: "review",
    options: EVENTS_INGEST_OPTIONS,
    summary:
      "ingest the game's runner event log into the store from its cursor; prints one typed JSON result line",
  },
  status: {
    forms: [["scope?", "since?", "state?", "audit?", "verify-since?", "format?"]],
    group: "status",
    options: STATUS_OPTIONS,
    summary:
      "read-only status of each registered repository's work items, store records and imported requests",
    values: {
      format: "json|markdown",
      scope: "all|GAME|KIT|ROLE",
      since: "ISO_TIMESTAMP",
      state: "STATE",
      "verify-since": "ISO_TIMESTAMP",
    },
  },
  "work check": {
    forms: [["decisions?"]],
    group: "work",
    options: WORK_CHECK_OPTIONS,
    summary:
      "validate docs/design index tables and docs/work front matter in the --root repository",
  },
  "work report": {
    forms: [[]],
    group: "work",
    options: WORK_OPTIONS,
    summary: "print each work item's milestone",
  },
  "work start": {
    forms: [["ID", "parent?", "native-id?", "worker?"]],
    group: "work",
    options: WORK_START_OPTIONS,
    summary: "start your work item: approved on main and not held; --parent links a parent item",
    values: { parent: "REPOSITORY:WORK_ID" },
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
  "work block": {
    forms: [["ID", "reason", "owner?", "native-id?", "worker?"]],
    group: "work",
    options: WORK_BLOCK_OPTIONS,
    summary: "record your work item blocked, with a reason and the role that can clear it",
  },
  "work unblock": {
    forms: [["ID", "native-id?", "worker?"]],
    group: "work",
    options: WORK_WRITE_OPTIONS,
    summary: "clear your work item's open block",
  },
  "work ready": {
    forms: [["ID", "native-id?", "worker?"]],
    group: "work",
    options: WORK_WRITE_OPTIONS,
    summary: "record your started work item ready for integration",
  },
  "work finish": {
    forms: [["ID", "native-id?", "worker?"]],
    group: "work",
    options: WORK_WRITE_OPTIONS,
    summary: "record your work item finished; its work file must be done on main",
  },
  "work show": {
    forms: [["ID"]],
    group: "work",
    options: WORK_READ_OPTIONS,
    summary: "print a work item's owner, work-file status, store record and covering holds",
  },
  "work history": {
    forms: [["ID"]],
    group: "work",
    options: WORK_READ_OPTIONS,
    summary: "print a work item's store events in order",
  },
  graph: {
    forms: [["work?", "depth?", "format?"]],
    group: "graph",
    options: GRAPH_OPTIONS,
    summary: "print the decision graph, or one work item's neighbourhood, as JSON or DOT",
    values: { depth: "N", format: "json|dot", work: "[REPOSITORY:]WORK_ID" },
  },
  "graph why": {
    forms: [["decision"]],
    group: "graph",
    options: GRAPH_WHY_OPTIONS,
    summary: "print a decision's supersedes chain with each item's approval reference",
    values: { decision: "[REPOSITORY:]WORK_ID/Dn" },
  },
  "graph index": {
    forms: [[]],
    group: "graph",
    options: GRAPH_INDEX_OPTIONS,
    summary: "rebuild the derived edges index from the registered repositories and the store",
  },
} as const satisfies Readonly<Record<string, GroupedSpec>>;
/* eslint-enable sort-keys */
export type Command = keyof typeof SPECS;
/** One `coordination-kit COMMAND ...` line per accepted form. */
export function synopsis(command: Command): string[] {
  return formSynopsis(VALUES, command, SPECS[command]);
}
/** The usage line a command prints with a usage error. */
export function commandUsage(command: Command): string {
  return usageText(BINARY, synopsis(command));
}
