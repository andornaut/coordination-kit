// Policy holds: the holds game-coordinator sets under a user approval.
import type { Projection } from "../types.ts";

export const POLICY_HOLDS_PROJECTION: Projection = {
  apply: {
    "hold.policy-released": (db, event) => {
      const { approval, id } = event.payload;
      db.prepare(
        `UPDATE policy_holds SET state = 'released', released_at = ?, release_approval = ?
         WHERE id = ?`,
      ).run(event.at, approval as string, id as string);
    },
    "hold.policy-set": (db, event) => {
      const { approval, id, issuer, reason, scope } = event.payload;
      db.prepare(
        `INSERT INTO policy_holds (id, issuer, scope, reason, approval, state, set_at, set_seq)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        id as string,
        issuer as string,
        scope as string,
        reason as string,
        approval as string,
        event.at,
        event.seq,
      );
    },
  },
  ddl: `CREATE TABLE IF NOT EXISTS policy_holds (
    id TEXT PRIMARY KEY,
    issuer TEXT NOT NULL,
    scope TEXT NOT NULL,
    reason TEXT NOT NULL,
    approval TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'released')),
    set_at TEXT NOT NULL,
    set_seq INTEGER NOT NULL,
    released_at TEXT,
    release_approval TEXT
  );
  CREATE INDEX IF NOT EXISTS policy_holds_scope ON policy_holds (scope, state, set_seq);`,
  tables: ["policy_holds"],
};
