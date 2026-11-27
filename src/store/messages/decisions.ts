// An unverified original has one decision identity. The recipient attests prompt display and the
// exact user's reply separately; the journal never manufactures a native prompt or user answer.
import { isCanonicalUuid } from "../../core/ids.ts";
import type { Store } from "../db.ts";
import { REF, sha256 } from "../eventCodec.ts";
import { secretShape } from "../secrets.ts";
import { DELIVERY_KIT_ROLE } from "../sessions/identity.ts";
import { type Actor, ensure, type MessageDecision, ROLE } from "../types.ts";

type Reader = Pick<Store, "eventByKey">;

interface Original {
  readonly id: string;
  readonly to: string;
  readonly from: string;
  readonly bodySha256: string;
  readonly sentSeq: number;
  readonly open: boolean;
}

export type MessageDecisionInput =
  | { readonly bodySha256: string; readonly promptRef: string; readonly status: "pending" }
  | {
      readonly bodySha256: string;
      readonly scope: string;
      readonly status: "approved";
      readonly userReply: string;
    }
  | { readonly bodySha256: string; readonly status: "declined"; readonly userReply: string };

const DECISION_KIND = "msg.decision";
const promptKey = (id: string) => `msg.decision.prompt:${id}`;
const answerKey = (id: string) => `msg.decision.answer:${id}`;

export function verifiedSender(store: Pick<Store, "db">, original: Original): boolean {
  const event = store.db
    .prepare("SELECT kind, actor_role, actor_native_id, actor_worker FROM events WHERE seq = ?")
    .get(original.sentSeq);
  return (
    event?.kind === "msg.sent" &&
    event.actor_role === original.from &&
    ROLE.test(original.from) &&
    (isCanonicalUuid(event.actor_native_id) ||
      (original.from === DELIVERY_KIT_ROLE &&
        event.actor_native_id === null &&
        event.actor_worker === null))
  );
}

function decisionId(original: Original): string {
  return `q-msg-${sha256(`${original.id}:${original.bodySha256}`)}`;
}

function receipt(store: Reader, original: Original, key: string) {
  const event = store.eventByKey(key);
  return event?.kind === DECISION_KIND &&
    event.actor.role === original.to &&
    event.actor.worker === undefined &&
    isCanonicalUuid(event.actor.nativeId) &&
    event.payload.id === original.id &&
    event.payload.bodySha256 === original.bodySha256 &&
    event.payload.promptId === decisionId(original)
    ? event.payload
    : undefined;
}

export function messageDecision(
  store: Reader,
  original: Original,
  includeEvidence: boolean,
): MessageDecision | undefined {
  const id = decisionId(original);
  const prompt = receipt(store, original, promptKey(original.id));
  const display = typeof prompt?.promptRef === "string" ? "attested" : "unknown";
  const base = {
    display,
    id,
    ...(includeEvidence && display === "attested"
      ? { promptRef: prompt!.promptRef as string }
      : {}),
  } as const;
  if (display === "attested") {
    const answer = receipt(store, original, answerKey(original.id));
    if (
      (answer?.status === "approved" || answer?.status === "declined") &&
      typeof answer.userReply === "string" &&
      (answer.status === "declined" || typeof answer.scope === "string")
    ) {
      return {
        ...base,
        status: answer.status,
        ...(includeEvidence ? { userReply: answer.userReply } : {}),
        ...(includeEvidence && typeof answer.scope === "string" ? { scope: answer.scope } : {}),
      };
    }
  }
  return original.open ? { ...base, status: "pending" } : undefined;
}

function safeReference(ref: string): boolean {
  return REF.test(ref) && secretShape(ref) === null;
}

export function recordMessageDecision(
  store: Store,
  actor: Actor,
  original: Original,
  input: MessageDecisionInput,
): boolean {
  ensure(
    isCanonicalUuid(actor.nativeId) && actor.worker === undefined,
    "message-decision-owner-required",
  );
  ensure(input.bodySha256 === original.bodySha256, "message-body-mismatch");
  ensure(!verifiedSender(store, original), "message-decision-not-required");
  const current = messageDecision(store, original, true);
  const payload = {
    bodySha256: original.bodySha256,
    id: original.id,
    promptId: decisionId(original),
  };
  if (input.status === "pending") {
    ensure(safeReference(input.promptRef), "invalid-prompt-reference");
    if (current?.promptRef !== undefined) {
      ensure(current.promptRef === input.promptRef, "message-prompt-conflict");
      return true;
    }
    ensure(original.open, "already-closed");
    store.append({
      actor,
      key: promptKey(original.id),
      kind: DECISION_KIND,
      payload: { ...payload, promptRef: input.promptRef, status: "pending" },
    });
    return false;
  }

  ensure(current?.promptRef !== undefined, "message-prompt-unattested");
  ensure(
    input.userReply !== current.promptRef && safeReference(input.userReply),
    "invalid-user-reply",
  );
  if (input.status === "approved") {
    ensure(
      input.scope.trim() !== "" && input.scope.length <= 1000 && !/[\r\n]/.test(input.scope),
      "invalid-approval-scope",
    );
    ensure(secretShape(input.scope) === null, "secret-shaped-body");
  }
  const scope = input.status === "approved" ? input.scope : undefined;
  if (current.status !== "pending") {
    ensure(
      current.status === input.status &&
        current.userReply === input.userReply &&
        current.scope === scope,
      "message-decision-conflict",
    );
    return true;
  }
  ensure(original.open, "already-closed");
  store.append({
    actor,
    key: answerKey(original.id),
    kind: DECISION_KIND,
    payload: {
      ...payload,
      ...(scope === undefined ? {} : { scope }),
      status: input.status,
      userReply: input.userReply,
    },
  });
  return false;
}
