# Upgrading

Moving from coordination-kit 1.1 to 1.2, and from delivery-kit 4.7 to coordination-kit 1.0.

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
