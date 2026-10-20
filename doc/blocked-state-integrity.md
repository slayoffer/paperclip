# Blocked-state integrity

Set `PAPERCLIP_BLOCKED_STATE_INTEGRITY=true` to enable these rules.
The default is disabled. The switch does not change cards or release gates.
Keep `PAPERCLIP_SELF_BLOCK_GUARD=true` to reject waits that name only the owner.

A blocked issue requires an open blocker link, a pending card, a recorded review handoff, or a typed outside wait.
The update API returns `422` when no target exists.
The self-block guard still returns `409 self_block_refused` for a self-owned wait without a target.
An action that names another issue requires an open blocker link to that issue.

The API accepts these optional `unblockDescriptor` fields:

- `kind`: `external`, `human`, or `date`.
- `until`: an ISO date and time. A `date` wait requires a future value.

The existing `owner` and `action` fields remain required.
A self-owned review wait requires the owner's latest handoff and its full head commit in the action.
The handoff branch must be `review/<issue identifier>`.
A later rejection or merge authorization ends that review wait.
The server can save the handoff comment and blocked status in one transaction.
This wait evidence grants no permission to publish, merge, or deploy.

An open bridge hold remains a blocker when an update replaces reviewer links.
Reviewer completion preserves that hold and does not wake the source owner.
Only explicit blocker relations contribute to `blockerAttention` counts.
Unlinked children do not contribute. Counts also cover issues outside blocked status.
Nonblocked issues without unresolved blockers retain `none` attention.

When the last blocker becomes `done` or `cancelled`, the same transaction returns an eligible dependent to `todo`.
It clears the old unblock action and records a system comment and an activity event.
The released issue retains its completed cycle timestamp for dependency wake keys.
A later transition into blocked creates a new cycle timestamp.
The transaction also records a dependency wake intent in `agent_wakeup_requests`.
The intent uses `pending_dependency_dispatch`. It does not represent a queued heartbeat.
After commit, dispatch applies the existing scheduler checks and the cycle wake key.
Failed or deferred dispatches remain pending. The periodic dependency check retries them for released `todo` issues.
An expired dispatch claim also permits a retry. An existing wake prevents a duplicate dispatch.
A new status transition or assignee change cancels an obsolete intent.
A card, approval, or review wait that appears after release keeps the intent pending.
Pending cards, open approvals, outside waits, review handoffs, and open bridge holds preserve the blocked state.
Both `pending` and `revision_requested` approvals remain open waits.
Workspace finalization remains a dependency barrier for both `done` and `cancelled` blockers. Its existing wake path rechecks the dependent after synchronization.
Both update validators use canonical dependency readiness for saved links and proposed links.
A blocked issue can receive title and wait-note updates while its blocker still needs workspace finalization.
The periodic dependency check also respects these waits.

No database migration is required. The descriptor uses the existing JSON column.
Disable the environment switch to restore the previous rules.
This source change does not enable the switch or deploy the server.

Verification uses `server/src/__tests__/blocked-state-integrity.test.ts` and `server/src/__tests__/dependency-release-wakes.test.ts`.
The test uses a temporary PostgreSQL database.
