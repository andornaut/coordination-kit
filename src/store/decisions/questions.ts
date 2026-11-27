// Questions, holds and decisions over the store. A question is a pending prompt owned by one role;
// answering it records a typed decision linked to a work item. A hold is owned by the role that
// set it and only that role releases it. Every writer trusts its `actor`: the CLI resolves it
// through the registry fence first, and these functions refuse any other owner's record.
import type { Layout } from "../../core/configuration/layout.ts";
import type { Harness } from "../../registry/schema.ts";
import type { Store } from "../db.ts";
import { payloadText as text } from "../eventCodec.ts";
import type { Cell, ProjectionRow } from "../projectionIndex.ts";
import { handoffHoldId } from "../projections/handoffs.ts";
import { holdOpen } from "../projections/questions.ts";
import { secretShape } from "../secrets.ts";
import {
  type Actor,
  type CodexQuestionInput,
  ensure,
  type Json,
  type JsonObject,
  ROLE,
  type WakeGuard,
  type WorkRef,
} from "../types.ts";
import { WORK_ID } from "../work-records/work.ts";
import { type CodexQuestion, normalizeCodexQuestion, readCodexQuestion } from "./codexQuestions.ts";
import {
  HOLD_STATES,
  type HoldState,
  type HoldView,
  policyHoldEntries,
  policyHoldIdExists,
  type PolicyHoldView,
  policyTargetCoversRole,
} from "./policyHolds.ts";

/**
 * Question and hold IDs: role-scoped `q-<role>-<n>` when generated, else lower-case letters, digits
 * and `-`, so a decision line's `answers` names any question.
 */
export const RECORD_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
/** A hold ID as `hold release` accepts it, including imported `approval-ledger:<id>` holds. */
const HOLD_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DECISION_REF = /^D([1-9][0-9]{0,5})$/;
const BY = ROLE;
const GAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOME_PATH = /\/(?:home|Users)\/[A-Za-z0-9._-]+|(?<![\w.-])\/root(?=\/)/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const MAX_OPTIONS = 8;

export type QuestionState = "pending" | "answered" | "cancelled";
export const QUESTION_STATES: readonly QuestionState[] = ["pending", "answered", "cancelled"];

export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface QuestionView {
  readonly id: string;
  readonly role: string;
  readonly title: string;
  readonly work: string | null;
  readonly options: readonly QuestionOption[] | null;
  readonly state: QuestionState;
  readonly openedAt: string;
  readonly closedAt: string | null;
  /** The decision that answered it. */
  readonly decision: string | null;
  /** The cancellation reason. */
  readonly reason: string | null;
  /** Durable answer and the latest Markdown projection outcome, when tracked. */
  readonly answer?: RecordedAnswer;
  readonly codex?: CodexQuestion;
}

/** A typed decision record, the store mirror of a work file's `- D<n> (...)` line. */
export interface DecisionRow {
  /** `<work>/D<n>`. */
  readonly id: string;
  readonly work: string;
  readonly question: string;
  readonly by: string;
  readonly at: string;
  /** The role whose binding recorded it: the question's owner. */
  readonly role: string;
  /** `<work>/D<k>`, or null. */
  readonly supersedes: string | null;
  readonly text: string;
}

export interface RecordedAnswer {
  readonly at: string;
  readonly by: string;
  readonly supersedes: string | null;
  readonly text: string;
  readonly work: string;
  readonly projection: {
    readonly status: "pending" | "failed" | "applied";
    readonly reason: string | null;
  };
}

type Row = ProjectionRow;
type Reader = Pick<Store, "index">;

function ownerOf(actor: Actor): string {
  ensure(actor.role !== null && ROLE.test(actor.role), "invalid-actor");
  return actor.role;
}

/** One line of private store text: a title, reason or option. */
function storeText(value: string, max: number, code: string): string {
  ensure(
    typeof value === "string" &&
      value.trim() !== "" &&
      value.length <= max &&
      !/[\r\n]/.test(value),
    code,
  );
  ensure(secretShape(value) === null, "secret-shaped-body");
  return value;
}

