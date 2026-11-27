import { isRecord } from "../../../core/encoding/pyjson.ts";
import type { Json, StoredEvent } from "../../types.ts";
import {
  type CheckpointHead,
  messageReductionRefusal,
  verifyCheckpointInput,
} from "./checkpoint.ts";
import type { FileCheckpointSource } from "./generation.ts";
import { type CompactionScope, planFileCompaction } from "./plan.ts";

type ScopeState = "open" | "closed" | "unknown";
interface Original {
  readonly event: StoredEvent;
  readonly id: string | null;
  readonly links: readonly unknown[];
  reason: string | null;
}

export interface ClosedHistoryQualification {
  readonly head: CheckpointHead;
  readonly registryRevision: number;
  readonly window: number;
  readonly selected: readonly string[];
  readonly excluded: readonly {
    readonly id: string | null;
    readonly seq: number;
    readonly reason: string;
  }[];
}

const OPERATIONAL_EVENT =
  /^(?:work|question|hold|decision|handoff|request|recovery|restore|migration|project|project-task|task|store)\./;
const MESSAGE_PREFIX = /^(?:(?:message|messages|msg):)+/i;

function text(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function operationalStates(events: readonly StoredEvent[]) {
  const works = new Map<string, Map<string, ScopeState>>();
  const questions = new Map<string, { owner: string; state: ScopeState }>();
  for (const { actor, kind, payload } of events) {
    const id = text(payload.id);
    if (id === null) {
      continue;
    }
    const repository = text(payload.repository);
    if (kind.startsWith("work.") && repository !== null) {
      const entries = works.get(id) ?? new Map<string, ScopeState>();
      works.set(id, entries);
      const before = entries.get(repository);
      if (kind === "work.finished") {
        const exact =
          actor.role !== null &&
          actor.role === payload.owner &&
          actor.nativeId !== null &&
          (payload.status === undefined ||
            payload.status === "done" ||
            payload.status === "cancelled" ||
            payload.status === "superseded");
        entries.set(repository, before === "unknown" || !exact ? "unknown" : "closed");
      } else if (before === undefined) {
        entries.set(repository, "open");
      } else if (before === "closed" && kind === "work.started") {
        entries.set(repository, "unknown");
      }
    }
    if (kind === "question.opened") {
      const owner = text(payload.role);
      if (owner !== null) {
        questions.set(id, {
          owner,
          state:
            !questions.has(id) && actor.role === owner && actor.nativeId !== null
              ? "open"
              : "unknown",
        });
      }
    } else if (kind === "question.answered" || kind === "question.cancelled") {
      const opening = questions.get(id);
      if (opening !== undefined) {
        questions.set(id, {
          ...opening,
          state:
            opening.state === "open" &&
            actor.role === opening.owner &&
            actor.nativeId !== null &&
            (kind !== "question.answered" || payload.role === opening.owner)
              ? "closed"
              : "unknown",
        });
      }
    }
  }
  return {
    question: (id: string): ScopeState => questions.get(id)?.state ?? "unknown",
    work: (ref: string): ScopeState => {
      const [value, id, ...rest] = ref.split(":");
      if (value === undefined || rest.length > 0) {
        return "unknown";
      }
      if (id !== undefined) {
        return works.get(id)?.get(value) ?? "unknown";
      }
      const matches = works.get(value);
      return matches?.size === 1 ? matches.values().next().value! : "unknown";
    },
  };
}

/** Match complete tokens and common message-reference spellings, including in evidence text. */
function retainCanonicalReferences(
  events: readonly StoredEvent[],
  originals: Map<string, Original>,
): void {
  const retain = (id: string) => {
    const original = originals.get(id);
    if (original !== undefined && original.reason === null) {
      original.reason = "canonical-message-reference";
    }
  };
  for (const { kind, payload } of events) {
    if (!OPERATIONAL_EVENT.test(kind) && kind !== "msg.decision") {
      continue;
    }
    const fields: Json[] = [payload];
    while (fields.length > 0) {
      const field = fields.pop();
      if (typeof field === "string") {
        retain(field);
        for (const token of field.matchAll(/[A-Za-z0-9][A-Za-z0-9._:-]*/g)) {
          const ref = token[0].replace(/[.:]+$/, "");
          // Preserve the full token and any exact target after a namespace separator.
          for (let start = 0; start < ref.length;) {
            const part = ref.slice(start);
            retain(part);
            if (part.endsWith(".json")) {
              retain(part.slice(0, -5));
            }
            const separator = ref.indexOf(":", start);
            if (separator === -1) {
              break;
            }
            start = separator + 1;
          }
        }
      } else if (Array.isArray(field)) {
        for (const value of field) {
          fields.push(value);
        }
      } else if (field !== null && field !== undefined && typeof field === "object") {
        for (const [key, value] of Object.entries(field)) {
          fields.push(key, value);
        }
      }
    }
  }
}

function linkRefusal(
  original: Original,
  originals: ReadonlyMap<string, Original>,
  states: ReturnType<typeof operationalStates>,
): string | null {
  for (const link of original.links) {
    if (!isRecord(link) || typeof link.ref !== "string") {
      return "unknown-operational-reference";
    }
    if (link.kind === "message" && originals.has(link.ref)) {
      continue;
    }
    if (link.kind === "work" || link.kind === "question") {
      const state = states[link.kind](link.ref);
      if (state === "closed") {
        continue;
      }
      if (state === "open") {
        return `open-${link.kind}-reference`;
      }
    }
    return "unknown-operational-reference";
  }
  return null;
}

function messageLinks(
  ids: ReadonlySet<string>,
  event: StoredEvent,
  close?: StoredEvent,
): readonly unknown[] {
  const links: unknown[] = Array.isArray(event.payload.links) ? [...event.payload.links] : [];
  for (const payload of close === undefined ? [event.payload] : [event.payload, close.payload]) {
    if (payload.work != null) {
      links.push({ kind: "work", ref: payload.work });
    }
    if (payload.supersededBy != null) {
      links.push({ kind: "message", ref: payload.supersededBy });
    }
    if (Array.isArray(payload.evidence)) {
      for (const ref of payload.evidence) {
        if (typeof ref === "string" && (ids.has(ref) || MESSAGE_PREFIX.test(ref))) {
          links.push({
            kind: "message",
            ref: ids.has(ref) ? ref : ref.replace(MESSAGE_PREFIX, ""),
          });
        }
      }
    }
  }
  return links;
}

function retainLinkedMessages(originals: ReadonlyMap<string, Original>, all: readonly Original[]) {
  const pending = all.filter(({ reason }) => reason !== null);
  while (pending.length > 0) {
    const { links } = pending.pop()!;
    for (const link of links) {
      if (isRecord(link) && link.kind === "message" && typeof link.ref === "string") {
        const target = originals.get(link.ref);
        if (target !== undefined && target.reason === null) {
          target.reason = "protected-message-reference";
          pending.push(target);
        }
      }
    }
  }
}

/** Qualify closed message bodies from an independently restored source, without writing it. */
export function qualifyClosedHistory(
  source: FileCheckpointSource,
  scope: CompactionScope,
  anchor: CheckpointHead,
  approved?: ReadonlySet<string>,
): ClosedHistoryQualification {
  const { events, first, head, reduced } = verifyCheckpointInput(
    source.tail.events,
    anchor,
    source.previous,
  );
  const originals = new Map<string, Original>();
  const ids = new Set(
    events.flatMap(({ kind, payload }) =>
      (kind === "msg.sent" || kind === "msg.imported") && typeof payload.id === "string"
        ? [payload.id]
        : [],
    ),
  );
  const all: Original[] = [];
  const { registeredGames, registeredRoles, registryRevision } = scope;
  const { window } = planFileCompaction(
    events,
    { registeredGames, registeredRoles, registryRevision },
    reduced,
    (event, planned, close) => {
      const id = text(event.payload.id);
      const original = {
        event,
        id,
        links: messageLinks(ids, event, close),
        reason:
          planned === "replacement-unverified"
            ? null
            : (planned ?? "replacement-selection-not-allowed"),
      };
      all.push(original);
      if (id !== null) {
        originals.set(id, original);
      }
    },
  );
  const states = operationalStates(events);
  const inCohort = (id: string | null) =>
    approved === undefined || (id !== null && approved.has(id));
  retainCanonicalReferences(events, originals);
  for (const original of all) {
    if (original.reason === null) {
      original.reason = inCohort(original.id)
        ? (messageReductionRefusal(original.event, anchor.seq || first.seq) ??
          linkRefusal(original, originals, states))
        : "outside-approved-cohort";
    }
  }
  retainLinkedMessages(originals, all);
  all.sort((a, b) => a.event.seq - b.event.seq);
  const selected: string[] = [];
  const excluded: { id: string | null; seq: number; reason: string }[] = [];
  for (const { event, id, reason } of all) {
    if (!inCohort(id)) {
      continue;
    }
    if (reason === null && id !== null) {
      selected.push(id);
    } else {
      excluded.push({ id, reason: reason ?? "ownership-unverified", seq: event.seq });
    }
  }
  return { excluded, head, registryRevision, selected, window };
}
