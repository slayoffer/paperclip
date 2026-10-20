# Dependency release

An issue relation declares a dependency. A cancelled blocker voids that dependency.
A done blocker releases its dependent when workspace synchronization settles.
Failed or cancelled runs cannot start missing finalization work.
Their recorded workspace operations no longer block a done issue.
A live finalizer still blocks release.

The completion route, finalization hook, and periodic release check use the same readiness function.
The release path moves eligible dependents from `blocked` to `todo` before the dependency wake.
It preserves other waits, including descriptors, pending questions, approvals, pause holds, active runs, monitors, and recovery holds.
The release writes an activity record and advances the status version.

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

Homelab owns deployment and live verification.
After deployment, its normal release event resolves false holds on the affected dependents.
No database edit or agent call to the board-only recovery API is required.
