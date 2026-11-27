// Every command's options: the one source for argument parsing and for the help text, so a flag a
// command accepts always appears in `coordination-kit --help`.
import { type CommandSpec, formSynopsis, usageText } from "../core/cli/usage.ts";
import { CALLER } from "./args.ts";
import { DOCS_AUDIT_OPTIONS, DOCS_COMPACT_OPTIONS } from "./documentation.ts";
import { GRAPH_OPTIONS, GRAPH_WHY_OPTIONS } from "./graph.ts";
import { DOCTOR_OPTIONS } from "./harness/doctor.ts";
import { INIT_OPTIONS, PROJECT_REGISTER_OPTIONS } from "./project/init.ts";
import {
  TASK_APPROVE_OPTIONS,
  TASK_CLOSE_OPTIONS,
  TASK_FIND_OPTIONS,
  TASK_LINK_OPTIONS,
  TASK_PROPOSE_OPTIONS,
  TASK_READ_OPTIONS,
  TASK_READY_OPTIONS,
  TASK_REPLACE_OPTIONS,
  TASK_REVIEW_APPROVE_OPTIONS,
  TASK_VERIFY_OPTIONS,
  TASK_WRITE_OPTIONS,
} from "./project/tasks.ts";
import { EVENTS_INGEST_OPTIONS, REVIEW_DELIVER_OPTIONS, REVIEW_SHOW_OPTIONS } from "./runner.ts";
import { SKILLS_INSTALL_OPTIONS } from "./skills.ts";
import { STATUS_SPEC } from "./status.ts";
import {
  COMPACTION_ACTIVATE_OPTIONS,
  COMPACTION_CANCEL_OPTIONS,
  COMPACTION_PREPARE_OPTIONS,
  COMPACTION_RESERVATION_OPTIONS,
} from "./store/compaction.ts";
import {
  STORE_COMPACTION_PLAN_OPTIONS,
  STORE_EXPORT_OPTIONS,
  STORE_IMPORT_OPTIONS,
  STORE_REBUILD_OPTIONS,
  STORE_RETIRE_OPTIONS,
} from "./store/maintenance.ts";
import {
  INBOX_OPTIONS,
  MSG_DECIDE_OPTIONS,
  MSG_DONE_OPTIONS,
  MSG_HISTORY_OPTIONS,
  MSG_RETAIN_OPTIONS,
  MSG_SEND_OPTIONS,
  MSG_STATUS_OPTIONS,
} from "./store/messages.ts";
import {
  MIGRATION_ACTIVATE_OPTIONS,
  MIGRATION_PREPARE_OPTIONS,
  MIGRATION_STATUS_OPTIONS,
} from "./store/migration.ts";
import {
  DECISION_LIST_OPTIONS,
  HOLD_LIST_OPTIONS,
  HOLD_RELEASE_OPTIONS,
  HOLD_SET_OPTIONS,
  POLICY_HOLD_RELEASE_OPTIONS,
  POLICY_HOLD_SET_OPTIONS,
  QUESTION_ANSWER_OPTIONS,
  QUESTION_CANCEL_OPTIONS,
  QUESTION_CLOSE_LEGACY_OPTIONS,
  QUESTION_LIST_OPTIONS,
  QUESTION_OPEN_OPTIONS,
  QUESTION_PROJECT_OPTIONS,
} from "./store/questions.ts";
import { REQUEST_CLOSE_OPTIONS } from "./store/requests.ts";
import {
  HANDOFF_OPEN_OPTIONS,
  HANDOFF_ROLE_OPTIONS,
  HANDOFF_SHOW_OPTIONS,
  HANDOFF_STATE_OPTIONS,
  SESSION_START_OPTIONS,
} from "./store/session.ts";
import {
  WORK_BLOCK_OPTIONS,
  WORK_CHECK_OPTIONS,
  WORK_EVIDENCE_OPTIONS,
  WORK_OPTIONS,
  WORK_READ_OPTIONS,
  WORK_START_OPTIONS,
  WORK_WRITE_OPTIONS,
} from "./work.ts";
import { WORK_FIND_OPTIONS } from "./workFind.ts";
const BINARY = "coordination-kit";
/** The placeholder each string option shows in help. */
const VALUES: Readonly<Record<string, string>> = {
  app: "ID",
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
  request: "imported requests (owner closes, fenced by the registry)",
  harness: "harness (claude, codex)",
  project: "standalone project setup and task workflow",
  review: "runner seam (delivery-kit)",
  status: "cross-repository status",
  work: "repository work files",
  docs: "documentation audit and compaction planning",
  graph: "decision graph",
} as const;
/* eslint-enable sort-keys */
interface GroupedSpec extends CommandSpec {
  readonly group: keyof typeof GROUPS;
}
const SCOPE = {
  app: { multiple: true, type: "string" },
  game: { multiple: true, type: "string" },
  role: { multiple: true, type: "string" },
} as const;
const READY = {
  forms: [
    ["app?", "role?"],
    ["game", "role?"],
  ],
  group: "harness",
  options: SCOPE,
  summary:
    "probe whether this harness can deliver now; prints one JSON line, exits 0 when ready, 1 when not",
} as const satisfies GroupedSpec;
/** Commands by their words: a noun group and its verb. */
/* eslint-disable sort-keys -- Specification order is the public command help order. */
export const SPECS = {
  "docs audit": {
    forms: [["area?", "format?"]],
    group: "docs",
    options: DOCS_AUDIT_OPTIONS,
    summary: "audit tracked documentation links and list rules to verify against code",
    values: { area: "TOPIC", format: "markdown|json" },
  },
  "docs compact": {
    forms: [["plan", "area?", "format?"]],
    group: "docs",
    options: DOCS_COMPACT_OPTIONS,
    summary: "prepare a read-only compaction plan for committed documentation",
    values: { area: "TOPIC", format: "markdown|json" },
  },
  init: {
    forms: [["project", "role?", "review?", "provider?", "repository?"]],
    group: "project",
    options: INIT_OPTIONS,
    summary: "set up Coordination Kit in an existing Git repository",
    values: {
      project: "ID",
      review: "off|chat|pr",
      provider: "github|gitlab",
      repository: "OWNER/REPO",
    },
  },
  "skills install": {
    forms: [["SKILL", "harness", "scope"]],
    group: "project",
    options: SKILLS_INSTALL_OPTIONS,
    summary: "install agent-cleanup, lifecycle or status in the primary Git checkout",
    values: { harness: "codex|claude", scope: "project" },
  },
  "project register": {
    forms: [["role", "harness", "native-id", "native-project-id?", "worktree?"]],
    group: "project",
    options: PROJECT_REGISTER_OPTIONS,
    summary: "register a verified session ID and worktree for a configured project role",
    values: { harness: "claude|codex", "native-project-id": "ID", worktree: "PATH" },
  },
  "task propose": {
    forms: [["ID", "owner", "title", "scope", "depends-on?", "native-id?"]],
    group: "project",
    options: TASK_PROPOSE_OPTIONS,
    summary: "record an idea with its owner and proposed scope",
    values: { scope: "TEXT", "depends-on": "TASK_ID" },
  },
  "task approve": {
    forms: [["ID", "approval", "native-id?"]],
    group: "project",
    options: TASK_APPROVE_OPTIONS,
    summary: "record the user's approval to build as the project maintainer",
  },
  "task start": {
    forms: [["ID", "native-id?"]],
    group: "project",
    options: TASK_WRITE_OPTIONS,
    summary: "start an approved task as its owner",
  },
  "task close": {
    forms: [["ID", "as", "reason", "approval", "native-id?"]],
    group: "project",
    options: TASK_CLOSE_OPTIONS,
    summary: "record a maintainer's decision to decline or cancel a task",
    values: { as: "declined|cancelled" },
  },
  "task replace-dependency": {
    forms: [["ID", "dependency", "replacement", "approval", "native-id?"]],
    group: "project",
    options: TASK_REPLACE_OPTIONS,
    summary: "explicitly replace a closed prerequisite before the dependant starts",
    values: { dependency: "TASK_ID", replacement: "TASK_ID" },
  },
  "task work-file": {
    forms: [["ID"]],
    group: "project",
    options: TASK_READ_OPTIONS,
    summary: "render the approved work file for the task branch",
  },
  "task ready": {
    forms: [
      ["ID", "branch", "head", "base?", "summary", "evidence", "refresh-policy?", "native-id?"],
    ],
    group: "project",
    options: TASK_READY_OPTIONS,
    summary: "record an exact candidate and print its review packet",
    values: { branch: "BRANCH", head: "SHA", base: "SHA", summary: "TEXT" },
  },
  "task approve-review": {
    forms: [["ID", "head", "approval", "revision?", "native-id?"]],
    group: "project",
    options: TASK_REVIEW_APPROVE_OPTIONS,
    summary: "record the user's approval to merge this exact revision",
    values: { head: "SHA", revision: "SHA" },
  },
  "task open-review": {
    forms: [["ID", "native-id?"]],
    group: "project",
    options: TASK_WRITE_OPTIONS,
    summary: "open a pull or merge request for the already-pushed candidate",
  },
  "task link-review": {
    forms: [["ID", "number", "native-id?"]],
    group: "project",
    options: TASK_LINK_OPTIONS,
    summary: "link an existing exact pull or merge request",
    values: { number: "N" },
  },
  "task merge": {
    forms: [["ID", "native-id?"]],
    group: "project",
    options: TASK_WRITE_OPTIONS,
    summary: "submit the exact candidate for integration under the configured review policy",
  },
  "task verify": {
    forms: [["ID", "evidence?", "native-id?"]],
    group: "project",
    options: TASK_VERIFY_OPTIONS,
    summary: "observe the actual merge and verify checks before marking the task landed",
  },
  "task list": {
    forms: [[]],
    group: "project",
    options: TASK_READ_OPTIONS,
    summary: "list the standalone project's tasks",
  },
  "task find": {
    forms: [["DESCRIPTION", "owner?"]],
    group: "project",
    options: TASK_FIND_OPTIONS,
    summary: "find a standalone task by canonical ID or description without writing",
  },
  "task show": {
    forms: [["ID"]],
    group: "project",
    options: TASK_READ_OPTIONS,
    summary: "show the task, exact candidate and recorded decisions",
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
  inbox: {
    forms: [
      ["include-body?", "all?", "native-id?", "worker?"],
      ["peek", "native-id?", "worker?"],
    ],
    group: "msg",
    options: INBOX_OPTIONS,
    summary: "collect messages, or list unread metadata with --peek without recording delivery",
  },
  "msg decide": {
    forms: [
      ["ID", "body-sha256", "prompt", "native-id?"],
      ["ID", "body-sha256", "approve", "scope", "user-reply", "native-id?"],
      ["ID", "body-sha256", "decline", "user-reply", "native-id?"],
    ],
    group: "msg",
    options: MSG_DECIDE_OPTIONS,
    summary:
      "record the recipient's displayed prompt or explicit user reply for an unverified original",
    values: { "body-sha256": "HASH", prompt: "REF", scope: "TEXT", "user-reply": "REF" },
  },
  "msg done": {
    forms: [["ID", "work?", "superseded-by?", "evidence?", "native-id?", "worker?"]],
    group: "msg",
    options: MSG_DONE_OPTIONS,
    summary: "close your own message as handled, or superseded with --superseded-by, in one write",
  },
  "msg retain": {
    forms: [
      ["ID", "reason", "next-boundary", "owner?", "evidence?", "native-id?", "worker?"],
      ["ID", "reason", "until", "owner?", "evidence?", "native-id?", "worker?"],
      ["ID", "reason", "next-review", "owner?", "evidence?", "native-id?", "worker?"],
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
    summary: "read exact message and wake metadata, or include its body with message access",
  },
  "msg history": {
    forms: [
      ["role?", "since?", "limit?"],
      ["include-body", "role?", "since?", "limit?", "native-id?", "worker?"],
    ],
    group: "msg",
    options: MSG_HISTORY_OPTIONS,
    summary: "read message events in order; --include-body requires message access",
  },
  "store import": {
    forms: [["approval-ledger", "dry-run?", "native-id?", "worker?"]],
    group: "store",
    options: STORE_IMPORT_OPTIONS,
    summary: "map the approval ledger to work records; --dry-run writes nothing",
    values: { "approval-ledger": "FILE" },
  },
  "store export": {
    forms: [["since", "native-id?", "worker?"]],
    group: "store",
    options: STORE_EXPORT_OPTIONS,
    summary: "list sends, closes and retentions recorded after a time, for rollback re-recording",
  },
  "store rebuild": {
    forms: [["native-id?", "worker?"]],
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
  "store compaction-reserve": {
    forms: [["id", "head-seq", "head-hash", "registry-revision", "native-id?"]],
    group: "store",
    options: COMPACTION_RESERVATION_OPTIONS,
    summary: "reserve the exact filesystem journal head under the writer lock",
    values: {
      "head-hash": "SHA256",
      "head-seq": "SEQ",
      id: "REQUEST_UUID",
      "registry-revision": "REVISION",
    },
  },
  "store compaction-cancel": {
    forms: [["id", "nonce", "head-seq", "head-hash", "registry-revision", "native-id?"]],
    group: "store",
    options: COMPACTION_CANCEL_OPTIONS,
    summary: "cancel the exact reservation before the permanent fence",
    values: {
      "head-hash": "SHA256",
      "head-seq": "SEQ",
      id: "REQUEST_UUID",
      nonce: "ACQUISITION_UUID",
      "registry-revision": "REVISION",
    },
  },
  "store compaction-prepare": {
    forms: [["restore", "evidence", "receipt", "id?", "native-id?"]],
    group: "store",
    options: COMPACTION_PREPARE_OPTIONS,
    summary: "qualify an exact filesystem checkpoint and write a new external receipt",
    values: {
      evidence: "ABSOLUTE_FILE",
      id: "REQUEST_UUID",
      receipt: "ABSOLUTE_FILE",
      restore: "ABSOLUTE_DIR",
    },
  },
  "store compaction-activate": {
    forms: [["id", "restore", "evidence", "receipt", "approval", "native-id?"]],
    group: "store",
    options: COMPACTION_ACTIVATE_OPTIONS,
    summary: "select an exact restored checkpoint at the approved idle boundary",
    values: {
      approval: "REF",
      evidence: "ABSOLUTE_FILE",
      id: "RECEIPT_ID",
      receipt: "ABSOLUTE_FILE",
      restore: "ABSOLUTE_DIR",
    },
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
  // CLEANUP (added 2026-11-25): see `closeLegacyQuestion`.
  "question close-legacy": {
    forms: [["id", "reason", "approval", "native-id?", "worker?"]],
    group: "decisions",
    options: QUESTION_CLOSE_LEGACY_OPTIONS,
    summary: "close your own pending question opened under Codex, citing the user's approval",
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
    values: { scope: "work:WORK_ID|role|app:ID" },
  },
  "hold policy-set": {
    forms: [["id", "scope", "reason", "approval", "native-id?"]],
    group: "decisions",
    options: POLICY_HOLD_SET_OPTIONS,
    summary: "record an explicit user policy hold with policy authority",
    values: { scope: "role:ROLE|app:APP|game:GAME|work:REPOSITORY:WORK_ID" },
  },
  "hold policy-release": {
    forms: [["id", "approval", "native-id?"]],
    group: "decisions",
    options: POLICY_HOLD_RELEASE_OPTIONS,
    summary: "release an exact user policy hold with policy authority",
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
    summary: "open a handoff for roles or all with workspace handoff authority",
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
    summary: "move a handoff to prepared, sent, completed or cancelled with handoff authority",
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
  "request close": {
    forms: [["id", "reason", "work?", "native-id?", "worker?"]],
    group: "request",
    options: REQUEST_CLOSE_OPTIONS,
    summary: "close your own imported request, optionally naming the work item that carries it",
  },
  "claude ready": READY,
  "codex ready": READY,
  "harness doctor": {
    forms: [["app", "role?"], ["game", "role?"], ["role"]],
    group: "harness",
    options: DOCTOR_OPTIONS,
    summary: "diagnose explicitly selected roles without sending or activating",
  },
  "harness ready": {
    forms: [
      ["app?", "role?"],
      ["game", "role?"],
    ],
    group: "harness",
    options: SCOPE,
    summary: "probe each selected role's effective harness without sending or activating",
  },
  "harness select": {
    forms: [
      ["harness", "expected-revision", "app", "role?", "native-id?"],
      ["harness", "expected-revision", "game", "role?", "native-id?"],
      ["harness", "expected-revision", "role", "native-id?"],
    ],
    group: "harness",
    options: {
      "native-id": CALLER["native-id"],
      ...SCOPE,
      "expected-revision": { type: "string" },
      harness: { type: "string" },
    },
    summary: "atomically select harness overrides for an explicit scope without activating roles",
  },
  "claude channel": {
    forms: [
      ["app?", "conversation?", "poll-seconds?"],
      ["game", "conversation?", "poll-seconds?"],
    ],
    group: "harness",
    options: {
      app: SCOPE.app,
      conversation: { type: "string" },
      game: { multiple: true, type: "string" },
      "poll-seconds": { type: "string" },
    },
    summary:
      "the stdio server the Claude recipient session starts; emits one notification per wake",
  },
  "review deliver": {
    forms: [
      ["app", "slot"],
      ["game", "slot"],
    ],
    group: "review",
    options: REVIEW_DELIVER_OPTIONS,
    summary: "deliver the scheduled review for one slot once; prints one typed JSON result line",
  },
  "review show": {
    forms: [
      ["app?", "slot?"],
      ["game", "slot?"],
    ],
    group: "review",
    options: REVIEW_SHOW_OPTIONS,
    summary: "print a stored review brief's full record: the slot's, else the latest",
  },
  "events ingest": {
    forms: [["app"], ["game"]],
    group: "review",
    options: EVENTS_INGEST_OPTIONS,
    summary: "ingest the app's runner event log from its cursor; prints one typed JSON result line",
  },
  status: STATUS_SPEC,
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
    summary: "finish your work item after main marks it done, superseded or cancelled",
  },
  "work find": {
    forms: [["DESCRIPTION", "scope?", "owner?"]],
    group: "status",
    options: WORK_FIND_OPTIONS,
    summary: "find shared work by canonical ID or description without writing",
    values: { scope: "all|workspace|app:ID|kit:ID|role:KEY|NAME" },
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
