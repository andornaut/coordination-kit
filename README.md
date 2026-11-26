# coordination-kit

Shared coordination for the game and kit roles: the role registry, the coordination store
with its message lifecycle, Claude and Codex wakes, work records, questions, holds and decisions,
the scheduled review brief, plus checks for a repository's work files. The kit owns the mechanisms; `game-coordinator` owns `config.json`, the registry and
mutable state. delivery-kit's resident runner decides when a scheduled review is due and calls
this kit to compose and deliver it.

The package is `@andornaut/coordination-kit`. Its operator tool is the `coordination-kit` CLI,
bundled into `dist/cli.js`. The bundle imports only `node:` builtins. Its child processes are
`flock`, `git`, `claude agents --json` and, for `store retire`, `tar`.

[Start a fresh coordinator](docs/configuration.md#start-a-fresh-coordinator) with SQLite and
use the [upgrade guide](docs/upgrading.md#filesystem-authority-migration) to qualify and activate
the file store. The [filesystem layout](docs/store.md#filesystem-layout) describes journal and
role records. [Git boundaries](docs/configuration.md#state) cover tracked
configuration and ignored runtime state.

## Install and pin

Pin the release asset as a devDependency in the primary game-coordinator checkout and commit the
lockfile. The CLI requires Node 24.21.0 or newer, and all roles use that installation.

```json
"devDependencies": {
  "@andornaut/coordination-kit": "https://github.com/andornaut/coordination-kit/releases/download/v7.3.1/coordination-kit-7.3.1.tgz"
}
```

Use `npm ci` to install the committed pin. Delivery Kit's runner calls the coordinator-installed
CLI for reviews and event ingest. Its bundled build libraries have a separate compatibility range.
See the [upgrade guide](docs/upgrading.md#coordination-kit-73).

## Usage

Commands resolve game-coordinator from
`--root DIR`, else `COORDINATION_KIT_ROOT`, else `DELIVERY_KIT_ROOT`, else the working directory.
`--root` may appear anywhere on the command line, at most once. Commands that require a game
take `--game ID`. The `work` commands read `--root` as the repository to inspect and default to
the working directory. They take the coordinator root only from `COORDINATION_KIT_ROOT` or
`DELIVERY_KIT_ROOT`.

| Group      | Verbs                                                                                                  | Purpose                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `msg`      | `send`, `done`, `retain`, `status`, `history`                                                          | Store messages: send with one guarded wake, close or retain in one write, read.                          |
| `inbox`    | (none)                                                                                                 | Read your store inbox and record it delivered.                                                           |
| `store`    | `import`, `export`, `rebuild`, `retire`, `migration-status`, `migration-prepare`, `migration-activate` | Import, export, rebuild, retire, and qualify or activate filesystem authority.                           |
| `request`  | `close`                                                                                                | Close an imported ledger request you own.                                                                |
| `question` | `open`, `answer`, `project`, `cancel`, `list`                                                          | Pending prompts, durable answers and recoverable work-file writeback.                                    |
| `hold`     | `set`, `release`, `list`                                                                               | Holds owned by the role that set them; only that role releases them.                                     |
| `session`  | `start`                                                                                                | Record a role's startup or resume and print its binding, checkpoint and open counts.                     |
| `handoff`  | `open`, `ready`, `state`, `active`, `show`                                                             | The store record of a harness handoff; see [sessions and handoffs](docs/store.md#sessions-and-handoffs). |
| `decision` | `list`                                                                                                 | Read the decision records.                                                                               |
| `harness`  | `ready`, `select`, `doctor`                                                                            | Readiness by effective harness, scoped harness selection and diagnosis.                                  |
| `claude`   | `ready`, `channel`                                                                                     | The Claude readiness probe and the stdio MCP channel server.                                             |
| `codex`    | `ready`                                                                                                | The Codex readiness probe.                                                                               |
| `review`   | `deliver`, `show`                                                                                      | The runner seam: one slot's scheduled review, as one typed JSON line; show a stored brief.               |
| `events`   | `ingest`                                                                                               | The runner seam: one event log ingest, as one typed JSON line.                                           |
| `status`   | (none)                                                                                                 | Read-only status of every registered repository's work items, as JSON or a Markdown digest.              |
| `work`     | `check`, `report`, `start`, `evidence`, `block`, `unblock`, `ready`, `finish`, `show`, `history`       | Validate a repository's work files and report them; record each item's live progress in the store.       |
| `graph`    | (none), `why`                                                                                          | The live decision graph and supersedes chains.                                                           |

`coordination-kit --help` lists every command form; it is generated from each command's parser
options. Per-command semantics are in [docs/commands.md](docs/commands.md).

Exit status is 0 on success, 1 for invalid configuration, a failed precondition, an unavailable
read or work-check findings, and 2 for a usage error or an unexpected failure. `review deliver`
and `events ingest` exit 0 for every typed result, 2 for a usage error and 1 for any other failure.
Errors go to stderr prefixed `coordination-kit:`. Commands with a JSON result keep it on stdout.

## Documentation

| Doc                                            | Covers                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [docs/commands.md](docs/commands.md)           | Per-command semantics and the `status` schema                                                                   |
| [docs/configuration.md](docs/configuration.md) | The coordinator root, `config.json`, the `reports` fields of `delivery-kit.json` and the state layout           |
| [docs/registry.md](docs/registry.md)           | `var/registry.json`, scoped harness selection, send-time resolution, the readiness probe and the harness doctor |
| [docs/messages.md](docs/messages.md)           | Store messages: send, pull, close and retain                                                                    |
| [docs/store.md](docs/store.md)                 | Store layout, schema, API, writer fence, wakes, event ingest, work records, requests and retirement             |
| [docs/review.md](docs/review.md)               | The review route, the runner seam, the stored brief, wake files and the Claude channel                          |
| [docs/work-files.md](docs/work-files.md)       | `work check`, `work report` and the decision line format                                                        |
| [docs/libraries.md](docs/libraries.md)         | The public build API subpaths and their main symbols                                                            |
| [docs/upgrading.md](docs/upgrading.md)         | Moving between releases, including the 3.0 retirement runbook and rollback                                      |
| [docs/design/](docs/design/README.md)          | Design area summaries, each linking its topic docs and indexing its work items                                  |
| [docs/work/][work-files]                       | The work-file convention and one file per approved task (repository only, not packaged)                         |

[work-files]: https://github.com/andornaut/coordination-kit/blob/main/docs/work/README.md

## Developing

| Target               | Does                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `make`, `make check` | Complete verification: root and contract types, lint, build, unit tests, contracts and package inspection, then ShellCheck |
| `make lint`          | Root and contract types, Prettier, ESLint with the import rules, Markdown lint and the work-file check, then ShellCheck    |
| `make test`          | Build, unit tests and the complete native contract suite                                                                   |
| `make build`         | Build, then package inspection                                                                                             |

Every target runs in stock images: the Node version pinned in `.nvmrc` and
`koalaman/shellcheck:v0.11.0`. No image is built. Each container binds the checkout read-only,
runs as the host user with four CPUs and a fixed 4 GiB memory ceiling, a read-only root
filesystem and no capabilities. The Node container copies the source without `.git`,
dependencies or build output into tmpfs, installs the root and contract dependencies with
`npm ci`, then runs the native npm checks. ShellCheck reads the bound source directly with no
network.

Native npm commands run directly wherever they are invoked. Local prerequisites are the pinned
Node version, root and contract dependencies, and ShellCheck 0.11.0. Install dependencies with
`npm ci` and `npm --prefix tests/contract ci`.

WORKAROUND: a root override keeps `markdownlint-cli2` 0.24.1 on a patched `katex` for
[GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7), because
`micromark-extension-math` 3.1.0 requires `katex` ^0.16.0. Remove it when upstream resolves a
patched `katex` without the override.

| Command                 | Checks                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm run verify`        | Root and contract types, lint, wrapper syntax, build, unit tests, full contracts and package inspection.           |
| `npm run check`         | Root and contract types.                                                                                           |
| `npm run lint`          | Prettier, ESLint with the import rules, Markdown, packaged docs, work files and ShellCheck with `-x -P SCRIPTDIR`. |
| `npm run build`         | Build the CLI and public build API bundles and declarations.                                                       |
| `npm test`              | Unit tests, using at most four workers by default; build first.                                                    |
| `npm run contract`      | Build, contract types and the complete native contract suite.                                                      |
| `npm run package:check` | Inspect the extracted CLI, the build API subpaths and strict NodeNext declarations.                                |

Explicit source or contract paths passed to `npm run verify --` select the corresponding suite;
unscoped filters apply to both. Standalone `npm run contract -- --lock` regenerates the contract
lockfile with native npm. Ordinary Git commits run serial local lint-staged, with direct Prettier
and ESLint fixes that preserve Git's staged/unstaged workflow.

CI runs the same native npm commands directly on the runner with the pinned Node version and the
pinned ShellCheck step. Its `lint` job (types, Prettier, ESLint with the import rules, Markdown lint, the packaged-docs
check, the work-file check and ShellCheck) runs for every push and pull request. The `build`,
`test`, `contract` and `package` jobs run only when a path outside `docs/` changed, and otherwise
report as skipped. A forced push, a new branch or a base the clone does not have runs every job.

The packaged-docs check (`npm run lint:docs`) holds `package.json` `files` to the tree: every
listed doc exists, every `docs/*.md` and `docs/design/*.md` is listed or excluded with a `!`
entry, and no packaged doc links by relative path to a file the package leaves out. Packaged docs
link to `docs/work/` by its repository URL.

Package inspection always reports `immutableCommitClaim: false`. Snapshot metadata retains
`CHECK_REVISION`, `CHECK_SOURCE_SHA256` and `CHECK_SOURCE_DIRTY` when supplied; native inspection
without that metadata invents no commit or source hash. Inspection writes its archive and
`CHECK_CONTEXT.json` to a fresh temporary directory and prints that location.

The thin wrappers `scripts/check.sh`, `scripts/pack.sh` and `tests/contract/run.sh` invoke
native Node helpers. The separately invoked
`npm run pack -- EXACT_COMMIT_SHA /new/absolute/directory` is the explicit host
release-controller exception: it archives the requested commit and starts its own offline release
container with four CPUs, a 4 GiB memory ceiling, the pinned Node image and the read-only
`coordination-kit-npm-check` cache volume
(`COORDINATION_KIT_NPM_VOLUME` names another); a missing volume or dependency fails without
fallback. The controller retains the source epoch and copies the exact revision's `SOURCE_COMMIT`
and `SHA256SUMS` out with the archive. CI fills the cache volume from the lockfile, then invokes
this controller after the checks.

## Source layout

`src/` is layered, lowest first. A module imports only from its own layer or a lower one, type-only
imports and re-exports included; tests are exempt. ESLint enforces the order with one
`no-restricted-imports` boundary per layer folder and fails on a `src/` folder that is in no layer.
`import-x/no-cycle` rejects runtime import cycles across `src/`, `scripts/` and `tests/`, including
cycles that cross those directories. Type-only imports are erased at build time, so they may form
a cycle within one layer. An import whose specifiers are all inline types still loads its module,
so `@typescript-eslint/no-import-type-side-effects` requires it as `import type`.

| Layer | Directory                     | Holds                                                                                                                          |
| ----- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `core/`                       | Identifiers, the persisted JSON form, validation, durable files, locks, the layout, Git reads, the clock, the command contract |
| 2     | `registry/`                   | `var/registry.json`: schema, guarded updates, resolution and harness selection                                                 |
| 3     | `workfiles/`                  | The work-file convention: front matter, decision lines, `work check` and `work report`                                         |
| 4     | `adapters/`                   | Claude and Codex transports and collectors, the review route, decision markers and endpoint selection                          |
| 5     | `store/`                      | The event store, its projections and file authority, the records over it, wakes and the store services                         |
| 6     | `review/`, `status/`, `work/` | The scheduled review, `status`, the work verbs, the decision graph and the approval-ledger import                              |
| 7     | `commands/`                   | Each command's options, parsing and output                                                                                     |
| 8     | `src/*.ts`                    | `bin.ts`, `cli.ts` and the public build barrels `store.ts`, `review.ts` and `shared.ts`                                        |

Only `bin.ts`, `cli.ts` and `commands/` read the process environment, the wall clock and the
host name; the layers below take them as explicit leading parameters or context fields.

`registry/index.ts` is the `build/registry` barrel. Within `store/`, `types.ts`, `eventCodec.ts`
and the projections in `projections/` sit below `db.ts`, so every record module can take a `Store`.

## Compatibility and releases

`VERSION` and `package.json` carry the version, and `pack` refuses a mismatch. The CLI, the build
API subpaths, `config.json`, the registry and route schemas and every on-disk format follow semver:
an incompatible change needs a major version.

A release is three files from `pack`:

- `coordination-kit-VERSION.tgz`, the npm package (`dist/`, `README.md`, the topic docs and `docs/design/`, `LICENSE`, `SOURCE_COMMIT`; not `docs/work/`);
- `SOURCE_COMMIT`, the exact commit it was built from, also inside the archive;
- `SHA256SUMS`, covering the archive and `SOURCE_COMMIT`.

The release owner pushes the release commit to `main`, verifies every required CI workflow
succeeded for that exact commit, then tags `vVERSION` there and attaches the `pack` output. A
published tag is never moved.

## Licence

MIT; see `LICENSE`.
