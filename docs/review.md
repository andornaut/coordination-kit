# Review route, scheduled review and harness adapters

The scheduled review route `var/route.json`, the seam between delivery-kit's runner and this
kit, how the Claude and Codex adapters deliver briefs and events, mixed inbox snapshots and the
event outbox.

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

The dependency runs one way: delivery-kit imports this kit, and this kit never imports
delivery-kit. The runner owns cadence: it reads the clock, decides which `wakeMinutes` slot is
due, never replays a missed slot and logs the outcome. This kit owns everything after that.

`deliverScheduledReview(layout, game, slot, signal?)` from
`@andornaut/coordination-kit/build/review` resolves the route and its recipient through the
registry as it is at that moment, checks the game's `reports.workerParents`, captures the inbox
inventory and message health, composes the brief and delivers it through the recipient's
effective harness. It returns one line for the runner to log:

- `""` when this game does not host the route, the route is held or absent;
- a line starting with `DEFERRED_PREFIX` (`bus: review deferred:` and a space) when the review is deferred before
  any native call;
- otherwise one JSON object with `status` and the slot, snapshot and health fields.

A review health event (`review-stuck`) goes to the game's event outbox through `recordEvent`. The
runner then flushes the outbox with `flushEvents(game)` from
`@andornaut/coordination-kit/build/events`. Slot receipts, snapshots and health records keep the
paths and formats delivery-kit 4.7.0 wrote.

## Harness adapters

- **Claude:** briefs and events are spooled under the bus's `unblock/` directory with a `sending`
  receipt written first. `coordination-kit claude channel` claims each entry, delivers it once to
  the recipient session, records the delivery, marks the receipt `accepted`, then removes the
  entry. A `sending` receipt with no spool entry becomes `ambiguous` and is never resent. The
  channel server is configured in the recipient session's MCP settings; see
  `examples/claude-channel.mcp.json`. A session reads that configuration only at launch: `/mcp`
  reconnect restarts the launch-time command, so a configuration change needs a relaunch. A brief or event is spooled only while
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

## Event outbox

`games/<g>/bus/events/` holds one `<sha256(kind:key)>.json` file per event; every `blocked-*` kind
shares one identity, so a changed block reason is not recorded again. `recordEvent` enqueues an
event once under `events/state.lock` and runs the producer's optional `underLock` step under the
same lock; delivery-kit uses that step to track each pushed commit's CI and deployment state and
to add its `complete` event. Progress kinds (`ci_pending`, `ci_running`, `deploy_pending`,
`deploy_retry` and `gate_skipped`) are never recorded, and any already queued is marked
`suppressed` at the next flush.

`flushEvents(game)` delivers unsent events in creation order under the non-blocking
`dispatch.lock`, to the game's `reports.recipient` through its effective harness, with no queue
fallback. Each delivered text stays within 900 UTF-8 bytes and ends with its event ID. An event is
marked sent only after the adapter accepts it; the first refusal stops a flush and the next flush
resumes there. A prior receipt for another recipient or provider whose outcome is unknown holds
the event until it is reconciled. An unresolvable recipient leaves every event unsent.
