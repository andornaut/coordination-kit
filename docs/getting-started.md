# Getting started

Choose how the repositories and roles work together.

| If you want to                                                           | Start here                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Track work and review changes in one Git repository using its own checks | [Set up a standalone project](#set-up-a-standalone-project)                                     |
| Give one or more apps a shared registry and inbox                        | [Set up an app workspace](#set-up-an-app-workspace)                                             |
| Keep the state of an existing game coordinator while adopting app mode   | [Migrate a legacy coordinator in place](configuration.md#migrate-a-legacy-coordinator-in-place) |

Both setups work with Codex or Claude. The examples use Codex and one role. Use the
conversation ID of the actual session doing the work. The harness supplies it to commands
through `CODEX_THREAD_ID` for Codex or `CLAUDE_CODE_SESSION_ID` for Claude.

## Get the CLI

You need Node 24.21.0 or later, Git and `flock`. Download the archive and its verification files
from the same [7.12.0 release][release]. Use a directory outside any repository.

```sh
kit_dir="$HOME/.local/share/coordination-kit/7.12.0"
kit_release="https://github.com/andornaut/coordination-kit/releases/download/v7.12.0"
mkdir -p "$kit_dir"
(
  set -e
  cd "$kit_dir"
  for asset in coordination-kit-7.12.0.tgz SOURCE_COMMIT SHA256SUMS; do
    curl -fLO "$kit_release/$asset"
  done
  sha256sum -c SHA256SUMS
  tar -xzf coordination-kit-7.12.0.tgz
  cmp SOURCE_COMMIT package/SOURCE_COMMIT
)
ck() { node "$kit_dir/package/dist/cli.js" "$@"; }
ck --version
```

Both checksum lines should say `OK`, the two `SOURCE_COMMIT` files should match, and the version
should be `7.12.0`. Keep the `ck` function in the shell where you run the standalone example.
A shared workspace can [pin the same release with npm](#set-up-an-app-workspace).

## Set up a standalone project

Use this path in an existing Git repository. It needs no npm project, shared coordinator,
or Delivery Kit. Start from the primary checkout in the Codex session you want to register.
Set `native_project_id` to the actual project ID from your harness and `conversation_id` to
that session's Codex conversation ID. With Claude, use its actual session ID and
`--harness claude` when registering.

```sh
primary="$(pwd -P)"
ck --root "$primary" init --project example --role maintainer --review chat
ck --root "$primary" project register --role maintainer --harness codex \
  --native-id "${conversation_id:?}" --native-project-id "${native_project_id:?}"
ck --root "$primary" session start
```

The start result names the `maintainer` role. Registration syncs the managed skills for the
chosen harness. Commit the generated `coordination-kit.json`, the `.gitignore` change, and
the skills and their manifest. Keep the same root for later invocations, including from task worktrees.
If registration warns about skill sync, resolve it with [explicit sync](#sync-project-skills).
When a role uses another linked worktree, register its path relative to the primary
checkout, such as `--worktree ../implementation`.

Record a small first task after the user has explicitly approved the scope. Replace the
approval reference below with one that points to the user's actual decision.

```sh
ck --root "$primary" task propose task-0001 --owner maintainer \
  --title "Document the local checks" --scope "List the commands in the README."
ck --root "$primary" task approve task-0001 --approval chat:build-decision
ck --root "$primary" task start task-0001
ck --root "$primary" task show task-0001
```

`task show` should show the approved scope and state `in-progress`. To take the task through
to a verified landing, use the repository's configured remote and default branch.

If you later have the task description but need its recorded ID, look it up without changing its
state.

```sh
ck --root "$primary" task find "Document the local checks"
```

1. [Build and prepare an exact candidate](standalone.md#approve-and-build). Commit the work
   file and implementation together, run the project checks, fetch the configured remote
   and record the candidate with `task ready`.
2. [Review and merge](standalone.md#review-and-merge). Under the example's `chat` policy,
   record the user's explicit approval for that exact head and run `task merge`.
   The `pr` policy requires pushing the candidate branch to the configured forge.
3. [Verify the landing](standalone.md#follow-the-merge-to-landing). Run the required checks
   on the integrated revision and record the exact-commit evidence with
   `task verify task-0001 --evidence REF`. Confirm `task show` reports `landed` and the merged SHA.

```text
repository/
  .gitignore, coordination-kit.json  tracked setup and review policy
  docs/work/task-0001.md             tracked with the implementation when created
  .coordination-kit/                 local and ignored
    registry.json                    native role bindings
    coordination.db                  task, approval and message history
```

| Review policy | What happens at review                                                                       |
| ------------- | -------------------------------------------------------------------------------------------- |
| `chat`        | Present the exact candidate to the user and record approval for its revision before merging. |
| `off`         | Run the project checks and use the fast-forward merge flow.                                  |
| `pr`          | Use the configured GitHub or GitLab provider and its existing authentication and checks.     |

The [review guide](standalone.md#review-and-merge) explains policy changes and exact-commit
approval. Run [landing verification](standalone.md#follow-the-merge-to-landing) after the
merge with the evidence your repository requires for the integrated revision.

## Sync project skills

Lifecycle, status, handoff and recovery skills ship in the pinned archive. The standalone
registration above installs them for the selected harness. For an existing standalone project or
shared workspace, run this in its primary checkout using the archive's `ck` function.

```sh
ck --root . skills sync --harness codex --scope project
```

Use `--harness claude` for Claude. With the app workspace's `ck` function, omit `--root .` because
the function supplies that root. Commit the files and their `.coordination-kit.json` manifest in
the harness skill directory. Linked worktrees get the skills when they update to the commit.

To upgrade, verify the new archive's checksum and matching `SOURCE_COMMIT` files, switch to that
release's CLI, then rerun sync and review the diff before committing. If the workspace pins the CLI
with npm, update the dependency and lockfile to the new release first.

If sync reports a conflict, inspect the named file and verify its reported SHA256. After approving
replacement, resync with the reviewed digest. For example, set `reviewed_sha256` to the digest for
the lifecycle skill and run

```sh
ck --root . skills sync --harness codex --scope project --adopt "lifecycle=$reviewed_sha256"
```

Repeat `--adopt` for each approved conflict. See [sync options](commands.md#skills-sync) and
[individual installers](commands.md#skills-install).

## Set up an app workspace

Use a primary workspace Git checkout and at least one app checkout. The example app is the
sibling directory `../dashboard`. Give additional apps their own entries and use the exact
configured role keys in the registry. You can start with coordination and inboxes, then
add Delivery Kit when you need a runner.

In the primary workspace, create `package.json` with `npm init -y` if it is absent.
Install the checked release, commit `package.json` and `package-lock.json`, and use
`npm ci` in subsequent checkouts. Ignore `/node_modules/` and `/var/`.

```sh
npm install --save-dev \
  https://github.com/andornaut/coordination-kit/releases/download/v7.12.0/coordination-kit-7.12.0.tgz
workspace="$(pwd -P)"
ck() { node "$workspace/node_modules/@andornaut/coordination-kit/dist/cli.js" --root "$workspace" "$@"; }
ck --version
```

Commit this `config.json` in the workspace. The `operator` role needs no privileged grants
to start its session and handle its own inbox. `wakeMinutes: []` disables scheduled reviews.

```json
{
  "schema": 1,
  "timezone": "UTC",
  "wakeMinutes": [],
  "apps": {
    "dashboard": { "name": "Dashboard", "path": "../dashboard", "roles": ["operator"] }
  },
  "kits": {},
  "sharedRoles": [],
  "permissions": {}
}
```

Start the Codex session from the app's checkout. In the same shell where you set `workspace`,
run the following from the primary workspace checkout with that session's verified
`native_project_id` and `conversation_id`. For Claude, use `harness: "claude"` and
`conversations: { claude: conversationId }`.

```sh
cd "$workspace"
node --input-type=module - "${native_project_id:?}" "${conversation_id:?}" <<'JS'
import { createRegistry, loadLayout } from "@andornaut/coordination-kit/build/registry";

const [, , nativeProjectId, conversationId] = process.argv;
const registry = createRegistry(() => new Date(), loadLayout(process.cwd()), {
  schema: 1,
  harness: "codex",
  host: { nativeProjectId, root: "." },
  roles: {
    operator: {
      ownership: "active",
      worktree: "../dashboard",
      conversations: { codex: conversationId },
    },
  },
  operations: {},
  transfers: [],
});
console.log(JSON.stringify({ revision: registry.revision }));
JS
```

The seed prints revision `1`. In the bound Codex session, use the workspace CLI function
above and send a test note to your own role. When the harness does not export its session ID,
pass the exact registered ID with `--native-id ID` on caller-bound commands.

```sh
ck session start
ck msg send --to operator --body "First inbox check."
ck inbox --include-body
```

`session start` reports role `operator`. The inbox lists the original with its text and
state `delivered`. To record handling, copy its ID and run `ck msg done ID`. Wakes are
optional for this check. The durable inbox works even when a native wake is guarded.

Once Dashboard has work records, look one up by description using the workspace CLI function.

```sh
ck work find "Report latency" --scope app:dashboard
```

```text
workspace/
  .gitignore, package.json, package-lock.json, config.json  tracked
  node_modules/                                            local dependency install
  var/                                                      local and ignored
    registry.json                                           native role bindings
    coordination.db                                         initial SQLite store
    route.json, reviews/                                    optional scheduled review state
    apps/dashboard/bus/                                     optional delivery state
dashboard/
  delivery-kit.json                                         tracked if using a runner
  docs/work/                                                tracked if using work files
```

Keep the local state and back it up independently of Git. See
[configuration and filesystem state](configuration.md#state) for an external state
pointer or an activated filesystem store. If you use Delivery Kit, configure explicit
[runner grants](store.md#app-mode-permissions), the app's committed reporting settings,
the local [review route](review.md#review-route) and a runner cadence. Use
[workspace configuration](configuration.md#workspace-configjson) to add roles and set
review minutes.

## Clean up agent-owned resources

To make the optional `agent-cleanup` skill available in a standalone or shared project, run this
from the intended checkout with the archive's `ck` function.

```sh
ck --root . skills install agent-cleanup --harness codex --scope project
```

Use `--harness claude` for Claude. When installing in the app workspace with its `ck` function,
omit `--root .` because that function already supplies the workspace root.

Ask for `agent-cleanup` by name when authorizing a cleanup of agent-owned resources. Before removal,
verify the exact resource ID or path, its owner and whether a task or session still needs it.
Reuse existing evidence and backups by default. Remove bundles within scope unless there is a
verified, specific retention reason beyond their absence from `main`. Honour the retention rules
for release artifacts and existing backups. Report what was removed, retained or left for owner
review.

## Troubleshooting

| Symptom                                   | Check                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `caller-unidentified` or `caller-unbound` | Run the command in the registered session. Check its effective harness, conversation ID and explicit workspace root.     |
| `registry-unavailable`                    | Check the root and local registry file. Seed a new registry only on initial setup.                                       |
| `permission-denied`                       | Check the current active binding and the exact workspace or app grant used by the command.                               |
| Wake guarded or unavailable               | Pull the recipient's `inbox` at a safe boundary. Use `inbox --peek` for unread metadata without changing delivery state. |
| Task review or merge cannot find its base | Fetch the configured remote and verify the target branch and exact candidate revision.                                   |

See the [command reference](commands.md) for syntax and the [documentation index](README.md)
for the remaining guides.

[release]: https://github.com/andornaut/coordination-kit/releases/tag/v7.12.0
