# Local stop and SSH phase evidence

The controller retains content-free evidence in `heartbeat_run_events`.
The event type is `execution.evidence`.
The schema is `paperclip.execution-evidence/v1`.
These records use the local run log. They add no external transmission.

Each executor creates an evidence scope. Each Stop call creates a separate scope.
A native helper inside that same Stop call reuses its request identity.
Repeated public Stop calls retain separate request identities, including calls after termination.

Each scope has a random identity, consecutive record indexes, and a final record count.
The final record also retains failed write counts and measured database write time.
A missing start, end, record, or count prevents complete coverage.
The reader also checks the complete run-event sequence against `heartbeat_runs.next_event_seq`.
This detects removal of an entire evidence scope.

Evidence writes have a five-second limit. After a failure, the recorder attempts only its final gap receipt.
A late write cannot remove the recorded failure.
The current controller also remembers a run's storage failure.
The executor's final receipt preserves that source failure when storage becomes available.
A controller failure before that receipt leaves an unclosed executor scope.
Each scope also retains its controller source identity.
A new controller reports old-source scopes as `source_epoch_unverified`.
It cannot attest the previous controller's lost in-memory storage failure state.
Retained old records remain readable. Archive their verified report before the controller ends.
The trial's separate lifecycle requirement still rejects a controller replacement.
The request captures its time before cancellation starts.
Its evidence writes begin after the cancellation operation settles.
This preserves the original connection-pool and row-lock ordering for Stop.
The reader reports `stop_source_pending` until the request's storage receipt settles.
A crash before that receipt makes the source epoch unverifiable.
Cancellation starts without waiting for evidence storage. Evidence does not establish provider termination.

## Sources

| Field | Source | Meaning |
| --- | --- | --- |
| Company, agent, run | Bound run row and event writer | The writer validates the company and agent before each append. |
| Request identity | Public Stop, bulk Stop, native cancellation, internal abort, or process timeout | Each separate request has a random identity. Nested native dispatch retains the outer request identity. |
| Request time | `stop_request.requestedAt` | Controller UTC time at the request boundary. Terminal time is never a substitute. |
| Source and initiator | Authenticated cancellation metadata, or the system path | Operator, queued message, control plane, or shutdown. A system path has a system initiator. |
| Reason | Closed reason category | Stop, budget, pause, reassignment, shutdown, lease loss, timeout, terminal cleanup, or checkpoint failure. Caller text is excluded. |
| SSH attempt | Workspace operation scheduler | Random attempt identity, prepare or restore, queued time, start time, end time, and success or failure. Nested attempts remain separate. |
| Terminal outcome | `heartbeat_runs.status` and `finished_at` | The final run outcome. A pending outcome prevents complete coverage. |
| Coverage | Scope manifests, full event sequence, and source storage health | Missing or inconsistent evidence prevents complete coverage. |
| Overhead | `scope_finished.writeMs` | Sum of measured evidence write waits before the final receipt. It excludes the final receipt write. |

`resultJson.cancellation.recordedAt` can be a terminal reconciliation time.
It is not request-time evidence. New inferred cancellation metadata has `requestedAt: null`.
Provider or transport cancellation without an observed request remains incomplete.
Historical runs without executor source coverage remain incomplete.

## Reads and retention

Use `GET /api/heartbeat-runs/:runId/execution-evidence` for the reconciliation report.
The route uses the same company and run-log read authorization as run events.
The read holds the run row while it reads the event history and sequence census.
It includes all retained attempts and requests for that run. It has no time-window or 200-record cutoff.
The existing paginated `/events` route supplies the original records.

Run-log rows have no evidence-specific expiration or truncation policy.
Existing company or run deletion still removes the source. A missing source cannot prove coverage.
Retain the complete run census, source records, and deployment lifecycle through the final assessment.
Include boundary runs by identity, even when they start before or finish after the observation window.
Wait for those runs and all scopes to settle before final reconciliation.

The report uses controller UTC with millisecond precision.
It does not assert a measured clock offset. The assessor must retain clock synchronization evidence separately.
A request at either SSH boundary intersects that attempt conservatively.
`phaseStopObserved` identifies a trial invalidation even when evidence coverage is complete.
`terminationProof` is always false. Existing cancellation acknowledgements and lease checks retain that authority.

This change does not activate cap 24, begin an observation, change trial criteria, or deploy a server.
The trial assessor still needs its complete census, lifecycle, cap, logs, sizes, useful-step times, and dispatch evidence.
