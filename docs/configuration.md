# Configuration

The coordinator root, game-coordinator's `config.json`, the fields of a game's `delivery-kit.json`
that coordination reads, and where the kit keeps mutable state.

Configuration never holds secret values. Use the operator's existing authentication and credential
references.

## Coordinator root

Every command except `work check` and `work report` resolves the game-coordinator root from, in
order:

1. `--root DIR`, anywhere on the command line, at most once;
2. `COORDINATION_KIT_ROOT`, unless empty;
3. `DELIVERY_KIT_ROOT`, the variable delivery-kit's runners and existing sessions already set;
4. the working directory.

The `work` commands read `--root` as the repository to inspect (default: the working directory)
and take the coordinator root only from `COORDINATION_KIT_ROOT`, else `DELIVERY_KIT_ROOT`.

## game-coordinator `config.json`

Committed in game-coordinator, schema 1. Every path is relative to game-coordinator. See
`examples/config.json`.

- `timezone` and `wakeMinutes` (integers 0 to 59): the scheduled review minutes. An empty
  `wakeMinutes` schedules no review.
- `games.<id>`: `name` (the report name, for example `Archie`), `path` to the game checkout and
  `roles`.
- `kits.<id>.path` and `sharedRoles`.

Role keys are `<game>/<role>` for each game role, then each shared role name. The registry, the
route and every role reference must use these keys.

## Game `delivery-kit.json`

Each game commits a `delivery-kit.json`, schema 1, owned by its Tech role. delivery-kit documents
its delivery sections: `git`, `schedule`, `gate`, `resources`, `ci` and `deploy`.

| Reader                                                         | Validates                                    |
| -------------------------------------------------------------- | -------------------------------------------- |
| coordination-kit commands, scheduled reviews and event flushes | the top-level shape and `reports`            |
| delivery-kit, through `loadProjectConfig` from `build/shared`  | every section, with the same top-level shape |

The top-level shape is an object holding exactly `schema` (1), the six delivery sections and
`reports`, with no secret-like key. This kit's readers (`loadReportsConfig`) pass the delivery
sections through unread, so a new delivery-kit setting does not refuse an inbox snapshot, a
scheduled review or an event flush. `loadProjectConfig` and `validateProjectConfig` keep the full
rules that delivery-kit loads its configuration with ([libraries](libraries.md)).

This kit uses only `reports`:

- `project`: the game's display name, matching its `name` in `config.json`.
- `scheduledTicks`: whether the game's runner reports scheduled departure slots.
- `recipient`: a registered role key. It receives the game's events and, when the game hosts the
  route, its scheduled reviews. `inbox snapshot`, `inbox ack` and `claude channel` default to it.
- `workerParents`: registered role keys whose verified workers the scheduled review covers. Each
  must belong to the active review route.

## State

The legacy default is game-coordinator's ignored `var/`. These paths remain there even when the
work protocol is active:

- `registry.json` and `registry.lock`.
- `route.json`: the review route.
- `handoffs/<scope>/`: checkpoints the registry references.
- `game-dev/`: review and inbox snapshots, health history, acknowledgements, retentions and the
  legacy message store. This persisted directory keeps its name.
- `games/<g>/bus/events/`: the event outbox (see [review](review.md#event-outbox)) and
  `games/<g>/bus/unblock/`: the scheduled review slot receipts, the Claude spool and recipient
  decision records. The rest of `games/<g>/bus/` belongs to delivery-kit's runner.
- `work-protocol.json` and `work-protocol-fence.json`: the work protocol's configuration pointer
  and cutover fence.

An active work protocol uses its external `stateRoot` for publications and artifacts,
`<stateRoot>/accounting` for the request ledger and intake, and `<stateRoot>/transport/messages`
for derived message transport state and recipient spools.

Every state write is a temp file, fsync, rename, then a directory fsync. Locks are `flock(1)` on
files under the selected state directories. The kit writes nothing under any `.claude/`
directory.
