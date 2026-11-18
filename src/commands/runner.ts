// `review deliver` and `events flush`: the seam delivery-kit's runner spawns from the
// coordinator-installed CLI. Each prints exactly one JSON line on stdout and exits 0 for every
// typed outcome, 2 for a usage error and 1 for an internal failure, which prints nothing on
// stdout and one `coordination-kit:` line on stderr.
import { parseArgs } from "node:util";

import { flushEvents, type FlushResult } from "../events.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { type GameLayout, gameLayout, type Layout, loadLayout, UnknownGame } from "../layout.ts";
import { deliverReview, reviewDeliverLine } from "../review/deliver.ts";
import { type CliIdentity, cliMember } from "../review/outcome.ts";
import { cliIdentity } from "../version.ts";

export const REVIEW_DELIVER_OPTIONS = {
  capture: { type: "boolean" },
  game: { type: "string" },
  slot: { type: "string" },
} as const;

export const EVENTS_FLUSH_OPTIONS = { game: { type: "string" } } as const;

class Usage extends Error {}

/** An ISO 8601 instant with an explicit offset. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The slot start in epoch seconds: an ISO instant on a whole minute. */
export function slotSeconds(text: string): number {
  const ms = ISO.test(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms) || ms % 60_000 !== 0) {
    throw new Usage(
      "--slot must be an ISO 8601 minute start with an offset, such as 2026-11-18T15:30:00Z",
    );
  }
  return ms / 1000;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    io.err(`coordination-kit: ${message(error)}\n`);
    return EXIT_INVALID;
  }
  try {
    if (game === undefined) {
      throw new Usage("--game is required");
    }
    return { cli: cliIdentity(io.entry), game: gameLayout(layout, game), layout };
  } catch (error) {
    io.err(`coordination-kit: ${message(error)}\n`);
    return error instanceof Usage || error instanceof UnknownGame ? EXIT_USAGE : EXIT_INVALID;
  }
}

export const reviewDeliver: Handler = async (io, root, args) => {
  let values;
  let slot: number;
  try {
    ({ values } = parseArgs({ args, options: REVIEW_DELIVER_OPTIONS, strict: true }));
    if (values.slot === undefined) {
      throw new Usage("--slot is required");
    }
    slot = slotSeconds(values.slot);
  } catch (error) {
    io.err(`coordination-kit: ${message(error)}\n`);
    return EXIT_USAGE;
  }
  const resolved = context(io, root, values.game);
  if (typeof resolved === "number") {
    return resolved;
  }
  // SIGTERM aborts the seam: an unresolved native send keeps its `sending` receipt.
  const controller = io.signal === undefined ? new AbortController() : undefined;
  const abort = (): void => controller?.abort();
  if (controller !== undefined) {
    process.once("SIGTERM", abort);
  }
  try {
    const result = await deliverReview(
      resolved.layout,
      resolved.game,
      slot,
      io.signal ?? controller?.signal,
      { capture: values.capture === true },
    );
    if (result === undefined) {
      io.err("coordination-kit: review deliver stopped before a result; no delivery claimed\n");
      return EXIT_INVALID;
    }
    io.out(reviewDeliverLine(resolved.cli, resolved.game.id, values.slot, result));
    return EXIT_OK;
  } catch (error) {
    io.err(`coordination-kit: review deliver failed: ${message(error)}\n`);
    return EXIT_INVALID;
  } finally {
    process.off("SIGTERM", abort);
  }
};

/** The one stdout line of `events flush`, in its documented key order. */
export function eventsFlushLine(cli: CliIdentity, game: string, result: FlushResult): string {
  return `${JSON.stringify(
    Object.fromEntries([
      ["schema", 1],
      ["kind", "events-flush"],
      ["game", game],
      ["status", result.status],
      ["reason", result.reason],
      ["detail", result.detail],
      ["delivered", result.delivered],
      ["held", result.held],
      ["cli", cliMember(cli)],
    ]),
  )}\n`;
}

export const eventsFlush: Handler = async (io, root, args) => {
  let values;
  try {
    ({ values } = parseArgs({ args, options: EVENTS_FLUSH_OPTIONS, strict: true }));
  } catch (error) {
    io.err(`coordination-kit: ${message(error)}\n`);
    return EXIT_USAGE;
  }
  const resolved = context(io, root, values.game);
  if (typeof resolved === "number") {
    return resolved;
  }
  try {
    const result = await flushEvents(resolved.game);
    io.out(eventsFlushLine(resolved.cli, resolved.game.id, result));
    return EXIT_OK;
  } catch (error) {
    io.err(`coordination-kit: events flush failed: ${message(error)}\n`);
    return EXIT_INVALID;
  }
};
