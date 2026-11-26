# Review route, scheduled review and the Claude channel

The scheduled review route `var/route.json`, the seam between delivery-kit's runner and this
kit, the stored brief, wake files, the Claude channel server and its status file.

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
state. This kit never imports delivery-kit.

### CLI seam

`coordination-kit --root R review deliver --game G --slot S` stores the [brief](#stored-brief)
for the slot that starts at `S`, an ISO 8601 instant with an offset on a whole minute. It prints
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
  "cli": { "version": "3.0.0", "distSha256": "HEX" }
}
```

`coordination-kit --root R events ingest --game G` ingests the runner's `events.jsonl` into the
store and prints the same keys with `kind` `events-ingest` and the counts `delivered`, `held`,
`ingested`, `quarantined` and `completed`; see [runner events](store.md#runner-events).

- `status` is `delivered`, `deferred` or `skipped`.
- `reason` is `null` for `delivered`, otherwise a token from `REASON_TOKENS` (below).
- `detail` is free text for the runner's log.
- `cli` is the running package version and the sha256 of the `dist/cli.js` bytes, the same as
  `coordination-kit --version --json`. From source the digest is 64 zeros.

Exit status is 0 for every typed result, 2 for a usage error (a missing or malformed `--game` or
`--slot`, an unknown game or an unknown option) and 1 for an internal failure. An internal
failure prints nothing on stdout and one `coordination-kit:` line on stderr; the runner reports
it, a timeout or unparsable output as no delivery claimed, with the `cli-error` token.

| Token                   | Meaning                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `route-unavailable`     | The review route is invalid; the route owner must fix it.              |
| `recipient-unavailable` | The route recipient is not a registered role.                          |
| `recipient-busy`        | Another call holds the game's review lock, or ingest is locked.        |
| `in-flight`             | Ingest holds an unterminated last line until the runner terminates it. |
| `question-pending`      | Reserved for a question guard.                                         |
| `held`                  | The route is held: no review.                                          |
| `receipt-ambiguous`     | Reserved for an unknown previous outcome; it is never resent.          |
| `already-delivered`     | The slot's brief was already stored.                                   |
| `nothing-due`           | This game does not host the route, or there is no route.               |
| `no-events`             | The event log has nothing new.                                         |
| `cli-error`             | The runner's token for a failed CLI call; the CLI never prints it.     |
| `outbox-unreadable`     | The ingest cursor cannot be read, so nothing is consumed.              |
| `compaction-reserved`   | A manual compaction reservation is deferring journal writes.           |

`review deliver` records each typed result at `games/<g>/bus/unblock/review-deliver/<slot>.json`,
where `<slot>` is the slot start in epoch seconds, under that directory's `deliver.lock`. A repeated
call for the same game and slot prints the recorded `status`, `reason` and `detail` with the
current `cli` and calls nothing else. Contention on another call's `deliver.lock` is `deferred`
with `recipient-busy` and is not recorded. An unreadable record is an internal failure.

A write refused with `compaction-reserved` leaves the refusal out of the recorded review
results. The CLI can retry that exact slot after the reservation ends. Delivery Kit 8.1.0
continues at its next configured review slot. Refused ingest leaves the files and cursor at
their previous position for the runner's next ingest call. Journal keys deduplicate any
records committed before the refusal.

SIGTERM or an aborted signal before the brief is stored records nothing, prints nothing and exits

1. A brief stored before the stop is recorded and printed.

### Library seam

`@andornaut/coordination-kit/build/review` exports `deliverReview(options, layout, game, slot,
signal?)`, which returns the typed result above without `cli`, `storeReview`, `composeBrief`,
`showBrief(context, layout, selection)`, the route readers and `REASON_TOKENS`. `options` carries
the store `clock` and the `env` for the brief's wakes. `coordinationEmit(context, layout, game,
project)` stores explicit events as messages from `delivery-kit` to the game's
`reports.recipient`.

## Stored brief

`review deliver` resolves the route as above: no route, a route this game does not
host, a held route, an invalid route and an unregistered recipient give the same typed results.
A slot already recorded returns its result at once. Otherwise, before any store write, the review
surveys every registered role under one registry revision. It uses one read-only Codex control
connection (`CODEX_CONTROL_SOCKET`, else the managed socket) and a 256-call budget and deadline.
When there are worker parents, the question phase leaves at least 96 calls and eight seconds
of the collection budget for worker evidence. A question timeout ends the question phase.
For each eligible role it checks the exact bound recipient's question history and verifies
worker lineage under that role's native parent. The structured record includes exact validated
Codex parent and child IDs under the observed registry revision. An unreadable child gets no
lineage proof. A review proves lineage for its slot. A caller still needs that child's exact native
binding, and a caller-supplied worker label cannot provide it. Held, unsupported, unbound and
unreadable roles retain an explicit coverage reason. The read-only
[decision marker](registry.md#decision-markers) lookup uses the recipient's game bus, or the
review host bus for shared roles.

The review records store decisions and pending store questions separately from local decision
markers, native history and current prompt visibility. The native collector can verify an exact
historical question or answer reference. Current prompt visibility remains unknown without an
exact live capability. The brief counts the shared visibility limitation once; the exact
per-role reasons and history remain in `review show`. In new `review show` records, `native.questions[].decisionMarker`
reports the local marker's structural state. Invalid markers include a reason and, for incomplete
resolution references, the invalid required field names. The diagnostic contains no marker
values or answer text. A null diagnostic means the marker was not inspected.

The review counts active [user policy holds](store.md#user-policy-holds). `review show` includes
their exact target, issuer and approval evidence as recorded for the slot.

The review reads ready handoffs from existing store work records. Each ready item identifies its
recorded owner and exact linked parent, including a parent whose work record is still unavailable.
Blocked and finished work do not appear as ready handoffs.

The review composes the brief and stores it as one message from `delivery-kit` to the route
recipient, in one transaction with a `review.brief` record of the slot. The message ID
derives from (game, slot), so a repeated call, even without the per-slot result file, stores
nothing and returns the recorded result: `delivered`, with a detail naming the message, the open
count and the exception count.

The brief is at most one page, 60 lines and 4096 bytes: open message counts by state and by
recipient, unconfirmed messages, outstanding, failed, ambiguous and guarded wakes, runner events
and COMPLETE records since the game's previous brief, store decisions, worker coverage and ready
work handoffs. The native prompt and history coverage lines appear only when at least one role
had a supported native survey, that is, a bound active Codex role. Exceptions fit in the
remaining space. Stalled and overdue originals take one line per recipient each, with the count,
the oldest original's ID and its age; every other exception takes its own line. `review show` has
the full details, including every exact ID.

- `store-question-pending`: a question still pending in the store, with its exact ID and owner;
- `question-pending`: an owner-attested pending question in a Codex role's latest-turn history,
  with its title (at most 80 characters), turn, item and question index;
- `question-unknown`: an unresolved native question or prompt-visibility check, with its reason
  code. Routine held and unsupported roles appear in the detailed coverage;
- `work-ready`: a ready store work item with its owner and linked parent, when recorded;
- `worker-failed`: a verified failed latest child turn of a Codex worker parent, reported once per
  game;
- `worker-unknown`: a Codex worker parent whose child health could not be read, with its reason;
- `channel-unresolved`: an active Claude role (effective harness `claude`, not held) whose
  [channel status file](#channel-status-file) is missing (`no channel status`) or names a
  conversation other than the role's current binding (`channel on <first 8 characters>`). A
  missing file means no channel has resolved the role, so its wakes are written but not
  announced; a different conversation means the channel that wrote it has not followed the
  rebind, such as a server that has exited;
- `channel-unknown`: an active Claude role whose channel status file or directory cannot be read
  or is malformed (`channel status unreadable`). The review still stores the brief;
- `stalled`: a message still `sent` or `delivered` that was open at the game's previous brief,
  that is, open across two distinct slots. Each exact ID is compared with the previous brief's
  stalled IDs. New stalls appear first with `newlyStalled: true` in the detailed record, and the
  brief line counts them. Each detailed record carries the original's `sentAt`.
- `retention-overdue`: a retained original open across two distinct slots whose declared next
  boundary is due, so the recipient can reconcile the original with its owner. Recognized deadlines are a timezone-qualified
  ISO instant, `Next scheduled review, <instant>`, and `Next scheduled review`, which is due at the
  first recorded slot after retention. `msg retain --until ISO_TIMESTAMP` and
  `msg retain --next-review` record these boundaries explicitly. Other text remains valid for
  dependencies and holds. The recipient retains control of the original and any hold. The
  detailed record keeps each original's owner, reason and boundary.
- `unconfirmed`: an imported uncertain delivery the recipient has not closed;
- `wake-failed` and `wake-ambiguous`: an outstanding wake with that outcome;
- `wake-guarded`: a wake-pending recipient whose last wake a guard refused.

The existing brief includes the counts of newly stalled originals and newly overdue retention
boundaries. Continuing cases and exact original IDs stay visible in the detailed review.
After the commit the review sends one wake to each recipient with unread originals, the route
recipient first: it clears the recipient's outstanding wake and wakes it through its harness
adapter, as for [store wakes](store.md#wakes). A pending question does not withhold this wake;
role holds, policy holds and the Codex native input check still do, and a Codex wake still queued
from earlier is not duplicated. A secret-shaped brief omits question titles.

`coordination-kit --root R review show [--game G] [--slot S]` prints the recorded brief for the
slot, or the latest one, as one JSON line: `kind` `review-show`, the game, slot, recipient,
message ID, recording time, result, counts, every exception, the open message IDs and the body.
New briefs include `decisions` with store references and `native` with per-role evidence and the
registry revision. `native.channels` lists each active Claude role's channel `status`
(`current`, `stale`, `missing` or `unreadable`), its `binding`, the recorded `conversation`,
`pid`, `startedAt` and `version`, and `counts.native.channels` counts each status. The `unread`
list preserves the slot's exact passive snapshot with the recipient, original ID and wake
evidence. Recipients can read current unread status with
`inbox --peek`. Earlier briefs retain their original survey scope and may lack these fields.
A missing brief exits 1 with `brief-missing`.

## Wake files

A wake tells a Claude session that messages wait, without carrying them. Each role has one file,
`<stateRoot>/wake/roles/<role>.json` with a configured state root and `var/wake/roles/` without
one; a game role's file is `<game>/<role>.json` there:

```json
{ "schema": 1, "seq": 3, "role": "game-coordinator", "count": 2 }
```

`seq` increases by one per write; `count` is the number of new messages. `writeWakeFile` replaces
the file atomically under a per-role lock and refuses a torn file, whose seq is unknown.
`msg send` writes it for a Claude recipient, at most once per outstanding wake, and the
scheduled review writes it once per review while originals stay unread
([store wakes](store.md#wakes)). Because the file is keyed by role, a rebind changes nothing for
the channel. A Codex recipient's wake is one guarded control-socket queue add.

## Claude channel

`coordination-kit claude channel` is the stdio MCP server the recipient session launches; see
`examples/claude-channel.mcp.json`. A session reads that configuration only at launch, and `/mcp`
reconnect restarts the launch-time command. A command that runs `node
<gc>/node_modules/@andornaut/coordination-kit/dist/cli.js --root <gc> claude channel` stays the
same across kit releases, so an upgrade needs `npm ci` at the root and a reconnect, not a
relaunch.

After `notifications/initialized` the server polls its role's wake file. With
`--conversation UUID` the role is the one whose effective Claude conversation is that ID. Claude
keeps a channel's launch arguments for the life of the session, so a `/mcp` reconnect after a
`/clear` still names the old ID. When no role is bound to it, the channel follows the `/clear`
lineage forward: across every project directory under `$CLAUDE_CONFIG_DIR/projects` (else
`$HOME/.claude/projects`), the one `*.jsonl` transcript whose header proves a `derived-from`
record via `clear` from that ID, by the same rules as the
[rebind after /clear](store.md#rebind-after-clear). A successor can sit in another project
directory than its predecessor when the session reached the same working directory through
another path, such as a symlink. Only transcripts modified at or after the ID's own transcript
are read. If that descendant is bound to exactly one Claude role, the channel serves it;
otherwise it follows that descendant's own successor, for at most 16 steps. No descendant,
several, or a fork or resume lineage leaves it unresolved; it never guesses. While unresolved it
checks the binding on every poll and scans the lineage at most once a minute. Once resolved, the
role stays fixed when `session start` later rebinds it, so the running channel keeps announcing
the role's wakes. Each seq increase emits one channel notification with the fixed text
`N new messages for ROLE: run coordination-kit inbox` and `meta` `{"kind":"wake","seq":"N"}`.
Increases between two polls coalesce into one notification, a seq is never announced twice and a
lower seq is never announced. A wake present when the channel starts is announced once, because it
may have been written while no channel was watching, and an absent file counts as seq 0. A
missing, torn or malformed file is skipped until a later poll. The server carries no message
payload: the recipient reads its messages with `coordination-kit inbox`.

`CLAUDE_BIN` overrides the `claude` executable that `claude ready` and `harness doctor` list.

## Channel status file

`claude channel` writes `<stateRoot>/channel/roles/<role>.json` (`var/channel/roles/` without a
configured state root) when it resolves its binding. At most once a minute it checks for a
replacement. A running channel updates the file only after verifying `/clear` lineage from its
previously proven conversation to the new binding. An unrelated replacement leaves the earlier
conversation reported until a channel connects for the new binding. On an update, `pid`,
`startedAt` and `argv` stay those of the running server. A game role's file is `<game>/<role>.json`
there. The role is the lookup key for `harness doctor` and the scheduled review:

```json
{
  "schema": 2,
  "role": "game-coordinator",
  "conversation": "UUID",
  "version": "6.0.0",
  "distSha256": "HEX",
  "pid": 4242,
  "startedAt": "ISO",
  "argv": ["/usr/bin/node", "/root/node_modules/@andornaut/coordination-kit/dist/cli.js", "..."]
}
```

A failed write never stops the channel. `harness doctor` reads it to report the loaded CLI; see
[the scoped doctor](registry.md#scoped-harness-doctor). The scheduled review compares its
`conversation` with the role's current binding and reports a missing, different or unreadable
file as a [brief exception](#stored-brief). A file shows that a channel resolved its role, never
that it is still connected.
