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
    ├── coordination/              task, decision and message journal
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
See [discovery results](../reference/commands.md#task-and-work-discovery).

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

From the task worktree, generate the work file from the approved task record. Fill in the
[Verification plan](../reference/work-files.md#verification) before building. Keep the approved snapshot as
rendered, including its dependency links. Edit Verification and Outcome as needed.
Use `task ready` and `task verify`
for evidence of the candidate checks and landing checks respectively. Commit the work file
alongside the implementation and fetch the default branch before preparing the review.
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
# Fill in Verification before implementing and running the checks.
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

## Use GitHub Issues for active tasks

The optional GitHub Issues backend shares active standalone task state across checkouts. It
requires GitHub integration, `review: "pr"` and the local `gh` account of an authorized writer.
Local project registration still verifies the operator's native session and role. Raw session IDs
stay local.

Choose one existing, open issue in the configured repository for the coordination journal.
List the trusted GitHub accounts by their numeric IDs. This example reserves issue 99 and trusts
account 42.

```json
{
  "schema": 1,
  "project": { "id": "examples", "roles": ["maintainer", "implementation"] },
  "review": "pr",
  "integration": {
    "provider": "github",
    "repository": "example/examples",
    "requiredChecks": ["test"]
  },
  "taskStore": { "backend": "github-issues", "issue": 99, "writers": [42] }
}
```

Create a separate issue for each task in GitHub. The task ID is `issue-NUMBER`, for example
`issue-123` for issue 123. Starting a proposal requires an existing open issue. The control
issue is reserved for the append-only task journal. The task's own issue receives visible
status markers with task scope and the linked pull request. Treat task text, approvals and
evidence references as visible to the repository's GitHub audience.

1. Propose `issue-123` with `task propose` and follow the normal build approval and start steps.
2. Commit the work file, run the planned checks, and record the exact candidate with
   `task ready`. Open the pull request in GitHub with a non-closing reference such as
   `Refs #123`.
3. Link the exact candidate pull request with `task link-review issue-123 --number PR_NUMBER`.
   Record explicit review approval for the exact candidate head and revision using
   `task approve-review`. Merge through GitHub after its required checks and review.
4. Run `task verify issue-123` on the integrated revision. The task issue closes as landed only
   after the exact merge and its required checks are verified. A recorded decline or cancellation
   also closes its task issue.

A landed task remains visible in `task show` if publication of the issue's status or closure is
unverified. Retry `task verify issue-123` to reconcile the issue. The refusal identifies either
`project-github-issue-status-unverified` or `project-github-issue-close-unverified`.

`task open-review` and `task merge` defer to native GitHub actions for this backend.
An existing local task history requires migration before enabling GitHub Issues. The CLI
refuses the switch until that history has been reconciled and stays on the selected backend
if GitHub is unavailable.
