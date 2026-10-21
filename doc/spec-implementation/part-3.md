# Implementation specification: part 3

## 7.16 Current Implementation Addenda

The current implementation includes additional V1-control-plane tables beyond the original February snapshot:

- Issue structure and review: `issue_relations` for blockers, `labels`/`issue_labels`, `issue_thread_interactions`, `issue_approvals`, `issue_execution_decisions`, `issue_work_products`, `issue_inbox_archives`, `issue_read_states`, and issue reference mention indexes.
- Execution and workspace control: `execution_workspaces`, `project_workspaces`, `workspace_runtime_services`, `workspace_operations`, `environments`, `environment_leases`, `agent_task_sessions`, `agent_runtime_state`, `agent_wakeup_requests`, heartbeat events, and watchdog decision tables.
- Plugins and routines: `plugins`, plugin config/state/entities/jobs/logs/webhooks, plugin database namespaces/migrations, plugin company settings, `routines`, `routine_revisions`, `routine_triggers`, and `routine_runs`.
- Access and operations: company memberships, instance roles, principal permission grants, invites, join requests, board API keys, CLI auth challenges, budget policies/incidents, feedback exports/votes, company skills, sidebar preferences, and company logos.

Decision-desk triage uses company-scoped sidecars rather than adding queue fields to every attention source:

- `decision_queues` stores durable named queues, optional retention overrides, server-derived creator/run provenance, and data-backed seed rules.
- `decision_queue_items` keys membership by `(queue_id, source_kind, source_id)` and repeats `company_id` for company-consistent joins.
- `decision_triage` keys current decide-by/snooze state by `(company_id, source_kind, source_id)` and preserves the latest setter attribution.
- `decision_triage_events` is the immutable mutation history for queue membership and triage overrides, including actor, run, API-key, and responsible-user provenance.
- `decision_retention` stores the attention source's last observed activity timestamp, monotonic version, Keep flag, and reversible archive provenance. Queue `retention_days` overrides use the shortest assigned queue threshold; otherwise the shelf threshold is 30 days.
- `decision_archive_notification_outbox` records one retry-safe origin-agent notification per source/archive version. The 90-day internal sweeper archives only unkept rows and coalesces delivery per origin agent.
- Queue membership never grants source visibility. Item writes re-authorize the referenced source, and queue reads re-authorize every member before returning rows or counts.

## 8. State Machines

## 8.1 Agent Status

Allowed transitions:

- `idle -> running`
- `running -> idle`
- `running -> error`
- `error -> idle`
- `idle -> paused`
- `running -> paused` (requires cancel flow)
- `paused -> idle`
- `* -> terminated` (board only, irreversible)

## 8.2 Issue Status

Allowed transitions:

- `backlog -> todo | cancelled`
- `todo -> in_progress | blocked | cancelled`
- `in_progress -> in_review | blocked | done | cancelled`
- `in_review -> in_progress | done | cancelled`
- `blocked -> todo | in_progress | cancelled`
- terminal: `done`, `cancelled`

Side effects:

- entering `in_progress` sets `started_at` if null
- entering `done` sets `completed_at`
- entering `cancelled` sets `cancelled_at`

V1 non-terminal liveness rule:

