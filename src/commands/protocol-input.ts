// Input-file shape checks for protocol commands. They mirror the store rules and never copy values.
import { isDeepStrictEqual } from "node:util";

import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import { registryRole } from "../protocol/runtime.ts";
import { ID_PATTERN } from "../validate.ts";

export type InputRule =
  | "required"
  | "unexpected-key"
  | "type"
  | "enum"
  | "empty"
  | "format"
  | "range"
  | "duplicate"
  | "mismatch"
  | "unknown";

/** A field-level failure: the store code it produces, a JSON pointer and a rule name. */
export interface InputIssue {
  readonly code: string;
  readonly path: string;
  readonly rule: InputRule;
}

export interface InputCheck {
  /** An envelope failure the command reports as `invalid-input` before it reaches the store. */
  readonly fatal: InputIssue | null;
  /** Shape failures, in store check order; each names the code the store refuses it with. */
  readonly issues: readonly InputIssue[];
  /** Fields a state-dependent refusal points at; used only when the store throws that code. */
  readonly refusals: readonly InputIssue[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const NAME = "[a-z0-9][a-z0-9-]{0,63}";
const BASE_ROLE = new RegExp(`^(?:coordinator|kits/${NAME}|games/${NAME}/${NAME})$`, "u");
/** The largest integer the core journal accepts (it requires values below 999999999999). */
const MAX_INTEGER = 999_999_999_998;
/** Unexpected keys are named only when they look like field names, never like values. */
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u;
const WORK_PHASES = [
  "execution",
  "check",
  "integration",
  "publication",
  "consumer-adoption",
  "delivery",
  "deployment",
  "acceptance",
];
const ENROLLMENT_KINDS = [
  "request",
  "work",
  "submission",
  "original",
  "intake",
  "coverage",
  "question",
  "hold",
];

class Checker {
  readonly issues: InputIssue[] = [];
  readonly refusals: InputIssue[] = [];
  fatal: InputIssue | null = null;

  fail(code: string, path: string, rule: InputRule): false {
    this.issues.push({ code, path, rule });
    return false;
  }

  refuse(code: string, path: string, rule: InputRule): void {
    this.refusals.push({ code, path, rule });
  }

  result(): InputCheck {
    return { fatal: this.fatal, issues: this.issues, refusals: this.refusals };
  }
}

/** RFC 6901 pointer to a child member or array index. */
function at(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function missing(value: unknown): InputRule {
  return value === undefined ? "required" : "type";
}

/** Exact or open object shape; reports missing and unexpected keys with the store's code. */
function shape(
  c: Checker,
  code: string,
  path: string,
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return c.fail(code, path, missing(value));
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      c.fail(code, at(path, key), "required");
    }
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      c.fail(code, SAFE_KEY.test(key) ? at(path, key) : path, "unexpected-key");
    }
  }
  return true;
}

/** Calls `check` only for a key the object carries; `shape` already reported missing keys. */
function present(
  value: Record<string, unknown>,
  key: string,
  check: (value: unknown) => unknown,
): void {
  if (Object.hasOwn(value, key)) {
    check(value[key]);
  }
}

function string(
  c: Checker,
  code: string,
  path: string,
  value: unknown,
  valid: (value: string) => boolean = () => true,
  blank: (value: string) => boolean = (text) => text === "",
): value is string {
  if (typeof value !== "string") {
    return c.fail(code, path, missing(value));
  }
  if (blank(value)) {
    return c.fail(code, path, "empty");
  }
  return valid(value) || c.fail(code, path, "format");
}

/** Core and protocol text: nonempty and free of NUL. */
function coreText(c: Checker, code: string, path: string, value: unknown): boolean {
  return string(c, code, path, value, (text) => !text.includes("\0"));
}

/** Work and enrollment text: not blank after trimming. */
function trimmed(c: Checker, code: string, path: string, value: unknown): boolean {
  return string(
    c,
    code,
    path,
    value,
    () => true,
    (text) => text.trim() === "",
  );
}

/** Message text: 1 to 4096 characters without control characters. */
function messageText(c: Checker, code: string, path: string, value: unknown): boolean {
  if (typeof value === "string" && value.length > 4096) {
    return c.fail(code, path, "range");
  }
  return string(c, code, path, value, (text) =>
    Array.from(text).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
  );
}

function pattern(c: Checker, code: string, path: string, value: unknown, test: RegExp): boolean {
  return string(c, code, path, value, (text) => test.test(text));
}

function integer(
  c: Checker,
  code: string,
  path: string,
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): boolean {
  if (!Number.isSafeInteger(value)) {
    return c.fail(code, path, missing(value));
  }
  return (Number(value) >= minimum && Number(value) <= maximum) || c.fail(code, path, "range");
}

function member(
  c: Checker,
  code: string,
  path: string,
  value: unknown,
  values: readonly unknown[],
): boolean {
  if (value === undefined) {
    return c.fail(code, path, "required");
  }
  return values.includes(value) || c.fail(code, path, "enum");
}

