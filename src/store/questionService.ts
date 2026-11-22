// The question, hold and decision verbs as the CLI runs them: resolve the caller through the
// registry fence, apply one owner-checked write, then, when the write may have cleared the owner's
// last wake guard, attempt one guarded wake for it. A recorded answer is projected separately
// onto the caller's main work file, left unstaged.
import { readFileSync } from "node:fs";

import { resolveHarness } from "../registry/resolve.ts";
import { systemGit } from "../status/git.ts";
import { type QuestionEvidence, readCodexQuestionEvidence } from "./codexQuestionEvidence.ts";
import {
  type NativeQuestionIdentity,
  nativeQuestionIdentity,
  type NativeQuestionProof,
  requireCodexOwner,
} from "./codexQuestions.ts";
import type { Store } from "./db.ts";
import {
  appendDecisionLine,
  decisionLine,
  fileDecisionNumbers,
  mainWorkFile,
  type WorkFileTarget,
} from "./decisionLine.ts";
import { type CallerOptions, resolveCaller } from "./identity.ts";
import {
  type PolicyHoldInput,
  policyHoldTarget,
  policyTargetCoversRole,
  releasePolicyHold,
  setPolicyHold,
} from "./policyHolds.ts";
import {
  type AnswerInput,
  cancelQuestion,
  type DecisionRow,
  getQuestionDecision,
  type HoldState,
  type HoldView,
  linkNativeQuestion,
  listDecisions,
  listHolds,
  listQuestions,
  numberRecordedAnswer,
  openQuestion,
  type QuestionOption,
  type QuestionState,
  type QuestionView,
  reaskNativeQuestion,
  type RecordedAnswer,
  recordQuestionAnswer,
  recordQuestionProjection,
  releaseHold,
  requireOwnQuestion,
  setHold,
} from "./questions.ts";
import { registry, type StoreServiceContext, withStore } from "./service.ts";
import { type Actor, StoreError } from "./types.ts";
import { wakeRecipient, type WakeStatus } from "./wake.ts";
import type { WorkRef } from "./work.ts";

interface QuestionContext extends StoreServiceContext {
  readonly questionEvidence?: QuestionEvidence;
}

export interface QuestionOutput {
  readonly schema: 1;
  readonly question: QuestionView;
  readonly duplicate: boolean;
}

export interface AnswerProjectionOutput extends QuestionOutput {
  readonly decision: DecisionRow | null;
  /** The main checkout work file, left unstaged when changed. */
  readonly workFile: {
    readonly path: string | null;
    readonly written: boolean;
    readonly status: RecordedAnswer["projection"]["status"];
    readonly reason: string | null;
  };
}

export interface AnswerOutput extends AnswerProjectionOutput {
  readonly wake: { readonly status: WakeStatus };
}

export interface HoldOutput {
  readonly schema: 1;
  readonly hold: HoldView;
  readonly duplicate: boolean;
}

/** One guarded wake for `role`, which wakes only when it is wake-pending with undelivered messages. */
export async function wakeOwner(
  context: StoreServiceContext,
  store: Store,
  role: string,
): Promise<{ readonly status: WakeStatus }> {
  const wake = await wakeRecipient(
    {
      env: context.env,
      layout: context.layout,
      store,
      ...(context.ports === undefined ? {} : { ports: context.ports }),
    },
    role,
  );
  return { status: wake.status };
}

export async function storeQuestionOpen(
  context: StoreServiceContext,
  options: CallerOptions,
  request: {
    readonly id?: string;
    readonly title: string;
    readonly work?: string;
    readonly options?: readonly QuestionOption[];
    readonly dependsOn?: readonly WorkRef[];
  },
): Promise<QuestionOutput> {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, options);
  const codex = resolveHarness(roles, actor.role) === "codex";
  if (!codex && request.dependsOn !== undefined) {
    throw new StoreError("codex-question-required");
  }
  const input = codex
    ? { ...request, codex: { dependsOn: request.dependsOn ?? [], thread: actor.nativeId } }
    : request;
  return withStore(context, (store) => ({ ...openQuestion(store, actor, input), schema: 1 }));
}

