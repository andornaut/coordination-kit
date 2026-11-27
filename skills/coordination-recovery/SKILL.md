---
name: coordination-recovery
description: Recover an existing Coordination Kit role on its registered harness and exact native session. Verify session-start proof and preserve WIP, holds, and pending questions.
---

# Coordination recovery

Use the pinned Coordination Kit CLI with the standalone primary checkout or shared coordinator
as `--root`. Resolve the authorized role, effective harness, exact bound conversation, worktree,
and current phase from the registry.

1. Verify the exact native session and its checkout through the project's existing session
   procedure. Reuse it if already live. If no frontend is live, resume the exact conversation
   after verifying it is resumable.
   Preserve the recorded worktree, branch, and WIP. A conflicting or unverifiable session is a
   blocker. A new or replacement ID needs separate authority. Use the handoff workflow for a
   harness change.
2. The recovered role runs `session start` from the verified session. Check its role, harness,
   conversation, registry phase, and checkpoint against the requested binding. A fence or held
   phase refusal needs resolution from the authorized owner. Keep the existing holds in place.
3. Read the checkpoint and reconcile existing work, inbox originals, and pending prompts.
   Preserve a visible native question. If its visibility is unknown, report that separately.
   If a recorded pending question needs to be presented again, its owner presents the exact
   wording and options and waits for the user's explicit answer. Preserve independent holds
   and continue approved work only when its own gates allow it.

Report each exact role recovered, already live, or blocked. Cite session-start proof and name
unverified state. Other services and scheduled coverage need their own evidence.
