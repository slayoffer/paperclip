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

Paid-operation settlement and receipt ingestion use operation-scoped transactions.
They do not acquire the company accounting mutex or update shared company/agent
spend counters. The ledger, reservation transition and accounting acknowledgement
commit atomically. Duplicate evidence uses stable identities; a conflicting
receipt is not another charge. Monthly and lifetime totals read the canonical
ledger and retained historical baselines.

Admission reads current company, agent and project controls plus coherent budget
exposure. Reservations record an operation's estimated obligation, rather than
an exclusive claim on shared remaining capacity. Concurrent admissions may see
the same available balance and both start. Budget enforcement is best effort,
not a guaranteed bound on final billed spend. Manual Stop, lifecycle authority,
permissions and provider-dispatch ownership retain their final gates.

Financial changes append independent durable evaluation inputs. The existing
worker coalesces notifications over one second and publishes budget holds,
incidents and durable Stop intent from a consistent snapshot. Policy/control
publication is fenced separately from settlement. Inputs arriving or committing
later stay pending; no global sequence watermark consumes them. Admission does
not wait for them: it reads the ledger and live exposure itself, so a reached
hard stop refuses new work even while evaluation lags.

**Admission is independent of cleanup and accounting.** Admitting new work never
waits on another run's cleanup or accounting completeness. Only these refuse it:

- spend at the limit (ledger plus observed running spend), or unpriced usage
  under a blocking policy (the hard stop);
- an explicit pause of the company, project or agent;
- an inactive company.

A run whose accounting is unfinished (its final receipt has not closed, its
native coordinator is still recovering, its usage capture failed, or a late
receipt is outstanding) contributes its bounded estimate to exposure: the
larger of its held reservation and its observed cost. It never creates a
company-wide or scope-wide gate, and it never pauses a scope or opens a
hard-stop incident. A budget-owned scope hold whose policies no longer reach a
hard stop is stale; the budget worker releases it, and budget admission does
not refuse work while it waits. Unevaluated budget inputs are not a gate.
Provider reporting and cancellation delays remain additional to evaluation lag.
Cancellation delivery is asynchronous and scoped; committed per-run Stop
survives policy changes and restart until existing stop proof succeeds. Budget
resume cannot clear a manual hold.

A successor run on the same task still waits while its predecessor owns
resources that the successor would reuse (a live environment lease, an open
native finalization coordinator, or workspace finalization). That wait is
per task, ends when the owner releases them, and wakes the successor through
the work-intent promotion path. A predecessor run row that no longer exists
owns nothing and never holds its successor.

**Accepted work intents are delivered exactly once.** An accepted work intent
(an assignment, a comment, a Retry or a recovery) ends in one of four terminal
outcomes only: delivered, consumed by a later run that received it, task
cancelled, or a reached hard stop. Every other refusal is temporary. The intent
is saved as a deferred wake whose `executionWait` names the refusal and the
event that clears it (a lifted pause, a released lock, settled accounting, a
released task-tree hold, or resumed scheduling). Each such event promotes
deferred intents through one promotion function, and the ownership reconciler
promotes any intent whose hold cleared without that event. Promotion re-runs
normal admission. Consumption is recorded per comment or intent id, so a
promotion never delivers an intent that a later run already received.

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
