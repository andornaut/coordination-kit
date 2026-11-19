// The question, hold and decision verbs as the CLI runs them: resolve the caller through the
// registry fence, apply one owner-checked write, then, when the write may have cleared the owner's
// last wake guard, attempt one guarded wake for it. `question answer` also appends the decision
// line to the work file in the main checkout of the caller's repository, left unstaged.
import { readFileSync } from "node:fs";

import { systemGit } from "../status/git.ts";
import type { Store } from "./db.ts";
import {
  appendDecisionLine,
  decisionLine,
  fileDecisionNumbers,
  mainWorkFile,
} from "./decisionLine.ts";
import { type CallerOptions, resolveCaller } from "./identity.ts";
import {
  answerQuestion,
  cancelQuestion,
  type DecisionRow,
  type HoldState,
  type HoldView,
  listDecisions,
  listHolds,
  listQuestions,
  openQuestion,
  type QuestionOption,
  type QuestionState,
  type QuestionView,
  releaseHold,
  requireOwnQuestion,
  setHold,
} from "./questions.ts";
import { registry, type StoreServiceContext, withStore } from "./service.ts";
import { wakeRecipient, type WakeStatus } from "./wake.ts";

export interface QuestionOutput {
  readonly schema: 1;
  readonly question: QuestionView;
  readonly duplicate: boolean;
}

export interface AnswerOutput extends QuestionOutput {
  readonly decision: DecisionRow;
  /** The work file in the main checkout, changed and left unstaged. */
  readonly workFile: { readonly path: string; readonly written: boolean };
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
  },
): Promise<QuestionOutput> {
  const actor = resolveCaller(registry(context), context.env, options);
  return withStore(context, (store) => ({ ...openQuestion(store, actor, request), schema: 1 }));
}

/**
 * Close the caller's own question with a decision: the store row first, then the work-file line.
 * Every precondition of the line (main checkout on `main`, the file and its Decisions section) is
 * checked before the store write. Repeating the same answer writes the line if it is missing.
 */
export async function storeQuestionAnswer(
  context: StoreServiceContext,
  options: CallerOptions,
  id: string,
  request: {
    readonly work: string;
    readonly text: string;
    readonly by?: string;
    readonly supersedes?: string;
  },
): Promise<AnswerOutput> {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, options);
  return withStore(context, async (store) => {
    // The question's owner is checked before any Git or file read names the caller's repository.
    requireOwnQuestion(store, actor, id);
    const target = mainWorkFile(
      systemGit(context.env),
      context.layout,
      roles,
      actor.role,
      request.work,
    );
    const answer = answerQuestion(store, actor, id, {
      ...request,
      fileNumbers: fileDecisionNumbers(readFileSync(target.path, "utf8")),
    });
    const { decision } = answer;
    const written = appendDecisionLine(
      target.path,
      answer.n,
      decisionLine({
        at: decision.at,
        by: decision.by,
        n: answer.n,
        question: decision.question,
        supersedes: decision.supersedes === null ? null : decision.supersedes.split("/").at(-1)!,
        text: decision.text,
      }),
    );
    return {
      decision,
      duplicate: answer.duplicate,
      question: answer.question,
      schema: 1 as const,
      wake: await wakeOwner(context, store, actor.role),
      workFile: { path: target.path, written },
    };
  });
}

export async function storeQuestionCancel(
  context: StoreServiceContext,
  options: CallerOptions,
  id: string,
  reason: string,
): Promise<QuestionOutput & { readonly wake: { readonly status: WakeStatus } }> {
  const actor = resolveCaller(registry(context), context.env, options);
  return withStore(context, async (store) => {
    const result = cancelQuestion(store, actor, id, reason);
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
