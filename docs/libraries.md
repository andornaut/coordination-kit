# Libraries

The public Node build APIs: their subpaths, main symbols, the registry library and transport
endpoint selection.

## Public build APIs

All library APIs are Node build and operations tools, not APIs for a running game. Import their
explicit subpaths:

| Subpath                                        | Purpose                                                                                       | Main symbols                                                                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@andornaut/coordination-kit/build/registry`   | Registry configuration, routing and guarded updates.                                          | `loadLayout`, `gameLayout`, `roleKeys`, `readRegistry`, `createRegistry`, `updateRegistry`, `resolveRole`, `resolveConversation`, `resolveHarness`, `selectHarness`, `RegistrySchema`       |
| `@andornaut/coordination-kit/build/transport`  | Read-only endpoint selection and message channel path references.                             | `resolveCodexControlSocket`, `messageChannelStateDir`, `DeliveryDiagnostic`, `NativeRpcCode`                                                                                                |
| `@andornaut/coordination-kit/build/accounting` | Request ledger, intake retention and closure evidence ([guide](request-accounting.md)).       | `LedgerStore`, `IntakeStore`, `captureAccounting`, `accountingStatus`, `snapshotIntake`, `messageIntake`, `auditIntake`, `projectOwnerBinding`                                              |
| `@andornaut/coordination-kit/build/protocol`   | Fenced filesystem work, message originals and recipient receipts ([guide](work-protocol.md)). | `ProtocolStore`, `runtimeProtocolStore`, `WorkStore`, `ProtocolMessages`, `EnrollmentStore`, `resolveProtocolLayout`, `resolveProtocolManagement`, `protocolNamespace`, migration functions |
| `@andornaut/coordination-kit/build/review`     | The scheduled review seam and the review route ([guide](review.md#scheduled-review-seam)).    | `deliverScheduledReview`, `reviewOutcome`, `DEFERRED_PREFIX`, `REASON_TOKENS`, `readRoleRoute`, `routeRecipient`, `validateRoleRoute`, `RouteError`, `ROUTE_SCHEMA_1`                       |
| `@andornaut/coordination-kit/build/events`     | The bus event outbox ([guide](review.md#event-outbox)).                                       | `recordEvent`, `enqueueEvent`, `writeEventState`, `flushEvents`, `flushEventsWith`, `FlushResult`, `eventsDir`, `eventId`, `deliveryMessage`, `QUIET_KINDS`, `BusEvent`, `EmitOptions`      |
| `@andornaut/coordination-kit/build/shared`     | The utilities both kits run on.                                                               | Durable writes and JSON reads, `flock(1)` locks, the layout, validation, `delivery-kit.json` loading, exit codes, help synopses, identifiers and the persisted JSON form                    |

There is no root barrel, wildcard export, public runtime API or public test API. Fixtures,
harnesses and private modules are not exported. The `./package.json` export is package metadata.
The CLI remains the operator entry point.

The API bundles share their common modules through `dist/chunks/`, so a consumer that imports
several subpaths gets one instance of each module: an error class thrown by one subpath is the
same class another subpath exports. Each bundle imports only `node:` builtins and those chunks.

## Shared utilities

`@andornaut/coordination-kit/build/shared` exports, by source module:

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

- `loadLayout(coordinatorRoot)` and `gameLayout(layout, game)`: `config.json` and the `var/`
  paths. `roleKeys(config)` and `validateGameCoordinatorConfig(value)` use
  `GameCoordinatorConfig`. `GameDevConfig` and `validateGameDevConfig` remain identical aliases
  for readers that still use those names.
- `readRegistry(layout)`: a validated snapshot carrying its `revision`; `RegistryMissing` when
  absent.
- `updateRegistry(layout, expectedRevision, mutate, options)` and
  `createRegistry(layout, initial, options)`: hold `var/registry.lock` (30 s by default), reject a
  changed revision with `RevisionConflict` or an existing file with `RegistryExists`, validate,
  write durably, increment `revision` and set `updatedAt`. An invalid result throws
  `ValidationError` and leaves the file unchanged. Pass `options.held` when the caller already
  holds the lock.
- `resolveRole(registry, role)` and `resolveConversation(registry, role)`, which throw
  `UnknownRole` for a name that is not a registered role key.
- `resolveHarness(registry, role)` returns a registered role's override or the registry default.
  `selectHarness(layout, expectedRevision, {harness, games?, roles?}, options?)` validates the
  entire explicit selection and changes only those overrides under `registry.lock`.
- `RegistrySchema`, `validateRegistry`, `HARNESSES` and `TRANSFER_PHASES`, with the record types.

## Transport endpoint selection

Import `resolveCodexControlSocket` from `@andornaut/coordination-kit/build/transport`. It returns
`{ path, source }`, selecting the explicit `controlSocket` option, then `CODEX_CONTROL_SOCKET`
from the supplied environment, then the managed socket under
`home/.codex/app-server-control/app-server-control.sock`. Invalid explicit paths throw without
fallback. Selection performs no connection or authentication probe. Existing runtime adapters and
`codex ready` still require configured endpoints.
