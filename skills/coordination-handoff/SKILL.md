---
name: coordination-handoff
description: Transfer authorized roles between harnesses in a shared Coordination Kit workspace. Record source readiness, verify exact target acceptance, and activate under a revision-checked selection.
---

# Coordination handoff

Use the pinned Coordination Kit CLI with the shared coordinator as `--root`. The operator needs
`handoff:manage` for the transition and `registry:manage` for harness selection, or the workspace's
supported legacy authority. Use the project's existing procedures for native session operations.
For resuming a role on its current harness, use coordination-recovery.

## Prepare and accept

1. Resolve the authorized roles and exact source and target bindings in the registry. Preserve
   the original selection for rollback. Open with `handoff open --scope ROLE --to TARGET`, repeating
   `--scope` for each selected role. Use `all` only if explicitly authorized. Recheck the exact
   handoff with `handoff show --id ID` before continuing or retrying.
2. Each source owner records a durable checkpoint with existing worktrees, WIP, pending questions,
   holds, relevant inbox IDs, and the next action, then runs `handoff ready --id ID`. READY sets its hold.
   The source stays idle. Once every selected role is READY, the operator records
   `handoff state prepared --id ID`.
3. Verify that each exact registered target session accepted its role and checkpoint and will
   stay idle until activation. Native presence and a delivered notice are separate from acceptance.
   Record the acceptance evidence and advance with `handoff state sent --id ID`.

## Select and activate

1. Recheck scope, bindings, and acceptance against the current registry. Select with
   `harness select --harness TARGET --expected-revision N --role ROLE`, repeating `--role` for the
   exact scope. On revision conflict, reread and requalify before retrying. Selection fences out
   the old source and admits the target. Activation still needs its own receipt.
2. Each target runs `session start` and verifies its role, harness, and bound conversation.
   Stop on a fence or phase refusal. Reconcile the checkpoint, open questions, holds, inbox,
   and outstanding work. Run `handoff active --id ID` to release only that role's handoff hold.
   Honour independent holds and resume only approved work.
3. Verify each target activation in `handoff show --id ID` before recording
   `handoff state completed --id ID`. Report READY, acceptance, selection, and activation
   separately, including any unavailable scope.

Before completion, `handoff state cancelled --id ID` releases the remaining handoff holds.
If selection changed, verify current scope and work and quiesce affected targets through the
project's procedure. Reconcile any work they performed, then restore the exact source routing
under authorization with a fresh registry revision before releasing holds. A completed
transfer needs a separately approved handoff to move ownership again.