/**
 * Decision text goes into a public work file: one line with no secret shape, home-directory path,
 * UUID or `hostname`, this machine's host name as the caller read it; the host name is never
 * stored.
 */
export function publicText(hostname: string, value: string): string {
  storeText(value, 1000, "invalid-text");
  const host = hostname.toLowerCase();
  ensure(
    !HOME_PATH.test(value) &&
      !UUID.test(value) &&
      (host.length < 3 || !value.toLowerCase().includes(host)),
    "text-not-public",
  );
  return value;
}

function withAnswer(store: Reader, row: Row): Row {
  const answer = store.index.get("question_answers", [row.id!]);
  return answer === undefined
    ? row
    : {
        ...row,
        answer_at: answer.at!,
        answer_by: answer.by!,
        answer_reason: answer.reason!,
        answer_status: answer.status!,
        answer_supersedes: answer.supersedes!,
        answer_text: answer.text!,
        answer_work: answer.work!,
      };
}

function questionRow(store: Reader, id: string): Row | undefined {
  const row = store.index.get("questions", [id]);
  return row === undefined ? undefined : withAnswer(store, row);
}

function recordedAnswer(row: Row): RecordedAnswer | undefined {
  if (row.answer_at == null) {
    return undefined;
  }
  return {
    at: row.answer_at as string,
    by: row.answer_by as string,
    projection: {
      reason: row.answer_reason as string | null,
      status: row.answer_status as RecordedAnswer["projection"]["status"],
    },
    supersedes: row.answer_supersedes as string | null,
    text: row.answer_text as string,
    work: row.answer_work as string,
  };
}

function parseOptions(value: Cell | undefined): QuestionOption[] | null {
  return value == null ? null : (JSON.parse(value as string) as QuestionOption[]);
}

function questionView(store: Reader, row: Row): QuestionView {
  const nullable = (key: string) => (row[key] as string | null) ?? null;
  const answer = recordedAnswer(row);
  const codex = readCodexQuestion(store, row.id as string);
  return {
    ...(answer === undefined ? {} : { answer }),
    closedAt: nullable("closed_at"),
    ...(codex === undefined ? {} : { codex }),
    decision: nullable("decision"),
    id: row.id as string,
    openedAt: row.opened_at as string,
    options: parseOptions(row.options),
    reason: nullable("reason"),
    role: row.role as string,
    state: row.state as QuestionState,
    title: row.title as string,
    work: nullable("work"),
  };
}

/** Options as a structured prompt shows them: 1 to 8, each a label and an optional description. */
export function normalizeOptions(raw: unknown): QuestionOption[] {
  ensure(Array.isArray(raw) && raw.length >= 1 && raw.length <= MAX_OPTIONS, "invalid-options");
  return raw.map((item: unknown) => {
    if (typeof item === "string") {
      return { label: storeText(item, 200, "invalid-options") };
    }
    ensure(typeof item === "object" && item !== null && !Array.isArray(item), "invalid-options");
    const { description, label, ...rest } = item as Record<string, unknown>;
    ensure(Object.keys(rest).length === 0 && typeof label === "string", "invalid-options");
    ensure(description === undefined || typeof description === "string", "invalid-options");
    return {
      label: storeText(label, 200, "invalid-options"),
      ...(description === undefined
        ? {}
        : { description: storeText(description, 1000, "invalid-options") }),
    };
  });
}

/** A comparable form of an option list; the stored copy has its keys sorted. */
function optionsKey(options: readonly QuestionOption[] | null): string {
  return JSON.stringify(
    options?.map((option) => [option.label, option.description ?? null]) ?? null,
  );
}

/** The next role-scoped ID, `q-<role>-<n>`, with `/` in a game role written as `-`. */
function nextQuestionId(store: Store, role: string): string {
  const prefix = `q-${role.replaceAll("/", "-")}-`;
  const rows = store.index.rows("questions").filter((row) => (row.id as string).startsWith(prefix));
  let max = 0;
  for (const row of rows) {
    const rest = (row.id as string).slice(prefix.length);
    if (/^[1-9][0-9]*$/.test(rest)) {
      max = Math.max(max, Number(rest));
    }
  }
  return `${prefix}${max + 1}`;
}