function list(
  c: Checker,
  code: string,
  path: string,
  value: unknown,
  item: (value: unknown, path: string) => unknown,
  options: {
    readonly nonEmpty?: boolean;
    readonly unique?: (value: unknown) => unknown;
    readonly uniqueCode?: string;
  } = {},
): value is unknown[] {
  if (!Array.isArray(value)) {
    return c.fail(code, path, missing(value));
  }
  if (options.nonEmpty === true && value.length === 0) {
    c.fail(code, path, "empty");
  }
  value.forEach((entry, index) => item(entry, at(path, index)));
  if (options.unique !== undefined) {
    const seen = new Set<string>();
    value.forEach((entry, index) => {
      const key = String(JSON.stringify(options.unique!(entry)));
      if (seen.has(key)) {
        c.fail(options.uniqueCode ?? code, at(path, index), "duplicate");
      }
      seen.add(key);
    });
  }
  return true;
}

function idList(c: Checker, code: string, path: string, value: unknown, nonEmpty = false): void {
  list(c, code, path, value, (entry, item) => pattern(c, code, item, entry, ID), {
    nonEmpty,
    unique: (entry) => entry,
  });
}

/**
 * The work store tests IDs with a coercing pattern, so a non-string ID that stringifies to a valid
 * one passes it; when the ID also names a journal object the transaction check refuses it.
 */
function coercedId(
  c: Checker,
  code: string,
  path: string,
  value: unknown,
  objectId: boolean,
): void {
  if (typeof value === "string") {
    pattern(c, code, path, value, ID);
  } else if (!ID.test(String(value))) {
    c.fail(code, path, "type");
  } else if (objectId) {
    c.fail("invalid-transaction", path, "type");
  }
}

/** A canonical protocol namespace, including a worker namespace under its parent's epoch. */
function namespace(value: string): boolean {
  const split = value.split("/workers/");
  if (split.length === 1) {
    return BASE_ROLE.test(value);
  }
  const [workerId, epoch, ...extra] = split[1]!.split("/");
  return (
    split.length === 2 &&
    BASE_ROLE.test(split[0]!) &&
    extra.length === 0 &&
    isCanonicalUuid(workerId) &&
    typeof epoch === "string" &&
    /^[1-9][0-9]*$/u.test(epoch) &&
    Number(epoch) <= MAX_INTEGER
  );
}

function stamp(text: string): boolean {
  return text.endsWith("Z") && Number.isFinite(Date.parse(text));
}

function binding(c: Checker, code: string, path: string, value: unknown): void {
  if (shape(c, code, path, value, ["harness", "nativeId"])) {
    present(value, "harness", (harness) =>
      member(c, code, at(path, "harness"), harness, ["codex", "claude"]),
    );
    present(value, "nativeId", (id) =>
      string(c, code, at(path, "nativeId"), id, (text) => isCanonicalUuid(text)),
    );
  }
}

/** Work context or message writer: a fenced transaction without mutations. */
function writer(c: Checker, path: string, value: unknown): void {
  const code = "invalid-transaction";
  if (
    !shape(
      c,
      code,
      path,
      value,
      ["id", "role", "epoch", "binding", "expectedRevision", "at"],
      ["mutations"],
    )
  ) {
    return;
  }
  present(value, "id", (id) => pattern(c, code, at(path, "id"), id, ID));
  present(value, "role", (role) => {
    if (coreText(c, code, at(path, "role"), role) && !namespace(role as string)) {
      c.fail("invalid-role", at(path, "role"), "format");
    }
  });
  present(value, "epoch", (epoch) => integer(c, code, at(path, "epoch"), epoch, 1, MAX_INTEGER));
  present(value, "binding", (entry) => binding(c, code, at(path, "binding"), entry));
  present(value, "expectedRevision", (revision) =>
    integer(c, code, at(path, "expectedRevision"), revision, 0, MAX_INTEGER),
  );
  present(value, "at", (stampValue) => string(c, code, at(path, "at"), stampValue, stamp));
  c.refuse("stale-revision", at(path, "expectedRevision"), "mismatch");
}

/** The envelope keys work verbs (`context`) and message verbs (`writer`) need before the store. */
function envelope(c: Checker, value: unknown, key: "context" | "writer"): void {
  if (!isRecord(value)) {
    c.fatal = { code: "invalid-input", path: "", rule: "type" };
    return;
  }
  const context = value[key];
  if (!isRecord(context)) {
    c.fatal = { code: "invalid-input", path: `/${key}`, rule: missing(context) };
    return;
  }
  if (typeof context.role !== "string") {
    c.fatal = { code: "invalid-input", path: `/${key}/role`, rule: missing(context.role) };
    return;
  }
  try {
    registryRole(context.role.split("/workers/")[0]!);
  } catch {
    c.fatal = { code: "invalid-input", path: `/${key}/role`, rule: "format" };
    return;
  }
  writer(c, `/${key}`, context);
}

