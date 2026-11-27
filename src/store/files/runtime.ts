import type { Layout } from "../../core/configuration/layout.ts";
import { readRegistry } from "../../registry/store.ts";
import { latestStoreReview, payloadText } from "../eventCodec.ts";
import type { FileProjection } from "../fileProjection.ts";
import { selectedFileCheckpoint } from "./compaction/generation.ts";
import { openFileJournal } from "./journal.ts";
import { fileRecords } from "./records.ts";
import { verifiedWorkerForEvent } from "./workerProof.ts";

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function fileLayoutProjection(layout: Layout, target: string): FileProjection {
  return {
    ...(selectedFileCheckpoint(target) ?? { journal: openFileJournal(target) }),
    records(index, throughSeq, events, history) {
      const registry = readRegistry(layout);
      const review = latestStoreReview(history, throughSeq);
      let workOwners: Map<string, string | null> | undefined;
      function priorRow(table: string, id: string, sequence: string) {
        const row = index.get(table, [id]);
        const position = row?.[sequence];
        return typeof position === "number" && position <= throughSeq ? row : undefined;
      }
      return fileRecords(events, {
        holdOwner: (id) => text(priorRow("holds", id, "set_seq")?.role),
        messageOwner: (id) => {
          const row = priorRow("messages", id, "sent_seq");
          return row === undefined
            ? null
            : { recipient: text(row.to_role), sender: text(row.from_role) };
        },
        questionOwner: (id) => text(priorRow("questions", id, "opened_seq")?.role),
        registeredRoles: new Set(Object.keys(registry.roles)),
        requestOwner: (id) => text(priorRow("requests", id, "imported_seq")?.owner),
        verifiedWorker: (event, parentRole) =>
          verifiedWorkerForEvent(registry, review, event, parentRole),
        workOwner: (repository, id) => {
          if (workOwners === undefined) {
            workOwners = new Map();
            for (const { payload, seq } of history.events({ kinds: ["work.started"] })) {
              if (seq <= throughSeq) {
                const key = JSON.stringify([payload.repository, payload.id]);
                workOwners.set(key, payloadText(payload, "owner"));
              }
            }
          }
          return workOwners.get(JSON.stringify([repository, id])) ?? null;
        },
      });
    },
  };
}
