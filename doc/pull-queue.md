# Guarded pull queue

Set `PAPERCLIP_PULL_QUEUE_ENABLED=true` to enable the pull queue. The default is off.
The heartbeat scheduler must also be enabled. Keep the existing promotion watchdog active during qualification.

The queue selects assigned tasks after a run ends or an issue activity event occurs.
Status changes, assignment changes, dependency changes, and interaction answers produce these events.
The regular scheduler tick reconciles missed events and startup state.

A ready task has `todo` or `backlog` status, resolved dependencies, and no pending interaction or scheduled monitor.
Dependencies resolve when their tasks reach `done` or `cancelled`.
A completed dependency with a workspace still requires successful workspace finalization.
The queue orders tasks by priority, creation time, and identifier.
It excludes conversation tasks, inactive companies, and paused agents.

The queue submits one task for each idle owner through normal heartbeat admission.
An existing run or queued wake prevents another selection for that owner.
A database advisory lock prevents duplicate selection across server processes.
The admission path retains its run limits, budget checks, execution holds, and governance checks.
Selection does not approve a card or a review.

Selection checks the current issue token budget before requesting a wake.
An exhausted issue keeps one budget card and does not create repeated skipped wakes.
Selection continues to the next candidate after a skipped admission.
A null admission result with queued or deferred work still reserves the owner.

A skipped pull records a condition fingerprint in its existing wake receipt.
The queue skips that issue while its admission conditions remain unchanged.
Task execution settings, owner configuration, project policy, instance settings, cards, and approvals contribute to this fingerprint.
Budget stops and subtree pauses use current gate state rather than the old receipt.
Timed skips become eligible at their recorded deadline. Daily caps reset at the normal day boundary.

An explicit backlog update records a parking receipt in the same transaction.
The issue stays parked until its saved unblock action, monitor condition, or execution policy changes.
An explicit move to `todo` or a new assignee also permits selection.
Title edits, comments, and scheduler reconciliation do not resume the same parked issue.
Existing backlog tasks with a recorded backlog disposition after an owner attempt receive one parking receipt on first selection.
A prior attempt alone does not park a backlog task.
Parking receipts include the monotonic status version. An ownership cycle cannot restore an earlier parking decision.
An explicit backlog reassertion advances that version under the issue row lock. Admission rejects an earlier selection.
These receipts affect automatic pull selection. Explicit wakes still pass through normal admission.

With this switch enabled, both assignment admission and queue selection count real work:

- Every `todo` task counts.
- An `in_progress` task counts when it has a live run or queued wake.
- A `blocked` task counts when it has no scheduled monitor.
- Conversation tasks and other statuses do not count.

Live runs include queued runs and scheduled retries.
Queued wakes include wakes deferred for issue execution.
The queue uses `PAPERCLIP_AGENT_WIP_LIMIT` when configured. Otherwise, it uses three work slots.
An existing `todo` task can run at that limit. A `backlog` task requires a free work slot.
Existing assignment exemptions remain in place.

Reconciliation returns an abandoned `in_progress` task to `todo` after 30 minutes.
The task must have no run, queued wake, scheduled monitor, or pending interaction.
Recent run completion or wake activity restarts that interval.
The update clears stale execution locks and adds a system comment and activity record.

A status change that would discard a scheduled monitor returns HTTP `409`.
The error code is `scheduled_monitor_status_conflict`.
Remove the monitor explicitly before such a status change.
With the switch off, the prior counting and monitor behavior remains active.
The release branch resolves cancelled blockers independently of this switch.

## Verification and qualification

Run the focused regression suite:

```sh
pnpm exec vitest run server/src/__tests__/heartbeat-pull-queue.test.ts --maxWorkers=1
pnpm exec vitest run server/src/__tests__/heartbeat-pull-queue-gap.test.ts --maxWorkers=1
```

The suites cover selection order, completed dependencies, pending cards, work counts, duplicate selection, ghost release, and monitor protection.
They also cover skipped heads, budget grants, durable parking, transaction rollback, owner changes, and timed retry eligibility.
It uses a temporary PostgreSQL database. It does not prove deployment latency.

After deployment, record a terminal run time and the next ready task's run start time for the same owner.
The acceptance threshold is ten minutes or less.
Keep the old promotion watchdog active until the deployment owner confirms the new path.
Disable the switch to restore prior behavior. Do not change run caps or token budgets during qualification.