- agent-owned `todo`, `in_progress`, `in_review`, and `blocked` issues must have a live execution path, an explicit waiting path, or an explicit recovery path
- `in_review` is healthy only when a typed execution participant, pending issue-thread interaction or approval, user owner, active run, queued wake, or explicit recovery action owns the next action
- a blocked chain is covered only when each unresolved leaf issue is live or explicitly waiting
- external waits are durable only when persisted as a bounded monitor/scheduled wake, a first-class blocker with a named owner and action, or healthy delegated child work connected by a blocker edge when the source must wait; parent/child structure alone is not a wait path
- unmanaged shell jobs, detached sessions, adapter child processes, local polling loops, PIDs, logs, and comments are evidence rather than liveness; a managed runtime service counts only when paired with a persisted monitor, wake, blocker, or delegated issue that owns the next check
- heartbeat finalization evaluates liveness from persisted Paperclip state; an issue cannot remain healthy `in_progress` solely because the exiting heartbeat started a local/background watcher
- a continuation cancelled as `issue_continuation_waiting_on_review` first converts a current typed wait target into a first-class wait; without a current target it is classified as `deliberate_wait_without_target` and gives the invokable original owner five normal-model disposition-repair attempts (immediate, then after 60, 120, 240, and 480 seconds, with up to 10 percent jitter)
- disposition repair revalidates blockers, children, interactions, approvals, monitors, execution stages, queued wakes, active runs, work products, owner invokability, budgets, and governance before every attempt; the attempt bound is keyed by durable source state, so comments or equivalent parked prose do not reset it while durable source-state changes may establish a new fingerprint
- exhausted disposition repair appears in both task threads as “Agent needs attention,” with recorded attempt details and an explicit retry action; display uses structured recovery evidence, and the server rechecks the exact action, current task state, original owner, pause/approval/dependency/budget gates before restoring the task to todo
- backwards-compatible upgrades count consecutive historical `issue_continuation_waiting_on_review` cancellations for the unchanged accepted-interaction source state against the same five-attempt disposition-repair ceiling; missing pre-upgrade recovery-action rows do not reset the budget
- the source fingerprint, source-attempt count, next due time, source owner, and return owner persist in the recovery action; startup and periodic reconciliation resume that exact lineage without duplicate wakes, fold it when a current typed wait appears, and reschedule or escalate an expired action that has no live scheduled run
- source-attempt exhaustion opens one board-owned source-scoped recovery action without changing the source assignee and without waking a substitute agent; the board explicitly chooses whether to repair, retry the original owner, reassign, or resolve
- an active recovery action counts as a live source or blocker-chain path only while its owner has a live run, queued wake, scheduled retry, typed wait, or explicit board escalation; source and blocker projections consume the same nested recovery-path result
- when Paperclip cannot safely infer the next action, it surfaces the problem through visible blocked/recovery work instead of silently completing or reassigning work
- explicit recovery actions are the liveness primitive; source-scoped actions are the default form, issue-backed recovery is a fallback for independent repair work or safety boundaries, and comments alone are evidence rather than a healthy liveness path
- recovery-action ownership is separate from source-task ownership: automatic repair and board escalation preserve both source assignee fields; reassignment requires an explicit board decision or a policy-defined serious failure
- source-scoped recovery routing is cause-keyed: bounded continuity and disposition repair may retry only the original agent; provider-quota failures create/reuse a scheduled wait-recovery monitor; every other exhausted or unsafe path creates/reuses a board-owned recovery action with `routingPolicy: board_escalation_no_takeover_v1` and no substitute-agent wake
- legacy active agent-owned recovery actions remain readable, resolvable, and API-compatible after upgrade, but reconciliation does not enqueue another takeover wake for them
- active-run output silence is an informational board UI signal at five minutes (`suspicious`) and fifteen minutes (`critical`); it does not create or update issues or recovery actions, comment on or block source work, change assignments, or wake an agent
- board snooze and continue decisions suppress the run signal until their stored re-arm time; a false-positive decision suppresses it permanently for that run; open legacy evaluation issues remain readable and manually resolvable without automatic refresh

Detailed ownership, execution, blocker, active-run watchdog, crash-recovery, and non-terminal liveness semantics are documented in `doc/execution-semantics.md`.

For native ordinary tasks, answering a Board comment does not authorize an
indefinite response wait when the structured result reports blocking remaining
work. Without a recorded wait condition, reject the finish report or use the
bounded incomplete-work recovery path. Preserve real governance and pause gates,
conversation lifecycles, and protection against replaying superseded requests.

## 8.3 Approval Status

- `pending -> approved | rejected | cancelled`
- terminal after decision

## 9. Auth and Permissions

## 9.1 Board Auth

- Session-based auth for human operator
- Board has full read/write across all companies in deployment
- Every board mutation writes to `activity_log`

## 9.2 Agent Auth

- Bearer API key mapped to one agent and company
- Agent key scope:
  - read org/task/company context for own company
  - read company-visible tasks and comments
  - comment on and update visible tasks under the shared write rule
  - create child tasks and assign visible work for delegation under the same rule
  - report heartbeat status
  - report cost events
- Agent cannot:
  - bypass approval gates
  - modify company-wide budgets directly
  - mutate auth/keys
