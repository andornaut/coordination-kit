---
name: coordination-status
description: Report progress, backlog, decisions, blockers, and completion evidence for a standalone Coordination Kit project or a shared coordination workspace. Use for status questions or audits of recorded work and requests.
---

# Coordination status

Use the workspace's pinned Coordination Kit CLI with `--root` pointed at the primary project
checkout or shared coordinator checkout. The steps below only read records. Leave inbox delivery,
questions, holds, work records, and Git refs untouched.

## Read the recorded state

- **Standalone project.** Run `task list` and use `task show ID` for specific tasks or dependency
  evidence. Run `question list --state pending` and `hold list --state active` for current decisions
  and holds. Follow `dependsOn` and any `dependencyReplacements` to identify prerequisites that
  still need to land. A proposed task awaits build approval. A ready task has a candidate, an
  approved review refers to an exact revision, and a merged task still awaits landing verification.
  Use `mergedSha` and `landingEvidence` when the task has landed.
- **Shared workspace.** Run `status --format json` and apply the requested scope. For a name
  collision, pass `app:ID`, `kit:ID`, or `role:KEY` to `--scope`. Read `items`, `pendingQuestions`,
  `activeHolds`, and `unmatchedRequests` together. Join `recentActivity` and `recentCompletions` to `items` by
  repository and ID. For a user-originated work audit, add `--audit`. `--since` filters recent and
  closed activity while open work, pending questions, and holds stay in view. Check repository and
  store availability even when the returned work list is empty.

## Report what remains

Lead with decisions and blockers that require action. Give each recorded question's owner, exact
wording, options, and thread when available. Distinguish a proposal awaiting approval from a recorded
pending question. State when native prompt visibility is unknown.

For a general backlog, include every outstanding in-scope record regardless of age. Group by
repository or project and give each item a short line with its recorded state and the next action,
owner, or blocker when supported. Include work with missing files. Count each open unmatched request
once, even if it also appears in `items`. Join linked requests to their work item.

Summarize recent activity and completions separately. For an audit, include exact IDs and evidence
references for landing, verification, release, or replacement when present. Treat each as a separate
milestone. Report assumed delivery as assumed and missing or unavailable evidence as unknown.
