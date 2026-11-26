# Configuration

The workspace root, its `config.json`, the fields of an app's `delivery-kit.json`
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

## Workspace `config.json`

Commit schema 1 in the primary workspace checkout. All checkout paths are relative to that
root. Use exactly one of `apps` and `games`.

- `timezone` and `wakeMinutes` (integers 0 to 59): the scheduled review minutes. An empty
  `wakeMinutes` schedules no review.
- `apps.<id>`: report `name`, repository `path` and explicit registry `roles`, such as
  `operator` or `dashboard/tech`. The app ID need not be part of a role key.
- `games.<id>`: the legacy shape with the same entry fields and role names such as `tech`.
  The kit expands each name to `<game>/<role>`. See the
  [legacy example](https://github.com/andornaut/coordination-kit/blob/main/examples/config.json).
- `kits.<id>.path` and `sharedRoles`.
- `permissions` is required with `apps`. Each listed role has a `workspace` array and an
  `apps` map of app IDs to grant arrays. An omitted role has no grants.
  [Permission checks](store.md#app-mode-permissions) describe how grants apply.
- `appStateDir` is optional with `apps`. It defaults to `apps`. Use `games` for an in-place
  migration that preserves runtime paths.

Registry entries, review routes and recipient references use the exact configured role keys.

## App `delivery-kit.json`

An app using Delivery Kit commits a schema-1 `delivery-kit.json`. Delivery Kit documents
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
  Coordination reports take the display name from the app or game entry's `name` in `config.json`.
- `scheduledTicks`: whether the app's runner reports scheduled departure slots.
- `recipient`: a registered role key. It receives the app's events and, when the app hosts the
  route, its scheduled reviews. `claude channel` defaults to it.
- `workerParents`: required list of role references retained for configuration compatibility. The
  current scheduled review derives native coverage from the registry.

## Start an app workspace

1. In the primary workspace checkout, commit `config.json` as below, the compatible checked
   Coordination Kit pin and its lockfile, and `.gitignore` rules for `/var/` and `/node_modules/`. Install with
   `npm ci`. In the app repository, commit `delivery-kit.json` if you plan to run reviews or
   ingest runner events. In its `reports` section use the exact recipient key `operator`.
2. Establish the actual Codex session from the app's worktree. Run the registry seed command
   below from the primary workspace checkout using the verified native project and conversation IDs.
3. In that session, use the workspace's installed CLI with the absolute workspace root and
   run `session start` as in the [coordinator startup command](#start-a-fresh-coordinator).
   Start with SQLite. Use the [filesystem migration guide](upgrading.md#filesystem-authority-migration)
   to qualify and activate filesystem authority.

```json
{
  "schema": 1,
  "timezone": "UTC",
  "wakeMinutes": [],
  "apps": {
    "dashboard": { "name": "Dashboard", "path": "../dashboard", "roles": ["operator"] }
  },
  "kits": {},
  "sharedRoles": [],
  "permissions": {
    "operator": {
      "workspace": ["store:maintain"],
      "apps": { "dashboard": ["review:deliver", "events:ingest", "delivery:operate"] }
    }
  }
}
```

Set `native_project_id` and `conversation_id` to the verified IDs before seeding the registry.

```sh
node --input-type=module - "${native_project_id:?}" "${conversation_id:?}" <<'JS'
import { createRegistry, loadLayout } from "@andornaut/coordination-kit/build/registry";

const [, , nativeProjectId, conversationId] = process.argv;
const registry = createRegistry(() => new Date(), loadLayout(process.cwd()), {
  schema: 1,
  harness: "codex",
  host: { nativeProjectId, root: "." },
  roles: {
    operator: {
      ownership: "active",
      worktree: "../dashboard",
      conversations: { codex: conversationId },
    },
  },
  operations: { dashboard: { busOwner: "operator" } },
  transfers: [],
});
console.log(JSON.stringify({ revision: registry.revision }));
JS
```

The workspace owner provisions the active runner binding and review route before enabling a
scheduled runner. The example leaves scheduled reviews disabled with `wakeMinutes: []`.
See the [review route](review.md#review-route) and [runner commands](store.md#runner-events).

### Migrate a legacy coordinator in place

1. Have the live workspace owner verify and adopt the compatible Coordination Kit reader
   before adopting an app-mode Delivery Kit writer. Use the existing owner, runner controls
   and scheduled cutover boundary.
2. In `config.json`, replace `games` with `apps` and replace each legacy role name with its
   current full registry key. For example, `games.dashboard.roles: ["tech"]` becomes
   `apps.dashboard.roles: ["dashboard/tech"]`. Set `appStateDir: "games"` and add explicit
   grants for the existing owners and the runner's verified binding.
3. Retain the app IDs, checkout paths, registry bindings, `operations.<id>.busOwner`, route,
   event and cursor files, and current store authority. The `games` state setting keeps
   `var/games/<id>/bus/` and `var/game-dev/`. The live workspace owner adopts the config and
   pins after verifying the exact bindings and their permissions.

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
| `config.json`, `package.json`, `package-lock.json` in the workspace                       | Tracked              | App or game definitions, role grants and the installed kit pin.                                         |
| `delivery-kit.json` and project work files in each app repository                         | Tracked              | Delivery and reporting configuration, work definitions and decision lines.                              |
| `var/registry.json`, `var/registry.lock`, `var/route.json`, `var/handoffs/`               | Ignored              | Local native bindings, review routing and role checkpoints.                                             |
| `var/coordination/`, `var/coordination-authority.json`, `var/coordination-authority.lock` | Ignored              | [Filesystem journal and role records](store.md#filesystem-layout), authority receipt and switch lock.   |
| `var/apps/<id>/bus/` or `var/games/<id>/bus/`                                             | Ignored              | Runner state and event logs, ingest cursor and quarantine, review result receipts and decision markers. |
| `var/reviews/` or `var/game-dev/`                                                         | Ignored              | Local review and inbox diagnostics, acknowledgements and retentions.                                    |
| `var/work-protocol.json`                                                                  | Ignored              | Optional external state-root pointer for the SQLite source, channel and wake files, and artifacts.      |
| External state root and independent backups                                               | Outside the checkout | `coordination.db`, transport state, artifacts and retirement archives.                                  |

The state pointer is `{"schema":2,"stateRoot":"/abs"}`. The 2.1 shape (`schema` 1 with
`workspaceId` and `generation`) is still read. The configured root must be absolute and outside
every configured repository, registered worktree and Git checkout (`state-root-excluded`).
A malformed pointer is `invalid-state-root-config`. Without a pointer, the source database,
`wake/`, `channel/`, `artifacts/` and any retirement `archive/` are under `var/`. Filesystem
activation moves store authority only. It retains the configured transport and artifact paths.

Example fresh app workspace and sibling repository after filesystem activation. See the
[filesystem layout](store.md#filesystem-layout) for journal and role records.

```text
workspace/
  .gitignore, config.json, package.json, package-lock.json  tracked
  node_modules/                                  ignored dependency install
  var/                                           ignored
    registry.json, registry.lock, route.json, handoffs/
    coordination-authority.json, coordination/
    reviews/
    apps/dashboard/bus/
      events.jsonl, events.cursor
    work-protocol.json                           optional external state pointer
dashboard/
  delivery-kit.json, docs/work/                   tracked
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