function artifact(c: Checker, path: string, value: unknown, code = "invalid-work"): void {
  if (shape(c, code, path, value, ["hash", "size"])) {
    present(value, "hash", (hash) => pattern(c, "invalid-artifact", at(path, "hash"), hash, HASH));
    present(value, "size", (size) => integer(c, "invalid-artifact", at(path, "size"), size));
  }
}

function plan(c: Checker, path: string, value: unknown): void {
  if (!isRecord(value)) {
    c.fail("invalid-artifact", path, missing(value));
    return;
  }
  present(value, "path", (file) =>
    string(
      c,
      "invalid-work",
      at(path, "path"),
      file,
      (text) =>
        text.length <= 512 &&
        /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(text) &&
        text.split("/").every((segment) => segment !== "." && segment !== ".."),
    ),
  );
  present(value, "commit", (commit) => {
    if (
      pattern(c, "invalid-work", at(path, "commit"), commit, SHA) &&
      !Object.hasOwn(value, "path")
    ) {
      c.fail("invalid-work", at(path, "path"), "required");
    }
  });
  const content = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "path" && key !== "commit"),
  );
  artifact(c, path, content);
}

function source(c: Checker, path: string, value: unknown): void {
  const code = "invalid-work";
  if (value === null || !shape(c, code, path, value, ["base", "commit", "tree", "dependencies"])) {
    return;
  }
  for (const key of ["base", "commit", "tree"]) {
    present(value, key, (pin) => pattern(c, code, at(path, key), pin, SHA));
  }
  present(value, "dependencies", (dependencies) =>
    list(c, code, at(path, "dependencies"), dependencies, (entry, item) => {
      if (shape(c, code, item, entry, ["role", "commit"])) {
        present(entry, "role", (role) => trimmed(c, code, at(item, "role"), role));
        present(entry, "commit", (pin) => pattern(c, code, at(item, "commit"), pin, SHA));
      }
    }),
  );
}

function definition(c: Checker, path: string, value: unknown): void {
  const code = "invalid-work";
  const keys = [
    "id",
    "requestIds",
    "clauseIds",
    "messageIds",
    "plan",
    "artifacts",
    "criteria",
    "source",
    "retention",
  ];
  if (!shape(c, code, path, value, keys)) {
    return;
  }
  present(value, "id", (id) => coercedId(c, code, at(path, "id"), id, true));
  present(value, "requestIds", (ids) => idList(c, code, at(path, "requestIds"), ids, true));
  present(value, "clauseIds", (ids) => idList(c, code, at(path, "clauseIds"), ids));
  present(value, "messageIds", (ids) => idList(c, code, at(path, "messageIds"), ids));
  present(value, "plan", (entry) => plan(c, at(path, "plan"), entry));
  present(value, "artifacts", (artifacts) =>
    list(c, code, at(path, "artifacts"), artifacts, (entry, item) => artifact(c, item, entry)),
  );
  present(value, "source", (entry) => source(c, at(path, "source"), entry));
  present(value, "criteria", (criteria) =>
    list(
      c,
      code,
      at(path, "criteria"),
      criteria,
      (entry, item) => {
        if (!shape(c, code, item, entry, ["id", "targetId", "phases", "consumers"])) {
          return;
        }
        present(entry, "id", (id) => pattern(c, code, at(item, "id"), id, ID));
        present(entry, "targetId", (id) => pattern(c, code, at(item, "targetId"), id, ID));
        present(entry, "phases", (phases) =>
          list(
            c,
            code,
            at(item, "phases"),
            phases,
            (phase, index) => member(c, code, index, phase, WORK_PHASES),
            { nonEmpty: true, unique: (phase) => phase },
          ),
        );
        present(entry, "consumers", (ids) => idList(c, code, at(item, "consumers"), ids));
      },
      { nonEmpty: true, unique: (entry) => (isRecord(entry) ? entry.id : undefined) },
    ),
  );
  present(value, "retention", (retention) => {
    if (
      retention !== null &&
      shape(c, code, at(path, "retention"), retention, ["owner", "reason", "nextBoundary"])
    ) {
      for (const key of ["owner", "reason", "nextBoundary"]) {
        present(retention, key, (text) => trimmed(c, code, at(at(path, "retention"), key), text));
      }
    }
  });
}

