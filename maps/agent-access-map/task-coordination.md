# Delegation, dependencies, and signoff — agent access

Product map: [Delegation, dependencies, and
signoff](../feature-map/task-coordination.md).

Feature ID: `task-coordination`.

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `delegation`

Capability ID: `task-coordination/delegation`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/issues`.

Agent access: `available` — Native create_task/reassign_task; REST / CLI / MCP.

Policy: Task visibility/mutation, task-assignment and ownership policy; review audience
independent; tree controls board-only.

Evidence: `source-only` —
[implementation](../../server/src/routes/issue-tree-control.ts#L95) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Parent/child and provenance paths exist; same-company assignment does not remove
protected task/resource policy.

## `dependencies`

Capability ID: `task-coordination/dependencies`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/issues/{id}`.

Agent access: `available` — Native set_dependencies for the current task; agent REST
/ native `call_api` under mutation and checkout policy.

Policy: Task visibility/mutation, task-assignment and ownership policy; review audience
independent; tree controls board-only.

Evidence: `source-only` —
[implementation](../../server/src/routes/issue-tree-control.ts#L95) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Dedicated set_dependencies is current-task scoped. Generic `call_api`
forwards blockedByIssueIds to the REST route and retains its ownership checks.

## `signoff`

Capability ID: `task-coordination/signoff`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/issues/{id}`.
- `POST /api/issues/{id}/interactions`.

Agent access: `partial` — Native paperclip_finish/paperclip_block and assigned
resolve_review; legacy agent REST disposition.

Policy: Task visibility/mutation, task-assignment and ownership policy; review audience
independent; tree controls board-only.

Evidence: `source-only` —
[implementation](../../server/src/routes/issue-tree-control.ts#L95) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Review policy determines final completion; formal board approval is a different
boundary.

## `tree-control`

Capability ID: `task-coordination/tree-control`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/issues/{id}/tree-control/preview`.
- `POST /api/issues/{id}/tree-holds`.
- `POST /api/issues/{id}/tree-holds/{holdId}/release`.

Agent access: `restricted` — Board-only task-tree APIs.

Policy: Task visibility/mutation, task-assignment and ownership policy; review audience
independent; tree controls board-only.

Evidence: `source-only` —
[implementation](../../server/src/routes/issue-tree-control.ts#L95) at the reviewed
commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Even reads/state/preview require board. There is no agent tree-control path just
from company/task permissions.

## `pull-queue`

Capability ID: `task-coordination/pull-queue`.

Review: `baseline`.

API: `not-applicable` — selecting the next ready task is an automatic server
operation, not an agent-invoked queue operation. Existing task changes use
`PATCH /api/issues/{id}`; that route does not grant direct scheduler control.

Agent access: `not-applicable` — the server selects work for an idle owner and
submits a system assignment wake through normal heartbeat admission. No dedicated
agent select/drain endpoint is exposed. Task edits retain the existing issue
mutation and assignment permissions; this scheduler grants no additional access.

Policy: `PAPERCLIP_PULL_QUEUE_ENABLED=true` enables selection. It is scoped to an
active company and its assigned agent. A per-owner transaction lock prevents
competing selection. Live runs and eligible pending wakes occupy the owner slot.
Candidates exclude conversations, scheduled monitors, pending interactions,
unready dependencies and parked work. Backlog selection requires a free runnable
WIP slot; typed external waits do not consume that slot. The wake includes the
selected status, status revision and assignee guard. Normal admission retains
budget, execution ownership and other dispatch restrictions.

Evidence: `source-only` — reviewed at `389f2c3b147ea33fd3ed7fd48955b91b89fa162a` during
the v2026.1106.0 fork replay:
[selection and guarded wake](../../server/src/services/pull-queue.ts),
[feature gate and live execution checks](../../server/src/services/pull-queue-policy.ts),
[parking and retry eligibility](../../server/src/services/pull-queue-state.ts),
[normal admission](../../server/src/services/heartbeat/queue.ts), and
[task mutation routes](../../server/src/routes/issues.ts). No live agent proof.

Verification: `not-run` — in an isolated fixture, enable the queue and finish an
owner's current run; observe one eligible assigned task enter normal admission.
Reject cross-company selection and duplicate selection; retain pending-card,
dependency, monitor, parking, WIP and budget holds. Existing
[selection tests](../../server/src/__tests__/heartbeat-pull-queue.test.ts) and
[skip/parking tests](../../server/src/__tests__/heartbeat-pull-queue-gap.test.ts)
cover these service boundaries; linked suites alone do not prove this revision.

Gaps: Live scheduling latency and the related task-edit paths through each agent
transport remain unverified. Operator configuration is separate from task access;
no agent-facing configuration or forced-dispatch path is claimed.
