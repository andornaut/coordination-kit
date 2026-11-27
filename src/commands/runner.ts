// `review deliver` and `events ingest`: the seam delivery-kit's runner spawns from the
// coordinator-installed CLI. Each prints exactly one JSON line on stdout and exits 0 for every
// typed outcome, 2 for a usage error and 1 for an internal failure, which prints nothing on
// stdout and one `coordination-kit:` line on stderr.

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../core/cli/io.ts";
import { type CliIdentity, cliMember, type RunnerIdField } from "../core/cli/outcome.ts";
import { cliIdentity } from "../core/cli/version.ts";
import {
  appLayout,
  type GameLayout,
  gameLayout,
  type Layout,
  loadLayout,
  UnknownApp,
  UnknownGame,
} from "../core/configuration/layout.ts";
import { readRegistry } from "../registry/store.ts";
import { deliverReview, reviewDeliverLine } from "../review/deliver.ts";
import { showBrief } from "../review/storeBrief.ts";
import { ingestEvents, type IngestResult } from "../store/ingest.ts";
import { resolveCaller } from "../store/sessions/identity.ts";
import { requirePermission } from "../store/sessions/permissions.ts";
import { StoreError } from "../store/types.ts";
import { errorMessage, parseOptions, systemClock } from "./args.ts";

const TARGET_OPTIONS = {
  app: { type: "string" },
  game: { type: "string" },
} as const;

export const REVIEW_DELIVER_OPTIONS = {
  ...TARGET_OPTIONS,
  slot: { type: "string" },
} as const;

export const EVENTS_INGEST_OPTIONS = TARGET_OPTIONS;

export const REVIEW_SHOW_OPTIONS = REVIEW_DELIVER_OPTIONS;

class Usage extends Error {}

const RESERVED = {
  detail: "The journal is reserved for compaction. Retry after the reservation ends.",
  reason: "compaction-reserved",
  status: "deferred",
} as const;

/** An ISO 8601 instant with an explicit offset. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The slot start in epoch seconds: an ISO instant on a whole minute. */
function slotSeconds(text: string): number {
  const ms = ISO.test(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms) || ms % 60_000 !== 0) {
    throw new Usage(
      "--slot must be an ISO 8601 minute start with an offset, such as 2026-11-18T15:30:00Z",
    );
  }
  return ms / 1000;
}

interface Context {
  readonly app: GameLayout;
  readonly cli: CliIdentity;
  readonly layout: Layout;
}

interface Target {
  readonly field: RunnerIdField;
  readonly id: string;
}

function target(values: { app?: string; game?: string }): Target | undefined {
  if (values.app !== undefined && values.game !== undefined) {
    throw new Usage("--app and --game are mutually exclusive");
  }
  if (values.app !== undefined) {
    return { field: "appId", id: values.app };
  }
  return values.game === undefined ? undefined : { field: "game", id: values.game };
}

function requiredTarget(values: { app?: string; game?: string }): Target {
  const selected = target(values);
  if (selected === undefined) {
    throw new Usage("Either --app or --game is required");
  }
  return selected;
}

function targetLayout(layout: Layout, selected: Target): GameLayout {
  return selected.field === "game" && layout.mode === "legacy"
    ? gameLayout(layout, selected.id)
    : appLayout(layout, selected.id);
}

/** Resolve the exact app and authenticate the caller before touching runner state. */
function context(
  io: Io,
  root: string,
  selected: Target,
  permission: "review:deliver" | "events:ingest",
): Context | number {
  try {
    const layout = loadLayout(root);
    const app = targetLayout(layout, selected);
    if (layout.mode !== "legacy") {
      const registry = readRegistry(layout);
      requirePermission(layout, registry, resolveCaller(registry, io.env), permission, app.id);
    }
    return { app, cli: cliIdentity(io.entry), layout };
  } catch (error) {
    io.err(`coordination-kit: ${error instanceof StoreError ? error.code : errorMessage(error)}\n`);
    return error instanceof UnknownApp || error instanceof UnknownGame ? EXIT_USAGE : EXIT_INVALID;
  }
}

