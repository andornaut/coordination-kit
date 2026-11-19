# Review route, scheduled review and harness adapters

The scheduled review route `var/route.json`, the seam between delivery-kit's runner and this
kit, the stored brief, how the Claude and Codex adapters deliver legacy briefs and events, mixed
inbox snapshots, wake files, the channel status file and the event outbox.

## Review route

`var/route.json` (schema 2) names the scheduled review's host game and its targets by role:

```json
{
  "schema": 2,
  "state": "active",
  "host": "archies-dog-walks",
  "targets": ["archies-dog-walks/tech", "chibis-way-home/tech", "art-kit"]
}
```

- `state` is `active` or `held`. A held route, or no route, delivers no scheduled review, and a
  held route also defers events addressed to its recipient.
- `host` is the game whose runner dispatches the scheduled review at the `config.json`
  `wakeMinutes`. The review goes to the host's `reports.recipient`, which must be a role key in
  `config.json`.
- Every target must be a role key in `config.json`. Targets are distinct, an active route needs at
  least one target, and an active route's targets exclude its recipient.
- The file has exactly these four keys. A schema 1 route is refused with the edit it needs.

## Scheduled review seam

The runner owns cadence: it reads the clock, decides which `wakeMinutes` slot is due, never
replays a missed slot and logs the outcome. This kit owns everything after that. The runner calls
the coordinator-installed CLI as a child process, so one code copy reads and writes coordination
state; the library form remains for runners that bundle this kit. This kit never imports
delivery-kit.

### CLI seam

`coordination-kit --root R review deliver --game G --slot S [--capture]` delivers the review for
the slot that starts at `S`, an ISO 8601 instant with an offset on a whole minute. It prints
exactly one stdout line, shown expanded here:

```json
{
  "schema": 1,
  "kind": "review-deliver",
  "game": "G",
  "slot": "S",
  "status": "delivered",
  "reason": null,
  "detail": "TEXT",
  "cli": { "version": "2.0.0", "distSha256": "HEX" }
}
```

`coordination-kit --root R events flush --game G` flushes the event outbox and prints one line:

```json
{
  "schema": 1,
  "kind": "events-flush",
  "game": "G",
  "status": "deferred",
  "reason": "recipient-busy",
  "detail": "TEXT",
  "delivered": 0,
  "held": 1,
  "cli": { "version": "2.0.0", "distSha256": "HEX" }
}
```

