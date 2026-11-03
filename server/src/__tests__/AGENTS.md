# Test rules

## Owned process Stop fixtures

`resumeQueuedRuns()` returns before asynchronous adapter preparation finishes.
Await the fixture's process readiness signal before checking `runningProcesses`.
A short registry poll can fail before the process starts and skip the Stop assertions.
Keep the test timeout and all cancellation settlement assertions.

SSH writer markers exist before the systemd scope and provider start.
Await a provider readiness signal before testing restart termination of a live writer.
Marker presence alone does not prove that the provider started.

For lease-expiry fixtures, freeze only `Date` and advance it after setup completes.
Real runtime initialization can exceed a short fixture lease TTL. Keep timers real
for database and runtime I/O, and restore `Date` in `finally`.

Runtime-service child exits persist their final state asynchronously.
For a fixture that exits through its own marker, await its persisted stopped state
before deleting runtime-service rows and parent rows. An explicit Stop can return
before the separate child-exit write finishes and restores a deleted row.
