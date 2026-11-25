# Registry

The shared role registry `var/registry.json`, scoped harness selection, send-time conversation resolution, the readiness probe and the scoped harness doctor.

`var/registry.json` (schema 1) is shared by coordination-kit, delivery-kit and the game-sessions skills. It records
ownership and the conversation ID of each role per harness. It never proves activation on its
own: `transfers` carries the hold, acceptance and activation markers.

| Field                             | Content                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `revision`, `updatedAt` | `1`, a non-negative integer incremented on every write, and a UTC timestamp.                                                                                                                          |
| `harness`                         | `claude` or `codex`: the default harness for roles without an override.                                                                                                                               |
| `host`                            | `nativeProjectId` and `root` (relative to game-coordinator).                                                                                                                                          |
| `roles.<key>`                     | `ownership`, `worktree` (relative to game-coordinator), `conversations` (`claude` and `codex`, each an ID or null), and optional `harness`, `branch`, `phase`, `activation` (`marker`, `checkpoint`). |
| `operations.<game>`               | `busOwner` (a role key), optional `activation.marker` and `lastAdoption` (`at`, `version`, `cliSha256`, optional `integrity` and `evidenceRef: "protocol-artifact:<audit hash>"`).                    |
| `transfers[]`                     | `marker`, `from`, `to`, `phase` (`source-held`, `accepted` or `active-confirmed`), `roles` and `checkpoint`.                                                                                          |