`coordination-kit --root R events ingest --game G` ingests the runner's `events.jsonl` into the
store and prints the same keys with `kind` `events-ingest` and three more counts, `ingested`,
`quarantined` and `completed`; see [runner events](store.md#runner-events). 6.1 runners call it;
6.0 runners keep calling `events flush`.

- `status` is `delivered`, `deferred` or `skipped`.
- `reason` is `null` for `delivered`, otherwise a token from `REASON_TOKENS` (below).
- `detail` is free text for the runner's log. For `review deliver` it is the line the library
  seam returns, without `DEFERRED_PREFIX`.
- `delivered` counts events marked sent by this flush; `held` counts events still unsent after
  it, an unreadable event file included.
- `cli` is the running package version and the sha256 of the `dist/cli.js` bytes, the same as
  `coordination-kit --version --json`. From source the digest is 64 zeros.

Exit status is 0 for every typed result, 2 for a usage error (a missing or malformed `--game` or
`--slot`, an unknown game or an unknown option) and 1 for an internal failure. An internal
failure prints nothing on stdout and one `coordination-kit:` line on stderr; the runner reports
it, a timeout or unparsable output as no delivery claimed, with the `cli-error` token.

| Token                   | Meaning                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `route-unavailable`     | The review route, its worker parents or an endpoint harness is invalid; the route owner must fix it. |
| `recipient-unavailable` | The recipient has no session, conversation, listing, socket or native metadata, or refused the send. |
| `recipient-busy`        | The recipient's session is blocked or mid-turn, or a lock is held.                                   |
| `in-flight`             | A spooled entry is waiting for the recipient's channel to accept it; the next pass completes it.     |
| `question-pending`      | A recipient decision, question or clearance guard refused the send.                                  |
| `held`                  | The route is held: no review, and events to its recipient wait.                                      |
| `receipt-ambiguous`     | A previous send's outcome is unknown; it is never resent.                                            |
| `already-delivered`     | The seam's slot receipt shows this slot was already delivered.                                       |
| `nothing-due`           | This game does not host the route, or there is no route.                                             |
| `no-events`             | The outbox has no unsent event.                                                                      |
| `cli-error`             | The runner's token for a failed CLI call; the CLI never prints it.                                   |
| `outbox-unreadable`     | An event file cannot be read, so the flush stops before any send.                                    |

A review maps as follows. A Claude brief written to the spool (`sending`) or an accepted Codex
turn is `delivered`. A game that does not host the route, or no route, is `skipped` with
`nothing-due`; a held route is `skipped` with `held`. A slot the seam had already recorded
(`deduplicated`) is `skipped`, with `already-delivered` when it was sent and otherwise the token of
its recorded outcome. Every other outcome, including each `DEFERRED_PREFIX` line, is `deferred`.
Its token comes from the first rule that matches: an `ambiguous` status or a reason ending "do not
resend" is `receipt-ambiguous`; lock contention is `recipient-busy`; a route, worker parent or
endpoint harness reason is `route-unavailable`; a question, answer, decision, clearance or
resolution reason is `question-pending`; a blocked or busy session is `recipient-busy`; anything
else is `recipient-unavailable`. An event flush that stops maps its receipt the same way; a held
route, an invalid route, an unresolvable recipient, a held `dispatch.lock` and an unreadable event
file give `held`, `route-unavailable`, `recipient-unavailable`, `recipient-busy` and
`outbox-unreadable`.

`review deliver` records each typed result at `games/<g>/bus/unblock/review-deliver/<slot>.json`,
where `<slot>` is the slot start in epoch seconds, under that directory's `deliver.lock`. A repeated
call for the same game and slot prints the recorded `status`, `reason` and `detail` with the
current `cli` and calls nothing else. Lock contention, on `unblock.lock` or on another call's
`deliver.lock`, is `deferred` with `recipient-busy` and is not recorded. An unreadable record is an
internal failure. The seam's own slot receipt, deduplication, ambiguity and stale-turn rules are
unchanged underneath.

In [store mode](store.md#store-mode) `review deliver` stores the [brief](#stored-brief) instead
of running the native seam, and records its result in the same per-slot file.

SIGTERM aborts `review deliver`. A Codex send in flight closes its connection and keeps its
`sending` receipt, which the next read marks `ambiguous` and never resends; a stop before the slot
receipt is written leaves the slot as it was. The call then records nothing, prints nothing and
exits 1. A result the seam completed before the stop is recorded and printed.

### Library seam

`deliverScheduledReview(layout, game, slot, signal?, options?)` from
`@andornaut/coordination-kit/build/review` resolves the route and its recipient through the
registry as it is at that moment, checks the game's `reports.workerParents`, captures the inbox
inventory and message health, composes the brief and delivers it through the recipient's
effective harness. It returns one line for the runner to log:

- `""` when this game does not host the route, the route is held or absent, or a stop interrupted
  a native send;
- a line starting with `DEFERRED_PREFIX` (`bus: review deferred:` and a space) when the review is
  deferred before any native call;
- otherwise one JSON object with `status` and the slot, snapshot and health fields.

`reviewOutcome` takes the same arguments and returns the outcome before formatting. With
`options.capture` the review captures accounting automatically; see
[request accounting](request-accounting.md#automatic-capture).

A review health event (`review-stuck`) goes through `coordinationEmit`: in store mode it is
stored as a message from `delivery-kit` to the game's `reports.recipient`
([store mode](store.md#store-mode)); otherwise it goes to the game's event outbox through
`recordEvent`. In legacy mode the runner then flushes the outbox with `flushEvents(game)` from
`@andornaut/coordination-kit/build/events`, which returns the flush result above without `cli`.
Slot receipts, snapshots and health records keep the paths and formats delivery-kit 4.7.0 wrote.

## Stored brief

In store mode `review deliver` resolves the route as above: no route, a route this game does not
host, a held route, an invalid route and an unregistered recipient give the same typed results.
A slot already recorded returns its result at once. Otherwise, before any store write, it runs the
legacy brief's native checks through the same collectors (`collectAll`): the question state of
each active Codex route member and the child health of each active Codex `reports.workerParents`
role, over one control connection (`CODEX_CONTROL_SOCKET`, else the managed socket) under the
collectors' 256-call budget and deadline. They are read-only, and nothing is contacted when no
Codex member or parent exists. It then composes the brief from the store and those checks and
stores it as one message from `delivery-kit` to the
route recipient, in one transaction with a `review.brief` record of the slot. The message ID
derives from (game, slot), so a repeated call, even without the per-slot result file, stores
nothing and returns the recorded result: `delivered`, with a detail naming the message, the open
count and the exception count.

The brief is at most one page, 60 lines and 4096 bytes: open message counts by state and by
recipient, unconfirmed messages, outstanding, failed, ambiguous and guarded wakes, runner events
and COMPLETE records since the game's previous brief, Codex question states (pending, clear or
unknown) and worker parents (read, unknown, failed children), then the exceptions while the page
has room, then `review show` for the rest. Claude roles have no native question or child health
check and are counted as unknown. Exceptions, native ones first:

- `question-pending`: an owner-attested pending question on a Codex role's latest turn, with its
  title (at most 80 characters) and turn and item IDs, every slot while it stays pending;
- `question-unknown`: a Codex role whose question state could not be read completely, with the
  collector's reason code (`control_unavailable` when the connection failed); a role is clear only
  when the collector read it completely with no pending or unknown question;
- `worker-failed`: a verified failed latest child turn of a Codex worker parent, reported once per
  game, as the legacy reminder is;
- `worker-unknown`: a Codex worker parent whose child health could not be read, with its reason;
- `stalled`: a message still `sent` or `delivered` that was open at the game's previous brief,
  that is, open across two distinct slots;
- `unconfirmed`: an imported uncertain delivery the recipient has not closed;
- `wake-failed` and `wake-ambiguous`: an outstanding wake with that outcome;
- `wake-guarded`: a wake-pending recipient whose last wake a guard refused.

The first brief of an episode with stalled messages also stores one `review-stuck` message. After
the commit the review rearms each failed or ambiguous outstanding wake, then wakes the recipient
and every wake-pending role, with no payload. A secret-shaped brief is stored without question
titles.

`coordination-kit --root R review show [--game G] [--slot S]` prints the recorded brief for the
slot, or the latest one, as one JSON line: `kind` `review-show`, the game, slot, recipient,
message ID, recording time, result, counts, every exception, the open message IDs and the body.
A missing brief exits 1 with `brief-missing`.

## Harness adapters

- **Claude:** briefs and events are spooled under the bus's `unblock/` directory with a `sending`
  receipt written first. `coordination-kit claude channel` claims each entry, delivers it once to
  the recipient session, records the delivery, marks the receipt `accepted`, then removes the
  entry. A `sending` receipt with no spool entry becomes `ambiguous` and is never resent. The
  channel server is configured in the recipient session's MCP settings; see
  `examples/claude-channel.mcp.json`. A session reads that configuration only at launch: `/mcp`
  reconnect restarts the launch-time command, so a changed command needs a relaunch. A command
  that runs `node <gc>/node_modules/@andornaut/coordination-kit/dist/cli.js --root <gc> claude
channel` stays the same across kit releases: `npm ci` at the root replaces the file it names, and
  `/mcp` reconnect starts the new release without a relaunch. A brief or event is spooled only while
  `claude agents --json` lists the recipient as an interactive session with status `idle`,
  `busy`, `shell` or `waiting` and no `state`; the brief queues in the channel until the session
  reads it. A missing or blocked session, or any other reported status or state, defers delivery,
  and the deferral reason names the reported token (`unknown` when it is not a plain lowercase
  token).
- **Codex:** turns are steered through the control socket at `CODEX_CONTROL_SOCKET`, which must be
  set to an absolute path, with the same receipt rules. Without it Codex delivery is deferred.

Claude session listings do not provide native history, queue contents or authoritative question
state. Unavailable capabilities remain explicitly unknown. A Claude conversation ID is never
queried through Codex, and unavailable native data is never presented as an empty queue or as
permission to acknowledge work. Mixed selection preserves exact payload guards, ambiguous-delivery
handling and the existing same-slot review deduplication.

Mixed inbox snapshots expose `harnesses` (the provider per conversation), `native_queues`
(native queue availability), `channel_queues` (delivered local-channel entries) and
`queue_sources` (inventory origin). `complete` means the requested available inventories were
collected without actual collection errors, preserving the legacy exit-0 success semantics. It
proves neither native visibility nor clearance.

CLI `channel_queues` rows expose only `count`, `queue_ids` and `status`. Full original payloads
remain in the persisted snapshot for acknowledgement validation and are not printed on stdout.

`native_complete` is true only when every requested recipient is Codex and its native queue was
captured. Any requested Claude recipient makes it false, even when its available delivered-channel
inventory is empty. An unrequested Claude peer's diagnostics do not make a Codex recipient's
`native_complete` false. Unsupported Claude APIs remain explicitly unknown; their absence adds
neither collection errors nor scheduled-wake blockers. Actual inventory collection failures remain
errors.

`CLAUDE_BIN` overrides the `claude` executable.

## Wake files

A wake tells a Claude session that messages wait, without carrying them. Each conversation has one
file, `<stateRoot>/wake/<conversation>.json` with an active work protocol and `var/wake/` without
one:

```json
{ "schema": 1, "seq": 3, "role": "game-coordinator", "count": 2 }
```

`seq` increases by one per write; `count` is the number of new messages. `writeWakeFile` replaces
the file atomically under a per-conversation lock and refuses a torn file, whose seq is unknown.
`msg send` writes it for a Claude recipient, at most once per outstanding wake
([store wakes](store.md#wakes)).

`claude channel` polls its conversation's wake file after draining the legacy spools, so spool
delivery never waits on it. Each seq increase emits one channel notification with the fixed text
`N new messages for ROLE: run coordination-kit inbox` and `meta` `{"kind":"wake","seq":"N"}`.
Increases between two polls coalesce into one notification, a seq is never announced twice and a
lower seq is never announced. A wake present when the channel starts is announced once, because it
may have been written while no channel was watching, and an absent file counts as seq 0. A missing, torn or malformed file is
skipped until a later poll.

## Channel status file

`claude channel` writes `<stateRoot>/channel/<conversation>.json` (`var/channel/` without an active
work protocol) once at start, for the conversation it serves:

```json
{
  "schema": 1,
  "conversation": "UUID",
  "version": "2.0.0",
  "distSha256": "HEX",
  "pid": 4242,
  "startedAt": "ISO",
  "argv": ["/usr/bin/node", "/root/node_modules/@andornaut/coordination-kit/dist/cli.js", "..."]
}
```

A failed write never stops the channel. `harness doctor` reads it to report the loaded CLI; see
[the scoped doctor](registry.md#scoped-harness-doctor).

## Event outbox

The outbox is the 6.0 runner's event path and is unchanged in 2.0. A 6.1 runner writes
`events.jsonl` instead, which `events ingest` reads ([runner events](store.md#runner-events)).

`games/<g>/bus/events/` holds one `<sha256(kind:key)>.json` file per event; every `blocked-*` kind
shares one identity, so a changed block reason is not recorded again. `recordEvent` enqueues an
event once under `events/state.lock` and runs the producer's optional `underLock` step under the
same lock; delivery-kit uses that step to track each pushed commit's CI and deployment state and
to add its `complete` event. Progress kinds (`ci_pending`, `ci_running`, `deploy_pending`,
`deploy_retry`, `gate_passed` and `gate_skipped`) are never recorded, and any already queued is marked
`suppressed` at the next flush.

`flushEvents(game)` delivers unsent events in creation order under the non-blocking
`dispatch.lock`, to the game's `reports.recipient` through its effective harness, with no queue
fallback. Each delivered text stays within 900 UTF-8 bytes and ends with its event ID. An event is
marked sent only after the adapter accepts it; the first refusal stops a flush and the next flush
resumes there. A prior receipt for another recipient or provider whose outcome is unknown holds
the event until it is reconciled. An unresolvable recipient leaves every event unsent.
