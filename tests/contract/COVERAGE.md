# Contract coverage

Every case under `cases/` runs against the built bundles: the CLI in `dist/cli.js`, and the
public seam in `dist/review.js` and `dist/shared.js`.

Fixture defaults: a case that names no report recipient gets a registered `game-coordinator` role
with a fixture conversation, because a recipient must resolve through the registry. A route
fixture sets its host game's `reports.recipient`, because the review recipient is that field.
Every command runs with `COORDINATION_KIT_ROOT` naming the fixture's game-coordinator.

The cases drive the built CLI for the runner seam (`review deliver`, `events ingest`), store
messages and wakes, the Claude channel's wake notifications, readiness probes and the entry
points. Cadence, missed-slot handling, departures and the runner's own lines are delivery-kit's
contract cases.

Decisions the cases assert:

- Event ingest: events-ingest runs `events ingest` over `fixtures/events.jsonl`, a log in the format agreed with delivery-kit 6.1 (one malformed line, a torn tail), and reads the stored messages back through `inbox`.
- Usage errors exit 2; an unavailable read exits 1.
- Coordinator root: `--root`, then `COORDINATION_KIT_ROOT`, then `DELIVERY_KIT_ROOT`.

fsync calls themselves are not observable from outside the process without syscall tracing. The durable-write cases assert the observable half of the durable primitive: replacement by rename (a new inode) and no leftover temporary files.