/** A work receipt; only the `work-receipt` verb also writes it as its own journal object. */
function workReceipt(
  c: Checker,
  path: string,
  value: unknown,
  workId: unknown,
  objectId: boolean,
): void {
  const keys = [
    "id",
    "workId",
    "definitionHash",
    "criterionId",
    "phase",
    "consumer",
    "outcome",
    "artifact",
    "source",
  ];
  if (!shape(c, "invalid-work", path, value, keys)) {
    return;
  }
  present(value, "id", (id) => coercedId(c, "invalid-receipt", at(path, "id"), id, objectId));
  present(value, "workId", (id) => {
    if (typeof id !== "string") {
      c.fail("invalid-receipt", at(path, "workId"), missing(id));
    } else if (typeof workId === "string" && id !== workId) {
      c.fail("invalid-receipt", at(path, "workId"), "mismatch");
    }
  });
  present(value, "definitionHash", (hash) =>
    pattern(c, "invalid-receipt", at(path, "definitionHash"), hash, HASH),
  );
  present(value, "outcome", (outcome) =>
    member(c, "invalid-receipt", at(path, "outcome"), outcome, ["passed", "failed", "unknown"]),
  );
  present(value, "phase", (phase) =>
    member(c, "receipt-scope-mismatch", at(path, "phase"), phase, WORK_PHASES),
  );
  present(value, "consumer", (consumer) => {
    if (consumer !== null && typeof consumer !== "string") {
      c.fail("receipt-scope-mismatch", at(path, "consumer"), "type");
    }
  });
  present(value, "source", (entry) => source(c, at(path, "source"), entry));
  present(value, "artifact", (entry) => artifact(c, at(path, "artifact"), entry));
  c.refuse("invalid-receipt", at(path, "definitionHash"), "mismatch");
  c.refuse("receipt-scope-mismatch", at(path, "criterionId"), "unknown");
  c.refuse("receipt-source-mismatch", at(path, "source"), "mismatch");
}

/** `--input-file` for `work-publish`: `{ context, input }`. */
export function checkWorkPublish(value: unknown): InputCheck {
  const c = new Checker();
  envelope(c, value, "context");
  if (c.fatal !== null || !isRecord(value)) {
    return c.result();
  }
  const input = value.input;
  if (!isRecord(input)) {
    c.fail("invalid-work", "/input", missing(input));
    return c.result();
  }
  if (!Object.hasOwn(input, "definition")) {
    c.fail("invalid-work", "/input/definition", "required");
  }
  present(input, "definition", (entry) => definition(c, "/input/definition", entry));
  if (typeof input.ready !== "boolean") {
    c.fail("invalid-work", "/input/ready", missing(input.ready));
  }
  const replaces = input.replaces;
  c.refuse(
    "explicit-replacement-required",
    "/input/replaces",
    replaces === undefined || replaces === null
      ? "required"
      : typeof replaces !== "string"
        ? "type"
        : replaces === ""
          ? "empty"
          : "mismatch",
  );
  c.refuse("stale-work", "/input/expectedWorkRevision", "mismatch");
  return c.result();
}

function currentWork(c: Checker, input: Record<string, unknown>): void {
  c.refuse("work-missing", "/input/workId", typeof input.workId === "string" ? "unknown" : "type");
  c.refuse("stale-work", "/input/expectedWorkRevision", "mismatch");
}

/** `--input-file` for `work-receipt`: `{ context, input }`. */
export function checkWorkReceipt(value: unknown): InputCheck {
  const c = new Checker();
  envelope(c, value, "context");
  if (c.fatal !== null || !isRecord(value)) {
    return c.result();
  }
  const input = value.input;
  if (!isRecord(input)) {
    c.fail(input === undefined ? "invalid-work" : "invalid-input", "/input", missing(input));
    return c.result();
  }
  currentWork(c, input);
  if (!Object.hasOwn(input, "receipt")) {
    c.fail("invalid-work", "/input/receipt", "required");
  }
  present(input, "receipt", (entry) => workReceipt(c, "/input/receipt", entry, input.workId, true));
  return c.result();
}