export interface OpenInput {
  readonly codex?: CodexQuestionInput;
  /** The opener's effective harness, recorded on the event. */
  readonly harness?: Harness;
  readonly id?: string;
  readonly title: string;
  readonly work?: string;
  readonly options?: readonly QuestionOption[];
}

export interface QuestionResult {
  readonly question: QuestionView;
  /** The same open, answer or cancel was already recorded; nothing was written. */
  readonly duplicate: boolean;
}

/**
 * Record a pending prompt owned by the caller's role. Without `id` it gets the next role-scoped
 * ID. Reopening an ID with identical owner, title, work and options is a no-op; any other reuse is
 * `id-conflict`. The native prompt itself is never touched.
 */
export function openQuestion(store: Store, actor: Actor, input: OpenInput): QuestionResult {
  const role = ownerOf(actor);
  ensure(input.id === undefined || RECORD_ID.test(input.id), "invalid-id");
  ensure(input.work === undefined || WORK_ID.test(input.work), "invalid-work");
  const codex = input.codex === undefined ? undefined : normalizeCodexQuestion(actor, input.codex);
  const title = codex === undefined ? storeText(input.title, 500, "invalid-title") : input.title;
  if (codex !== undefined) {
    ensure(
      title.trim() !== "" &&
        title.isWellFormed() &&
        Buffer.byteLength(title, "utf8") <= 4096 &&
        !/[\r\0]/.test(title),
      "invalid-title",
    );
    ensure(secretShape(title) === null, "secret-shaped-body");
  }
  const options = input.options === undefined ? null : normalizeOptions(input.options);
  return store.transaction(() => {
    const id = input.id ?? nextQuestionId(store, role);
    const existing = questionRow(store, id);
    if (existing !== undefined) {
      const prior = readCodexQuestion(store, id);
      ensure(
        existing.role === role &&
          JSON.stringify(prior?.dependsOn ?? []) === JSON.stringify(codex?.dependsOn ?? []) &&
          existing.title === title &&
          ((existing.work as string | null) ?? null) === (input.work ?? null) &&
          optionsKey(parseOptions(existing.options)) === optionsKey(options),
        "id-conflict",
      );
      return { duplicate: true, question: questionView(store, existing) };
    }
    store.append({
      actor,
      key: `question.opened:${id}`,
      kind: "question.opened",
      payload: {
        ...(codex === undefined ? {} : { codex: codex as unknown as Json }),
        ...(input.harness === undefined ? {} : { harness: input.harness }),
        id,
        options: options as unknown as Json,
        role,
        title,
        work: input.work ?? null,
      },
    });
    return { duplicate: false, question: questionView(store, questionRow(store, id)!) };
  });
}

/** The caller's own question, or `missing` and `not-owner`. */
function ownQuestion(store: Store, actor: Actor, id: string): Row {
  const role = ownerOf(actor);
  ensure(RECORD_ID.test(id), "invalid-id");
  const row = questionRow(store, id);
  ensure(row !== undefined, "missing");
  ensure(row.role === role, "not-owner");
  return row;
}

function decisionRow(row: Row): DecisionRow {
  return {
    at: row.at as string,
    by: row.by as string,
    id: row.id as string,
    question: row.question as string,
    role: row.role as string,
    supersedes: (row.supersedes as string | null) ?? null,
    text: row.text as string,
    work: row.work as string,
  };
}

export interface AnswerInput {
  readonly work: string;
  readonly text: string;
  /** `user` unless another decider is named. */
  readonly by?: string;
  /** `D<k>` of the same work item. */
  readonly supersedes?: string;
  /** Decision numbers the work file already uses; the new one takes the next free number. */
  readonly fileNumbers?: readonly number[];
}

/** An owned question's recorded work can supply the answer's target. */
export type AnswerRequest = Omit<AnswerInput, "work"> & { readonly work?: string };

