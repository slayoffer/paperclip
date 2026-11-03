# Agent issue admission

Agent creation quotas and the WIP decision run inside the issue insertion
transaction. The service uses the existing company `issue-privacy-tree` advisory
lock. It reads counts through that transaction after duplicate detection, then
holds the lock until insertion commits or rolls back.

This applies to the company issue route, the child issue route, and each child
created from an accepted plan. Concurrent requests share the same admission
boundary. With one daily or child slot left, only one new issue is admitted;
the other request receives HTTP 409 with `agent_issue_create_limit`. With one
WIP slot left, one assignment stays active and the other waits in backlog.
The existing board, critical-priority, and watchdog exemptions remain in place.

The route supplies the actor and quota exemption as internal service context.
Clients cannot select this context. It is excluded from accepted-plan request
fingerprints. A duplicate returned by the service does not consume a new slot.
Early route quota checks can still reject a request before insertion; the
transaction check is authoritative for concurrent creation.

The real PostgreSQL regression test holds the existing company lock until two
HTTP requests wait for it, then releases the lock and checks stored outcomes.
See `server/src/__tests__/issue-create-admission-concurrency.test.ts`.

When agent quotas apply, an accepted-plan request holds the same company lock
and one outer transaction for the entire remaining batch. It checks only the
missing children against the quota before creation. Per-child savepoints cannot
commit a prefix after a later refusal. The route logs and wakes the newly created
children after that outer transaction commits. Existing partial claims resume
from their saved child IDs; completed retries need no additional quota slots.
Without quota admission context, the existing per-child commit behavior remains.

Issue updates share the same company lock with creation. The route takes that
lock before an issue row lock, rereads the current issue, and checks WIP through
the transaction client. Two own-backlog promotions cannot consume the same last
slot. A rejected promotion receives HTTP 409 with `agent_wip_limit`; a new agent
assignment over the limit is saved in backlog before the service derives status
side effects. Existing reopen, resume, review-return, board, and critical-priority
exceptions remain unchanged.

Before execution stops or reassignment effects, the route previews WIP and
validates blocked-state requirements. A preview fallback stays in backlog even
if capacity later frees. If capacity fills after a valid blocked reassignment
stops execution, locked admission saves backlog and clears the blocked descriptor.
The route does not repeat blocked validation after cancellation; the service's
existing integrity checks remain. Invalid blocked requests fail before execution
stops. Privacy changes that also lock review policy take the
same company-before-row lock order, even when WIP admission does not apply.

The transaction-bound issue service prepares and saves the final status on the
same connection. Activity publications and completion actions stay in the route's
queues until the outer transaction commits. This also works with a one-connection
pool. See `server/src/__tests__/issue-update-admission-concurrency.test.ts` for
real route races against promotion, reassignment, and creation.
