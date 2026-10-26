# Service rules

## Deferred dependency wakes

Durable wake payloads describe the blocker set at release time.
The saved blocker set can differ from the current blocker set during a retry.
Check current blocker membership before reusing a saved resolved-blocker ID.
Use current dependency readiness and its blocked-cycle key for dispatch and duplicate checks.

## Pull queue stops

Record an explicit backlog disposition with its parking receipt in the issue transaction.
Keep parking conditions separate from general issue recency. Comments and title edits do not resume a parked issue.
Skip receipts restrict automatic selection only. Normal admission always checks current authority.
Recheck budget, dependency, pause, and recovery gates before reusing an old skip.