export interface AnswerResult extends QuestionResult {
  readonly decision: DecisionRow;
  /** The decision's number in its work item. */
  readonly n: number;
}

type AnswerDetails = Pick<RecordedAnswer, "by" | "supersedes" | "text" | "work">;

function validatedAnswer(hostname: string, input: AnswerInput): AnswerDetails {
  ensure(WORK_ID.test(input.work), "invalid-work");
  const decisionText = publicText(hostname, input.text);
  const by = input.by ?? "user";
  ensure(BY.test(by), "invalid-by");
  const ref = input.supersedes === undefined ? null : DECISION_REF.exec(input.supersedes);
  ensure(input.supersedes === undefined || ref !== null, "invalid-supersedes");
  return {
    by,
    supersedes: ref === null ? null : `${input.work}/D${ref[1]}`,
    text: decisionText,
    work: input.work,
  };
}

function matchesAnswer(recorded: AnswerDetails | undefined, answer: AnswerDetails): boolean {
  return (
    recorded?.work === answer.work &&
    recorded.text === answer.text &&
    recorded.by === answer.by &&
    recorded.supersedes === answer.supersedes
  );
}

function linkedDecision(store: Store, question: Row): Row | undefined {
  return question.decision == null ? undefined : store.index.get("decisions", [question.decision]);
}

/** Return the caller's numbered decision when it has already been allocated. */
export function getQuestionDecision(store: Store, actor: Actor, id: string): DecisionRow | null {
  const row = linkedDecision(store, ownQuestion(store, actor, id));
  return row === undefined ? null : decisionRow(row);
}

/**
 * Record the exact answer independently of numbering and filesystem access, or verify a retry.
 * The owning role answers from any binding; native evidence never gates it.
 */
export function recordQuestionAnswer(
  hostname: string,
  store: Store,
  actor: Actor,
  id: string,
  input?: AnswerRequest,
): QuestionResult {
  return store.transaction(() => {
    const row = ownQuestion(store, actor, id);
    const existing = recordedAnswer(row);
    const legacy = linkedDecision(store, row);
    const previous = existing ?? (legacy === undefined ? undefined : decisionRow(legacy));
    if (input === undefined) {
      ensure(previous !== undefined, "question-unanswered");
    }
    const work = input?.work ?? (row.work as string | null) ?? previous?.work;
    ensure(work !== undefined, "question-work-required");
    const answer = input === undefined ? previous! : validatedAnswer(hostname, { ...input, work });
    ensure(row.work == null || row.work === answer.work, "work-mismatch");
    const duplicate = row.state !== "pending";
    ensure(!duplicate || matchesAnswer(previous, answer), "already-closed");
    if (existing === undefined) {
      ensure(
        duplicate || readCodexQuestion(store, id) === undefined || answer.by === "user",
        "invalid-by",
      );
      store.append({
        actor,
        key: `question.answer-recorded:${id}`,
        kind: "question.answer-recorded",
        payload: {
          ...(previous === undefined ? {} : { answeredAt: previous.at }),
          by: answer.by,
          id,
          supersedes: answer.supersedes,
          text: answer.text,
          work: answer.work,
        },
      });
    }
    return { duplicate, question: questionView(store, questionRow(store, id)!) };
  });
}

