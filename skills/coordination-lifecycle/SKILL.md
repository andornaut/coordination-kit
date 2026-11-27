---
name: coordination-lifecycle
description: Start or resume implementation from an ordinary-language request in a Coordination Kit project or shared workspace. Resolve the recorded work and owner, then follow approved work through review, integration, exact-commit checks, and any applicable delivery.
---

# Coordination lifecycle

Use the project's pinned Coordination Kit CLI. Run standalone commands from the primary checkout
or pass its path with `--root`. In a shared workspace use its coordinator and repository roots.
The installed package's `docs/standalone.md` and `docs/store.md` cover the two workflows.

## Resolve the work

Search the user's description or supplied exact ID with `task find "description"` for standalone
tasks or `work find "description"` from the shared coordinator. Narrow by `--owner ROLE` and, for
shared records, `--scope` when the request identifies one. On older installs use
`task list` and `task show ID`, or scoped `status --format json` and `work show ID` in the owning
repository. Read applicable pending questions and holds before starting or resuming.

For a `match`, confirm the exact ID, record type, repository, owner, approved scope, and current
stage. If `ambiguous`, narrow by existing scope and owner evidence. Ask the user when the
remaining candidates would change the work or when required approval is missing. An
`unavailable` read leaves the record unknown. On a confirmed `no-match`, record a proposal if
the request calls for new work.

On resume, inspect and reuse the branch and worktree already associated with the task. Preserve
uncommitted changes and unpushed commits. Check the project's authorized push owner and procedure
before publishing a candidate or integrated commit. When another owner pushes, hand off the exact
revision and keep following it through verification.

## Standalone project

Read `coordination-kit.json` for project roles and review policy.

1. The maintainer records the user's actual build approval with `task approve`. The assigned
   owner runs `task start ID` after prerequisites land. Resume from the recorded stage.
2. Work on the approved scope in the task branch. Use `task work-file ID` to prepare
   `docs/work/ID.md` and commit it with the implementation. Run the repository's checks and
   record the candidate branch, exact head, summary, and evidence with `task ready`.
3. Follow the candidate's review policy. Under `off`, use `task merge` after the project checks.
   Under `chat`, present the candidate's review packet and have the maintainer record explicit
   approval for that candidate with `task approve-review` before merging. Under `pr`, publish
   the candidate and run `task open-review` when authorized. The user can merge in the forge.
   An authorized agent merge requires approval recorded by the maintainer for that exact
   candidate. Recheck the candidate if the head or policy changes.
4. Follow the integrated commit through the repository's current landing checks. Record evidence
   for that commit with `task verify`, then confirm `task show ID` reports `landed` and the verified
   SHA. Keep responsibility while required CI or applicable delivery remains open.

## Shared workspace

Use the owning repository's work file, registry role, and store record. Run its work verbs with the
repository as `--root` and the coordinator as `COORDINATION_KIT_ROOT`. Follow the existing
`work start`, evidence, READY handoff, integration, and `work finish` flow. Use the project's
review and delivery paths with their assigned owners. Track the exact integrated commit through
its required CI and applicable delivery. Record actual evidence at each stage and follow up
with the responsible owner when a gate is pending or fails.
