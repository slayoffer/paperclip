# Service guidance

## Interaction outbox budget stops

Check the current issue token budget before question delivery claims and resolution wake admission.
A stopped issue keeps pending intents without new wake receipts or question delivery attempts.
Budget acceptance retries both outboxes after commit. Keep acceptance replay protection in that path.
Known admission holds from the exact wake invocation preserve the answer without an error retry.
Use `wakeupForOutbox` for admission reasons without skipped receipts. The outbox is the durable retry record.
Persist a 30-second exponential delay, capped at 30 minutes, for known holds in both outboxes.
Check the deadline in direct delivery and sweep selection. A terminated assignee ends delivery with its reason.
Only unexplained null wakes consume the bounded error retry limit. Old skipped receipts are not current diagnostics.
Advance the pending-answer cursor past budget-held rows. Reuse budget checks only within the current page.
After a budget acceptance commits, clear pending retry deadlines, catch each row failure, and continue.
Catch each question sweep row failure so later answers can proceed.

## Restart recovery ownership

The orphan reaper owns process-loss recovery for legacy runs with a controller or checkpoint.
Do not terminalize these runs from the stale-lock sweeper because their provider stopped.
An expired lease permits a restart claim. It does not permit the sweeper to remove the task locks.
Check new ownership evidence in the terminal write as well as the initial read.
Measured 2026-10-26 (VLAT): sweeping first interrupted six checkpointed runs and prevented their restart claims.

## SSH ownership recovery

Agent-home and primary workspaces can have no `executionWorkspaceId`.
Older leases can also lack `sshInPlaceWriter` tracking.
Recover their lock path from the saved `in_place` realization with matching lease and provider identities.
A terminal run and released lease still require remote termination proof before lock removal.
Observed on 2026-10-26 (VLAT): a sweep that used only execution-workspace rows skipped these locks.

## SSH restart recovery

SSH restart recovery retains an active lease and its filesystem lock across shutdown.
Confirm remote termination before releasing that exact lease and lock for a new acquisition.
Otherwise in-place realization falls back to copy mode and changes the provider session identity.
Measured 2026-11-03 (VLAT): the loopback SSH Codex restart test failed with `restart_session_identity_changed`.
Consume budget admission once per restart claim, and clear the previous finalization deadline when claiming recovery.
