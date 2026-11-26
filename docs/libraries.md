# Libraries

The public Node build APIs: their subpaths, main symbols and the registry library. 3.0 removed
the `build/transport`, `build/accounting`, `build/protocol` and `build/events` subpaths.

## Public build APIs

All library APIs are Node build and operations tools, not APIs for a running game. Import their
explicit subpaths:

| Subpath                                      | Purpose                                                                                    | Main symbols                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@andornaut/coordination-kit/build/registry` | Registry configuration, routing and guarded updates.                                       | `loadLayout`, `gameLayout`, `roleKeys`, `readRegistry`, `createRegistry`, `updateRegistry`, `resolveRole`, `resolveConversation`, `resolveHarness`, `selectHarness`, `RegistrySchema`                        |
| `@andornaut/coordination-kit/build/review`   | The scheduled review seam and the review route ([guide](review.md#scheduled-review-seam)). | `deliverReview`, `storeReview`, `composeBrief`, `showBrief`, `coordinationEmit`, `REASON_TOKENS`, `readRoleRoute`, `routeRecipient`, `validateRoleRoute`, `RouteError`                                       |
| `@andornaut/coordination-kit/build/store`    | The SQLite coordination store and its message lifecycle ([guide](store.md#library-api)).   | `Store`, `storePath`, `sendMessage`, `readInbox`, `closeMessage`, `retainMessage`, `wakeRecipient`, `rearmWake`, `resolveCaller`, `storeRetire`, `closeRequest`, `readRequests`, `PROJECTIONS`, `StoreError` |
| `@andornaut/coordination-kit/build/shared`   | The utilities both kits run on.                                                            | Durable writes and JSON reads, `flock(1)` locks, the layout, validation, `delivery-kit.json` loading, exit codes, help synopses, identifiers and the persisted JSON form                                     |

There is no root barrel, wildcard export, public runtime API or public test API. Fixtures,
harnesses and private modules are not exported. The `./package.json` export is package metadata.
The CLI remains the operator entry point.

The API bundles share their common modules through `dist/chunks/`, so a consumer that imports
several subpaths gets one instance of each module: an error class thrown by one subpath is the
same class another subpath exports. Each bundle imports only `node:` builtins and those chunks.

## Shared utilities

`@andornaut/coordination-kit/build/shared` exports, by source module:

- Codex control endpoint: `resolveCodexControlSocket`, `CodexControlSocketEndpoint` and
  `CodexControlSocketOptions`. Startup tools can use this path selector without probing the
  socket. See [Codex endpoint selection](registry.md#scoped-harness-doctor).
- durable files: `writeDurable`, `writeJsonDurable`, `fsyncDirectory`, `readJson`,
  `readJsonIfExists`, `JsonFileError`;
- locks: `holdLock`, `holdLockAsync`, `withLock`, `lockIsFree`, `LockBusy`, `LockError`,
  `LockMissing`;
- layout: `loadLayout`, `gameLayout`, `roleKeys`, `UnknownGame`, `CONFIG_FILE`,
  `PROJECT_CONFIG_FILE`, `Layout`, `GameLayout`;
- validation: `Issues`, `ValidationError`, the `check*` helpers and the ID, UUID and secret-key
  patterns;
- game configuration: `loadProjectConfig` and `validateProjectConfig` (every section),
  `loadReportsConfig` and `validateReportsConfig` (the top-level shape and `reports` only),
  `addressedRoles`, `gameRecipients`, `ProjectConfig` and `ReportsConfig`;
- the command contract: `EXIT_OK`, `EXIT_INVALID`, `EXIT_USAGE`, `EXIT_REFUSED`, `Io`, `Handler`,
  `coordinatorRoot`, and the help synopsis helpers `formSynopsis`, `usageText`, `CommandSpec`;
- identifiers: `isCanonicalUuid`, `CANONICAL_UUID`, `SHA_PATTERN`, `uuid5`, `slotRequestId`,
  `eventRequestId`;
- the Python-compatible JSON form of persisted state: `dumpsJson`, `pyJsonDumps`, `isRecord`,
  `digest`, `PyJson`.

## Registry library

`@andornaut/coordination-kit/build/registry` is the typed registry module the skills use. It uses
only `node:` builtins and `flock(1)`; `dist/cli.js` embeds the same source. Context parameters
come first and the subject last.

- `loadLayout(workspaceRoot)` and `appLayout(layout, appId)` resolve configuration, checkout
  and state paths. `appRoleKeys(config, appId)` returns the app's exact configured role keys.
  `validateWorkspaceConfig(value)` reads either workspace shape. `gameLayout(layout, game)`,
  `roleKeys(config)` and `validateGameCoordinatorConfig(value)` remain compatible with
  `GameCoordinatorConfig`. `GameDevConfig` and `validateGameDevConfig` remain identical aliases
  for readers that still use those names.
- `isPermitted(layout, registry, actor, permission, appId?)` checks the active native binding
  and the configured grant for a privileged action. `hasPermission` checks configuration
  alone. Policy hold writers take a `PolicyHoldAuthority` with the layout and registry before
  the actor. See [app mode permissions](store.md#app-mode-permissions).
- `readRegistry(layout)`: a validated snapshot carrying its `revision`; `RegistryMissing` when
  absent.
- `updateRegistry(clock, layout, expectedRevision, mutate, options)` and
  `createRegistry(clock, layout, initial, options)`: hold `var/registry.lock` (30 s by default), reject a
  changed revision with `RevisionConflict` or an existing file with `RegistryExists`, validate,
  write durably, increment `revision` and set `updatedAt` from `clock`. An invalid result throws
  `ValidationError` and leaves the file unchanged. Pass `options.held` when the caller already
  holds the lock.
- `resolveRole(registry, role)` and `resolveConversation(registry, role)`, which throw
  `UnknownRole` for a name that is not a registered role key.
- `resolveHarness(registry, role)` returns a registered role's override or the registry default.
  `selectHarness(clock, layout, expectedRevision, {harness, apps?, roles?}, options?)` validates the
  entire explicit selection and changes only those overrides under `registry.lock`.
- `RegistrySchema`, `validateRegistry`, `HARNESSES` and `TRANSFER_PHASES`, with the record types.
