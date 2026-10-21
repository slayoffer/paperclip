# Owned task drain

A task drain prevents new run admission across server recreation.
It does not cancel running work or change operator holds.
This contract applies to the Synthiq fork.

## Access and identity

The `/api/instance/task-drain` routes retain the existing Board access checks.
Only an instance administrator or the local implicit Board can acquire or release a lease.
The server records the authenticated actor ID as `ownerId`.
A caller cannot supply another owner ID.

`POST /api/instance/task-drain` accepts `{ "ttlMs": 900000 }`.
The duration defaults to 15 minutes.
It must be a positive integer of at most 24 hours.
The server rejects `null` and an indefinite duration.
The response contains `leaseId`, `ownerId`, `startedAt`, and `expiresAt`.
The server creates a fresh lease ID for each acquisition.
A competing acquisition returns HTTP 409, including a request from the same owner.
A retry must read status before it proceeds.
Acquisition does not extend an active lease.

`DELETE /api/instance/task-drain` requires `{ "leaseId": "<returned UUID>" }`.
The authenticated owner and lease ID must both match the stored lease.
A mismatch returns HTTP 409.
A matching release returns `{ "wasActive": true }` before expiry.
It returns `{ "wasActive": false }` after expiry.
A release cannot clear an independent operator hold.
A delayed release cannot clear a replacement lease.

## Persistence and admission

The reserved `instance_settings` row with `singleton_key = 'task-drain'` stores the lease.
Its `general` field contains `{ "version": 1, "lease": <lease or null> }`.
The editable settings remain in the separate `default` row.
This change requires no database migration.

Acquisition and release use one exclusive database lock.
The lease mutation and activity records commit in the same transaction.
A failed storage or audit write leaves the previous state intact.
Activity publication occurs after commit.
A publication failure cannot reverse a committed lease.

Every scheduling check reads persisted state before it permits admission.
No process cache or startup window bypasses the lease.
A failed read or malformed storage stops admission.
Queued wakes remain pending during the drain.
Queued-run claims hold a shared database lock until their claim transaction commits.
Acquisition waits for claims that already hold that lock.
Claims that follow acquisition observe the committed lease and remain queued.
A lease expires when the server clock reaches `expiresAt`.
Existing worktree, restore, budget, company, and operator holds still apply.

## Status and measurement

`GET /api/instance/task-drain` returns the active `lease`, or `null`.
It retains `draining`, `startedAt`, `expiresAt`, `activeRuns`, and `pendingWakes`.
The last two fields count only local promises.
It also returns these database counts:

- `persistedRunningRuns` counts runs with status `running`.
- `persistedQueuedRuns` counts runs with status `queued`.
- `persistedScheduledRetryRuns` counts runs with status `scheduled_retry`.
- `persistedPendingWakes` counts wakes with status `queued`, `claimed`, or `deferred_issue_execution`.

`quiescent` requires zero local promises and zero values for all database counts.
A storage failure returns an error instead of a quiet-state report.
A queued run can keep `quiescent` false throughout a drain.
Each response reports a sample, not permission to stop or deploy a server.
Operators must check the expected active lease and its remaining duration before a controlled measurement.
Source approval does not permit lease activation, deployment, host changes, or credentials.