function evidence(
  context: QuestionContext,
  question: QuestionView,
  native?: NativeQuestionIdentity | null,
): Promise<NativeQuestionProof> {
  if (native == null) {
    return Promise.resolve({ reason: "native-question-unlinked", status: "unknown" });
  }
  return (
    context.questionEvidence?.(question, native) ??
    readCodexQuestionEvidence(context, question, native)
  );
}

function ownEvidenceQuestion(store: Store, actor: Actor, id: string): QuestionView {
  const question = requireOwnQuestion(store, actor, id);
  if (question.codex !== undefined) {
    requireCodexOwner(actor, question.codex);
  }
  return question;
}

export async function storeQuestionAttach(
  context: QuestionContext,
  options: CallerOptions,
  id: string,
  input: NativeQuestionIdentity,
): Promise<QuestionOutput> {
  const actor = resolveCaller(registry(context), context.env, options);
  const native = nativeQuestionIdentity(input);
  return withStore(
    context,
    async (store) => {
      const question = ownEvidenceQuestion(store, actor, id);
      if (question.codex === undefined) {
        throw new StoreError("codex-question-required");
      }
      return {
        ...linkNativeQuestion(store, actor, id, native, await evidence(context, question, native)),
        schema: 1,
      };
    },
    { createMissing: false },
  );
}

export async function storeQuestionReconcile(
  context: QuestionContext,
  options: CallerOptions,
  id: string,
): Promise<{
  readonly schema: 1;
  readonly question: QuestionView;
  readonly observation: NativeQuestionProof;
  readonly form: "unsupported";
}> {
  const actor = resolveCaller(registry(context), context.env, options);
  return withStore(
    context,
    async (store) => {
      const question = ownEvidenceQuestion(store, actor, id);
      if (question.codex === undefined) {
        throw new StoreError("codex-question-required");
      }
      return {
        form: "unsupported",
        observation: await evidence(context, question, question.codex.native),
        question,
        schema: 1,
      };
    },
    { createMissing: false },
  );
}

export async function storeQuestionReask(
  context: QuestionContext,
  options: CallerOptions,
  id: string,
): Promise<QuestionOutput> {
  const actor = resolveCaller(registry(context), context.env, options);
  return withStore(
    context,
    async (store) => {
      const question = ownEvidenceQuestion(store, actor, id);
      return {
        ...reaskNativeQuestion(
          store,
          actor,
          id,
          await evidence(context, question, question.codex?.native),
        ),
        schema: 1,
      };
    },
    { createMissing: false },
  );
}

function fileResult<T>(operation: () => T): { value: T } | { reason: string } {
  try {
    return { value: operation() };
  } catch (error) {
    return { reason: error instanceof StoreError ? error.code : "work-file-io-failed" };
  }
}

const ALLOCATION_FAILURES = new Set([
  "decision-numbers-exhausted",
  "decision-predecessor-pending",
  "invalid-supersedes",
]);

