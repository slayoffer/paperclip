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

Promote retry fixtures at their persisted `scheduledRetryAt`. Infrastructure retry
delays include jitter; a guessed offset from the base delay can leave the run
scheduled and prevent the adapter and completion assertions from executing.

Runtime-service child exits persist their final state asynchronously.
For a fixture that exits through its own marker, await its persisted stopped state
before deleting runtime-service rows and parent rows. An explicit Stop can return
before the separate child-exit write finishes and restores a deleted row.

For unequal receipt timestamps, derive the changed value from the compared value.
Subtracting from a later release time can recreate the original confirmation time.

For an exact remaining RPC timeout assertion, control `Date.now()` around the call.
A deadline budget decreases between its creation and dispatch, even by one
millisecond. Keep real timers active and restore the clock spy in `finally`.

## Publication history and fixture cleanup

`TRUNCATE companies CASCADE` reaches the publication-history guard even when
the fixture creates no publication rows. Use `clearCompanyFixtures` for ordinary
row cleanup. A complete reset of a disposable test database can use a transaction
with `SET LOCAL session_replication_role = replica` before truncation. Keep this
setting inside the cleanup transaction so all test assertions run with triggers
active. Do not disable the production publication-history guard.

## Git fixture environment

Measured 2026-11-07: a host Git template can omit `.git/info` and install hooks
that correctly fail managed-checkout proof. Fixtures that require stock Git
metadata must isolate global/system Git configuration and restore it afterward.
Git apply also uses the process umask: `002` creates executable files as `0775`,
while restore fixtures expect `0755`. Set `022` within those fixtures and restore
the previous mask. Keep exact mode assertions and production proof checks.

Restore-point mode overrides exclude ordinary `0644` and `0755` files. A fixture
that tests override validation must explicitly `chmod` a changed file to another
mode; do not depend on the host umask to populate the mode manifest.
