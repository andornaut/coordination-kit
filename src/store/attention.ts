import type { Store } from "./db.ts";
import { closeMessage, sendMessage } from "./messages.ts";
import { derivedId } from "./notices.ts";

const COORDINATOR = { nativeId: null, role: "game-coordinator" };
const RECIPIENT_LINK = "unblock-recipient";
export const ATTENTION_CLEARED = "attention-source-cleared";

// Only the service-generated self-addressed message has this provenance. An ordinary
// caller's links and a legacy import do not make its message eligible for retirement.
export const ATTENTION_ORIGIN = `origin.kind = 'msg.sent'
  AND origin.actor_role = 'game-coordinator' AND origin.actor_native_id IS NULL
  AND m.from_role = 'game-coordinator' AND m.to_role = 'game-coordinator'
  AND m.intent = 'queue' AND EXISTS (
    SELECT 1 FROM json_each(m.links) link
    WHERE json_extract(link.value, '$.kind') = '${RECIPIENT_LINK}'
  )`;

function openAttention(store: Store, recipient: string): string | undefined {
  const row = store.db
    .prepare(
      `SELECT m.id FROM messages m JOIN events origin ON origin.seq = m.sent_seq
     WHERE ${ATTENTION_ORIGIN}
       AND m.state IN ('sent', 'delivered', 'retained') AND EXISTS (
         SELECT 1 FROM json_each(m.links) link
         WHERE json_extract(link.value, '$.kind') = ?
           AND json_extract(link.value, '$.ref') = ?
       ) ORDER BY m.sent_seq LIMIT 1`,
    )
    .get(RECIPIENT_LINK, recipient);
  return row?.id as string | undefined;
}

/** Called inside the writer transaction after the original's exact refusal was checked. */
export function attentionId(recipient: string, original: string): string {
  return derivedId("recipient-unblock-attention", recipient, original);
}

export function recordAttention(store: Store, recipient: string, original: string) {
  const existing = openAttention(store, recipient);
  if (existing !== undefined) {
    return { duplicate: true, id: existing };
  }
  const id = attentionId(recipient, original);
  const { duplicate } = sendMessage(store, COORDINATOR, {
    body:
      `Urgent work remains unread for ${recipient} after a confirmed wake refusal or failure. ` +
      "Review its exact unread originals and wake evidence.",
    id,
    intent: "queue",
    links: [
      { kind: RECIPIENT_LINK, ref: recipient },
      { kind: "message", ref: original },
    ],
    to: COORDINATOR.role,
  });
  return { duplicate, id };
}

/** Retire only generated metadata when the source recipient has no unread unblockers. */
export function retireAttention(store: Store, recipient: string): void {
  if (
    store.db
      .prepare(
        "SELECT 1 FROM messages WHERE to_role = ? AND intent = 'unblock' AND state = 'sent' LIMIT 1",
      )
      .get(recipient) !== undefined
  ) {
    return;
  }
  const id = openAttention(store, recipient);
  if (id !== undefined) {
    closeMessage(store, COORDINATOR, id, { evidence: [ATTENTION_CLEARED] });
  }
}
