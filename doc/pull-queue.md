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
With the switch off, the prior counting, dependency, and monitor behavior remains active.

## Verification and qualification

Run the focused regression suite:

```sh
pnpm exec vitest run server/src/__tests__/heartbeat-pull-queue.test.ts --maxWorkers=1
```

The suite covers selection order, completed dependencies, pending cards, work counts, duplicate selection, ghost release, and monitor protection.
It uses a temporary PostgreSQL database. It does not prove deployment latency.

After deployment, record a terminal run time and the next ready task's run start time for the same owner.
The acceptance threshold is ten minutes or less.
Keep the old promotion watchdog active until the deployment owner confirms the new path.
Disable the switch to restore prior behavior. Do not change run caps or token budgets during qualification.