/** `--input-file` for `work-submit`: `{ context, input }`; the context is the worker's own. */
export function checkWorkSubmit(value: unknown): InputCheck {
  const c = new Checker();
  envelope(c, value, "context");
  if (c.fatal !== null || !isRecord(value)) {
    return c.result();
  }
  const input = value.input;
  const keys = [
    "id",
    "parentRole",
    "parentEpoch",
    "workerId",
    "workId",
    "definitionHash",
    "criterionIds",
    "source",
    "artifacts",
    "receipts",
  ];
  if (!shape(c, "invalid-work", "/input", input, keys)) {
    return c.result();
  }
  present(input, "id", (id) => coercedId(c, "invalid-work", "/input/id", id, true));
  present(input, "artifacts", (artifacts) =>
    list(c, "invalid-work", "/input/artifacts", artifacts, (entry, item) =>
      artifact(c, item, entry),
    ),
  );
  present(input, "parentRole", (role) => {
    if (typeof role !== "string") {
      c.fail("invalid-role", "/input/parentRole", missing(role));
    } else if (!BASE_ROLE.test(role)) {
      c.fail("invalid-role", "/input/parentRole", "format");
    }
  });
  present(input, "workerId", (id) =>
    string(c, "invalid-parent", "/input/workerId", id, (text) => isCanonicalUuid(text)),
  );
  present(input, "parentEpoch", (epoch) =>
    integer(c, "invalid-parent", "/input/parentEpoch", epoch, 1, MAX_INTEGER),
  );
  present(input, "definitionHash", (hash) =>
    pattern(c, "submission-scope-mismatch", "/input/definitionHash", hash, HASH),
  );
  present(input, "criterionIds", (ids) =>
    idList(c, "submission-scope-mismatch", "/input/criterionIds", ids, true),
  );
  present(input, "source", (entry) => source(c, "/input/source", entry));
  present(input, "receipts", (receipts) =>
    list(
      c,
      "invalid-work",
      "/input/receipts",
      receipts,
      (entry, item) => {
        if (!isRecord(entry)) {
          c.fail("invalid-work", item, missing(entry));
          return;
        }
        if (
          Array.isArray(input.criterionIds) &&
          typeof entry.criterionId === "string" &&
          !input.criterionIds.includes(entry.criterionId)
        ) {
          c.fail("submission-scope-mismatch", at(item, "criterionId"), "mismatch");
        }
        if (typeof entry.phase === "string" && !["execution", "check"].includes(entry.phase)) {
          c.fail("submission-scope-mismatch", at(item, "phase"), "enum");
        }
        if (Object.hasOwn(entry, "source") && !isDeepStrictEqual(entry.source, input.source)) {
          c.fail("receipt-source-mismatch", at(item, "source"), "mismatch");
        }
        workReceipt(c, item, entry, input.workId, false);
      },
      { unique: (entry) => (isRecord(entry) ? entry.id : undefined), uniqueCode: "receipt-exists" },
    ),
  );
  c.refuse("worker-scope-mismatch", "/context/role", "mismatch");
  c.refuse("submission-scope-mismatch", "/input/definitionHash", "mismatch");
  return c.result();
}

/** `--input-file` for `work-accept`: `{ context, input }`. */
export function checkWorkAccept(value: unknown): InputCheck {
  const c = new Checker();
  envelope(c, value, "context");
  if (c.fatal !== null || !isRecord(value)) {
    return c.result();
  }
  const input = value.input;
  if (!isRecord(input)) {
    c.fail(input === undefined ? "invalid-work" : "invalid-input", "/input", missing(input));
    return c.result();
  }
  currentWork(c, input);
  if (!Object.hasOwn(input, "evidence")) {
    c.fail("invalid-work", "/input/evidence", "required");
  }
  present(input, "evidence", (entry) => artifact(c, "/input/evidence", entry));
  const submission = input.submission;
  if (!isRecord(submission)) {
    c.fail("invalid-input", "/input/submission", missing(submission));
    return c.result();
  }
  if (typeof submission.role !== "string") {
    c.fail("invalid-input", "/input/submission/role", missing(submission.role));
  } else if (!namespace(submission.role)) {
    c.fail("invalid-role", "/input/submission/role", "format");
  }
  c.refuse("submission-changed", "/input/submission/revision", "mismatch");
  c.refuse("submission-scope-mismatch", "/input/submission/artifact", "mismatch");
  return c.result();
}

function messageArtifact(c: Checker, code: string, path: string, value: unknown): void {
  if (shape(c, code, path, value, ["hash", "size"])) {
    present(value, "hash", (hash) => pattern(c, code, at(path, "hash"), hash, HASH));
    present(value, "size", (size) => integer(c, code, at(path, "size"), size));
  }
}

function guards(c: Checker, path: string, value: unknown): void {
  const code = "invalid-message-guards";
  if (!shape(c, code, path, value, ["question", "hold", "references", "artifacts"])) {
    return;
  }
  present(value, "question", (question) =>
    member(c, code, at(path, "question"), question, ["unknown", "pending", "clear", "unavailable"]),
  );
  present(value, "hold", (hold) =>
    member(c, code, at(path, "hold"), hold, ["unknown", "held", "clear", "unavailable"]),
  );
  present(value, "references", (references) =>
    list(c, code, at(path, "references"), references, (entry, item) =>
      messageText(c, code, item, entry),
    ),
  );
  present(value, "artifacts", (artifacts) =>
    list(c, code, at(path, "artifacts"), artifacts, (entry, item) =>
      messageArtifact(c, code, item, entry),
    ),
  );
}

function links(c: Checker, path: string, value: unknown): void {
  const code = "invalid-message-links";
  const keys = ["requestIds", "clauseIds", "workIds", "messageIds"];
  if (!shape(c, code, path, value, keys)) {
    return;
  }
  for (const key of keys) {
    present(value, key, (ids) =>
      list(c, code, at(path, key), ids, (entry, item) => messageText(c, code, item, entry), {
        unique: (entry) => entry,
      }),
    );
  }
}

