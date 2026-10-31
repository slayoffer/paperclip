# Service rules

## Cap recovery sessions

Terminal success can precede task-session persistence.
A cap wake must use `payload.resumeFromRunId` and require the source run's saved `sessionIdAfter`.
The ordinary resume path checks the source's company and agent before it restores that session.
Test restart recovery with real wake admission and an absent or stale task checkpoint.

## Deferred dependency wakes

Durable wake payloads describe the blocker set at release time.
The saved blocker set can differ from the current blocker set during a retry.
Check current blocker membership before reusing a saved resolved-blocker ID.
Use current dependency readiness and its blocked-cycle key for dispatch and duplicate checks.

## SSH ownership recovery

Agent-home and primary workspaces can have no `executionWorkspaceId`.
Older leases can also lack `sshInPlaceWriter` tracking.
Recover their lock path from the saved `in_place` realization with matching lease and provider identities.
A terminal run and released lease still require remote termination proof before lock removal.
Observed on 2026-10-26 (VLAT): a sweep that used only execution-workspace rows skipped these locks.

## Restart recovery ownership

The orphan reaper owns process-loss recovery for legacy runs with a controller or checkpoint.
Do not terminalize these runs from the stale-lock sweeper because their provider stopped.
An expired lease permits a restart claim. It does not permit the sweeper to remove the task locks.
Check new ownership evidence in the terminal write as well as the initial read.
Measured 2026-10-26 (VLAT): sweeping first interrupted six checkpointed runs and prevented their restart claims.

## Pull queue stops

Record an explicit backlog disposition with its parking receipt in the issue transaction.
Keep parking conditions separate from general issue recency. Comments and title edits do not resume a parked issue.
Skip receipts restrict automatic selection only. Normal admission always checks current authority.
Recheck budget, dependency, pause, and recovery gates before reusing an old skip.

## Owner parking

`owner:stopped` and `owner:local-session` are execution stops, not descriptive labels.
Read current company-scoped labels at wake admission, retry promotion, and queued dispatch.
Check before recovery actions and pull selection. Record `issue.owner_parked` when skipping.
A status or assignee change cannot override these labels. Remove both labels to resume agent execution.

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
