# Standalone projects

A Git repository can be its own Coordination Kit workspace. Install a pinned CLI, register
the maintainers and task owners who work there, and use the repository's existing remote and
checks. Each task has one owner and can use its own Git branch and worktree. A project only
needs its own Coordination Kit configuration, local state and native sessions.

Game Coordinator continues to coordinate separate games, kits and their role registries. Delivery
Kit continues to schedule departures and run delivery gates. Standalone projects use their own
task commands and can publish or deploy landed revisions through their existing automation.

## Install and initialize

Use the [verified release archive](getting-started.md#get-the-cli) and the
[standalone first run](getting-started.md#set-up-a-standalone-project). The archive also
works for Go, Ansible and other repositories without an npm dependency.

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
the Claude session ID. `--worktree PATH` names an existing linked worktree of the same
Git repository by its path relative to the primary checkout, for example
`--worktree ../implementation`. Run `session start` in each registered session. The first configured role is
the maintainer that records the user's explicit decisions. These commands assume the operator
trusts the people and processes with write access to the local coordination state. Normal Git
and forge permissions still apply.

Registration defaults to the sole configured project role. In a project with multiple roles,
pass `--role` explicitly. Registration syncs the lifecycle, status, handoff and recovery skills
for the selected harness.
Commit the skill files with their manifest. For an existing checkout, or after upgrading the
pinned CLI, follow [project skill sync](getting-started.md#sync-project-skills).

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

## Find an existing task

If you have a task name or description, run `task find` from the primary checkout. Add
`--owner ROLE` when you know the recorded owner.

```sh
ck --root "$(pwd -P)" task find "Validate input" --owner implementation
```

Use the returned task ID with `task show ID` to inspect its current owner, state and approval.
Resolve multiple matches to an exact ID before acting.
See [discovery results](commands.md#task-and-work-discovery).

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

In a project with one configured role, `task propose` defaults to that owner. Pass `--owner`
explicitly when the project has multiple roles.

From the task worktree, create the approved work file using the canonical task record and
commit it alongside the implementation. Fetch the default branch before preparing the review.
A dependency declared with repeatable `--depends-on TASK_ID` must already exist. An owner can
start a dependent task once those tasks have landed.

Maintainers can decline a proposal or cancel approved, unmerged work with an explicit decision.
A dependant waits until the maintainer records a replacement for the closed prerequisite
and the replacement lands. The task record keeps the original dependency and approval.

```sh
ck task close task-0002 --as cancelled --reason "Replaced by the new parser task" \
  --approval chat:cancel-decision
ck task replace-dependency task-0003 --dependency task-0002 --replacement task-0004 \
  --approval chat:replacement-decision
```

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

If the review policy changes before merge and the target stays the same, run `task ready`
again with the same head and `--refresh-policy`. The new packet includes a
`candidateRevision`. When review is required, record the fresh approval with
`task approve-review ID --head SHA --revision CANDIDATE_REVISION --approval REF`.

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
Verification uses the current check list after proving the merge against its original target.
For older candidates, the committed policy at the recorded base can supply that proof.
Use distinct check names if a workflow must run after a fast-forward to the default branch.
A pending, failed or unavailable check leaves the task in `merged`. At a safe boundary,
rerun verification or prepare a fix-forward candidate under the same review policy.

When the project uses its own CI or local checks, the owner runs the required checks and records
their exact-commit evidence with `task verify ID --evidence REF`. A task only reaches `landed`
after the target and required evidence are present. A GitHub or GitLab release, host rollout or
game departure remains a separate action under that project's policy.
