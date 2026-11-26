# Configuration

The coordinator root, game-coordinator's `config.json`, the fields of a game's `delivery-kit.json`
that coordination reads, and where the kit keeps mutable state.

Configuration never holds secret values. Use the operator's existing authentication and credential
references.

## Coordinator root

Commands that use the coordinator root resolve it in this order.

1. `--root DIR`, anywhere on the command line, at most once;
2. `COORDINATION_KIT_ROOT`, unless empty;
3. `DELIVERY_KIT_ROOT`, the variable delivery-kit's runners and existing sessions already set;
4. the working directory.

The `work` commands read `--root` as the repository to inspect (default: the working directory)
and take the coordinator root only from `COORDINATION_KIT_ROOT`, else `DELIVERY_KIT_ROOT`.

## game-coordinator `config.json`

Committed in game-coordinator, schema 1. Every path is relative to game-coordinator. See the
[example configuration](https://github.com/andornaut/coordination-kit/blob/main/examples/config.json).

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
sections through unread, so a new delivery-kit setting does not refuse a
scheduled review or an event ingest. `loadProjectConfig` and `validateProjectConfig` keep the full
rules that delivery-kit loads its configuration with ([libraries](libraries.md)).

This kit uses only `reports`:

- `project`: an optional legacy display name. Both readers still validate a supplied value.
  Coordination reports take the display name from `games.<id>.name` in coordinator `config.json`.
- `scheduledTicks`: whether the game's runner reports scheduled departure slots.
- `recipient`: a registered role key. It receives the game's events and, when the game hosts the
  route, its scheduled reviews. `claude channel` defaults to it.
- `workerParents`: required list of role references retained for configuration compatibility. The
  current scheduled review derives native coverage from the registry.

## Start a fresh coordinator

1. Prepare the primary Git checkout with a valid `config.json`, a pinned Coordination Kit
   dependency and its lockfile, and an ignore rule for `var/`. Install the dependency with
   `npm ci`. The [minimal example](#registry-seed-example) starts with the coordinator role.
2. Establish the actual role sessions and [seed the registry](#registry-seed-example) with the
   public [registry library](libraries.md#registry-library). It initializes revision 1 from
   the supplied bindings.
3. From an active registered session, set `coordinator_root` to the absolute primary checkout
   path and run `session start`.
   With the default authority, a successful first store open creates `coordination.db` in the
   configured state root, or under `var/` when no pointer exists.

```sh
node "$coordinator_root/node_modules/@andornaut/coordination-kit/dist/cli.js" \
  --root "$coordinator_root" session start
```

A fresh workspace starts with SQLite. To select filesystem authority, qualify the existing
SQLite source with an independent backup and restore, then activate the exact receipt through
the [migration procedure](upgrading.md#filesystem-authority-migration). Creating an empty
`var/coordination/` does not select it.

### Registry seed example

For a coordinator-only workspace, commit this `config.json` in the primary checkout.

```json
{
  "schema": 1,
  "timezone": "America/Toronto",
  "wakeMinutes": [],
  "games": {},
  "kits": {},
  "sharedRoles": ["game-coordinator"]
}
```

Run the following from that checkout after installing the pinned kit. Set `native_project_id`
and `conversation_id` to the verified project and Codex conversation IDs for this workspace.

```sh
node --input-type=module - "${native_project_id:?}" "${conversation_id:?}" <<'JS'
import { createRegistry, loadLayout } from "@andornaut/coordination-kit/build/registry";

const [, , nativeProjectId, conversationId] = process.argv;
const registry = createRegistry(() => new Date(), loadLayout(process.cwd()), {
  schema: 1,
  harness: "codex",
  host: { nativeProjectId, root: "." },
  roles: {
    "game-coordinator": {
      ownership: "active",
      worktree: ".",
      conversations: { codex: conversationId },
    },
  },
  operations: {},
  transfers: [],
});
console.log(JSON.stringify({ revision: registry.revision }));
JS
```

## Add a game

1. Add the game ID, display name, repository path and roles to the coordinator's committed
   `config.json`. The game repository supplies its own committed `delivery-kit.json`.
2. Register the exact role sessions and worktrees with the coordinator's revision-checked
   registry writer. Set `reports.recipient` to a registered role. Any optional review membership
   uses the same role keys in the coordinator's local [route](review.md#review-route).
3. Follow the [coordinator workspace setup guide](https://github.com/andornaut/game-coordinator/blob/main/docs/setup.md#add-a-game)
   for readiness, acceptance and activation. The kit validates references and records coordination state. The coordinator
   provisions native sessions, adopts routing and controls, and authorizes scheduled delivery.

## State

| Location                                                                                  | Git                  | Content                                                                                                 |
| ----------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| `config.json`, `package.json`, `package-lock.json` in the coordinator                     | Tracked              | Game and role definitions and the installed kit pin.                                                    |
| `delivery-kit.json` and project work files in each game repository                        | Tracked              | Delivery and reporting configuration, work definitions and decision lines.                              |
| `var/registry.json`, `var/registry.lock`, `var/route.json`, `var/handoffs/`               | Ignored              | Local native bindings, review routing and role checkpoints.                                             |
| `var/coordination/`, `var/coordination-authority.json`, `var/coordination-authority.lock` | Ignored              | [Filesystem journal and role records](store.md#filesystem-layout), authority receipt and switch lock.   |
| `var/games/<game>/bus/`                                                                   | Ignored              | Runner state and event logs, ingest cursor and quarantine, review result receipts and decision markers. |
| `var/work-protocol.json`                                                                  | Ignored              | Optional external state-root pointer for the SQLite source, channel and wake files, and artifacts.      |
| External state root and independent backups                                               | Outside the checkout | `coordination.db`, transport state, artifacts and retirement archives.                                  |

The state pointer is `{"schema":2,"stateRoot":"/abs"}`. The 2.1 shape (`schema` 1 with
`workspaceId` and `generation`) is still read. The configured root must be absolute and outside
every configured repository, registered worktree and Git checkout (`state-root-excluded`).
A malformed pointer is `invalid-state-root-config`. Without a pointer, the source database,
`wake/`, `channel/`, `artifacts/` and any retirement `archive/` are under `var/`. Filesystem
activation moves store authority only. It retains the configured transport and artifact paths.

Example coordinator checkout after filesystem activation. See the
[filesystem layout](store.md#filesystem-layout) for journal and role records.

```text
coordinator/
  config.json, package.json, package-lock.json    tracked
  var/                                           ignored
    registry.json, route.json, handoffs/
    coordination-authority.json, coordination/
    games/example-game/bus/
    work-protocol.json                           optional external state pointer
```

With SQLite selected and no pointer, the database is `var/coordination.db`. With a pointer,
the SQLite database, transport state and artifacts live under its external `stateRoot`.

Only the runner writes `events.jsonl` and its rotated `events.<epochSeconds>.jsonl` logs.
`events ingest` owns `events.cursor`, `events.quarantine.jsonl` and `events.ingest.lock`. See
[runner events](store.md#runner-events). The bus `unblock/` directory holds `review-deliver/`
receipts and the recipient decision records the Codex wake guard reads.

Registry and authority metadata use durable file replacement. SQLite writes use transactions.
The filesystem journal uses [batch publication](store.md#filesystem-layout). State locks use
`flock(1)`. The kit writes nothing under any `.claude/` directory.
