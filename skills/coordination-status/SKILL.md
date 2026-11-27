---
name: coordination-status
description: Answer ordinary-language progress, backlog, decision, and blocker questions for a standalone Coordination Kit project or shared workspace. Find the recorded work and report its owner, next action, and exact completion evidence.
---

# Coordination status

Use the workspace's pinned Coordination Kit CLI from the primary project or shared coordinator
checkout. Read local refs and coordination records without fetching, consuming inbox messages,
recording decisions, or writing back. State when remote freshness is unknown.

## Find the work

Use `task find "description"` for standalone tasks or `work find "description"` from the shared
coordinator. Prefer an exact ID when supplied. Use `--owner ROLE` and, for shared records,
`--scope` when the request identifies one. For a `match`, check the exact ID, type, repository,
and owner. If `ambiguous`, narrow the query or report the plausible matches. If `no-match`,
report the scope searched. An `unavailable` read leaves the result unknown.

- **Standalone project.** Use `task show ID` for the recorded stage, candidate, and dependencies.
  Use `task list` for the full backlog or as a lookup fallback on an older install.
  Read `question list --state pending` and `hold list --state active` for current decisions
  and holds. Follow `dependsOn` and any `dependencyReplacements` to find prerequisites that
  still need to land.
- **Shared workspace.** Run `status --format json`, scoped when requested, for the full inventory
  or as a lookup fallback on an older install. Use `work show ID` with the owning repository as
  `--root` and the coordinator as `COORDINATION_KIT_ROOT` for exact work detail. Read `items`,
  `pendingQuestions`, `activeHolds`, and `unmatchedRequests` together. Use the explicit
  `app:ID`, `kit:ID`, or `role:KEY` scopes if names collide. Check repository and store
  availability even when the work list is empty.

## Report the evidence

Lead with the work's owner, recorded stage, and next action, including the exact blocker or
question when known. Give each pending question's exact wording, options, owner, and thread
when available. Distinguish a proposal awaiting approval from a recorded pending question.
State when native prompt visibility is unknown.

Report READY, integration, exact-commit CI verification, and delivery as separate milestones.
In standalone mode, `ready` has a candidate, review approval covers that exact candidate,
`merged` awaits landing verification, and `landed` has `mergedSha` and `landingEvidence`.
In shared mode, report the `finished` disposition alongside the separate READY, merged,
and verified evidence. Report CI verified only when its evidence names the integrated commit.
Cite the deployment or release evidence when delivery applies. Mark assumed delivery as
assumed and unavailable evidence as unknown.

For a general backlog, include every outstanding in-scope record regardless of age, including
records with missing files. Group by repository or project and count each open unmatched
request once. Join linked requests to their work item and recent activity to items by repository
and ID. Summarize recent completions separately. In shared mode, `--since` filters recent and
closed activity while open work, questions, and holds stay in view. For a user-originated shared
audit, add `--audit` and cite exact evidence or replacement IDs when available.