function originalRef(c: Checker, path: string, value: unknown): void {
  const code = "invalid-original-reference";
  if (!shape(c, code, path, value, ["senderRole", "messageId", "revision", "hash"])) {
    return;
  }
  present(value, "senderRole", (role) => messageText(c, code, at(path, "senderRole"), role));
  present(value, "messageId", (id) => messageText(c, code, at(path, "messageId"), id));
  present(value, "revision", (revision) => integer(c, code, at(path, "revision"), revision, 1, 1));
  present(value, "hash", (hash) => pattern(c, code, at(path, "hash"), hash, HASH));
  c.refuse("message-missing", at(path, "messageId"), "unknown");
  c.refuse("original-reference-mismatch", at(path, "hash"), "mismatch");
}

function envelopeRole(text: string): boolean {
  return text.split("/").length <= 2 && text.split("/").every((part) => ID_PATTERN.test(part));
}

function messageEnvelope(c: Checker, path: string, value: unknown): void {
  const code = "invalid-envelope";
  if (!isRecord(value)) {
    c.fail(code, path, missing(value));
    return;
  }
  if (value.schema !== 1) {
    c.fail(code, at(path, "schema"), value.schema === undefined ? "required" : "enum");
  }
  pattern(c, code, at(path, "id"), value.id, ID);
  string(c, code, at(path, "fromRole"), value.fromRole, envelopeRole);
  string(c, code, at(path, "toRole"), value.toRole, envelopeRole);
  member(c, code, at(path, "intent"), value.intent, ["queue", "unblock"]);
  if (typeof value.body !== "string") {
    c.fail(code, at(path, "body"), missing(value.body));
  }
  string(c, code, at(path, "created"), value.created, stamp);
  if (value.parentRole !== undefined || value.workerId !== undefined) {
    const target = "invalid-worker-target";
    string(c, target, at(path, "workerId"), value.workerId, (text) => isCanonicalUuid(text));
    if (string(c, target, at(path, "parentRole"), value.parentRole, envelopeRole)) {
      if (value.toRole !== value.parentRole) {
        c.fail(target, at(path, "toRole"), "mismatch");
      }
    }
  }
}

/** `--input-file` for `message-publish`: `{ writer, input }`. */
export function checkMessagePublish(value: unknown): InputCheck {
  const c = new Checker();
  envelope(c, value, "writer");
  if (c.fatal !== null || !isRecord(value)) {
    return c.result();
  }
  const input = value.input;
  const code = "invalid-message";
  if (!shape(c, code, "/input", input, ["envelope", "links", "guards"], ["imported"])) {
    return c.result();
  }
  present(input, "envelope", (entry) => messageEnvelope(c, "/input/envelope", entry));
  present(input, "links", (entry) => links(c, "/input/links", entry));
  present(input, "guards", (entry) => guards(c, "/input/guards", entry));
  present(input, "imported", (entry) => {
    if (
      shape(c, "invalid-legacy-record", "/input/imported", entry, ["legacyRecord", "evidenceRef"])
    ) {
      present(entry, "evidenceRef", (ref) =>
        messageText(c, "invalid-legacy-record", "/input/imported/evidenceRef", ref),
      );
      present(entry, "legacyRecord", (ref) =>
        messageArtifact(c, "invalid-artifact", "/input/imported/legacyRecord", ref),
      );
    }
  });
  c.refuse("message-sender-mismatch", "/writer/role", "mismatch");
  return c.result();
}

/** `--input-file` for `message-receipt`: `{ writer, input }`; the writer is the recipient. */
export function checkMessageReceipt(value: unknown): InputCheck {
  const c = new Checker();
  envelope(c, value, "writer");
  if (c.fatal !== null || !isRecord(value)) {
    return c.result();
  }
  const input = value.input;
  const code = "invalid-message-receipt";
  const keys = ["id", "original", "disposition", "evidence", "retention", "guards"];
  if (!shape(c, code, "/input", input, keys)) {
    return c.result();
  }
  present(input, "original", (entry) => originalRef(c, "/input/original", entry));
  present(input, "id", (id) => messageText(c, code, "/input/id", id));
  present(input, "disposition", (disposition) =>
    member(c, code, "/input/disposition", disposition, ["handled", "superseded", "retained"]),
  );
  present(input, "evidence", (evidence) =>
    list(
      c,
      code,
      "/input/evidence",
      evidence,
      (entry, item) => messageArtifact(c, code, item, entry),
      { nonEmpty: true },
    ),
  );
  present(input, "guards", (entry) => guards(c, "/input/guards", entry));
  present(input, "retention", (retention) => {
    if (input.disposition === "retained") {
      const required = "message-retention-required";
      if (
        shape(c, required, "/input/retention", retention, ["ownerRole", "reason", "nextBoundary"])
      ) {
        for (const key of ["ownerRole", "reason", "nextBoundary"]) {
          present(retention, key, (text) =>
            messageText(c, required, at("/input/retention", key), text),
          );
        }
      }
    } else if (retention !== null) {
      c.fail(code, "/input/retention", "type");
    }
  });
  c.refuse("message-recipient-mismatch", "/writer/role", "mismatch");
  return c.result();
}