function projectAnswer(
  store: Store,
  actor: Actor,
  result: { readonly question: QuestionView; readonly duplicate: boolean },
  workFile: () => WorkFileTarget,
): AnswerProjectionOutput {
  const { id } = result.question;
  function finish(
    path: string | null,
    write: { value: boolean } | { reason: string },
  ): AnswerProjectionOutput {
    const projection: RecordedAnswer["projection"] =
      "reason" in write
        ? { reason: write.reason, status: "failed" }
        : { reason: null, status: "applied" };
    return {
      decision: getQuestionDecision(store, actor, id),
      duplicate: result.duplicate,
      question: recordQuestionProjection(store, actor, id, projection),
      schema: 1,
      workFile: { path, written: "value" in write && write.value, ...projection },
    };
  }

  // The receipt is already durable. Numbering commits before the file write, so a retry after a
  // process interruption can always recognise and verify the exact projected line.
  const allocation = store.transaction(() => {
    const file = fileResult(workFile);
    if ("reason" in file) {
      return finish(null, file);
    }
    const { path } = file.value;
    const numbers = fileResult(() => fileDecisionNumbers(readFileSync(path, "utf8")));
    if ("reason" in numbers) {
      return finish(path, numbers);
    }
    try {
      return numberRecordedAnswer(store, actor, id, numbers.value);
    } catch (error) {
      if (error instanceof StoreError && ALLOCATION_FAILURES.has(error.code)) {
        return finish(path, { reason: error.code });
      }
      throw error;
    }
  });
  if ("schema" in allocation) {
    return allocation;
  }
  return store.transaction(() => {
    const file = fileResult(workFile);
    if ("reason" in file) {
      return finish(null, file);
    }
    const { path } = file.value;
    const { decision, n } = allocation;
    return finish(
      path,
      fileResult(() =>
        appendDecisionLine(
          path,
          n,
          decisionLine({
            at: decision.at,
            by: decision.by,
            n,
            question: decision.question,
            supersedes: decision.supersedes?.split("/").at(-1) ?? null,
            text: decision.text,
          }),
        ),
      ),
    );
  });
}

function answerProjection(
  context: QuestionContext,
  options: CallerOptions,
  id: string,
  request: AnswerInput | undefined,
  wake: true,
): Promise<AnswerOutput>;
function answerProjection(
  context: QuestionContext,
  options: CallerOptions,
  id: string,
  request: AnswerInput | undefined,
  wake: false,
): Promise<AnswerProjectionOutput>;
function answerProjection(
  context: QuestionContext,
  options: CallerOptions,
  id: string,
  request: AnswerInput | undefined,
  wake: boolean,
): Promise<AnswerProjectionOutput | AnswerOutput> {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, options);
  return withStore(context, async (store) => {
    const question = ownEvidenceQuestion(store, actor, id);
    const proof =
      request !== undefined && question.state === "pending" && question.codex?.native != null
        ? await evidence(context, question, question.codex.native)
        : undefined;
    const result = recordQuestionAnswer(store, actor, id, request, proof);
    const projected = projectAnswer(store, actor, result, () =>
      mainWorkFile(
        systemGit(context.env),
        context.layout,
        roles,
        actor.role,
        result.question.answer!.work,
      ),
    );
    return wake ? { ...projected, wake: await wakeOwner(context, store, actor.role) } : projected;
  });
}

/** Record the explicit answer, then independently attempt its Markdown projection and a wake. */
export function storeQuestionAnswer(
  context: QuestionContext,
  options: CallerOptions,
  id: string,
  request: AnswerInput,
): Promise<AnswerOutput> {
  return answerProjection(context, options, id, request, true);
}

/** Retry only the Markdown projection of the caller's recorded answer. */
export function storeQuestionProject(
  context: StoreServiceContext,
  options: CallerOptions,
  id: string,
): Promise<AnswerProjectionOutput> {
  return answerProjection(context, options, id, undefined, false);
}

export async function storeQuestionCancel(
  context: QuestionContext,
  options: CallerOptions,
  id: string,
  reason: string,
): Promise<QuestionOutput & { readonly wake: { readonly status: WakeStatus } }> {
  const actor = resolveCaller(registry(context), context.env, options);
  return withStore(context, async (store) => {
    const question = ownEvidenceQuestion(store, actor, id);
    const proof =
      question.state === "pending" && question.codex?.native != null
        ? await evidence(context, question, question.codex.native)
        : undefined;
    const result = cancelQuestion(store, actor, id, reason, proof);
    return { ...result, schema: 1 as const, wake: await wakeOwner(context, store, actor.role) };
  });
}

