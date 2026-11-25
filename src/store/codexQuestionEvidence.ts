import { performance } from "node:perf_hooks";

import { collectQuestionState } from "../adapters/codex/collectors/questionState.ts";
import { connectControl } from "../adapters/codex/rpc.ts";
import { decisionDirectory, decisionRecord } from "../adapters/shared/decisions.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import type { Layout } from "../core/layout.ts";
import { nativeQuestionObservation, unknownProof } from "./codexQuestionObservation.ts";
import type { NativeQuestionProof } from "./codexQuestions.ts";
import type { QuestionView } from "./questions.ts";
import type { NativeQuestionIdentity } from "./types.ts";

interface EvidenceContext {
  readonly env: NodeJS.ProcessEnv;
  readonly layout: Layout;
}

export type QuestionEvidence = (
  question: QuestionView,
  native: NativeQuestionIdentity,
) => Promise<NativeQuestionProof>;

/** Use the bounded read-only collector. No available method proves cancellation or reopens a form. */
export async function readCodexQuestionEvidence(
  context: EvidenceContext,
  question: QuestionView,
  native: NativeQuestionIdentity,
): Promise<NativeQuestionProof> {
  const thread = question.codex?.thread;
  if (thread === undefined) {
    return unknownProof("native-question-unlinked");
  }
  let socket: string;
  try {
    socket = resolveCodexControlSocket({ env: context.env }).path;
  } catch {
    return unknownProof("native-endpoint-unavailable");
  }
  const directory = decisionDirectory(context.layout, question.role);
  const record = directory === null ? null : decisionRecord(directory, thread);
  try {
    const client = await connectControl(performance.now() + 4000, socket);
    try {
      const result = await collectQuestionState(client, { [thread]: record }, [thread], 3, {
        maxCalls: 12,
      });
      return nativeQuestionObservation(question, native, result[thread]);
    } finally {
      client.close();
    }
  } catch {
    return unknownProof("native-history-unavailable");
  }
}
