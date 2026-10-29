# Blocked-state integrity

Set `PAPERCLIP_BLOCKED_STATE_INTEGRITY=true` to enable these rules.
The default is disabled. The switch does not change cards or release gates.
Keep `PAPERCLIP_SELF_BLOCK_GUARD=true` to reject waits that name only the owner.

A blocked issue requires an open blocker link, a pending card, a recorded review handoff, or a typed outside wait.
The update API returns `422` when no target exists.
The self-block guard still returns `409 self_block_refused` for a self-owned wait without a target.
An action that names another issue requires a blocker link to that issue.

The API accepts these optional `unblockDescriptor` fields:

- `kind`: `external`, `human`, or `date`.
- `until`: an ISO date and time. A `date` wait requires a future value.

The existing `owner` and `action` fields remain required.
A self-owned review wait requires the owner's latest handoff and its full head commit in the action.
The handoff branch must be `review/<issue identifier>`.
A later rejection or merge authorization ends that review wait.
The server can save the handoff comment and blocked status in one transaction.
The released board-owned review wait also remains valid for a saved owner handoff.
An agent cannot create that board-owned wait from an unsaved comment or change its assignee.
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
Native completion passes activity and wake queues through its outer status transaction.
It dispatches those queues through the root database after the outer commit.
A transaction-bound issue service never dispatches from a savepoint.
Without a caller queue, its durable intents remain available for recovery after commit.
Failed or deferred dispatches remain pending. The periodic dependency check retries them for released `todo` issues.
A retry reuses a saved resolved-blocker ID only while that ID remains in the current blocker set.
An expired dispatch claim also permits a retry. An existing wake prevents a duplicate dispatch.
Route completion and recovery use the same cycle key when integrity is enabled.
They suppress an existing completed wake for that cycle.
A new status transition or assignee change cancels an obsolete intent.
Native completion uses the same blocked-cycle key as durable dependency release.
If a completed child explicitly blocks its parent, the dependency path owns that notification.
The separate child-completion path does not send a second parent wake.
The dependency notification retains the child summaries for native and HTTP completion.
Completed onboarding parents retain their final report notification.
This also preserves deferred dispatch and workspace finalization checks.
Unlinked child completion retains its parent summary wake unless a separate blocked wait remains.
These rules require the integrity switch. The disabled default retains the previous behavior.
A card, approval, or review wait that appears after release keeps the intent pending.
Pending cards, open approvals, outside waits, review handoffs, and open bridge holds preserve the blocked state.
A typed wait whose action names only other issues is stale when all of those issues are complete or cancelled.
The release ignores a stale wait and clears it. An action with other words, for example a vendor reply, stays an outside wait.
Both `pending` and `revision_requested` approvals remain open waits.
Workspace finalization remains a dependency barrier for both `done` and `cancelled` blockers. Its existing wake path rechecks the dependent after synchronization.
Both update validators use canonical dependency readiness for saved links and proposed links.
A blocked issue can receive title and wait-note updates while its blocker still needs workspace finalization.
An `in_progress` update with explicit blocker links returns `422` until workspace finalization succeeds.
An `in_progress` update also checks each open bridge hold that the blocker sync keeps. It returns `422` while a hold is open.
The update checks the saved links again in its transaction.
Restoring completed blocker links does not send a dependency wake while a separate blocked wait remains.
The periodic dependency check also respects these waits.

Stranded-work recovery escalates an issue without an open blocker with a board-owned `human` wait.
The wait action names the recovery action ID and no issue identifier.
If the server refuses a recovery write with `422`, the sweep skips that issue until its row changes or one hour passes.
The sweep logs one warning for each refused issue state, not one for each tick.

No database migration is required. The descriptor uses the existing JSON column.
Action references use all saved or proposed blocker links, including completed links.
Readiness uses only unresolved blockers. Completed links do not create a waiting target.
Disable the environment switch to restore the previous rules.
The release branch still resolves cancelled dependencies when both integrity and pull queue are disabled.
Its active finalization checks and saved board review waits also remain available.
This source change does not enable the switch or deploy the server.

Verification uses `server/src/__tests__/blocked-state-integrity.test.ts`, `server/src/__tests__/blocked-state-holds-and-stale-waits.test.ts`, `server/src/__tests__/dependency-release-wakes.test.ts`, and `server/src/__tests__/stranded-reconcile-refusal.test.ts`.
The test uses a temporary PostgreSQL database.
