# Service rules

## Deferred dependency wakes

Durable wake payloads describe the blocker set at release time.
The saved blocker set can differ from the current blocker set during a retry.
Check current blocker membership before reusing a saved resolved-blocker ID.
Use current dependency readiness and its blocked-cycle key for dispatch and duplicate checks.

## SSH ownership recovery

Agent-home and primary workspaces can have no `executionWorkspaceId`.
Older leases can also lack `sshInPlaceWriter` tracking.
Recover their lock path from the saved `in_place` realization with matching lease and provider identities.
A terminal run and released lease still require remote termination proof before lock removal.
Observed on 2026-10-26 (VLAT): a sweep that used only execution-workspace rows skipped these locks.
