// Exact Codex input per owner and conversation survives durable inbox pulls.
import type { DatabaseSync } from "node:sqlite";

import { wakeText } from "../adapters/claude/wakeFile.ts";
import { MESSAGE_ID } from "./messages.ts";
import type { Projection } from "./projections.ts";
import type { JsonObject, StoredEvent } from "./types.ts";

export interface PendingNotice {
  readonly id: string;
  readonly role: string;
  readonly conversation: string;
  readonly origin: "wake" | "reminder";
  readonly seq: number;
  readonly count: number;
  readonly readyForProof: number;
}

export interface NoticeBinding {
  readonly role: string;
  readonly conversation: string;
}

type Reader = { readonly db: DatabaseSync };

function string(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function claim(db: DatabaseSync, event: StoredEvent, origin: PendingNotice["origin"]): void {
  const p = event.payload;
  const id = string(p, origin === "wake" ? "wake" : "id");
  const role = string(p, "role");
  const conversation = string(p, origin === "wake" ? "conversation" : "nativeId");
  const count = origin === "wake" ? p.count : Array.isArray(p.originals) ? p.originals.length : 0;
  if (
    p.harness === "codex" &&
    id !== null &&
    role !== null &&
    conversation !== null &&
    typeof count === "number" &&
    Number.isSafeInteger(count) &&
    count > 0
  ) {
    db.prepare(
      `INSERT INTO pending_notices (id, role, conversation, origin, seq, count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, role, conversation, origin, event.seq, count);
  }
}

function conclude(db: DatabaseSync, id: string | null, origin: PendingNotice["origin"]): void {
  db.prepare("DELETE FROM pending_notices WHERE id = ? AND origin = ?").run(id, origin);
}

export const COLLECTION_RELEASE = "accepted-queue-absent-originals-collected";

export const NOTICE_PROJECTION: Projection = {
  apply: {
    "notice.consumed": (db, { payload: p }) => {
      db.prepare("DELETE FROM pending_notices WHERE id = ? AND role = ? AND conversation = ?").run(
        string(p, "id"),
        string(p, "role"),
        string(p, "conversation"),
      );
      db.prepare("UPDATE wake_state SET outstanding = NULL WHERE role = ? AND outstanding = ?").run(
        string(p, "role"),
        string(p, "id"),
      );
    },
    "notice.released": (db, { payload: p }) => {
      if (p.reason !== COLLECTION_RELEASE || typeof p.claimSeq !== "number") {
        return;
      }
      const id = string(p, "id");
      const role = string(p, "role");
      const released = db
        .prepare(
          `DELETE FROM pending_notices
         WHERE id = ? AND role = ? AND conversation = ? AND seq = ? AND origin = 'wake'`,
        )
        .run(id, role, string(p, "conversation"), p.claimSeq);
      if (released.changes === 1) {
        db.prepare(
          "UPDATE wake_state SET outstanding = NULL WHERE role = ? AND outstanding = ?",
        ).run(role, id);
      }
    },
    "reminder.claimed": (db, event) => claim(db, event, "reminder"),
    "reminder.settled": (db, { payload: p }) => {
      if (p.outcome === "refused") {
        conclude(db, string(p, "id"), "reminder");
      }
    },
    "wake.claimed": (db, event) => claim(db, event, "wake"),
    "wake.completed": (db, { payload: p }) => {
      if (p.outcome === "failed" || p.outcome === "guarded") {
        conclude(db, string(p, "wake"), "wake");
      }
    },
  },
  ddl: `CREATE TABLE IF NOT EXISTS pending_notices (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    conversation TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('wake', 'reminder')),
    seq INTEGER NOT NULL,
    count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pending_notices_binding ON pending_notices(role, conversation, seq);`,
  tables: ["pending_notices"],
};

export function pendingNotices(store: Reader, binding: NoticeBinding): PendingNotice[] {
  if (
    store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'pending_notices'").get() ===
    undefined
  ) {
    return [];
  }
  return store.db
    .prepare(
      `SELECT n.id, n.role, n.conversation, n.origin, n.seq, n.count,
        (n.origin = 'wake' OR c.outcome IS NOT NULL) AS readyForProof
     FROM pending_notices n LEFT JOIN reminder_claims c ON c.id = n.id
     WHERE n.role = ? AND n.conversation = ? ORDER BY n.seq`,
    )
    .all(binding.role, binding.conversation) as unknown as PendingNotice[];
}

interface AcceptedClaim {
  readonly seq: number;
  readonly count: number;
  readonly id: string;
  readonly originals: string | null;
  readonly legacy: number;
}

function exactIds(value: string): string[] | null {
  const ids = JSON.parse(value) as unknown[];
  return new Set(ids).size === ids.length &&
    ids.every((id) => typeof id === "string" && MESSAGE_ID.test(id))
    ? (ids as string[])
    : null;
}

/** Compare accepted wake claims with exact inbox pulls made by the same native owner. */
export function collectedNotices(store: Reader, binding: NoticeBinding): Map<string, number[]> {
  const { conversation, role } = binding;
  const claims = store.db
    .prepare(
      `SELECT n.id, n.seq, n.count,
        json_type(c.payload, '$.messages') IS NULL AS legacy,
        CASE WHEN json_type(c.payload, '$.messages') = 'array'
          THEN json_extract(c.payload, '$.messages') END AS originals
     FROM pending_notices n
     JOIN wakes w ON w.id = n.id AND w.role = n.role AND w.conversation = n.conversation
     JOIN events c ON c.seq = n.seq AND c.kind = 'wake.claimed'
     WHERE n.role = ? AND n.conversation = ? AND n.origin = 'wake'
       AND w.outcome = 'accepted' AND w.harness = 'codex'
     ORDER BY n.seq`,
    )
    .all(role, conversation) as unknown as AcceptedClaim[];
  if (claims.length === 0) {
    return new Map();
  }

  const pulls = store.db
    .prepare(
      `SELECT seq,
        CASE WHEN json_type(payload, '$.delivered') = 'array'
          THEN json_extract(payload, '$.delivered') END AS delivered
     FROM events WHERE kind = 'inbox.read' AND seq > ? AND actor_role = ?
       AND actor_native_id = ? AND json_extract(payload, '$.role') = ?
     ORDER BY seq`,
    )
    .all(claims[0]!.seq, role, conversation, role) as unknown as {
    seq: number;
    delivered: string | null;
  }[];
  const message = store.db.prepare("SELECT sent_seq FROM messages WHERE id = ? AND to_role = ?");
  const sentById = new Map<string, number>();
  const readById = new Map<string, number>();
  const reads: { seq: number; originals: number[] | null }[] = [];
  for (const { delivered, seq } of pulls) {
    const ids = delivered === null ? null : exactIds(delivered);
    const originals = ids?.map((id) => {
      const sent = sentById.get(id) ?? Number(message.get(id, role)?.sent_seq ?? 0);
      sentById.set(id, sent);
      return sent;
    });
    if (
      ids === null ||
      originals === undefined ||
      originals.some((sent) => sent === 0 || sent >= seq)
    ) {
      reads.push({ originals: null, seq });
      continue;
    }
    reads.push({ originals, seq });
    for (const id of ids) {
      if (!readById.has(id)) {
        readById.set(id, seq);
      }
    }
  }
  const proven = new Map<string, number[]>();
  for (const claim of claims) {
    if (claim.legacy) {
      // Originals delivered by the first pull and sent by the claim are exactly the wake's
      // contents when their count agrees. Later sent originals do not contribute.
      const first = reads.find(({ seq }) => seq > claim.seq);
      if (first?.originals?.filter((sent) => sent <= claim.seq).length === claim.count) {
        proven.set(claim.id, [first.seq]);
      }
    } else if (claim.originals !== null) {
      const ids = exactIds(claim.originals);
      if (ids?.length !== claim.count) {
        continue;
      }
      const proof = ids.map((id) => readById.get(id) ?? 0);
      if (
        proof.every((seq) => seq > claim.seq) &&
        ids.every((id) => (sentById.get(id) ?? Infinity) <= claim.seq)
      ) {
        proven.set(
          claim.id,
          [...new Set(proof)].sort((a, b) => a - b),
        );
      }
    }
  }
  return proven;
}

export function noticeText(count: number, role: string, reminderId?: string): string {
  const text = wakeText({ count, role, seq: 1 });
  return reminderId === undefined ? text : `${text} [${reminderId}]`;
}
