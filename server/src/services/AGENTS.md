# Service rules

## Deferred dependency wakes

Durable wake payloads describe the blocker set at release time.
The saved blocker set can differ from the current blocker set during a retry.
Check current blocker membership before reusing a saved resolved-blocker ID.
Use current dependency readiness and its blocked-cycle key for dispatch and duplicate checks.

## Restart recovery ownership

The orphan reaper owns process-loss recovery for legacy runs with a controller or checkpoint.
Do not terminalize these runs from the stale-lock sweeper because their provider stopped.
An expired lease permits a restart claim. It does not permit the sweeper to remove the task locks.
Check new ownership evidence in the terminal write as well as the initial read.
Measured 2026-10-26 (VLAT): sweeping first interrupted six checkpointed runs and prevented their restart claims.