function numberDecision(
  store: Store,
  actor: Actor,
  id: string,
  answer: AnswerDetails,
  fileNumbers: readonly number[],
): AnswerResult {
  const row = ownQuestion(store, actor, id);
  ensure(
    row.state !== "pending" || readCodexQuestion(store, id) === undefined || answer.by === "user",
    "invalid-by",
  );
  ensure(row.work == null || row.work === answer.work, "work-mismatch");
  const receipt = recordedAnswer(row);
  const recorded = linkedDecision(store, row);
  if (recorded !== undefined) {
    const decision = decisionRow(recorded);
    ensure(matchesAnswer(decision, answer), "already-closed");
    return { decision, duplicate: true, n: Number(recorded.n), question: questionView(store, row) };
  }
  ensure(row.state === "pending" || matchesAnswer(receipt, answer), "already-closed");
  const answerSeq = Number(store.index.get("question_answers", [id])?.seq ?? Infinity);
  const predecessor = store.index.rows("question_answers").some((item) => {
    if (item.work !== answer.work || Number(item.seq) >= answerSeq) {
      return false;
    }
    const question = store.index.get("questions", [item.id!]);
    return question !== undefined && question.decision == null;
  });
  ensure(!predecessor, "decision-predecessor-pending");
  const stored = store.index
    .rows("decisions")
    .filter((item) => item.work === answer.work)
    .map((item) => Number(item.n));
  const known = new Set([...stored, ...fileNumbers]);
  const superseded = answer.supersedes?.split("/D").at(-1);
  ensure(superseded === undefined || known.has(Number(superseded)), "invalid-supersedes");
  const n = Math.max(0, ...known) + 1;
  ensure(n <= 999999, "decision-numbers-exhausted");
  store.append({
    actor,
    key: `question.answered:${id}`,
    kind: "question.answered",
    payload: {
      ...(receipt === undefined ? {} : { answeredAt: receipt.at }),
      by: answer.by,
      id,
      n,
      role: row.role as string,
      supersedes: answer.supersedes,
      text: answer.text,
      work: answer.work,
    },
  });
  const updated = questionRow(store, id)!;
  return {
    decision: decisionRow(linkedDecision(store, updated)!),
    duplicate: false,
    n,
    question: questionView(store, updated),
  };
}

/** Answer directly when decision numbering is already available to the store caller. */
export function answerQuestion(
  hostname: string,
  store: Store,
  actor: Actor,
  id: string,
  input: AnswerInput,
): AnswerResult {
  const answer = validatedAnswer(hostname, input);
  return store.transaction(() => numberDecision(store, actor, id, answer, input.fileNumbers ?? []));
}

/** Allocate or retrieve a numbered decision for a durable answer under the store write lock. */
export function numberRecordedAnswer(
  store: Store,
  actor: Actor,
  id: string,
  fileNumbers: readonly number[],
): AnswerResult {
  return store.transaction(() => {
    const receipt = recordedAnswer(ownQuestion(store, actor, id));
    ensure(receipt !== undefined, "question-unanswered");
    return numberDecision(store, actor, id, receipt, fileNumbers);
  });
}

/** Record a changed projection outcome; repeated identical observations are no-ops. */
export function recordQuestionProjection(
  store: Store,
  actor: Actor,
  id: string,
  projection: RecordedAnswer["projection"],
): QuestionView {
  return store.transaction(() => {
    const row = ownQuestion(store, actor, id);
    const receipt = recordedAnswer(row);
    ensure(receipt !== undefined, "question-unanswered");
    if (
      receipt.projection.status !== projection.status ||
      receipt.projection.reason !== projection.reason
    ) {
      store.append({
        actor,
        key: `question.projection:${id}:${store.head().seq + 1}`,
        kind: "question.projection",
        payload: { id, ...projection },
      });
    }
    return questionView(store, questionRow(store, id)!);
  });
}

/**
 * Cancel the caller's own pending question with a reason. The owning role cancels from any
 * binding; native evidence never gates it. Repeating the same cancel is a no-op.
 */
export function cancelQuestion(
  store: Store,
  actor: Actor,
  id: string,
  reason: string,
): QuestionResult {
  const why = storeText(reason, 1000, "invalid-reason");
  return store.transaction(() => {
    const row = ownQuestion(store, actor, id);
    if (row.state !== "pending") {
      ensure(row.state === "cancelled" && row.reason === why, "already-closed");
      return { duplicate: true, question: questionView(store, row) };
    }
    store.append({
      actor,
      key: `question.cancelled:${id}`,
      kind: "question.cancelled",
      payload: { id, reason: why },
    });
    return { duplicate: false, question: questionView(store, questionRow(store, id)!) };
  });
}