export async function storeQuestionList(
  context: StoreServiceContext,
  filter: { readonly role?: string; readonly states?: readonly QuestionState[] },
): Promise<{ readonly schema: 1; readonly questions: readonly QuestionView[] }> {
  return withStore(
    context,
    (store) => ({ questions: listQuestions(store, filter), schema: 1 as const }),
    { createMissing: false },
  );
}

export async function storeHoldSet(
  context: StoreServiceContext,
  options: CallerOptions,
  request: { readonly id: string; readonly scope: string; readonly reason: string },
): Promise<HoldOutput> {
  const actor = resolveCaller(registry(context), context.env, options);
  return withStore(context, (store) => ({ ...setHold(store, actor, request), schema: 1 as const }));
}

export async function storeHoldRelease(
  context: StoreServiceContext,
  options: CallerOptions,
  id: string,
): Promise<HoldOutput & { readonly wake: { readonly status: WakeStatus } }> {
  const actor = resolveCaller(registry(context), context.env, options);
  return withStore(context, async (store) => {
    const result = releaseHold(store, actor, id);
    return { ...result, schema: 1 as const, wake: await wakeOwner(context, store, actor.role) };
  });
}

function policyIssuer(context: StoreServiceContext, options: CallerOptions) {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, options);
  const binding = roles.roles[actor.role]!;
  if (
    actor.role !== "game-coordinator" ||
    actor.worker !== undefined ||
    binding.ownership !== "active" ||
    binding.phase === "held" ||
    binding.phase === "source-held"
  ) {
    throw new StoreError("not-coordinator");
  }
  return { actor, roles };
}

export async function storePolicyHoldSet(
  context: StoreServiceContext,
  options: CallerOptions,
  request: PolicyHoldInput,
): Promise<HoldOutput> {
  const { actor, roles } = policyIssuer(context, options);
  const target = policyHoldTarget(request.scope);
  const { games, kits } = context.layout.config;
  if (target.kind === "role" && !Object.hasOwn(roles.roles, target.role)) {
    throw new StoreError("policy-role-unregistered");
  }
  if (target.kind === "game" && !Object.hasOwn(games, target.game)) {
    throw new StoreError("policy-game-unregistered");
  }
  if (
    target.kind === "work" &&
    target.repository !== "game-coordinator" &&
    !Object.hasOwn(games, target.repository) &&
    !Object.hasOwn(kits, target.repository)
  ) {
    throw new StoreError("policy-repository-unregistered");
  }
  return withStore(context, (store) => ({ ...setPolicyHold(store, actor, request), schema: 1 }));
}

export async function storePolicyHoldRelease(
  context: StoreServiceContext,
  options: CallerOptions,
  request: { readonly id: string; readonly approval: string },
): Promise<
  HoldOutput & {
    readonly wakes: readonly { readonly role: string; readonly status: WakeStatus }[];
  }
> {
  const { actor, roles } = policyIssuer(context, options);
  return withStore(context, async (store) => {
    const result = releasePolicyHold(store, actor, request);
    const targets = Object.keys(roles.roles)
      .sort()
      .filter((role) => policyTargetCoversRole(result.hold.policy.target, role));
    const wakes = await Promise.all(
      targets.map(async (role) => ({ role, ...(await wakeOwner(context, store, role)) })),
    );
    return { ...result, schema: 1, wakes };
  });
}

export async function storeHoldList(
  context: StoreServiceContext,
  filter: { readonly role?: string; readonly states?: readonly HoldState[] },
): Promise<{ readonly schema: 1; readonly holds: readonly HoldView[] }> {
  return withStore(context, (store) => ({ holds: listHolds(store, filter), schema: 1 as const }), {
    createMissing: false,
  });
}

export async function storeDecisionList(
  context: StoreServiceContext,
  filter: { readonly work?: string; readonly role?: string },
): Promise<{ readonly schema: 1; readonly decisions: readonly DecisionRow[] }> {
  return withStore(
    context,
    (store) => ({ decisions: listDecisions(store, filter), schema: 1 as const }),
    { createMissing: false },
  );
}
