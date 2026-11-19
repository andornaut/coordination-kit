# Contract coverage

Every case under `cases/` runs against the built bundles: the CLI in `dist/cli.js`, and the
public seam in `dist/review.js`, `dist/events.js` and `dist/shared.js`.

Fixture defaults: a case that names no report recipient gets a registered `game-coordinator` role
with a fixture conversation, because a recipient must resolve through the registry. A route
fixture sets its host game's `reports.recipient`, because the review recipient is that field.
Every command runs with `COORDINATION_KIT_ROOT` naming the fixture's game-coordinator.

A scheduled review slot is one observer pass: a fresh Node process imports the built seam, calls
`deliverScheduledReview` for the explicit slot, writes the runner's log line for it to stdout and
stderr, then calls `flushEvents`, as delivery-kit's runner observer does. Restarting is a new
pass that keeps only durable state. Cadence, missed-slot handling, departures and the runner's
own lines are delivery-kit's contract cases, which reach this kit through the same seam.

The event cases drive the outbox the same way: a producer pass is a fresh process that records
its events in order through the built `recordEvent`, and a flush pass is a fresh process that
calls `flushEvents` alone, as an observer pass without a review slot ends. Which events the
runner produces, and its per-commit CI and deployment tracking, are delivery-kit's cases.

Decisions the cases assert:

- Adapter selection: the recipient's selected harness chooses the adapter, not the route. claude-route "the registry's harness, not the route, selects the adapter" expects a malformed or schema 1 route under a Claude registry to be rejected without the Codex path.
- Route deferral wording: an unusable `var/route.json` defers with "review route is unavailable or invalid; its owner must verify identities and ownership" (`ROUTE_INVALID_MESSAGE`).
- Routes carry no harness: a route names roles, and brief target lines name the registry role key (`briefTarget`).
- Native health events: in legacy mode, health events such as review-stuck are delivered natively to the recipient. Cases that count slot sends count only slot requests (`slotMutations`).
- Event ingest: events-ingest runs `events ingest` over `fixtures/events.jsonl`, a log in the format agreed with delivery-kit 6.1 (one malformed line, a torn tail), and reads the stored messages back through `inbox`.
- Usage errors exit 2; an unavailable read exits 1.
- Receive timeouts: a native reply that never arrives is classified and latched as a timeout (child health, question state and the review history transport failure).
- Coordinator root: `--root`, then `COORDINATION_KIT_ROOT`, then `DELIVERY_KIT_ROOT`.

fsync calls themselves are not observable from outside the process without syscall tracing. The durable-write cases assert the observable half of the durable primitive: replacement by rename (a new inode) and no leftover temporary files.
