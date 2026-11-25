import type { DatabaseSync } from "node:sqlite";

import type { Layout } from "../../core/layout.ts";
import { readRegistry } from "../../registry/store.ts";
import { latestStoreReview } from "../eventCodec.ts";
import type { FileProjection } from "../fileProjection.ts";
import { selectedFileCheckpoint } from "./compactionGeneration.ts";
import { openFileJournal } from "./journal.ts";
import { fileRecords } from "./records.ts";
import { verifiedWorkerForEvent } from "./workerProof.ts";

function ownerLookup(index: DatabaseSync, query: string, throughSeq: number) {
  const stmt = index.prepare(query);
  return (id: string): string | null => {
    const owner = stmt.get(id, throughSeq)?.owner;
    return typeof owner === "string" ? owner : null;
  };
}

export function fileLayoutProjection(layout: Layout, target: string): FileProjection {
  return {
    ...(selectedFileCheckpoint(target) ?? { journal: openFileJournal(target) }),
    records(index, throughSeq, events) {
      const registry = readRegistry(layout);
      const message = index.prepare(
        "SELECT from_role, to_role FROM messages WHERE id = ? AND sent_seq <= ?",
      );
      const work = index.prepare(
        `SELECT json_extract(payload, '$.owner') AS owner FROM events
         WHERE kind = 'work.started' AND json_extract(payload, '$.repository') = ?
           AND json_extract(payload, '$.id') = ? AND seq <= ? ORDER BY seq DESC LIMIT 1`,
      );
      const review = latestStoreReview(index, throughSeq);
      return fileRecords(events, {
        holdOwner: ownerLookup(
          index,
          "SELECT role AS owner FROM holds WHERE id = ? AND set_seq <= ?",
          throughSeq,
        ),
        messageOwner: (id) => {
          const value = message.get(id, throughSeq);
          return value === undefined
            ? null
            : {
                recipient: typeof value.to_role === "string" ? value.to_role : null,
                sender: typeof value.from_role === "string" ? value.from_role : null,
              };
        },
        questionOwner: ownerLookup(
          index,
          "SELECT role AS owner FROM questions WHERE id = ? AND opened_seq <= ?",
          throughSeq,
        ),
        registeredRoles: new Set(Object.keys(registry.roles)),
        requestOwner: ownerLookup(
          index,
          "SELECT owner FROM requests WHERE id = ? AND imported_seq <= ?",
          throughSeq,
        ),
        verifiedWorker: (event, parentRole) =>
          verifiedWorkerForEvent(registry, review, event, parentRole),
        workOwner: (repository, id) => {
          const owner = work.get(repository, id, throughSeq)?.owner;
          return typeof owner === "string" ? owner : null;
        },
      });
    },
  };
}