export const reviewDeliver: Handler = async (io, root, args) => {
  let values;
  let selected: Target;
  let slot: number;
  try {
    ({ values } = parseOptions(REVIEW_DELIVER_OPTIONS, args));
    selected = requiredTarget(values);
    if (values.slot === undefined) {
      throw new Usage("--slot is required");
    }
    slot = slotSeconds(values.slot);
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return EXIT_USAGE;
  }
  const resolved = context(io, root, selected, "review:deliver");
  if (typeof resolved === "number") {
    return resolved;
  }
  // SIGTERM aborts the seam before the brief is stored.
  const controller = io.signal === undefined ? new AbortController() : undefined;
  const abort = (): void => controller?.abort();
  if (controller !== undefined) {
    process.once("SIGTERM", abort);
  }
  try {
    const result = await deliverReview(
      { clock: systemClock, env: io.env },
      resolved.layout,
      resolved.app,
      slot,
      io.signal ?? controller?.signal,
    );
    if (result === undefined) {
      io.err("coordination-kit: review deliver stopped before a result; no delivery claimed\n");
      return EXIT_INVALID;
    }
    io.out(reviewDeliverLine(resolved.cli, resolved.app.id, values.slot, result, selected.field));
    return EXIT_OK;
  } catch (error) {
    if (error instanceof StoreError && error.code === RESERVED.reason) {
      io.out(
        reviewDeliverLine(resolved.cli, resolved.app.id, values.slot, RESERVED, selected.field),
      );
      return EXIT_OK;
    }
    io.err(`coordination-kit: review deliver failed: ${errorMessage(error)}\n`);
    return EXIT_INVALID;
  } finally {
    process.off("SIGTERM", abort);
  }
};

/** The one stdout line of `events ingest`: the seam keys plus the ingest counts. */
function eventsIngestLine(cli: CliIdentity, selected: Target, result: IngestResult): string {
  return `${JSON.stringify(
    Object.fromEntries([
      ["schema", 1],
      ["kind", "events-ingest"],
      [selected.field, selected.id],
      ["status", result.status],
      ["reason", result.reason],
      ["detail", result.detail],
      ["delivered", result.delivered],
      ["held", result.held],
      ["ingested", result.ingested],
      ["quarantined", result.quarantined],
      ["completed", result.completed],
      ["cli", cliMember(cli)],
    ]),
  )}\n`;
}

export const eventsIngest: Handler = async (io, root, args) => {
  let selected: Target;
  try {
    selected = requiredTarget(parseOptions(EVENTS_INGEST_OPTIONS, args).values);
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return EXIT_USAGE;
  }
  const resolved = context(io, root, selected, "events:ingest");
  if (typeof resolved === "number") {
    return resolved;
  }
  try {
    const result = await ingestEvents(
      { clock: systemClock, env: io.env, layout: resolved.layout },
      resolved.app,
    );
    io.out(eventsIngestLine(resolved.cli, selected, result));
    return EXIT_OK;
  } catch (error) {
    if (error instanceof StoreError && error.code === RESERVED.reason) {
      io.out(
        eventsIngestLine(resolved.cli, selected, {
          ...RESERVED,
          completed: 0,
          delivered: 0,
          held: 0,
          ingested: 0,
          quarantined: 0,
        }),
      );
      return EXIT_OK;
    }
    io.err(`coordination-kit: events ingest failed: ${errorMessage(error)}\n`);
    return EXIT_INVALID;
  }
};

/** `review show`: the recorded stored brief for a slot, or the latest, with its full detail. */
export const reviewShow: Handler = (io, root, args) => {
  let selected: Target | undefined;
  let slot: number | undefined;
  try {
    const { values } = parseOptions(REVIEW_SHOW_OPTIONS, args);
    selected = target(values);
    slot = values.slot === undefined ? undefined : slotSeconds(values.slot);
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return Promise.resolve(EXIT_USAGE);
  }
  let layout: Layout;
  try {
    layout = loadLayout(root);
    if (selected !== undefined) {
      targetLayout(layout, selected);
    }
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return Promise.resolve(
      error instanceof UnknownApp || error instanceof UnknownGame ? EXIT_USAGE : EXIT_INVALID,
    );
  }
  try {
    const brief = showBrief(io, layout, {
      ...(selected === undefined ? {} : { game: selected.id }),
      ...(slot === undefined ? {} : { slot }),
    });
    io.out(
      `${JSON.stringify(
        Object.fromEntries([
          ["schema", 1],
          ["kind", "review-show"],
          [selected?.field ?? "game", brief.game],
          ["slot", new Date(brief.slot * 1000).toISOString()],
          ["recipient", brief.recipient],
          ["messageId", brief.messageId],
          ["at", brief.at],
          ["result", brief.result],
          ["counts", brief.counts],
          ["decisions", brief.decisions],
          ["native", brief.native],
          ["policyHolds", brief.policyHolds],
          ["readyHandoffs", brief.readyHandoffs],
          ["exceptions", brief.exceptions],
          ["open", brief.open],
          ["unread", brief.unread],
          ["body", brief.body],
        ]),
      )}\n`,
    );
    return Promise.resolve(EXIT_OK);
  } catch (error) {
    io.err(
      `coordination-kit: ${error instanceof StoreError ? error.code : "review show failed"}\n`,
    );
    return Promise.resolve(EXIT_INVALID);
  }
};
