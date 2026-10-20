# Company flow report

`GET /api/companies/:companyId/flow` returns one company snapshot for the board.
The route requires board access and membership in the requested company.
Agent keys cannot use this route. It has no write operation.

The response contains these fields:

| Field | Meaning |
| --- | --- |
| `companyId`, `collectedAt` | Company and snapshot time in UTC. |
| `readyQueues` | Separate `todo` and `backlog` groups for each owner. |
| `chainRoots` | Open issues that block other open issues, with unique transitive dependent counts. |
| `agents` | Active agents, their assignment count, configured limit, and limit state. |
| `ghosts.inProgressWithoutRun` | Open work with no current queued or running run for its assigned agent. |
| `ghosts.blockedWithClosedLinks` | Blocked work with at least one blocker link, all done with workspace finalization complete. |
| `ghosts.reviewHoldsWithoutRound` | Open review holds without an open review round for the same parent or issue identifier. |
| `unassigned` | Open work without an agent or user owner, except review holds. |
| `counts` | Counts for the complete report. |
| `scorecard` | Counts and owner groups with the weekly scorecard title exclusions. |

Ready issues have no open blocker link and no pending decision.
Only `done` blockers resolve a dependency. Cancelled blockers remain unresolved until an operator removes or replaces the link.
A done blocker remains unresolved while its workspace finalization is pending or unsuccessful.
The report uses the same finalization barrier as issue checkout, inside the same snapshot.
Workspaces without recorded operations need no finalization.
The barrier tracks each blocker's operations. A later successful finalization can release blockers that share the workspace.
Pending decisions include pending thread interactions and linked approvals that need a decision or revision.
An owner at the assignment limit can still have ready backlog work.
Readiness describes the issue dependencies. The agent fields describe owner capacity.
Queues sort by priority, then age, then issue ID.
`ageMs` measures time since creation. `unchangedForMs` measures time since the last issue update.
Both fields use milliseconds and cannot be negative.

The report excludes hidden issues, conversation harnesses, and idle Slack issues from execution queues and diagnostics.
Dependency counts include each open visible dependent once. Cycles cannot count the root itself.
Closed issues end dependency paths.
The report ignores relations whose endpoints are outside the company.

Chain roots include owner details and these possible reasons:
`pending_decision`, `open_blocker`, `owner_at_wip_limit`, `owner_error`, `owner_paused`,
`review_hold_without_round`, `in_progress_without_run`, and `unassigned`.
An empty reason list means that none of these conditions applies.
Review round detection uses the existing `Review r<N>:` and `Review hold:` title conventions.

A run must belong to the same company and agent. It must be queued or running, without a finish time.
The route uses the native issue link, then the stored issue or task context.
A run pointer can also link the issue when its run has no issue context.
Stale pointers and pointers to another issue cannot hide ghosts.

## Work counts and the weekly scorecard

`agents[].wip` uses the existing assignment limit predicate without visibility or title exclusions:
`todo`, `in_progress`, and `blocked` issues assigned to that agent.
`wipLimit` uses `PAPERCLIP_AGENT_WIP_LIMIT`. A missing or invalid limit produces `null`.
Terminated agents and agents pending approval do not appear in the active agent list.
`counts.wip` counts these statuses for all owners, including users and unassigned work.

The weekly scorecard excludes titles that start with `Review hold:`, `Review r`, or `Gate `.
`scorecard.counts` applies those same exclusions to each report count.
`scorecard.counts.wip` includes blocked real work, for comparison with the assignment limit.
`scorecard.wip` preserves the older weekly definition: only `todo` and `in_progress` real work.
`scorecard.byOwner` supplies both definitions and the flow counts for each current owner.
User owners and unassigned work have separate groups.
The scorecard can copy these fields from one response and cite its `collectedAt` time.
Review hold counts are zero under the weekly title exclusions. Use the complete `counts` for review infrastructure.
Historical completion, cost, and deployment metrics still require their existing weekly sources.

The weekly routine must add a company flow section after this route is deployed.
It must include `scorecard.counts`, `scorecard.wip`, and `scorecard.byOwner`.
It must also include `counts.reviewHoldsWithoutRound` as a separate review infrastructure measure.
If the route is unavailable, record the flow fields as `TBD` with the failed route as the source.
Do not replace a failed request with zero or change the existing weekly work count.

## Consistency and verification

The service uses at most nine company-scoped queries in one repeatable-read, read-only transaction.
It does not read comments, decision contents, logs, or agent configuration.
The response still contains board-visible issue titles and owner IDs.
Use the existing board session or board key access rules.

Run the route, isolation, graph, work count, and performance checks:

```sh
pnpm exec vitest run server/src/__tests__/company-flow-model.test.ts server/src/__tests__/company-flow.test.ts server/src/services/agent-wip-limit.test.ts
```

The HTTP test includes JSON transfer and decoding for 2,000 linked issues.
It requires a complete report in less than two seconds.
This fixture verifies a representative company size. Larger companies need separate capacity measurements.
The fork pull request workflow runs these checks on the exact candidate commit.
