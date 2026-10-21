# Implementation specification: part 13

## 11.5 Recovery Work Classes

Status-only recovery coordination must include guard context that prevents deliverable work and document or plan updates (`allowDeliverableWork: false`, `allowDocumentUpdates: false`, `resumeRequiresNormalModel: true`). Recovery work classes do not select or change the agent model.

Failed source-work retries, process-loss retries, transient or scheduled retries, max-turn continuations, source-assignee continuations, and downstream source-work child, requeue, or resume contexts use the agent's configured model. If status-only recovery repairs liveness while actual work remains, the next live continuation path must be a separate worker run.

## 11.6 Scheduler Rules

Per-agent schedule fields in `adapter_config`:

- `enabled` boolean
- `intervalSec` integer (minimum 30)
- `maxConcurrentRuns` integer; new agents default to `20`; scheduler clamps configured values to `1..50`

Scheduler must skip invocation when:

- agent is paused/terminated
- an existing run is active
- hard budget limit has been hit

Budget admission and accounting serialize under the company accounting lock.
The dispatch boundary rechecks current company, agent, and project policies and
reserves capacity before paid work starts. Accounting commits budget blocks and
durable stop intent without waiting for provider shutdown or reconciling unrelated
agents. An asynchronous worker cancels only work in the affected scope; committed
stop intent survives policy changes and restart until existing stop proof succeeds.

Accepted cumulative per-run usage checkpoints contribute observed running spend
before the final ledger charge. Admission counts each unfinished operation's
maximum of its reservation and observed spend; hard stops count actual ledger
and observed running spend, rather than reservation estimates. Final settlement
atomically replaces the observation with the ledger charge. Incomplete or unknown
accounting remains conservative. Mid-run enforcement depends on provider usage
reports or existing supported pricing; providers reporting only at completion
cannot offer exact mid-call spend detection.

Legacy execution records a renewable controller lease when claiming a queued run,
before provisioning. A live lease protects the run during overlapping service
deployments. An expired controller loses dispatch authority; a recovery worker
must establish that the previous execution stopped before starting a successor.
