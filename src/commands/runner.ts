// `review deliver` and `events ingest`: the seam delivery-kit's runner spawns from the
// coordinator-installed CLI. Each prints exactly one JSON line on stdout and exits 0 for every
// typed outcome, 2 for a usage error and 1 for an internal failure, which prints nothing on
// stdout and one `coordination-kit:` line on stderr.

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../core/io.ts";
import {
  type GameLayout,
  gameLayout,
  type Layout,
  loadLayout,
  UnknownGame,
} from "../core/layout.ts";
import { type CliIdentity, cliMember } from "../core/outcome.ts";
import { cliIdentity } from "../core/version.ts";
import { deliverReview, reviewDeliverLine } from "../review/deliver.ts";
import { showBrief } from "../review/storeBrief.ts";
import { ingestEvents, type IngestResult } from "../store/ingest.ts";
import { StoreError } from "../store/types.ts";
import { errorMessage, parseOptions, systemClock } from "./args.ts";

export const REVIEW_DELIVER_OPTIONS = {
  game: { type: "string" },
  slot: { type: "string" },
} as const;

export const EVENTS_INGEST_OPTIONS = { game: { type: "string" } } as const;

export const REVIEW_SHOW_OPTIONS = {
  game: { type: "string" },
  slot: { type: "string" },
} as const;

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
  readonly cli: CliIdentity;
  readonly game: GameLayout;
  readonly layout: Layout;
}

/** Parse, then resolve the layout, the game and the CLI identity; a usage error exits 2. */
function context(io: Io, root: string, game: string | undefined): Context | number {
  let layout: Layout;
  try {
    layout = loadLayout(root);
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return EXIT_INVALID;
  }
  try {
    if (game === undefined) {
      throw new Usage("--game is required");
    }
    return { cli: cliIdentity(io.entry), game: gameLayout(layout, game), layout };
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return error instanceof Usage || error instanceof UnknownGame ? EXIT_USAGE : EXIT_INVALID;
  }
}

export const reviewDeliver: Handler = async (io, root, args) => {
  let values;
  let slot: number;
  try {
    ({ values } = parseOptions(REVIEW_DELIVER_OPTIONS, args));
    if (values.slot === undefined) {
      throw new Usage("--slot is required");
    }
    slot = slotSeconds(values.slot);
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return EXIT_USAGE;
  }
  const resolved = context(io, root, values.game);
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
      resolved.game,
      slot,
      io.signal ?? controller?.signal,
    );
    if (result === undefined) {
      io.err("coordination-kit: review deliver stopped before a result; no delivery claimed\n");
      return EXIT_INVALID;
    }
    io.out(reviewDeliverLine(resolved.cli, resolved.game.id, values.slot, result));
    return EXIT_OK;
  } catch (error) {
    if (error instanceof StoreError && error.code === RESERVED.reason) {
      io.out(reviewDeliverLine(resolved.cli, resolved.game.id, values.slot, RESERVED));
      return EXIT_OK;
    }
    io.err(`coordination-kit: review deliver failed: ${errorMessage(error)}\n`);
    return EXIT_INVALID;
  } finally {
    process.off("SIGTERM", abort);
  }
};

/** The one stdout line of `events ingest`: the seam keys plus the ingest counts. */
function eventsIngestLine(cli: CliIdentity, game: string, result: IngestResult): string {
  return `${JSON.stringify(
    Object.fromEntries([
      ["schema", 1],
      ["kind", "events-ingest"],
      ["game", game],
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
  let values;
  try {
    ({ values } = parseOptions(EVENTS_INGEST_OPTIONS, args));
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return EXIT_USAGE;
  }
  const resolved = context(io, root, values.game);
  if (typeof resolved === "number") {
    return resolved;
  }
  try {
    const result = await ingestEvents(
      { clock: systemClock, env: io.env, layout: resolved.layout },
      resolved.game,
    );
    io.out(eventsIngestLine(resolved.cli, resolved.game.id, result));
    return EXIT_OK;
  } catch (error) {
    if (error instanceof StoreError && error.code === RESERVED.reason) {
      io.out(
        eventsIngestLine(resolved.cli, resolved.game.id, {
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
  let values;
  let slot: number | undefined;
  try {
    ({ values } = parseOptions(REVIEW_SHOW_OPTIONS, args));
    slot = values.slot === undefined ? undefined : slotSeconds(values.slot);
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return Promise.resolve(EXIT_USAGE);
  }
  let layout: Layout;
  try {
    layout = loadLayout(root);
    if (values.game !== undefined) {
      gameLayout(layout, values.game);
    }
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return Promise.resolve(error instanceof UnknownGame ? EXIT_USAGE : EXIT_INVALID);
  }
  try {
    const brief = showBrief(io, layout, {
      ...(values.game === undefined ? {} : { game: values.game }),
      ...(slot === undefined ? {} : { slot }),
    });
    io.out(
      `${JSON.stringify(
        Object.fromEntries([
          ["schema", 1],
          ["kind", "review-show"],
          ["game", brief.game],
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
