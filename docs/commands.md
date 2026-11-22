# Commands

Per-command semantics for the `coordination-kit` CLI, beyond the group table in the
[README](../README.md#usage). `coordination-kit --help` lists
every form and flag.

## Command forms

| Command                                                                                                                                                                                                                                                                                | Purpose                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `msg send --to ROLE (--body-file FILE \| --body TEXT) [--intent queue\|unblock] [--id UUID] [--link KIND=REF]...`                                                                                                                                                                      | Store a message, then attempt one guarded wake; see [store](store.md#message-lifecycle).                                           |
| `inbox [--include-body] [--all]`                                                                                                                                                                                                                                                       | List your undelivered and open store messages and record them `delivered`.                                                         |
| `msg done ID [--work WORK_ID] [--superseded-by ID] [--evidence REF]...`, `msg retain ID --reason TEXT (--until ISO_TIMESTAMP \| --next-review \| --next-boundary TEXT) [--owner ROLE]`                                                                                                 | Close or retain your own message in one write.                                                                                     |
| `msg status ID`, `msg history [--role ROLE] [--since ISO_TIMESTAMP] [--limit N]`                                                                                                                                                                                                       | Read a message's metadata, or message events in order, without bodies.                                                             |
| `msg status ID --include-body`                                                                                                                                                                                                                                                         | Read one exact body as its sender, recipient or game-coordinator without recording delivery.                                       |
| `msg history --include-body [--role ROLE] [--since ISO_TIMESTAMP] [--limit N]`                                                                                                                                                                                                         | Message events with the bodies the fenced caller may read; see [store](store.md#message-history).                                  |
| `question open --title TEXT [--id ID] [--work WORK_ID] [--option LABEL]...`, `question answer --id ID --work WORK_ID --text TEXT [--by user\|ROLE] [--supersedes D<N>]`, `question cancel --id ID --reason TEXT`, `question list [--role ROLE] [--state pending\|answered\|cancelled]` | Pending prompts owned by your role and their decisions; see [questions](store.md#questions-holds-and-decisions).                   |
| `hold set --id ID --scope work:WORK_ID\|role\|game:ID --reason TEXT`, `hold release --id ID`, `hold list [--role ROLE] [--state active\|released]`                                                                                                                                     | Holds owned by your role; see [holds](store.md#holds).                                                                             |
| `session start`                                                                                                                                                                                                                                                                        | Record your session start and print your binding, checkpoint and counts; see [sessions](store.md#sessions-and-handoffs).           |
| `handoff open --scope ROLE\|all... --to claude\|codex [--id ID]`, `handoff state prepared\|sent\|completed\|cancelled --id ID`, `handoff ready [--id ID]`, `handoff active [--id ID]`, `handoff show [--id ID]`                                                                        | A harness handoff record; see [handoffs](store.md#sessions-and-handoffs).                                                          |
| `decision list [--work WORK_ID] [--role ROLE]`                                                                                                                                                                                                                                         | Read decision records in recording order.                                                                                          |
| `store export --since ISO_TIMESTAMP`, `store rebuild`                                                                                                                                                                                                                                  | Export for rollback, verify the chain and rebuild projections; see [store](store.md).                                              |
| `store retire --dry-run`, `store retire --apply`                                                                                                                                                                                                                                       | The 3.0 migration: import open ledger requests, archive the retired state; see [retirement](store.md#retirement).                  |
| `request close --id ID --reason TEXT [--work WORK_ID]`                                                                                                                                                                                                                                 | Close your own imported request; see [requests](store.md#requests).                                                                |
| `store import --approval-ledger FILE [--dry-run]`                                                                                                                                                                                                                                      | Map the approval ledger to work evidence, retained items and holds; see [approval-ledger import](store.md#approval-ledger-import). |
| `claude ready [--game ID]... [--role ROLE]...`, `codex ready [--game ID]... [--role ROLE]...`                                                                                                                                                                                          | The handoff readiness probe, optionally scoped; see [readiness](registry.md#readiness-probe).                                      |
| `harness ready [--game ID]... [--role ROLE]...`                                                                                                                                                                                                                                        | Read-only readiness using each selected role's effective harness.                                                                  |
| `harness select --harness claude\|codex\|default --expected-revision N [--game ID]... [--role ROLE]...`                                                                                                                                                                                | Atomic selection for at least one explicit game or role, without activation.                                                       |
| `harness doctor --game ID ... [--role ROLE ...]`, `harness doctor --role ROLE ...`                                                                                                                                                                                                     | Diagnose explicitly selected roles without sending or activating.                                                                  |
| `claude channel [--game ID]... [--conversation UUID] [--poll-seconds N]`                                                                                                                                                                                                               | The stdio MCP server the Claude recipient session starts.                                                                          |
| `review deliver --game ID --slot ISO_TIMESTAMP [--capture]`                                                                                                                                                                                                                            | Deliver one slot's scheduled review once; see [review](review.md#cli-seam).                                                        |
| `review show [--game ID] [--slot ISO_TIMESTAMP]`                                                                                                                                                                                                                                       | Print a stored brief's full record; see [stored brief](review.md#stored-brief).                                                    |
| `events ingest --game ID`                                                                                                                                                                                                                                                              | Ingest the runner's event log into the store; see [runner events](store.md#runner-events).                                         |
| `status [--scope all\|GAME\|KIT\|ROLE] [--since ISO_TIMESTAMP] [--state STATE]... [--audit] [--verify-since ISO_TIMESTAMP] [--format json\|markdown]`                                                                                                                                  | Read-only status of every registered repository's work items; see [status](#status).                                               |
| `work check [--decisions] [--root DIR]`, `work report [--root DIR]`                                                                                                                                                                                                                    | Validate a repository's work files and report their state; see [work files](work-files.md).                                        |
| `work start ID [--parent REPOSITORY:WORK_ID]`, `work evidence ID --stage STAGE --sha SHA [--ref REF]`                                                                                                                                                                                  | Start your approved item, or record a stage commit; see [work records](store.md#work-records).                                     |
| `work block ID --reason TEXT [--owner ROLE]`, `work unblock ID`, `work ready ID`, `work finish ID`                                                                                                                                                                                     | Record your item blocked, unblocked, ready, or finished once its work file is `done` on `main`.                                    |
| `work show ID`, `work history ID`                                                                                                                                                                                                                                                      | Read an item's owner, store record and covering holds, or its work events.                                                         |
| `graph [--work [REPOSITORY:]ID] [--depth N] [--format json\|dot]`, `graph why --decision ID`, `graph index`                                                                                                                                                                            | The decision graph, a decision's supersedes chain, and the derived index; see [decision graph](store.md#decision-graph).           |
| `help`, `--help`, `--version`, `--version --json`                                                                                                                                                                                                                                      | Usage, the version, and the version with the `dist/cli.js` sha256 as one JSON line.                                                |

## Command semantics

- `claude channel`: by default it serves the conversation of the `reports.recipient` that every
  game (or each `--game`) names, and requires that role's effective harness to be `claude`.
  Games that name different recipients stop it with exit 1; select games with one recipient or
  pass `--conversation`. `--poll-seconds` defaults to 5. Without `--conversation`, an absent
  registry stops it with exit 1. It watches the conversation's [wake file](review.md#wake-files)
  and emits one notification per seq increase. The server identifies itself to the session as
  `delivery-kit-channel`, the name existing channel configurations use.
- `msg send`, `inbox`, `msg done`, `msg retain`, `request close`, `store import` and
  `store retire` (without `--dry-run`) identify
  the caller through the [registry fence](store.md#writer-fence): `--native-id ID`, else
  `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` for the role's effective harness. `--worker NAME`
  is an unverified attribution. Each prints one JSON object; a refusal prints
  `coordination-kit: CODE` on stderr and exits 1, and a usage error exits 2. `msg send` takes the
  body from exactly one of `--body-file` (relative to the working directory, valid UTF-8) and
  `--body`, and `--link` values as `KIND=REF`, such as `work=ck-0017`. `msg history` lists at
  most `--limit` events (default 1000). `--since` takes an ISO 8601 instant.
- `msg status ID --include-body` and `msg history --include-body` identify the caller
  through the same registry fence and apply message-body visibility.
- `question open|answer|cancel` and `hold set|release` identify the caller through the registry fence. Only the owning role answers, cancels or releases its
  own records (`not-owner`). `question answer` prints the decision and the work file it changed
  (`workFile.path`), left unstaged for the role's next commit. `question cancel`, `question answer`
  and `hold release` then attempt one guarded wake for the caller, since the write may clear its
  last wake guard. `--option LABEL` is repeatable, 1 to 8 labels. The list verbs take no caller and read an absent store as empty.
- `session start`, `handoff ready` and `handoff active` identify the caller through the registry
  fence; `handoff open` and `handoff state` also require game-coordinator (`not-coordinator`).
  `session start` refuses a held role with `session-held: phase held` (or `source-held`).
  `handoff show` takes no caller and prints the latest handoff without `--id`.
- `review deliver` and `events ingest`: the runner seam. Each prints exactly one
  typed JSON line and exits 0 for every typed result, 2 for a usage error and 1 for an internal
  failure, with nothing on stdout. `--slot` is an ISO 8601 minute start with an offset. A repeated
  `review deliver` for a slot prints the recorded result. SIGTERM before the brief is stored aborts it
  with exit 1 and no result. `review deliver` stores the brief as a message. See
  [review](review.md#cli-seam) and [runner events](store.md#runner-events).
- `review show`: prints the recorded stored brief for `--slot` (default: the latest) of `--game`
  (default: any game) as one JSON line; exit 1 with `brief-missing` when there is none.
- `store retire`: exactly one of `--dry-run` and `--apply`. `--dry-run` takes no caller and
  writes nothing. `--apply` accepts only `game-coordinator` (`not-coordinator`). See
  [retirement](store.md#retirement).
- `--version --json` prints `{"schema":1,"version":V,"distSha256":H}`, where `H` is the sha256 of
  the running `dist/cli.js` bytes, or 64 zeros from source. Plain `--version` prints `V` alone.
- `work check` and `work report`: `--root` names the repository, not the coordinator.
  See [work files](work-files.md).
- The `work` store verbs also read `--root` as the repository and take the coordinator from
  `COORDINATION_KIT_ROOT` or `DELIVERY_KIT_ROOT` only. Writes identify the caller through the
  [registry fence](store.md#writer-fence) and accept only the item's owner. Each prints one JSON
  object with `duplicate` and the `record`; a refusal prints `coordination-kit: CODE` on stderr and
  exits 1, and a usage error exits 2.
- `graph`: `--root` names the coordinator. `graph --format dot` prints DOT instead of JSON.

## status

`status` reads every distinct Git repository behind the registry's roles and reports one derived
status per work item. It writes nothing and uses no network: repositories are read through local
refs only (`main` and, when present, `origin/main`), with no fetch or checkout, and the
coordinator state is read once. `--root` names the coordinator, as for the other non-work
commands.

- **Repositories:** each role's registered worktree resolves with `git rev-parse` to its common Git
  directory, whose parent is the repository; when the worktree is missing, the role's game or kit
  path in `config.json` is tried. Roles sharing a repository are listed together. A repository is a
  `game` or `kit` by its `config.json` path, `coordinator` for the coordinator root, else `other`.
- **Reads:** per repository, one `git log` over `main` and `origin/main` (parents, committer dates,
  messages, changes against the first parent with rename detection, and release tags) and one
  first-parent `git log -p` over `docs/work/` on `main` with unbounded context, whose diffs show
  each change of front-matter status and whose newest diff of each file holds its
  current text. The store is read once and each game's bus outbox directory once. The number of Git calls does not depend on the number of items.
- **Items:** each `docs/work/<id>.md` on `main` (front matter `id`, `title`, `status`, `approved`,
  `supersedes`), joined with the [imported requests](store.md#requests) whose ID is the item's ID
  or whose `work` (or close `--work`) names it. An open imported request that no work file names
  appears as a `requested` item of its owner's repository (else the coordinator's).
- **Store:** the [work records](store.md#work-records) and imported requests of
  `<stateRoot>/coordination.db`, read once
  through a read-only connection; nothing is created or migrated. A missing store file is
  `absent`. Each item carries its record as `store` (null without one).
- **Scope:** `all` (the default); a game or kit ID selects its repository; a registry role key
  selects its repository and keeps the items that role owns as a request or in the store, or
  whose `design` area is the role's name (a game's `art`, `gameplay` or `tech`).
- **Filters:** `--state` is repeatable and keeps items with any named status; `--state unverified`
  keeps done items whose delivery is unverified. `--since` keeps items
  whose latest evidence time is at or after it: the newest work-file commit (for a closed item, the
  commit that closed it), the landing, the deployment and linked request updates. A `last-deploy`
  time counts only for the commit it names, since it also covers every older commit. `--audit` keeps user-originated items: a work file whose `approved` reference starts
  with `user`, or a linked request whose source reference starts with `user` or whose origin is
  `native-user`.

### Delivery evidence

- **Landing:** integration sets `status: done` in the merge, so the primary rule (`done-flip`) is
  the first commit on `main` (first parent) whose change sets the item's work file front matter to
  `status: done`, by adding it as `done` or changing it from another status. Without one, the
  secondary rules take the oldest commit reachable from local `main` that is not bookkeeping and
  whose message names the ID as a whole token (`id`) or whose subject equals the item's title
  (`title`). Bookkeeping is a commit that changes only `docs/work/` and `docs/design/`, or that
  adds the item's work file (its proposal or approval, reported as `workFile.addedIn`).
  `delivery.landing.rule` names the rule that matched.
- **On origin:** whether `origin/main` contains the landing commit; null without a landing or
  without a local `origin/main`.
- **Deployment:** the earliest deployment point that contains the landing commit.
  - A game has two kinds of point. A runner COMPLETE event (`var/games/<g>/bus/events/*.json` with
    kind `complete`, key the pushed SHA) is timed by its `created` stamp. The runner's last deployed
    SHA (`var/games/<g>/bus/last-deploy.sha`) is timed by the epoch seconds in `last-deploy`, or has
    a null time when that file is missing.
  - A COMPLETE event may carry an optional `work` array of work IDs. A listed ID counts as deployed
    by the first such event even without a landing match (`deployed.matched` is `work-list`,
    otherwise `landing`). Events without the field are read as before.
  - A kit's points are its release tags (`vMAJOR.MINOR.PATCH`), each timed by its commit's
    committer date.
  - A SHA outside the history of `main` and `origin/main` counts for nothing.
- **Store evidence:** store stage evidence is preferred to Git. A `merged` record counts as a
  landing and a `deployed` record (or `published`, for a kit) as a deployment, even without a Git
  landing or deployment point. `deliverySource.landing` and `deliverySource.deployment` name which
  evidence set each (`store`, `git` or null); `delivery` keeps the Git evidence as before.
- **Verification:** an item with deployment evidence has `deliveryVerified: true` and
  `deliveryEvidence: "deployed"`. A `done` item without evidence is checked against its done
  commit (the `done-flip` commit, else the work file's latest commit) and the cutoff, which
  `--verify-since ISO_TIMESTAMP` sets and which defaults to 2026-11-19T02:00:00Z, the instant the
  user decided that items marked done before it are done. Before the cutoff it reads
  `deliveryVerified: null` and `deliveryEvidence: "assumed"`; at or after it, it reads
  `deliveryVerified: false` and `deliveryEvidence: null`. Other items, and `done` items in a
  repository with no deployment channel, read null for both.

### Status precedence

A work-file item takes the first that applies:

1. `superseded`: front matter `superseded`, or another work file that is not `proposed`,
   `declined` or `cancelled` names it in `supersedes`; `replacement` is that file's ID, else null.
2. `cancelled`, `declined`: the front-matter status.
3. `done`: front matter `done`, verified, assumed or unverified as above.
4. `deployed`: deployment evidence for an item whose front matter is not `done`.
5. `landed`: a landing commit for an item whose front matter is not `done`.
6. `in-progress`: front matter `approved` and started: a store record with a start, or a linked request in `started`, `blocked`, `waiting`, `ready`, `checked`,
   `integrated` or `delivered`.
7. `approved`: front matter `approved`.
8. `proposed`: front matter `proposed` or any other value.

A request item is `requested`. An open item is `blocked` when a linked request is `blocked` or
`waiting` (`blocker` is its reason, `owner` its required owner); an open store block takes precedence (its reason and the role
that can clear it). Otherwise `blocker` and `owner` are null. `waitingOnUser` is
true for `proposed` items and for items with a linked request whose question is `pending`.

### Output

Stdout is one JSON object, schema 2; field order is not significant. Schema 2 drops
`coordinator.protocol`, `coordinator.ledger` and each item's `protocol`; `requests` now come from
the store's imported requests, a closed one with state `closed`.

```text
schema        2
coordinator   {root, store: {status: available | absent | unavailable, reason?}}
filters       {scope, since, states, audit, verifySince}
repositories  [{name, kind, path, roles, status, reason, main, originMain,
                deployment: {channel: bus | release-tag | none,
                             status: available | absent | unavailable | not-applicable,
                             unreadable}}]
items         [{repository, id, title, status, replacement, blocked, blocker, owner,
                waitingOnUser, userOriginated, deliveryVerified: true | false | null,
                deliveryEvidence: deployed | assumed | null, latestEvidenceAt,
                workFile: {path, status, approved, design, supersedes: [ID], addedIn, commit,
                           committedAt} | null,
                requests: [{id, kind, state, owner, question, requiredOwner, reason,
                            updatedAt, userSource}],
                store: {repository, id, owner, state, parent, children, startedAt, readyAt,
                        finishedAt, block, evidence, retained, updatedAt} | null,
                deliverySource: {landing: store | git | null, deployment: store | git | null},
                delivery: {landing: {sha, at, rule: done-flip | id | title} | null,
                           onOrigin, deployed: {sha, at, via: complete | last-deploy | release,
                                                tag, matched: landing | work-list} | null}}]
```

Items are ordered by repository name, then ID.

`--format markdown` prints a digest: per repository, the headings Done (`done`, `deployed`,
`declined`, `cancelled`, `superseded`), In progress (`in-progress`, `landed`), New (`requested`),
Outstanding (`approved`) and Waiting on the user (proposed items and pending questions, which take
precedence), each item once. An unverified done item carries the marker `(unverified)` after its
title.

The command exits 0, or 1 when the store is unavailable, a selected
repository or a game's bus cannot be read, or a bus event file is unreadable; the output is still
printed. A usage error, including an unknown `--scope` or `--state`, exits 2.
