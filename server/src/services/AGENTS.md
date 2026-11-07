# Service rules

## Issue WIP admission

Creation and limited updates share the company `issue-privacy-tree` lock. Take it
before issue row locks, count through the transaction, and choose backlog fallback
before `issueService.update` derives status fields. Bind the service to that
transaction and pass both post-commit queues; pooled reads or early effect flushes
inside the outer transaction can deadlock or expose a rolled-back change.
Privacy changes combined with review-policy validation need that same lock order.
Validate blocked-state requirements before cancellation. Retain an early WIP
backlog fallback so a later capacity change cannot restore an unvalidated status;
then recheck admission under the transaction lock. If that pass changes a validated
blocked request to backlog, set its descriptor to null in both update patches.
Do not repeat route blocked validation after cancellation; retain service integrity checks.

## Issue token budget authority

Automatic retries and provider dispatch must check the current canonical issue
budget. A board override belongs to its server-written wake receipt and the run
bound to that receipt; caller payload/context flags and automatic successors do
not grant authority. Check outside held transactions so card creation can use its
own transaction. See `doc/issue-token-budget.md`.
Existing-runner reattachment must reach ownership reconciliation above the budget;
dead-runner resume and new provider starts remain gated. Deferred override wakes
must retain the authenticated actor when they merge or promote.
Pre-provider budget stops need durable bootstrap evidence so deferred board work
can promote and unused reservations can settle. Never infer that evidence from
an absent dispatch in a recovered attempt with earlier provider work.

Deferred-wake promotion holds a transaction while resolving session, routine,
and responsible-user context. Forward its client through every host callback;
the root client waits forever when the ordinary pool has one connection.

## Process supervision fixtures

Wait for a completed successful health probe before stopping its fixture process.
Counting probe dispatches does not prove that the identity check finished. Killing
the process between `kill -0` and its command-line read can correctly fail identity
validation. Keep production identity checks unchanged.

## Physical checkout ownership

Automatic close removes a physical checkout, not only an execution-workspace row.
Resolve path aliases before checking owners, runs, and primary-project paths.
Protect resources at or inside the directory that cleanup removes. Check saved
context and native run bindings after issue pointers move. Archived workspace IDs
remain valid references for live-run checks, but do not block cleanup by themselves.
Apply close readiness to every matching workspace row. Keep denial text generic
when another company's row prevents cleanup. A terminal source issue does not
prove that its runtime service or provider run stopped.
Hold automatic close when multiple non-archived rows own the checkout. The close
workflow must retain control of both the archive and artifact lifecycle.
Check provider process and controller ownership after terminal run statuses too.
Read saved legacy working directories as well as workspace IDs. Inspect persisted
runtime rows even when configuration no longer displays them. For local native
providers, read the environment driver from `contextSnapshot.paperclipEnvironment`.
Use saved process start times and the restart recovery identity check;
remote PIDs and expired coordinator leases do not prove local ownership.
Use the lifecycle transaction client for guard queries and destruction callbacks.
A query through the root client waits forever when the transaction holds the only
pool connection.
Compare persisted restore-point mode entries by path and mode, with the same array
length and order. PostgreSQL `jsonb` can change object key order; serialized object
text is not a stable equality check for a saved manifest.
An issue update inside a transaction must pass its post-commit actions to the caller's
commit-effects queue. Never run physical cleanup before the outer commit.

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

SSH restart recovery retains an active lease and its filesystem lock across shutdown.
Confirm remote termination before releasing that exact lease and lock for a new acquisition.
Otherwise in-place realization falls back to copy mode and changes the provider session identity.
Measured 2026-11-03 (VLAT): the loopback SSH Codex restart test failed with `restart_session_identity_changed`.
Consume budget admission once per restart claim, and clear the previous finalization deadline when claiming recovery.

## Pull queue stops

Hold the owner selection lock on a dedicated database connection through wake admission.
Suppression and normal heartbeat admission use the ordinary pool; holding its only
connection during those callbacks deadlocks selection. Keep candidate reads on the
selection transaction and let `withDedicatedDbConnection` close its connection.

Record an explicit backlog disposition with its parking receipt in the issue transaction.
Keep parking conditions separate from general issue recency. Comments and title edits do not resume a parked issue.
Skip receipts restrict automatic selection only. Normal admission always checks current authority.
Recheck budget, dependency, pause, and recovery gates before reusing an old skip.

## Owner parking

Resolve explicit resume context before issue admission checks. A request that
contains only `resumeFromRunId` still needs the saved issue's parking and budget gates.
Use the canonical native/first-class/snapshot binding. Reject caller issue, task,
or session-key fields that conflict with the saved binding before issue policy checks.

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
