# Standalone projects

A Git repository can be its own Coordination Kit workspace. Install a pinned CLI, register
the maintainers and task owners who work there, and use the repository's existing remote and
checks. Each task has one owner and can use its own Git branch and worktree. A project only
needs its own Coordination Kit configuration, local state and native sessions.

Game Coordinator continues to coordinate separate games, kits and their role registries. Delivery
Kit continues to schedule departures and run delivery gates. Standalone projects use their own
task commands and can publish or deploy landed revisions through their existing automation.

## Install and initialize

Download the pinned release archive, `SOURCE_COMMIT` and `SHA256SUMS` from the
[releases page][releases].
Verify the archive with `sha256sum -c SHA256SUMS`, then extract it outside the checkout
and use its `package/dist/cli.js`. Node 24.21.0 or later, Git and `flock` are required.
This installation works for Go, Ansible and other repositories without an npm dependency.

Run these commands from the repository's primary checkout. From a task worktree, add
`--root /absolute/path/to/primary-checkout` to every Coordination Kit invocation. In the
examples, `ck` means `node /absolute/path/to/package/dist/cli.js`.

```sh
ck init --project examples --role maintainer --role implementation --review chat
ck project register --role maintainer --harness codex \
  --native-id "$maintainer_thread" --native-project-id "$native_project"
ck project register --role implementation --harness codex \
  --native-id "$implementation_thread"
ck session start
```

Use the actual conversation IDs from the harness. For Claude, pass `--harness claude` and
the Claude session ID. A registration may name an existing linked worktree with
`--worktree PATH`. Run `session start` in each registered session. The first configured role is
the maintainer that records the user's explicit decisions. These commands assume the operator
trusts the people and processes with write access to the local coordination state. Normal Git
and forge permissions still apply.

To add an agent later, add its role to `project.roles` and use `project register` for its
verified session and worktree.

```text
repository/
├── .gitignore                     tracked, ignores local coordination state
├── coordination-kit.json           tracked, policy and role names
├── docs/work/task-0001.md           tracked with the task implementation
└── .coordination-kit/              ignored
    ├── registry.json              exact native session and worktree bindings
    ├── coordination.db            task, decision and message journal
    └── handoffs/                   optional local session checkpoints
```

Commit `coordination-kit.json` and the ignore rule through the normal repository process.
Keep the runtime directory across agent sessions. Use the same primary checkout and state
for all its task worktrees.

## Approve and build

The maintainer records the user's approval to build. A reviewer can ask for revisions by
messaging the task owner. An owner starts approved work and retains responsibility through
integration and successful checks on the landed commit.

```sh
ck task propose task-0001 --owner implementation --title "Validate input" \
  --scope "Reject blank names and preserve valid existing input."
ck task approve task-0001 --approval chat:build-decision
ck task start task-0001
```

From the task worktree, create the approved work file using the canonical task record and
commit it alongside the implementation. Fetch the default branch before preparing the review.
A dependency declared with repeatable `--depends-on TASK_ID` must already exist. An owner can
start a dependent task once those tasks have landed.

```sh
mkdir -p docs/work
ck --root "$primary" task work-file task-0001 > docs/work/task-0001.md
git add docs/work/task-0001.md
# Stage the implementation and commit it with the work file.
git fetch origin
ck --root "$primary" task ready task-0001 --branch task/validate-input \
  --head "$(git rev-parse HEAD)" --summary "Rejects blank names." --evidence checks:focused
```

`task ready` records the exact head, approved base, review policy, summary, check evidence
and changed paths. Pass `--base SHA` when the approved base differs from the current
remote-tracking branch. `task show` and `task list` read the current records. Review evidence should
use shareable references. For PR or MR mode, the summary, task ID, revision and evidence reference
are included in the review description.

## Review and merge

Set one of these policies in `coordination-kit.json`.

| Policy | Owner action                                                                                                                                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`  | Run `task merge` after project checks. Git accepts only a normal fast-forward update to the configured target.                                                                                                                      |
| `chat` | Present the ready packet to the user. The maintainer records `task approve-review ID --head SHA --approval REF` after explicit approval. The owner then runs `task merge`.                                                          |
| `pr`   | Push the candidate branch and run `task open-review ID`. A human can merge in the forge. For an agent-initiated merge, the maintainer records `task approve-review ID --head SHA --approval REF`, then the owner runs `task merge`. |

A correction that changes the head needs a new ready packet and any required approval. An
existing PR or MR for that exact branch and head can be linked with `task link-review ID --number N`.
After an ambiguous external action, check the forge or target branch before submitting again.
The provider's authentication, required checks and branch protection apply to all merges.

For GitHub or GitLab use a configuration such as the following. GitHub uses the locally
authenticated `gh` CLI. GitLab uses `glab`. Optionally configure `hostname` for a self-managed
GitLab instance. `defaultBranch` and `remote` default to `main` and `origin`.
Set GitHub's optional `mergeMethod` to `merge`, `squash` or `rebase` when the project
uses a specific method.

```json
{
  "schema": 1,
  "project": { "id": "examples", "roles": ["maintainer", "implementation"] },
  "review": "pr",
  "defaultBranch": "main",
  "remote": "origin",
  "integration": {
    "provider": "github",
    "repository": "example/examples",
    "requiredChecks": ["test"]
  }
}
```

## Follow the merge to landing

Run `task verify ID` as the owner after merge, whether the merge was submitted by the agent or
performed in the forge. The command refreshes the target and checks the actual integrated SHA.
For a squash merge, it uses the provider's exact head and merge evidence plus the Git target.
When required forge checks are configured, it reads their results for the **merged SHA**.
Use distinct check names if a workflow must run after a fast-forward to the default branch.
A pending, failed or unavailable check leaves the task in `merged`. At a safe boundary,
rerun verification or prepare a fix-forward candidate under the same review policy.

When the project uses its own CI or local checks, the owner runs the required checks and records
their exact-commit evidence with `task verify ID --evidence REF`. A task only reaches `landed`
after the target and required evidence are present. A GitHub or GitLab release, host rollout or
game departure remains a separate action under that project's policy.

[releases]: https://github.com/andornaut/coordination-kit/releases