- Every role key must be a role key in `config.json`, and every `operations` key a game.
- Role references (`busOwner`, `reports.recipient`, `reports.workerParents`, `--requester`,
  `--role`, `--recipient`, `--parent`) use registered role keys; explicit inbox conversation UUID
  selectors follow the [inbox validation rules](commands.md#command-semantics). There are no role aliases.
- Every writer holds `var/registry.lock`, rejects a changed `revision`, validates the result,
  writes durably and increments `revision`.
- The skills own every field except `operations.*.lastAdoption`, which is reserved for
  supported resident-adoption recording. The harness-selection CLI changes only selected roles' `harness` overrides and
  registry revision metadata; it preserves all other fields, including `operations`.
- `session start` writes one field: after a proved Claude `/clear`, it replaces the cleared
  role's `conversations.claude` with the new ID under the revision it read, refusing
  `rotation-conflict` when the revision changed. See [rebind after /clear](store.md#rebind-after-clear).

## Create and extend a registry

The [registry library](libraries.md#registry-library) provides `createRegistry` for a new
`var/registry.json` and `updateRegistry` for revision-checked changes to an existing registry.
Creation sets revision 1 and refuses an existing file. Supply the actual coordinator project and
native conversation IDs from the workspace owner. A null conversation marks an unbound harness.

For a new game, first add its role keys to [the coordinator configuration](configuration.md#add-a-game).
The coordinator then adds those roles and their worktree paths to the registry using the current
revision. The CLI's `harness select` only changes existing role overrides.

## Scoped harness selection

`roles.<role>.harness`, when present, is `claude` or `codex`. An absent override falls back to the
top-level `harness`, preserving the global-only schema 1 behaviour. Selection records an adapter
choice, not activation, target startup, ownership acceptance, delivery control or permission to
clear a hold or question. Changing selection requires the caller's explicit authority for that
exact scope.

Older schema 1 readers reject the new role field. Upgrade every reader of the shared registry
through a reviewed consumer pin before writing any override. A successful readiness probe does
not authorize adoption or mutation.

After explicit approval and the reader upgrades, probe the selected target and apply one atomic,
revision-checked selection, using the freshly read registry revision for `N`:

```sh
coordination-kit claude ready \
  --game archies-dog-walks \
  --game chibis-way-home
coordination-kit harness select \
  --harness claude \
  --expected-revision N \
  --game archies-dog-walks \
  --game chibis-way-home
```

Each `--game` selects every configured role for that game. Repeat `--role` to select additional
registered role names; the union is changed once. Missing or invalid roles,
an unknown game, an unavailable selected conversation ID, or a changed revision refuse the entire mutation. At least one scope is
required, so this command never implicitly switches the global default. `--harness default`
removes only the selected overrides. Unselected games, shared roles, conversation IDs, worktrees,
activation markers, operations, delivery state and schedules remain unchanged. No provider is
started and no runner is restarted by selection.

## Send-time resolution

Route, configuration, briefs and events name roles, never conversation IDs. Each send, wake and
readiness probe reads `var/registry.json` when it
sends: the role's optional `harness` override, otherwise the registry default, selects the adapter;
`roles.<role>.conversations.<effective harness>` gives the ID.
Nothing is cached across sends. A missing or null ID is reported `unavailable` for that role,
never as clearance.

A scoped harness handoff selects only its approved roles, with no configuration edit, runner
restart or delivery-state change. The other harness's IDs stay in place. Activation still needs
its separate hold, acceptance and activation checks.

The store's [handoff record](store.md#sessions-and-handoffs) orders it: each role runs
`handoff ready` from its source session, game-coordinator sets `prepared` and `sent`, runs
`harness select` for the scope, then each target session runs `session start` and
`handoff active`, and game-coordinator sets `completed`. The fence admits a target session only
after select, and select fences out the source sessions.

### Decision markers

A Codex role's decision record (`unblock/decisions/<conversation>.json` on its game bus, or the
review host's bus for a shared role) stays keyed by its exact Codex conversation. No wake depends
on it: the [store question guard](store.md#wakes) gates wakes. The scheduled review reads it
read-only to report its structure in `review show` and to pass its resolutions to the native
question collectors, and `question reconcile` reads it the same way. Each resolution has
`question_turn_id`, `question_item_id`, `answer_turn_id` and `answer_item_id`, and each question
turn and item pair appears once. [Stored review diagnostics](review.md#stored-brief) list invalid
field names without exposing their values. The kit does not write it.

## Readiness probe

`claude ready` and `codex ready` send nothing and report whether that adapter can deliver now:

- Claude: `claude agents --json` returns a listing.
- Codex: the endpoint selected by the [shared resolver](#scoped-harness-doctor) accepts a
  connection. An explicit `CODEX_CONTROL_SOCKET` must be a valid absolute socket path.
- The route's recipient and every target, or every game's `reports.recipient` when there is no
  route, have a conversation ID for that harness. An invalid route is never ready.

Output is one JSON line:

```json
{
  "harness": "codex",
  "adapter": { "status": "available", "reason": null },
  "roles": [{ "role": "game-coordinator", "conversation": "<uuid>", "status": "resolved" }],
  "ready": true
}
```

Unscoped `claude ready` and `codex ready` retain this output and probe every route role against
the requested target harness. With `--game` or `--role`, they probe only the selected roles and
add `current_harness` and `probed_harness` to each role row. Unselected games and kits need no
conversation ID for that target. Scopes never create or modify a registry entry.

`harness ready` probes the current effective harness for each selected role. Without a scope it
uses the route recipient and targets, or every game's recipient without a route. Its output contains
`harness: "mixed"`, an `adapters` object keyed by each required harness, the role rows with
`current_harness` and `probed_harness`, and `ready`. Each distinct adapter is probed once. Missing
IDs or unavailable adapter capabilities make the result not ready; an invalid selection fails
closed. These are adapter-and-conversation probes, not proof that questions, queues or ownership
checks are clear.

Readiness exits 0 when ready and 1 when not, including when the registry is missing or the layout
cannot be read. Malformed command options exit 2. It sends nothing and activates nothing.

## Scoped harness doctor

`coordination-kit harness doctor --role ROLE` diagnoses only the role's current effective harness.
Repeat `--role` or `--game ID` to select more roles. At least one nonempty explicit scope is
required; an invalid selection fails before any probe. It sends nothing, performs no queue
writes, starts no frontend and changes no registry, HOLD, activation or draft state.

Output is one JSON line with `schema: 1` and `roles`. Each row includes the exact `role`,
`effective_harness`, `native_id`, `endpoint` path and source, registry `config_reference`,
`channel_reference`, `native_session`, and `layers` for adapter, service, frontend, bridge and channel. Layer
statuses distinguish `available`, `unavailable`, `unknown` and `held`; a registry entry alone
never proves a native HOLD or activation. Inactive bindings are skipped as unknown, and
unselected harnesses are not probed. `failed_layer`, `recovery_owner` and
`supported_next_action` identify an observed failure and its supported diagnostic follow-up.
Recovery actions are reported, never executed. Unknown capabilities remain unknown even when
`failed_layer` is null. Exit 0 means the report has no observed failed layer, not that all
layers are healthy or delivery is safe. Observed failures or invalid configuration exit 1;
malformed options or missing scope exit 2.

Read-only probe eligibility requires `ownership: "active"` and excludes phases `held` and
`source-held`. Other phases, including `prototype-approved`, describe product scope and do not
disable probes. Eligibility never proves native HOLD clearance or activation.

Codex readiness, doctor and wakes use `resolveCodexControlSocket({env, home?, controlSocket?})`:
explicit option, then `CODEX_CONTROL_SOCKET`, then the managed socket under
`.codex/app-server-control/app-server-control.sock` in `home`, else in `env.HOME`. The result is `{path, source}`, where
source is `option`, `environment` or `managed`. Selection performs no probe; an invalid
explicit path never falls back. Doctor uses environment or managed selection and performs only
control connect/initialization and exact `thread/read` with `includeTurns: false` for selected
active bindings. A readable native thread does not prove a healthy TUI, HTTP MCP bridge,
channel, native HOLD clearance or activation. Bridge diagnosis and recovery require the native
owner; doctor never probes authenticated HTTP ports or opens private configuration.

Each Claude row also carries two read-only channel checks; Codex rows carry `null` for both.

- `channel_command` compares the channel MCP server in `<root>/var/claude-channel.mcp.json` (the
  first server whose arguments include `claude channel`) with the stable command
  `node <root>/node_modules/@andornaut/coordination-kit/dist/cli.js --root <root> claude channel`,
  further arguments allowed. `status` is `stable` (`stable_path`), `unstable`
  (`command_not_stable_path`, such as an `npx` command, which needs a relaunch to change) or
  `unknown` (`channel_config_missing`, `channel_config_unreadable` or
  `channel_server_not_configured`). It reports the config path, server name, configured command
  and the expected one. A session keeps the command it launched with, so a stable config does not
  prove a running session uses it.
- `channel_server` reports the conversation, version, dist digest, start time, pid and argv from
  the role's [channel status file](review.md#channel-status-file), which a `/clear` rebind does
  not move. `status` is `reported` with `status_file_read` when its `conversation` is the role's
  current binding and `status_file_stale` when it names another, or `unknown` with
  `status_file_missing` when the channel wrote none and `status_file_unreadable` when the file or
  its directory cannot be read or is malformed. The scheduled review reports the same cases as
  `channel-unresolved` and `channel-unknown` [brief exceptions](review.md#stored-brief). Neither
  check is clearance or proof of a connected channel, and neither changes `failed_layer` or the
  exit status.

Claude diagnosis uses only `claude agents --json` and an exact session ID match. Session
reported state does not provide native history, queue or authoritative question state. Channel
connection remains unknown: a configured spool or receipt alone does not prove a connected
channel, acceptance or handling. Reports contain normalized codes and nonsecret references,
never message bodies, raw errors, environments or authentication material.

`messageChannelStateDir(layout, conversationId)` returns
`<reviewDir>/messages/recipients/<conversationId>/unblock` on the legacy path, or
`<stateRoot>/transport/messages/recipients/<conversationId>/unblock` with an active work protocol,
without creating state. An already
active Claude session's existing channel process includes its exact conversation's generic bus
alongside game bus directories by default. Explicit `--state-dir` is exclusive: configure
`claude channel --conversation UUID --state-dir DIR` with existing absolute directories only.
Doctor reports the generic reference even if absent; neither the reference nor directory
presence proves a connected channel. No inactive frontend or additional channel is started.
