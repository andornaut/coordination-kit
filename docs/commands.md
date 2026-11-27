# Commands

Per-command semantics for the `coordination-kit` CLI, beyond the group table in the
[README](../README.md#usage). `coordination-kit --help` lists every form and flag.
For one command, run `coordination-kit COMMAND --help`, for example
`coordination-kit msg send --help`.

## Command forms

Use `docs audit [--area TOPIC] [--format markdown|json]` to check committed local links and list
marked rules. Use `docs compact [--plan] [--area TOPIC] [--format markdown|json]` to prepare
reviewable changes. Both accept the repository as `--root`. See the [documentation guide](README.md).

| Command                                                                                                                                                                                                                                                                                  | Purpose                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `msg send --to ROLE (--body-file FILE \| --body TEXT) [--intent queue\|unblock] [--id UUID] [--link KIND=REF]...`                                                                                                                                                                        | Store a message, then attempt one guarded wake; see [store](store.md#message-lifecycle).                                           |
| `inbox [--include-body] [--all]`                                                                                                                                                                                                                                                         | List your undelivered and open store messages and record them `delivered`.                                                         |
| `inbox --peek`                                                                                                                                                                                                                                                                           | Read the current role's unread IDs and wake metadata without recording delivery.                                                   |
| `msg done ID [--work WORK_ID] [--superseded-by ID] [--evidence REF]...`, `msg retain ID --reason TEXT [--until ISO_TIMESTAMP \| --next-review \| --next-boundary TEXT] [--owner ROLE] [--evidence REF]...`                                                                               | Record your own message disposition with optional evidence.                                                                        |
| [`msg decide` forms](store.md#unverified-originals)                                                                                                                                                                                                                                      | Record prompt display and the user decision for an [unverified original](store.md#unverified-originals).                           |
| `msg status ID`, `msg history [--role ROLE] [--since ISO_TIMESTAMP] [--limit N]`                                                                                                                                                                                                         | Read a message's metadata and wake evidence, or message events in order, without bodies.                                           |
| `msg status ID --include-body`                                                                                                                                                                                                                                                           | Read one exact body as its sender, recipient or an authorized workspace reader without recording delivery.                         |
| `msg history --include-body [--role ROLE] [--since ISO_TIMESTAMP] [--limit N]`                                                                                                                                                                                                           | Message events with the bodies the fenced caller may read; see [store](store.md#message-history).                                  |
| `question open --title TEXT [--id ID] [--work WORK_ID] [--option LABEL]...`, `question answer --id ID [--work WORK_ID] --text TEXT [--by user\|ROLE] [--supersedes D<N>]`, `question cancel --id ID --reason TEXT`, `question list [--role ROLE] [--state pending\|answered\|cancelled]` | Pending prompts owned by your role and their decisions; see [questions](store.md#questions-holds-and-decisions).                   |
| `question project --id ID`                                                                                                                                                                                                                                                               | Retry Markdown writeback for your recorded answer.                                                                                 |
| `question close-legacy --id ID --reason TEXT --approval REF`                                                                                                                                                                                                                             | Close your own pending question opened under Codex, citing the user approval; see [questions](store.md#questions).                 |
| `hold set --id ID --scope work:WORK_ID\|role\|app:ID --reason TEXT`, `hold release --id ID`, `hold list [--role ROLE] [--state active\|released]`                                                                                                                                        | Holds owned by your role; see [holds](store.md#holds).                                                                             |
| `hold policy-set --id ID --scope SCOPE --reason TEXT --approval REF`, `hold policy-release --id ID --approval REF`                                                                                                                                                                       | Record or release an exact user policy hold with policy authority.                                                                 |
| `session start`                                                                                                                                                                                                                                                                          | Record your session start, rebind after Claude `/clear`, print binding and counts; see [sessions](store.md#sessions-and-handoffs). |
| `handoff open --scope ROLE\|all... --to claude\|codex [--id ID]`, `handoff state prepared\|sent\|completed\|cancelled --id ID`, `handoff ready [--id ID]`, `handoff active [--id ID]`, `handoff show [--id ID]`                                                                          | A harness handoff record; see [handoffs](store.md#sessions-and-handoffs).                                                          |
| `decision list [--work WORK_ID] [--role ROLE]`                                                                                                                                                                                                                                           | Read decision records in recording order.                                                                                          |
| `store export --since ISO_TIMESTAMP`, `store rebuild`                                                                                                                                                                                                                                    | Export for rollback, verify the chain and rebuild projections; see [store](store.md).                                              |
| `store retire [--dry-run]`, `store retire --apply`                                                                                                                                                                                                                                       | The 3.0 migration: import open ledger requests, archive the retired state; see [retirement](store.md#retirement).                  |
| `request close --id ID --reason TEXT [--work WORK_ID]`                                                                                                                                                                                                                                   | Close your own imported request; see [requests](store.md#requests).                                                                |
| `store import --approval-ledger FILE [--dry-run]`                                                                                                                                                                                                                                        | Map the approval ledger to work evidence, retained items and holds; see [approval-ledger import](store.md#approval-ledger-import). |
| `claude ready [--app ID]... [--role ROLE]...`, `codex ready [--app ID]... [--role ROLE]...`                                                                                                                                                                                              | The handoff readiness probe, optionally scoped; see [readiness](registry.md#readiness-probe).                                      |
| `harness ready [--app ID]... [--role ROLE]...`                                                                                                                                                                                                                                           | Read-only readiness using each selected role's effective harness.                                                                  |
| `harness select --harness claude\|codex\|default --expected-revision N [--app ID]... [--role ROLE]...`                                                                                                                                                                                   | Atomic selection for at least one explicit app or role, without activation.                                                        |
| `harness doctor --app ID ... [--role ROLE ...]`, `harness doctor --role ROLE ...`                                                                                                                                                                                                        | Diagnose explicitly selected roles without sending or activating.                                                                  |
| `claude channel [--app ID]... [--conversation UUID] [--poll-seconds N]`                                                                                                                                                                                                                  | The stdio MCP server the Claude recipient session starts.                                                                          |
| `review deliver --app ID --slot ISO_TIMESTAMP`                                                                                                                                                                                                                                           | Deliver one slot's scheduled review once; see [review](review.md#cli-seam).                                                        |
| `review show [--app ID] [--slot ISO_TIMESTAMP]`                                                                                                                                                                                                                                          | Print a stored brief's full record; see [stored brief](review.md#stored-brief).                                                    |
| `events ingest --app ID`                                                                                                                                                                                                                                                                 | Ingest the runner's event log into the store; see [runner events](store.md#runner-events).                                         |
| `status [--scope SCOPE] [--since ISO_TIMESTAMP] [--state STATE]... [--audit] [--verify-since ISO_TIMESTAMP] [--format json\|markdown]`                                                                                                                                                   | Read-only status of every registered repository's work items; see [status](#status).                                               |
| `work check [--decisions] [--root DIR]`, `work report [--root DIR]`                                                                                                                                                                                                                      | Validate a repository's work files and report their state; see [work files](work-files.md).                                        |
| `work start ID [--parent REPOSITORY:WORK_ID]`, `work evidence ID --stage STAGE --sha SHA [--ref REF]`                                                                                                                                                                                    | Start your approved item, or record a stage commit; see [work records](store.md#work-records).                                     |
| `work block ID --reason TEXT [--owner ROLE]`, `work unblock ID`, `work ready ID`, `work finish ID`                                                                                                                                                                                       | Record your item blocked, unblocked, ready, or finished once its work file is `done`, `superseded` or `cancelled` on `main`.       |
| `work show ID`, `work history ID`                                                                                                                                                                                                                                                        | Read an item's owner, store record and covering holds, or its work events.                                                         |
| `graph [--work [REPOSITORY:]ID] [--depth N] [--format json\|dot]`, `graph why --decision ID`                                                                                                                                                                                             | The live decision graph and supersedes chains; see [decision graph](store.md#decision-graph).                                      |
| `help`, `--help`, `--version`, `--version --json`                                                                                                                                                                                                                                        | Usage, the version, and the version with the `dist/cli.js` sha256 as one JSON line.                                                |

Commands with an app selector also accept the legacy `--game` spelling. Use one spelling per invocation.

## Task and work discovery

Quote the description so it is one argument. Use a standalone primary checkout as the root
for `task find DESCRIPTION [--owner ROLE]`. Use the shared coordinator as the root for
`work find DESCRIPTION [--scope SCOPE] [--owner ROLE]`.

```sh
coordination-kit --root /path/to/project task find "Validate input" --owner implementation
coordination-kit --root /path/to/coordinator work find "Report latency" --scope app:dashboard
```

Work discovery uses the same [scope names as status](#status), including `all`, `workspace`,
`app:ID`, `kit:ID` and `role:KEY`. It defaults to `all`. Use `--owner ROLE` to narrow either
command to an exact role.

The JSON result has `schema: 1`. Its `status` is `match`, `ambiguous`, `no-match` or
`unavailable`. The `match` field gives the best tier. An exact ID (`id`) takes precedence,
then a title normalized for Unicode, case and spaces (`title`), then all query tokens in the title
or ID (`tokens`). With no match type, `match` is `null`. The `matches` list contains the
best tier only, sorted by canonical ID, with recorded evidence. Standalone results include the task
records and scoped holds and questions. Shared results include status records with `workOwner`,
plus top-level `pendingQuestions`, `activeHolds` and `availability`.

Both commands read local records only, with no fetch. A complete lookup exits 0 for `match`,
`ambiguous` or `no-match`. An incomplete source returns `unavailable` and exits 1. Any matches
in that result are partial. Invalid usage exits 2. Resolve ambiguous matches to an exact ID, and
confirm approval and ownership before acting.

## Skills sync

`skills sync --harness codex|claude [--scope project] [--adopt SKILL=SHA256]...` installs or
updates the lifecycle, status, handoff and recovery skills from the running CLI release.
Choose a harness with `--harness`. Scope defaults to `project`, the only supported value.
Use the project's primary checkout as `--root`.
Standalone `project register` syncs this same set for the registered harness. The cleanup skill
uses the individual installer.

The manifest records the managed files. Track `.agents/skills/.coordination-kit.json` for Codex
or `.claude/skills/.coordination-kit.json` for Claude with the installed skills.
A differing unmanaged file or a change to a managed file conflicts. Inspect the file and its
reported SHA256 before authorizing a replacement. Pass one `--adopt SKILL=SHA256` per approved
conflict, using the skill alias and the exact digest of the reviewed file.

Sync returns `status: "synced"` with each skill's `skill`, `path`, `sha256` and `action`.
A conflict exits 1 and returns `status: "conflict"`, the harness, manifest and conflict entries.
Each conflict includes its path and reason, and may also include its skill alias and SHA256.
Registration reports sync in `skillSync`. A conflict or unavailable sync produces a warning
while preserving the registered binding. Resolve it with explicit sync.

The handoff and recovery skills use the existing binding and authorization controls. A handoff
transfers ownership across harnesses. Recovery reuses the exact registered binding. Game-specific
wrappers belong in their game workspaces.

## Skills install

`skills install SKILL --harness codex|claude [--scope project]` installs one skill bundled with
the current CLI release. Choose a harness with `--harness`. Scope defaults to `project`.
Use `--root DIR` to select the project explicitly.

| Skill           | Folder name              | What it covers                                         |
| --------------- | ------------------------ | ------------------------------------------------------ |
| `lifecycle`     | `coordination-lifecycle` | Approved standalone tasks through verified landing.    |
| `status`        | `coordination-status`    | Read-only status in standalone and shared workspaces.  |
| `handoff`       | `coordination-handoff`   | Transfer to another harness using exact role bindings. |
| `recovery`      | `coordination-recovery`  | Resume an existing role using its registered session.  |
| `agent-cleanup` | `agent-cleanup`          | Explicitly requested cleanup of agent-owned resources. |

Codex skills go under `.agents/skills/` and Claude skills go under `.claude/skills/`, relative
to the Git root. Each skill folder holds its `SKILL.md`.

An identical file makes the command a no-op. If the target has different contents, the installer
stops and preserves it for review. Install separately from `init` or copy the release's bundled
skill to the corresponding path yourself. See [standalone setup](getting-started.md#set-up-a-standalone-project).

## Options and refusals

Every command parses its options strictly. An unknown option, an option without its value or a
single-value option given more than once is a usage error, exit 2. Only the options that `--help`
shows with `...` repeat, such as `--link`, `--option`, `--depends-on` and `msg done --evidence`.

The store, `task`, `work` and `graph` verbs share one wrapper.
The family is `store` for the `msg`, `inbox`, `store`, `question`, `hold`, `decision`, `request`,
`session` and `handoff` verbs, `work` for `work start|evidence|block|unblock|ready|finish|show|history`
and `graph` for `graph` and `graph why`. The `task` family covers the standalone task verbs.

- **Positionals:** exactly the ones the form names (`ID`), else none.
- **Usage errors:** a blank option value or positional is also a usage error. The first stderr line
  is `coordination-kit: invalid_FAMILY_options (COMMAND)`. Safe guidance follows and the command
  exits 2.
- **Refusals:** exit 1 with `coordination-kit: CODE` on stderr, where `CODE` is the store refusal
  code, else `FAMILY_operation_failed`. A refusal that carries a short reason prints it after the
  code, such as `coordination-kit: session-held: phase held`.
- **Output:** one JSON object on stdout, or DOT for `graph --format dot`.

## Filesystem migration commands

`store migration-status` reads the current authority and any prepared receipt.
`store migration-prepare --backup ABSOLUTE_FILE --restore ABSOLUTE_FILE` qualifies fresh
independent copies outside the checkout and prepares the ignored filesystem target.
`store migration-activate --id RECEIPT_ID` requires the exact prepared receipt. Preparation and
activation require the current active game-coordinator binding. See the
[migration runbook](upgrading.md#filesystem-authority-migration).

## Filesystem compaction commands

- `store compaction-plan` reports history windows, measured bytes and protected reasons at the
  selected journal head. It writes nothing.
- `store compaction-reserve --id REQUEST_UUID --head-seq SEQ --head-hash SHA256 --registry-revision REVISION`
  blocks journal writes at the exact reviewed head and reports its acquisition `nonce`.
- `store compaction-prepare --id REQUEST_UUID --restore DIR --evidence FILE --receipt NEW_FILE`
  qualifies a candidate against an independent restore and writes a new external receipt.
  A repeat checkpoint requires the selected tail's reservation.
- `store compaction-activate --id RECEIPT_ID --restore DIR --evidence FILE --receipt FILE --approval REF`
  selects the exact candidate during an approved idle boundary.
- `store compaction-cancel --id REQUEST_UUID --nonce ACQUISITION_UUID --head-seq SEQ
--head-hash SHA256 --registry-revision REVISION` releases the exact reservation before permanent
  fencing.

Reserve, prepare, activate and cancel require the active workspace `store:maintain` binding. See the
[filesystem compaction runbook](store.md#filesystem-compaction-runbook).

### One-time closed-history compaction

- `store compaction-plan --closed-history APPROVAL_REF --restore ABSOLUTE_DIR` plans against an
  independent restore. The schema 1 result is `kind: "closed-history-compaction-plan"` with
  `head`, `registryRevision`, `window`, `selected` and `excluded`. It includes a replay
  equivalence summary in `replay` and a schema 2 recipe in `evidence`. Both fields are
  `null` when the selection is empty.
- `store compaction-prepare --closed-history APPROVAL_REF --restore ABSOLUTE_DIR --evidence ABSOLUTE_FILE --receipt ABSOLUTE_FILE --id REQUEST_UUID`
  verifies the exact approved scope against the reserved source and independent restore.
- `store compaction-activate --closed-history APPROVAL_REF --restore ABSOLUTE_DIR --evidence ABSOLUTE_FILE --receipt ABSOLUTE_FILE --id RECEIPT_ID --approval EXACT_ACTIVATION_REF`
  rechecks the approval, evidence, restore and receipt before selecting the checkpoint.

Reserve the exact plan head and registry revision with the ordinary reserve command. This form
requires a reservation even for the first checkpoint. Prepare and activate use the same
exact existing user decision reference. Activation also requires approval for the exact prepared receipt.
See the [one-time runbook](store.md#one-time-closed-history-compaction).

## Command semantics

- `claude channel`: by default it serves the `reports.recipient` that every app (or each
  `--app`) names, and requires that role's effective harness to be `claude`. Apps that name
  different recipients stop it with exit 1. Select apps with one recipient or pass
  `--conversation`. With `--conversation UUID` it serves the one role whose effective Claude
  conversation is that ID, or is reached from it by `/clear` lineage
  ([Claude channel](review.md#claude-channel)). `--poll-seconds` defaults to 5. Without
  `--conversation`, an absent registry stops it with exit 1. It watches its role's
  [wake file](review.md#wake-files) and emits one notification per seq increase, so it keeps
  serving the role after `session start` rebinds it after `/clear`. The server identifies itself
  to the session as `delivery-kit-channel`, the name existing channel configurations use.
- `msg send`, `inbox`, `msg done`, `msg retain`, `request close`, `store import` and
  `store retire --apply` identify
  the caller through the [registry fence](store.md#writer-fence): `--native-id ID`, else
  `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` for the role's effective harness. `--worker NAME`
  is an unverified attribution. Each prints one JSON object; a refusal prints
  `coordination-kit: CODE` on stderr and exits 1, and a usage error exits 2. `msg send` takes the
  body from exactly one of `--body-file` (relative to the working directory, valid UTF-8) and
  `--body`, and `--link` values as `KIND=REF`, such as `work=ck-0017`. `msg history` lists at
  most `--limit` events (default 1000). `--since` takes an ISO 8601 instant.
  `msg send` also accepts [unbound senders](messages.md) for ordinary queued messages.
  `msg retain` defaults to the next scheduled review. A workspace without scheduled reviews
  requires an explicit boundary.
- `msg status ID --include-body` and `msg history --include-body` identify the caller
  through the same registry fence and apply message-body visibility.
- `question open|answer|project|cancel|close-legacy`, `hold set|release` identify the caller
  through the same registry fence. Only the owning role answers, projects, cancels or releases its
  own records (`not-owner`), from whichever binding the registry currently holds for it, on either
  harness. `question answer` records the answer before Markdown writeback and
  reports its projection status. Supply `--work` when the question has no recorded work ID.
  Use `question project --id ID` to recover a failed or missing
  writeback. A changed work file is left unstaged for the role's next commit. `question cancel`,
  `question close-legacy`, `question answer` and `hold release` attempt one guarded wake for the
  caller, since the write may clear its last wake guard. `--option LABEL` is repeatable, 1 to 8
  labels. Repeated `--depends-on REPOSITORY:WORK_ID` fences those work items until the question
  closes, on either harness. The list verbs take no caller and read an absent store as empty.
- `question close-legacy` closes only a pending question opened under a Codex binding and cites
  the explicit user approval in `--approval`. It is temporary, for questions left pending from the
  Codex period.
- For Codex, record exact prompt wording, ordered `--option LABEL` or `--option-json JSON`,
  and repeated `--depends-on REPOSITORY:WORK_ID` through `question open` before presentation.
  See [Codex question recovery](store.md#codex-question-recovery).
- `hold policy-set` and `hold policy-release` require an active `policy:manage` binding and the
  exact user approval reference for the action. Policy IDs start with `policy-`. Set names one
  target as `role:ROLE`, `app:APP`, the legacy `game:GAME` or `work:REPOSITORY:WORK_ID`. Release names its exact policy
  ID. See [user policy holds](store.md#user-policy-holds).
- `session start`, `handoff ready` and `handoff active` identify the caller through the registry
  fence. `handoff open` and `handoff state` also require the workspace `handoff:manage` grant.
  `session start` refuses a held role with `session-held: phase held` (or `source-held`).
  An unbound Claude caller without `--native-id` is rebound when its transcript proves a `/clear`
  of exactly one role's current Claude binding; the output then adds
  `rotation: {"from": OLD_ID, "revision": N}`. A registry changed since the read refuses
  `rotation-conflict`. See [rebind after /clear](store.md#rebind-after-clear).
  `handoff show` takes no caller and prints the latest handoff without `--id`.
- `review deliver` and `events ingest`: the runner seam. Each prints exactly one
  typed JSON line and exits 0 for every typed result, 2 for a usage error and 1 for an internal
  failure, with nothing on stdout. `--slot` is an ISO 8601 minute start with an offset. A repeated
  `review deliver` for a slot prints the recorded result. SIGTERM observed before review
  processing starts exits 1 without writing a brief or printing a result to stdout. See
  [same-slot recovery](review.md#stored-brief) and [runner events](store.md#runner-events).
- `review show`: prints the recorded brief for `--slot` (default: the latest) of `--app`
  (default: any app) as one JSON line. It exits 1 with `brief-missing` when there is none.
- `store retire` defaults to a dry run, which takes no caller and writes nothing. The optional
  `--dry-run` flag uses the same preview. Applying requires `--apply` and the workspace
  `store:maintain` grant. See
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
- `work finish` accepts a work file whose status on `main` is `done`, `superseded` or `cancelled`
  (`work-not-done` otherwise). A `superseded` item needs a work file on `main` whose `supersedes`
  names it (`successor-missing` otherwise); the record cites each successor. See
  [finish](store.md#finish).
- `graph`: `--root` names the coordinator. `graph --format dot` prints DOT instead of JSON.

## status

`status` reads every distinct Git repository behind the registry's roles and reports current work,
recorded pending questions, active holds, unmatched legacy requests and recent work activity.
It writes nothing and uses no network: repositories are read through local
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
  `unmatchedRequests` also identifies those imports explicitly, including recent closed entries
  without a matching work file. Their repository is null when the owner has no registered repository.
  Store work records with missing work files are shown with `workFile: null`.
- **Store:** a read-only snapshot of [work records](store.md#work-records), pending questions,
  unread originals, active holds and imported requests from the configured authority. An absent
  store reports `absent`. Each item carries its record as `store` (null without one).
  `pendingQuestions` reports stored wording, ordered options and the opening thread of a question
  with a Codex record when available. `unread` lists exact original IDs and wake evidence within
  the selection. Reading status leaves delivery and native prompts untouched.
- **Scope.** Use `all` for every repository, `workspace` for the workspace repository,
  `app:ID` for an app, `kit:ID` for a kit or `role:KEY` for work and records owned by that role.
  Unambiguous bare app IDs, kit IDs and role keys still work. When names collide, choose
  the explicit scope in the error. Use a prefix for app, kit or role IDs named `all` or `workspace`.
  The work commands and status both use the explicit `owner` if
  given, then the repository's only role, then the game's registered `design` role with Tech
  as the fallback.
- **Filters:** `--state` is repeatable and keeps items with any named status; `--state unverified`
  keeps done items whose delivery is unverified. `--since` time-filters `recentActivity`,
  `recentCompletions` and closed items. Open items, pending questions and active holds remain
  visible regardless of age. Activity uses the work-file update (or completion time for a closed
  item), verified landing and deployment, and linked store activity. A `last-deploy` time counts
  only for the commit it names, since it also covers every older commit. Completion records the
  transition to a closed state, including the replacement of superseded work or a store finish.
  `--audit` keeps user-originated items: a work file whose `approved` reference starts
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
  `delivery.landing.rule` names the rule that matched. The `id` and `title` rules preserve
  heuristic lineage. Only a `done-flip` or explicit store stage evidence establishes a landing.
- **On origin:** whether `origin/main` contains the landing commit; null without a landing or
  without a local `origin/main`.
- **Deployment:** the earliest deployment point that contains the landing commit.
  - A game's successful runner deploy event is read from the store using its exact SHA and event
    time. A skipped deployment remains a distinct runner outcome. Historical COMPLETE events are
    read from the store or legacy outbox. The runner's last deployed SHA
    (`var/games/<g>/bus/last-deploy.sha`) is timed by the epoch seconds in `last-deploy`, or has a
    null time when that file is missing.
  - A successful deploy or legacy COMPLETE event can list work IDs. A listed ID has deployment
    evidence even without a landing match (`deployed.matched` is `work-list`, otherwise `landing`).
  - A deployment containing an ID or title citation is shown in
    `delivery.heuristicDeployment`. An ID or title citation does not establish that the item shipped.
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

A store record whose repository or work file cannot be read keeps its own item: a finished record
reads as its `finishedStatus` (`replacement` is its first successor), else `deployed`, `landed`,
`in-progress` or `requested` from its evidence and start.

A request item is `requested`. An open item is `blocked` when a linked request is `blocked` or
`waiting` (`blocker` is its reason, `owner` its required owner); an open store block takes precedence (its reason and the role
that can clear it). Otherwise `blocker` and `owner` are null. `waitingOnUser` is
true for `proposed` items and for items with a linked recorded question or imported request whose
question is `pending`.

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
pendingQuestions  [{id, role, title, work, options, state, openedAt, closedAt, decision, reason, codex?}]
unread            [{id, from, to, wake}]
activeHolds       [{id, role, scope, source, reason, state, setAt, releasedAt, policy?}]
unmatchedRequests [{id, repository, owner, state, summary, work, closedAt, ...request fields}]
recentActivity    [{repository, id, at}]
recentCompletions [{repository, id, at}]
items         [{repository, id, title, status, replacement, blocked, blocker, owner,
                waitingOnUser, userOriginated, deliveryVerified: true | false | null,
                deliveryEvidence: deployed | assumed | null, latestEvidenceAt, completedAt,
                workFile: {path, status, approved, design, supersedes: [ID], addedIn, commit,
                           committedAt} | null,
                requests: [{id, kind, state, owner, question, requiredOwner, reason,
                            updatedAt, userSource}],
                store: {repository, id, owner, state, parent, children, startedAt, readyAt,
                        finishedAt, finishedStatus, successors, block, evidence,
                        retained, updatedAt} | null,
                deliverySource: {landing: store | git | null, deployment: store | git | null},
                delivery: {landing: {sha, at, rule: done-flip | id | title} | null,
                           onOrigin, deployed and heuristicDeployment:
                                               {sha, at, via: complete | deploy-event | last-deploy | release,
                                                tag, matched: landing | work-list} | null}}]
```

Items are ordered by repository name, then ID.

`--format markdown` prints pending questions, active holds and unmatched imports. With `--since`
it prints the recent activity and completions. Per repository, the headings are Done (`done`, `deployed`,
`declined`, `cancelled`, `superseded`), In progress (`in-progress`, `landed`), New (`requested`),
Outstanding (`approved`) and Waiting on the user (proposed items and pending questions, which take
precedence), each item once. An unverified done item carries the marker `(unverified)` after its
title.

The command exits 0, or 1 when the store is unavailable, a selected
repository or a game's bus cannot be read, or a bus event file is unreadable; the output is still
printed. A usage error, including an unknown `--scope` or `--state`, exits 2.
