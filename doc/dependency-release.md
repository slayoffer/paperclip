# Dependency release

An issue relation declares a dependency. A cancelled blocker voids that dependency.
A done blocker releases its dependent when workspace synchronization settles.
Workspace operations use their owning run to determine settlement.
A later cancelled retry cannot settle an older live preparation, provider execution, or export.
Failed or cancelled owners release their unfinished records after active exports stop.
Missing ownership evidence preserves the barrier.

The completion route, finalization hook, and periodic release check use the same readiness function.
The release path moves eligible dependents from `blocked` to `todo` before the dependency wake.
It preserves other waits, including descriptors, pending questions, approvals, pause holds, active runs, monitors, and recovery holds.
The release writes an activity record and advances the status version in one transaction.
That record preserves a pending wake until enqueue succeeds.
The periodic sweep retries pending releases after enqueue errors, deferred requests, and server restarts.
A delivery record closes the receipt for that status version.
The release key prevents duplicate wakes when enqueue succeeds before the delivery record commits.
A later status cycle expires the old receipt.

`GET /api/issues/:id` includes `dependencyReadiness`.
It contains `isDependencyReady`, `unresolvedBlockerIds`, and the existing detailed readiness fields.
The shared issue type carries this optional read projection.

A cancelled scheduled retry does not imply uncertain provider work.
The recovery classifier checks its dispatch fields, process records, native coordinator, events, and environment leases.
A dependency wait with no execution evidence creates no recovery action.
Repeated observations of an uncertain source run retain its existing action.

The release path also resolves historical false holds through this retained evidence check.
It retains each recovery record and its original evidence.
It marks replay as `not_required` and records `actionOutcome: not_started`.
Conflicting execution evidence retains the hold.
This includes actions whose status is already `resolved` but whose replay flag still blocks execution.
The periodic sweep also selects assigned `todo` issues with these historical holds.
Those issues need no release receipt or dependency relation for evidence settlement.
The sweep checks retained dispatch evidence before it checks dependency readiness.
It preserves cancelled recovery records and holds with conflicting execution evidence.
Relation-free settlement retains issue status and creates no dependency wake.
Normal scheduling can then admit the issue through its existing guards.
Repeated sweeps do not repeat settlement or dependency wakes.

Wake admission checks dependency receipts again while it holds the company-scoped issue row lock.
This check and the request insert use the same transaction.
Concurrent finalize, route, and backstop producers can pass their earlier readiness checks.
Only the first producer admits a request and records an emitted wake.
Coalesced requests also cover the current ready state.
Native status intents require admission before they cover that state.
Route callbacks record an emitted wake only when admission returns a run.
Failed, cancelled, and skipped requests permit another admission attempt.
A later blocked cycle uses a different key.

Homelab owns deployment and live verification.
After deployment, its normal release event resolves false holds on the affected dependents.
No database edit or agent call to the board-only recovery API is required.