/**
 * CLEANUP (added 2026-11-25): remove `question close-legacy` once no pending question opened
 * under a Codex binding remains in the live store.
 *
 * Close the caller's own pending question opened under a Codex binding, citing the explicit user
 * approval for the close. It appends `question.cancelled` with the reason and the approval
 * reference. A question opened on Claude is `legacy-question-required`. Repeating the same close
 * is a no-op.
 */
export function closeLegacyQuestion(
  store: Store,
  actor: Actor,
  input: { readonly id: string; readonly reason: string; readonly approval: string },
): QuestionResult & { readonly approval: string } {
  const why = storeText(input.reason, 1000, "invalid-reason");
  const approval = storeText(input.approval, 1000, "invalid-approval");
  const { id } = input;
  return store.transaction(() => {
    const row = ownQuestion(store, actor, id);
    ensure(
      readCodexQuestion(store, id) !== undefined &&
        store.eventByKey(`question.opened:${id}`)?.payload.harness !== "claude",
      "legacy-question-required",
    );
    if (row.state !== "pending") {
      ensure(
        row.state === "cancelled" &&
          row.reason === why &&
          store.eventByKey(`question.cancelled:${id}`)?.payload.approval === approval,
        "already-closed",
      );
      return { approval, duplicate: true, question: questionView(store, row) };
    }
    store.append({
      actor,
      key: `question.cancelled:${id}`,
      kind: "question.cancelled",
      payload: { approval, id, reason: why },
    });
    return { approval, duplicate: false, question: questionView(store, questionRow(store, id)!) };
  });
}

/** Questions in opening order, optionally of one owner and in the given states. */
export function listQuestions(
  store: Reader,
  filter: { readonly role?: string; readonly states?: readonly QuestionState[] } = {},
): QuestionView[] {
  const states = filter.states ?? QUESTION_STATES;
  return store.index
    .rows("questions")
    .filter(
      (row) =>
        (filter.role === undefined || filter.role === row.role) &&
        states.includes(row.state as QuestionState),
    )
    .sort((a, b) => Number(a.opened_seq) - Number(b.opened_seq))
    .map((row) => questionView(store, withAnswer(store, row)));
}

/** Decision records in recording order, optionally of one work item and one owning role. */
export function listDecisions(
  store: Reader,
  filter: { readonly work?: string; readonly role?: string } = {},
): DecisionRow[] {
  return store.index
    .rows("decisions")
    .filter(
      (row) =>
        (filter.work === undefined || filter.work === row.work) &&
        (filter.role === undefined || filter.role === row.role),
    )
    .sort((a, b) => Number(a.seq) - Number(b.seq))
    .map(decisionRow);
}

/** Validate a new work, role or app hold scope. */
export function holdScope(scope: string): string {
  const [kind, ref, ...rest] = scope.split(":");
  ensure(
    rest.length === 0 &&
      ((kind === "role" && ref === undefined) ||
        (kind === "work" && ref !== undefined && WORK_ID.test(ref)) ||
        (kind === "app" && ref !== undefined && GAME.test(ref))),
    "invalid-scope",
  );
  return scope;
}

function holdRow(store: Store, id: string): Row | undefined {
  return store.index.get("holds", [id]);
}