/** `--input-file` for `message-withdraw`: `{ writer, input }`; the writer is the sender. */
export function checkMessageWithdraw(value: unknown): InputCheck {
  const c = new Checker();
  envelope(c, value, "writer");
  if (c.fatal !== null || !isRecord(value)) {
    return c.result();
  }
  const input = value.input;
  const code = "invalid-message-withdrawal";
  if (!shape(c, code, "/input", input, ["id", "original", "reason", "evidenceRef", "guards"])) {
    return c.result();
  }
  const original = input.original;
  if (!isRecord(original)) {
    // A null original fails before the comparison; any other non-object fails the comparison.
    c.fail(original === null ? "invalid-input" : code, "/input/original", "type");
  } else {
    const role = (value.writer as Record<string, unknown>).role;
    if (original.senderRole !== role) {
      c.fail(code, "/input/original/senderRole", "mismatch");
    }
  }
  for (const key of ["id", "reason", "evidenceRef"]) {
    present(input, key, (text) => messageText(c, code, at("/input", key), text));
  }
  if (isRecord(original)) {
    originalRef(c, "/input/original", original);
  }
  present(input, "guards", (entry) => guards(c, "/input/guards", entry));
  return c.result();
}

/** `--input-file` for `message-observe`: `{ writer, input }`; the writer is the sender. */
export function checkMessageObserve(value: unknown): InputCheck {
  const c = new Checker();
  envelope(c, value, "writer");
  if (c.fatal !== null || !isRecord(value)) {
    return c.result();
  }
  const input = value.input;
  if (
    !shape(c, "invalid-message-transport", "/input", input, ["id", "original", "record", "guards"])
  ) {
    return c.result();
  }
  const original = input.original;
  if (!isRecord(original)) {
    c.fail(
      original === null ? "invalid-input" : "message-sender-mismatch",
      "/input/original",
      "type",
    );
  } else {
    if (original.senderRole !== (value.writer as Record<string, unknown>).role) {
      c.fail("message-sender-mismatch", "/input/original/senderRole", "mismatch");
    }
    present(input, "id", (id) => messageText(c, "message-sender-mismatch", "/input/id", id));
    originalRef(c, "/input/original", original);
  }
  present(input, "record", (entry) =>
    messageArtifact(c, "invalid-artifact", "/input/record", entry),
  );
  present(input, "guards", (entry) => guards(c, "/input/guards", entry));
  return c.result();
}

/** `--input-file` for `message-original`: an exact `OriginalRef`. */
export function checkOriginalRef(value: unknown): InputCheck {
  const c = new Checker();
  originalRef(c, "", value);
  return c.result();
}

/** `--input-file` for `claim`: a `ProtocolClaim` at the top level. */
export function checkClaim(value: unknown): InputCheck {
  const c = new Checker();
  const code = "invalid-claim";
  if (
    !shape(c, code, "", value, ["role", "expectedEpoch", "binding", "evidence", "at"], ["parent"])
  ) {
    return c.result();
  }
  present(value, "role", (role) => coreText(c, code, "/role", role));
  present(value, "expectedEpoch", (epoch) =>
    integer(c, code, "/expectedEpoch", epoch, 0, MAX_INTEGER),
  );
  present(value, "binding", (entry) => binding(c, code, "/binding", entry));
  present(value, "evidence", (evidence) => coreText(c, code, "/evidence", evidence));
  present(value, "at", (stampValue) => string(c, code, "/at", stampValue, stamp));
  const role = value.role;
  if (typeof role === "string" && role !== "" && !namespace(role)) {
    c.fail("invalid-role", "/role", "format");
  } else if (typeof role === "string" && namespace(role)) {
    const worker = role.split("/workers/")[1];
    if (worker === undefined) {
      if (Object.hasOwn(value, "parent")) {
        c.fail("invalid-parent", "/parent", "unexpected-key");
      }
    } else {
      const [workerId, epoch] = worker.split("/");
      const expected = { epoch: Number(epoch), role: role.split("/workers/")[0], workerId };
      if (!Object.hasOwn(value, "parent")) {
        c.fail("invalid-parent", "/parent", "required");
      } else if (
        shape(c, "invalid-parent", "/parent", value.parent, ["role", "epoch", "workerId"])
      ) {
        if (!isDeepStrictEqual({ ...value.parent }, expected)) {
          c.fail("invalid-parent", "/parent", "mismatch");
        }
      }
      if (isRecord(value.binding) && value.binding.nativeId !== workerId) {
        c.fail("invalid-parent", "/binding/nativeId", "mismatch");
      }
    }
  }
  c.refuse("epoch-conflict", "/expectedEpoch", "mismatch");
  return c.result();
}

