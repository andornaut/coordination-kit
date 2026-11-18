# Upgrading

Moving from delivery-kit 4.7 to coordination-kit 1.0.

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
- Root: `--root` and `DELIVERY_KIT_ROOT` keep working. `COORDINATION_KIT_ROOT`, when set, takes
  precedence over `DELIVERY_KIT_ROOT`.
- Channel MCP configuration: run `coordination-kit ... claude channel` instead of
  `delivery-kit ... claude channel`. The server still identifies itself as
  `delivery-kit-channel`, so an existing server key needs no change.
- Library imports: `@andornaut/delivery-kit/build/registry`, `/build/transport`,
  `/build/accounting` and `/build/protocol`, and their unprefixed aliases, become
  `@andornaut/coordination-kit/build/registry`, `/build/transport`, `/build/accounting` and
  `/build/protocol` with the same symbols. This package has no unprefixed aliases.
- Output: `harness doctor` keeps `recovery_owner: "delivery-kit"` for adapter failures the kit
  must recover, as delivery-kit 4.7.0 printed it.
- delivery-kit's removed command forms from 2.0 and 3.0 (`monitor ...`, `channel ...` and the
  others) are not recognized here; they print usage and exit 2.