function holdView(row: Row): HoldView {
  return {
    id: row.id as string,
    reason: row.reason as string,
    releasedAt: (row.released_at as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    scope: row.scope as string,
    setAt: row.set_at as string,
    source: (row.source as string | null) ?? null,
    state: row.state as HoldState,
  };
}

export interface HoldResult {
  readonly hold: HoldView;
  readonly duplicate: boolean;
}

/**
 * Set a hold owned by the caller's role. Setting the same ID again with identical owner, scope and
 * reason while it is active is a no-op; any other reuse, including after release, is `id-conflict`.
 */
export function setHold(
  store: Store,
  actor: Actor,
  input: { readonly id: string; readonly scope: string; readonly reason: string },
): HoldResult {
  const role = ownerOf(actor);
  ensure(RECORD_ID.test(input.id), "invalid-id");
  const scope = holdScope(input.scope);
  const reason = storeText(input.reason, 1000, "invalid-reason");
  return store.transaction(() => {
    const existing = holdRow(store, input.id);
    if (existing !== undefined) {
      ensure(
        existing.state === "active" &&
          existing.role === role &&
          existing.scope === scope &&
          existing.reason === reason,
        "id-conflict",
      );
      return { duplicate: true, hold: holdView(existing) };
    }
    ensure(!policyHoldIdExists(store, input.id), "id-conflict");
    store.append({
      actor,
      key: `hold.set:${input.id}`,
      kind: "hold.set",
      payload: { id: input.id, reason, role, scope },
    });
    return { duplicate: false, hold: holdView(holdRow(store, input.id)!) };
  });
}

/** Release the caller's own hold. Only its owner can; repeating a release is a no-op. */
export function releaseHold(store: Store, actor: Actor, id: string): HoldResult {
  const role = ownerOf(actor);
  ensure(HOLD_REF.test(id), "invalid-id");
  return store.transaction(() => {
    const row = holdRow(store, id);
    ensure(row !== undefined, "missing");
    ensure(row.role === role, "not-owner");
    if (row.state === "released") {
      return { duplicate: true, hold: holdView(row) };
    }
    store.append({ actor, key: `hold.released:${id}`, kind: "hold.released", payload: { id } });
    return { duplicate: false, hold: holdView(holdRow(store, id)!) };
  });
}

/** Holds in setting order, optionally of one owner and in the given states. */
export function listHolds(
  store: Reader,
  filter: { readonly role?: string; readonly states?: readonly HoldState[] } = {},
  layout?: Layout,
): HoldView[] {
  const states = filter.states ?? HOLD_STATES;
  const rows = store.index
    .rows("holds")
    .filter(
      (row) =>
        (filter.role === undefined || filter.role === row.role) &&
        states.includes(row.state as HoldState),
    );
  const policy = policyHoldEntries(store, states).filter(
    ({ hold }) =>
      filter.role === undefined || policyTargetCoversRole(hold.policy.target, filter.role, layout),
  );
  return [...rows.map((row) => ({ hold: holdView(row), seq: Number(row.set_seq) })), ...policy]
    .sort((a, b) => a.seq - b.seq)
    .map(({ hold }) => hold);
}

type GuardResult = WakeGuard & {
  readonly blocker?: {
    readonly kind: "question" | "hold" | "policy-hold";
    readonly id: string;
    readonly owner: string;
    readonly native?: { readonly turnId: string; readonly itemId: string };
  };
};

/**
 * The store wake guard for send-time wakes: a recipient with a pending question, an active `role`
 * hold or a policy hold for its exact role or app gets no wake. A wake never answers or clears
 * either. The scheduled review wakes with `holdGuard` instead, so a pending question delays a
 * wake by at most one review slot.
 */
export function questionHoldGuard(
  store: Store,
  role: string,
  harness?: string | null,
  layout?: Layout,
): GuardResult {
  const pending = store.index
    .rows("questions")
    .filter((row) => row.role === role && row.state === "pending")
    .sort((a, b) => Number(a.opened_seq) - Number(b.opened_seq))[0];
  if (pending === undefined) {
    return holdGuard(store, role, harness, layout);
  }
  const id = pending.id as string;
  const native = readCodexQuestion(store, id)?.native;
  return {
    blocker: {
      id,
      kind: "question",
      owner: role,
      ...(native == null ? {} : { native: { itemId: native.item, turnId: native.turn } }),
    },
    reason: "recipient-question-pending",
    status: "blocked",
  };
}

/** The wake guard without the pending-question check: role holds and policy holds only. */
export function holdGuard(
  store: Store,
  role: string,
  harness?: string | null,
  layout?: Layout,
): GuardResult {
  const policy = policyHoldEntries(store, ["active"]).find(({ hold }) =>
    policyTargetCoversRole(hold.policy.target, role, layout),
  );
  if (policy !== undefined) {
    return {
      blocker: { id: policy.hold.id, kind: "policy-hold", owner: policy.hold.policy.issuer },
      reason: "recipient-policy-hold-active",
      status: "blocked",
    };
  }
  // A handoff hold quiets the source. The target must be woken to release that hold.
  const targetHolds = new Set(
    store.index
      .rows("handoff_roles")
      .filter(
        (row) =>
          row.role === role &&
          store.index.get("handoffs", [row.handoff!])?.to_harness === (harness ?? ""),
      )
      .map((row) => handoffHoldId(row.handoff as string, role)),
  );
  const hold = store.index
    .rows("holds")
    .filter(
      (row) =>
        row.role === role &&
        row.scope === "role" &&
        row.state === "active" &&
        !targetHolds.has(row.id as string),
    )
    .sort((a, b) => Number(a.set_seq) - Number(b.set_seq))[0];
  return hold === undefined
    ? { status: "clear" }
    : {
        blocker: { id: hold.id as string, kind: "hold", owner: role },
        reason: "recipient-hold-active",
        status: "blocked",
      };
}

/**
 * The `work start` and `work show` hold port: active holds that cover the item. A `work:` hold
 * covers it by ID (and repository, for an imported hold), a `role` hold when its owner is the
 * item's owner, and an app hold when it matches the item's repository.
 */
export const storeHolds: HoldLookup = (store, ref, cover) => {
  const local = store.index
    .rows("holds")
    .filter((row) => row.state === "active")
    .filter((row) => {
      const scope = row.scope as string;
      if (scope === "role") {
        return cover?.owner != null && row.role === cover.owner;
      }
      if (scope.startsWith("app:") || scope.startsWith("game:")) {
        return cover?.game != null && scope.slice(scope.indexOf(":") + 1) === cover.game;
      }
      return (JSON.parse(row.work as string) as { id: string; repository: string | null }[]).some(
        (item) =>
          item.id === ref.id && (item.repository === null || item.repository === ref.repository),
      );
    })
    .map((row) => ({
      hold: {
        id: row.id as string,
        owner: (row.role as string | null) ?? null,
        reason: row.reason as string,
      },
      seq: Number(row.set_seq),
    }));
  const policy = policyHoldEntries(store, ["active"])
    .filter(({ hold }) => {
      const { target } = hold.policy;
      if (target.kind === "role") {
        return target.role === cover?.owner;
      }
      if (target.kind === "game") {
        return target.game === cover?.game;
      }
      if (target.kind === "app") {
        return target.app === ref.repository;
      }
      return target.id === ref.id && target.repository === ref.repository;
    })
    .map(({ hold, seq }) => ({
      hold: { id: hold.id, owner: hold.policy.issuer, policy: hold.policy, reason: hold.reason },
      seq,
    }));
  return [...local, ...policy].sort((a, b) => a.seq - b.seq).map(({ hold }): CoveringHold => hold);
};

/** An open hold that covers a work item, as `work start` sees it. */
export interface CoveringHold {
  readonly id: string;
  readonly owner: string | null;
  readonly policy?: PolicyHoldView["policy"];
  readonly reason: string | null;
}

/** What else a hold may cover besides the item itself: its owner role and its game. */
export interface HoldCover {
  readonly owner: string | null;
  /** The item's repository when it is a game, else null. */
  readonly game: string | null;
}

/**
 * The hold seam of `work start` and `work show`. The default is the hold records' `storeHolds`
 * `importedHolds` reads only the imported events.
 */
export type HoldLookup = (
  store: Pick<Store, "index" | "events">,
  ref: WorkRef,
  cover?: HoldCover,
) => readonly CoveringHold[];

export const importedHolds: HoldLookup = (store, ref) =>
  store
    .events({ kinds: ["hold.imported"] })
    .filter((event) => holdOpen(text(event.payload, "state")))
    .filter((event) =>
      (Array.isArray(event.payload.work) ? (event.payload.work as readonly JsonObject[]) : []).some(
        (item) => item.repository === ref.repository && item.id === ref.id,
      ),
    )
    .map((event) => ({
      id: text(event.payload, "id") ?? event.key,
      owner: text(event.payload, "owner"),
      reason: text(event.payload, "reason"),
    }));