function enrollmentArtifacts(c: Checker, path: string, value: unknown): void {
  const required = "enrollment-evidence-required";
  if (!Array.isArray(value)) {
    c.fail(required, path, missing(value));
    return;
  }
  if (value.length === 0) {
    c.fail(required, path, "empty");
  }
  value.forEach((entry, index) => {
    const item = at(path, index);
    if (shape(c, "invalid-enrollment", item, entry, ["hash", "size"])) {
      present(entry, "hash", (hash) =>
        pattern(c, "invalid-enrollment", at(item, "hash"), hash, HASH),
      );
      present(entry, "size", (size) => integer(c, "invalid-enrollment", at(item, "size"), size));
    }
  });
}

/** `--input-file` for `enroll`: `{ context, input }`. */
export function checkEnroll(value: unknown): InputCheck {
  const c = new Checker();
  if (!isRecord(value)) {
    c.fatal = { code: "invalid-input", path: "", rule: "type" };
    return c.result();
  }
  if (!isRecord(value.context)) {
    c.fatal = { code: "invalid-input", path: "/context", rule: missing(value.context) };
    return c.result();
  }
  writer(c, "/context", value.context);
  const input = value.input;
  const code = "invalid-enrollment";
  const keys = [
    "workspaceId",
    "generation",
    "phase",
    "registryRevision",
    "inspectedAt",
    "ledger",
    "references",
    "unknowns",
    "evidence",
  ];
  if (!shape(c, code, "/input", input, keys)) {
    return c.result();
  }
  present(input, "workspaceId", (id) => trimmed(c, code, "/input/workspaceId", id));
  present(input, "generation", (generation) =>
    integer(c, code, "/input/generation", generation, 1),
  );
  present(input, "phase", (phase) =>
    member(c, code, "/input/phase", phase, ["prepared", "active"]),
  );
  present(input, "registryRevision", (revision) =>
    integer(c, code, "/input/registryRevision", revision),
  );
  present(input, "inspectedAt", (stampValue) =>
    string(c, code, "/input/inspectedAt", stampValue, (text) => Number.isFinite(Date.parse(text))),
  );
  present(input, "ledger", (ledger) => {
    if (!shape(c, code, "/input/ledger", ledger, ["revision", "hash"])) {
      return;
    }
    if (integer(c, code, "/input/ledger/revision", ledger.revision)) {
      // Revision zero is the uninitialized ledger and has no hash.
      if (ledger.revision === 0 && ledger.hash !== null) {
        c.fail(code, "/input/ledger/hash", "mismatch");
      } else if (ledger.revision !== 0) {
        pattern(c, code, "/input/ledger/hash", ledger.hash, HASH);
      }
    }
  });
  present(input, "references", (references) =>
    list(
      c,
      code,
      "/input/references",
      references,
      (entry, item) => {
        if (shape(c, code, item, entry, ["kind", "key"])) {
          present(entry, "kind", (kind) =>
            member(c, code, at(item, "kind"), kind, ENROLLMENT_KINDS),
          );
          present(entry, "key", (key) => trimmed(c, code, at(item, "key"), key));
        }
      },
      { unique: (entry) => (isRecord(entry) ? [entry.kind, entry.key] : undefined) },
    ),
  );
  present(input, "evidence", (evidence) => enrollmentArtifacts(c, "/input/evidence", evidence));
  present(input, "unknowns", (unknowns) =>
    list(
      c,
      code,
      "/input/unknowns",
      unknowns,
      (entry, item) => {
        const fields = ["id", "participantRole", "scope", "parentRole", "reason", "nextBoundary"];
        if (shape(c, code, item, entry, [...fields, "evidence"])) {
          for (const key of fields) {
            present(entry, key, (text) => trimmed(c, code, at(item, key), text));
          }
          present(entry, "evidence", (evidence) =>
            enrollmentArtifacts(c, at(item, "evidence"), evidence),
          );
        }
      },
      { unique: (entry) => (isRecord(entry) ? entry.id : undefined) },
    ),
  );
  if (
    Array.isArray(input.references) &&
    Array.isArray(input.unknowns) &&
    input.references.length + input.unknowns.length === 0
  ) {
    c.fail("empty-enrollment", "/input/references", "empty");
  }
  c.refuse("enrollment-inspection-time", "/input/inspectedAt", "mismatch");
  c.refuse("enrollment-registry-mismatch", "/input/registryRevision", "mismatch");
  c.refuse("enrollment-reference-mismatch", "/input/references", "mismatch");
  return c.result();
}

/** The issue that locates a store refusal with `code`, if this input explains it. */
export function locateIssue(check: InputCheck, code: string): InputIssue | undefined {
  return (
    check.issues.find((issue) => issue.code === code) ??
    check.refusals.find((issue) => issue.code === code)
  );
}
