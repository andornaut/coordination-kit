# Upgrading

Moving from coordination-kit 2.1 to 3.0, from 2.0 to 2.1, from 1.3 to 2.0, from 1.1 to 1.2, and from delivery-kit
4.7 to coordination-kit 1.0.

## From 3.0.0

- A handoff hold no longer withholds wakes once `harness select` binds the role on the handoff's
  target harness, so the target session can be woken to run `handoff active`.

## From 2.1

3.0 removes the Phase 4 layers of the [simplification plan](design/simplification.md#phase-4-thin-protocol-and-retirement).
Identity and fencing come from the registry binding alone.

Removed:

- Commands: every `protocol` command, every `ledger` command, `message send|dispatch|status|reconcile|retire-spool`,
  `inbox snapshot|ack`, `events flush`, `store cutover`, `store import --from-legacy`, `--capture`,
  `claude channel --state-dir` and `question open --options-file` (now repeated `--option LABEL`).
- Mechanisms: epochs, claims, enrollment, adoption, coverage, intake offers, the request ledger,
  protocol journals, the legacy message store, the Claude spool, the transport outbox, the bus
  `events/` outbox, review snapshots, acknowledgements and reconciliation, the legacy native
  review path, Codex worker verification and the Codex worker inbox. `claude channel` only
  emits wakes.
- Package subpaths: `build/protocol`, `build/accounting`, `build/transport` and `build/events`.
  `build/review` drops `deliverScheduledReview`, `reviewOutcome` and `DEFERRED_PREFIX` and adds
  `deliverReview`; `build/store` drops the legacy import, `storeMode`, `isStoreMode` and
  `storeCutover` and adds the request and retirement functions. `build/registry` and
  `build/shared` are unchanged.
- Output: `status` is schema 2 without `coordinator.protocol`, `coordinator.ledger` and
  item `protocol` ([status](commands.md#status)); `work report` has no `publications` and no
  `unconfigured` state; `claude ready` and `codex ready` print no `accounting`; `harness doctor`
  reports `channel_reference` as the wake file (`source: "wake_file"`).

Added:

- Commands: `session start` and `handoff open|ready|state|active|show`,
  with the `sessions`,
  `handoffs` and `handoff_roles` projections, added when a 2.1 store is first opened; see
  [sessions and handoffs](store.md#sessions-and-handoffs). The schema version stays 1.

`var/work-protocol.json` becomes `{"schema":2,"stateRoot":"/abs"}`. 3.0 still reads the 2.1
shape and ignores `work-protocol-fence.json` and `<stateRoot>/workspace.json`.

### Retirement runbook

Run it once at the 3.0 cutover, in a window after a scheduled review with no planned handoff.

1. Pin 3.0 at the coordinator root (`npm ci`) and replace each runner with delivery-kit 7.0 while
   idle. No 2.1 writer remains, so the ledger and protocol journals are frozen.
2. Back up the state root and `var/work-protocol-fence.json`.
3. Run `store retire --dry-run` and match `requests` and `paths` against the inventory.
   `requests.unowned` lists requests no binding can close; give them an owner or close them
   after import as `game-coordinator` through a work item.
4. Run `store retire --apply` as `game-coordinator` and keep its `archive.sha256`.
5. Rewrite `var/work-protocol.json` to `{"schema":2,"stateRoot":...}` with the same state root.
6. Each owner maps its imported requests to work files, or closes them with `request close`.

The originals stay in place; deleting them needs separate user approval.

### Rollback

1. Restore the archive over the state root (`tar -xzf phase4-<date>.tar.gz -C <stateRoot>`, and
   `var/work-protocol-fence.json` from its `var/` member) and the 2.1 `work-protocol.json`.
2. Pin coordination-kit 2.1.2 at the coordinator root and delivery-kit 6.1 in each game, `npm ci`,
   and replace the runners while idle.
3. The frozen state restores exactly. Store events recorded since, including the imported
   requests and `store.retired`, remain in `coordination.db` as history; 2.1 ignores them.

To read the archive without rolling back, extract it to scratch and run the 2.1.2 CLI that the
manifest's `readWith` names against that copy.

## From 2.1.1

- `gate_passed` (delivery-kit 6.1.2 and later) is a quiet type: stored as an event, not delivered,
  and it proves the gate for COMPLETE.

## From 2.1.0

- `work check` no longer requires `approved` on a `proposed` or `declined` item, and accepts
  `supersedes` as one ID or a list, checking every target.
- `status` reports `workFile.supersedes` as a list of IDs (empty when there is none) instead of
  one ID or null; each named item is `superseded` by this one.

## From 2.0

2.1 adds [work records](store.md#work-records), the [decision graph](store.md#decision-graph), the
[approval-ledger import](store.md#approval-ledger-import) and
[questions, holds and decisions](store.md#questions-holds-and-decisions). The store file, its
schema version and every 2.0 event are unchanged; message and runner behaviour is unchanged apart
from the wake guard below.

- Work verbs: `work start`, `work evidence`, `work block`, `work unblock`, `work ready`,
  `work finish`, `work show`, `work history`, `graph`, `graph why`, `graph index`, and
  `store import --approval-ledger FILE`.
- Store: the `work`, `work_evidence`, `work_retained`, `questions`, `decisions` and `holds`
  projections are added when a 2.0 store is first opened by 2.1, filled from existing events; the schema version stays 1. `graph index`
  adds derived tables that are safe to delete.
- Work files: `owner` is a new optional front-matter field and Decisions sections may carry
  decision lines. A 2.0 `work check` reports `owner` as `field-unknown`: release 2.1, bump every
  repository's pin, then add the field.
- `status`: adds `coordinator.store`, and `store` and `deliverySource` per item. Store stage
  evidence is preferred to Git for `landed` and `deployed`, an open store block sets `blocked`, and
  an unavailable store exits 1. Existing fields keep their meaning.
- Approval ledger: freeze `approval-ledger.json`, run `store import --approval-ledger FILE
--dry-run` and check that the outcome counts sum to the entry count, then import as
  game-coordinator. Owners stub the listed entries without a work file. Imported holds are never
  released by import.
- Question verbs: `question open|answer|cancel|list`, `hold set|release|list` and `decision list`.
  Writes go through the registry fence, and only the owning role answers, cancels or releases its
  own records.
- Holds: `work start` refuses an item that an active hold covers (its `work:` scope, its owner's
  `role` hold or its `game:` hold), including imported approval-ledger holds, which keep their
  recorded owner.
- Decisions: `question answer` records a typed decision and appends its `- D<n> (...)` line to
  `docs/work/<id>.md` in the main checkout of the caller's repository, left unstaged. Commit it
  with the role's next commit.
- Wakes: a recipient with a pending question or an active `role` hold gets no wake, logged
  `guarded`. Each owner records its existing pending prompts with `question open` so the guard
  sees them; the native prompt is not touched. The Codex native question check still runs.
- History: `msg history` without `--include-body` is unchanged. `--include-body` identifies the
  caller and shows bodies only to the message's sender, its recipient and `game-coordinator`.
- Library: `@andornaut/coordination-kit/build/store` adds the question, hold and decision functions,
  `QUESTIONS_PROJECTION` and `questionHoldGuard`, which is now the default `storeGuard` of
  `wakeRecipient`. Pass `NO_STORE_GUARD` to keep the 2.0 behaviour.
- Rollback: a 2.0 CLI ignores the new event kinds and tables; they stay in the store as history.

## From 1.3

2.0 adds the [coordination store](store.md), `coordination.db` beside the wake files, its verbs,
runner event ingest, the stored review brief and the cutover. Until `store cutover --apply`, every
1.3 path behaves as before: the legacy message store, the `message` commands, native review
briefs, `events flush` and the event outbox.

- New verbs: `msg send`, `inbox`, `msg done`, `msg retain`, `msg status`, `msg history`,
  `store import`, `store export`, `store rebuild`, `store cutover`, `events ingest` and
  `review show`. `inbox` alone is the store read; `inbox snapshot` and `inbox ack` are unchanged.
- Identity: writing verbs take no `--from`. The caller is the role whose effective registry
  binding equals `--native-id`, `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`; no enrollment or
  epoch is involved. Workers write under their parent with an unverified `--worker NAME`.
- Delivery: `msg send` stores the message, then sends at most one wake per recipient: the Claude
  wake file that `claude channel` already watches, or one guarded Codex queue add. Wakes carry no
  payload; recipients run `coordination-kit inbox`. There is no `dispatch` or `reconcile`.
- Closing: `msg done ID` or `msg retain ID --reason R --next-boundary B` replaces the receipt,
  artifact and `message reconcile` sequence.
- Runner seam: delivery-kit 6.1 runners append to `var/games/<g>/bus/events.jsonl` and call
  `events ingest`, which stores runner events and COMPLETE as messages from `delivery-kit`
  ([runner events](store.md#runner-events)). 6.0 runners keep `events flush`. Install 2.0 at the
  coordinator root before any 6.1 runner starts; 6.1 requires `>=2.0.0 <3.0.0`.
- Store mode: the [store cutover fence](store.md#store-mode) selects it. Then `review deliver`
  stores a one-page brief per (game, slot) ([stored brief](review.md#stored-brief)), review
  health goes to the store, and legacy message writes are refused with `store-cutover`.
- Doctor: Claude rows report `channel_command` (the configured channel command against the stable
  path) and `channel_server` (the version and digest the running channel wrote at start).
- Channel: `claude channel` writes a [status file](review.md#channel-status-file) at start. Move
  every channel MCP config to the stable command
  `node <root>/node_modules/@andornaut/coordination-kit/dist/cli.js --root <root> claude channel`
  before the cutover; an `npx` command needs one relaunch onto it.
- Library: `@andornaut/coordination-kit/build/store` is a new subpath, and `build/review` adds the
  stored brief; the others are unchanged.
- Cutover: follow the [runbook](store.md#runbook), in one window from :35 to :55 after a review.
- Rollback: [store rollback](store.md#rollback). Restoring the previous fence returns this kit to
  legacy mode, and restoring the 1.3 pins makes a 1.3 CLI work again; `coordination.db` stays.

## From 1.1

On-disk formats are unchanged; 1.2 adds files beside them. Runners that bundle 1.1 and the 1.2 CLI
work against the same state.

- Capture: automatic accounting capture at inbox snapshots, scheduled reviews, `message send`,
  `protocol boundary` and the mutating `protocol work-*` and `message-*` commands is off. Pass
  `--capture` to restore it for a call; `ledger boundary` still captures. The ledger and intake
  then grow only from explicit commands, coverage reports list fewer references, and enrollment
  and adoption are not refused for it. The library seam `deliverScheduledReview` takes
  `options.capture`; without it a bundled runner's reviews do not capture either.
- Runner seam: `review deliver --game G --slot S` and `events flush --game G` print one typed JSON
  line each ([review](review.md#cli-seam)). They replace parsing `DEFERRED_PREFIX` and
  `flushEvents` calls in the runner. Recorded results are new files under
  `games/<g>/bus/unblock/review-deliver/`. `flushEvents` now returns its result.
- Identity: `--version --json` prints the version and the sha256 of `dist/cli.js`; every seam result
  carries the same pair. Plain `--version` is unchanged.
- Channel: `claude channel` drains the legacy spools as before and also watches the conversation's
  [wake file](review.md#wake-files); no wake file is written yet. A channel configuration that runs
  `node <gc>/node_modules/@andornaut/coordination-kit/dist/cli.js --root <gc> claude channel` keeps
  the same command across releases, so after this one-time change `npm ci` plus `/mcp` reconnect
  adopts each later release without a relaunch. A session started with another command needs one
  relaunch onto that path.

## From delivery-kit 4.7

The coordination commands, modules and state move out of delivery-kit unchanged. delivery-kit
keeps the game operations (`run`, `runner unit`, `status`, `control`, `check-config` and
`request`) and, from 5.0, depends on this package.

- State: nothing moves and nothing is rewritten. The state root, registry, route, message store,
  Claude spool, receipts, ledger events, protocol journals and artifact store keep the byte
  formats delivery-kit 4.7.0 wrote, and both kits read and write them.
- Commands: `delivery-kit GROUP VERB ...` becomes `coordination-kit GROUP VERB ...` for the
  `inbox`, `message`, `ledger`, `harness`, `claude`, `codex` and `protocol` groups, with the same
  options, JSON output and exit codes. Errors on stderr are prefixed `coordination-kit:`.
- Root: `--root` and `DELIVERY_KIT_ROOT` keep working. `COORDINATION_KIT_ROOT`, when nonempty, takes
  precedence over `DELIVERY_KIT_ROOT`.
- Channel MCP configuration: run `coordination-kit ... claude channel` instead of
  `delivery-kit ... claude channel`. The server still identifies itself as
  `delivery-kit-channel`, so an existing server key needs no change. Relaunch each session after
  the change; `/mcp` reconnect reruns the command the session launched with.
- Library imports: `@andornaut/delivery-kit/build/registry`, `/build/transport`,
  `/build/accounting` and `/build/protocol`, and their unprefixed aliases, become
  `@andornaut/coordination-kit/build/registry`, `/build/transport`, `/build/accounting` and
  `/build/protocol` with the same symbols. This package has no unprefixed aliases.
- Output: `harness doctor` keeps `recovery_owner: "delivery-kit"` for adapter failures the kit
  must recover, as delivery-kit 4.7.0 printed it.
- delivery-kit's removed command forms from 2.0 and 3.0 (`monitor ...`, `channel ...` and the
  others) are not recognized here; they print usage and exit 2.
