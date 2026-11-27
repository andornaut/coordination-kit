---
name: agent-cleanup
description: Run an authorized cleanup of agent-owned worktrees, branches, containers, sessions, jobs, scratch, and coordination messages. Verify release or orphan evidence before removing exact local resources and report what was retained.
---

# Agent cleanup

Resolve the authorized workspace, owners, and resource scope from its registry or team roster.
Use the existing coordination channel. Send one scoped request per owner, link the exact work
or request IDs, and let each owner check their workers and shared dependencies. Track delivery
separately from the owner's confirmation. Audit your own resources at the same boundary.

## Qualify each resource

Inventory exact paths, refs and commit SHAs, container or job IDs, and session identifiers.
Resolve provenance and current consumers before any stop or removal.

- **Attributable work.** Confirm the owner and work ID, integration at the exact commit, and that
  the published ref contains that commit when publication applies. Verify durable evidence,
  including applicable review and delivery, and confirm actual owner release and absence of
  consumers. Preserve dirty, unmerged, or unpublished source work and any resource with a live
  dependency. Route work that still needs to land to its owner through the existing workflow.
- **Confirmed orphan.** Check the registry and work records, branch and worktree provenance,
  archived and pending handoffs, jobs and processes, and container mounts or other consumers.
  Remove an exact local resource only when those checks establish that no work can be
  attributed to it and no active dependency exists. A failed lookup, resource age, or an empty
  queue gives no clearance. Retain unresolved resources and name the owner or next check.

Preserve WIP, live roles and session transports, runners, pending questions, holds, existing
backups, actual distribution artifacts, and durable evidence. Confirm the creating job has ended
for attributable scratch. Resolve exact scratch paths without following symlinks outside them.
Remote cleanup requires explicit authorization and the same evidence and release checks for
each exact remote ref.

## Preserve evidence and reconcile messages

Use published Git, existing backups, and small receipts or essential review evidence. Keep the
identifiers and references needed to reproduce the decision.

Retain an individual Git bundle only for a verified reason, such as unique recovery, an active
dependency, or required evidence. Record its exact owner, reason, and expiry under the
workspace's existing retention policy. An unmerged commit or its absence from the integration
branch alone gives no basis for retention. Remove the other Git bundles in authorized scope
without creating replacement archives.

Create a recovery copy only for a concrete exception under the same retention policy, with its
exact owner, reason, and expiry recorded. Use small evidence references for routine cleanup
without creating bundles, tarballs, backups, or cache copies.

Use the supported lifecycle to reconcile messages. Close only the exact original, unchanged
since collection, with evidence of handling or supersession. Retain unresolved originals with
an owner, reason, and next boundary. Verify ambiguous delivery before retrying.

Report once per owner what was integrated, stopped, removed, or reconciled and what remains.
Include exact identifiers and proof references for completed actions. Mark any unavailable
scope or missing owner confirmation as pending.
