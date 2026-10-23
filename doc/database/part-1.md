# Database: part 1

### Durable native provider backups

`native_harness_backups` journals encrypted provider-session archives in object
storage. One current row per company and session scope selects the published
backup. Pending uploads remain recorded after failure; a controller must still
own the native run when it publishes. Superseded controllers cannot replace the
selected backup. Archive bytes never enter the database.

The dedicated volume migration imports verified surviving backups without
removing their source files or changing task-session pointers. Replacement
readiness rejects retained session pointers whose backups remain local. The
existing bounded startup retention pass retires current backups only after its
task, run, lease and age checks pass. Old superseded objects have a separate
retention path that preserves the current backup and exact backups referenced
by live leases. Abandoned pending uploads also require a settled run without an
owner. Object deletion is acknowledged before removing the ledger row. This
adds no idle polling.

Archives stream up to 4 GiB of file data and 100,000 entries, with a separate
4.75 GiB encoded-object bound. Contained relative symbolic links are preserved
verbatim; absolute or escaping targets, link chains, writes beneath links, and
special files are rejected. Offline verification streams file hashes and honors
cancellation. A changed local manifest cannot be silently skipped just because
a previous migration published an object. Backups whose source run was deleted
remain untouched on the original volume and do not block enrollment.

The same offline maintenance process imports surviving legacy controller state
into `native_runner_checkpoints` and binds its existing session snapshot through
`nativeControllerRecovery` metadata. Runner validates the original protocol
state and recorded artifact; Core requires a finished run with no live owner.
Blocked or pending recovery records remain unchanged while their surviving
state is preserved; migration does not mark their work completed.
The normal bounded continuation selector handles inherited, unstarted follow-ups.
Never-started queued turns keep their task pointers and remain queued. Original
files stay intact, canonical database checkpoints take precedence, and missing
source files are reported separately rather than fabricated. This migration
does not recover provider state that was already lost before enrollment.

For an already-failed run, a valid legacy controller can lack proof of the
original Runner artifact after its old bootstrap tickets were pruned. The
migration preserves those exact controller and supervisor bytes as an encrypted
`paperclip.legacy-controller-archive.v1` object through the same backup ledger.
Its scope is the hash of its manifest and is separate from the provider session
scope. Publication requires a terminal-failure coordinator with no live owner.
The archive does not become an executable Runner checkpoint. Task pointers,
failed results and recovery blockers stay unchanged. A successful retained
session without artifact proof still blocks migration. The migration receipt
reports failed-session archives separately from imported recovery authorities.

An internal maintenance owner can separately record
`runnerProfileJson.nativeHarnessFilesystemIndependence` when an original-volume
inspection finds no uncovered provider or Runner payload. This is not a backup
or a successful recovery. It requires a fresh, independently reviewed provider
attachment witness and a private nonce anchor on that original volume. The
anchor survives normal releases; current deployment and mount identities are
verified afresh. Replacement hosts cannot create the receipt from missing files.

Publication binds the retained session, canonical newest resume source, frozen
inputs and checkpoints, every associated lease and destroyed-provider receipt,
released controller/finalizer ownership, and existing immutable skill references.
Any surviving skill files must match their admitted package bytes and modes.
Surviving controller and supervisor files require separate authenticated raw-byte
archives through the existing encrypted backup ledger. This evidence-only path
also accepts a settled successful source whose controller records match its
durable checkpoint. Its `original_volume_source_evidence` manifest reason does
not grant provider recovery or Runner execution authority. Publication checks
the source bytes again and retains the first authenticated archive during a
concurrent capture. The receipt binds the exact archive row and checkpoint parts.
Retired authority epochs can use the same evidence archive with a closed
inventory of their original controller and suspended Runner files, bytes and
modes. Each epoch must match a retained same-session run and its canonical
checkpoint identity when a header exists. A genuinely absent historical header
instead requires the exact admitted authority binding and remains explicitly
absent. Malformed, retired, or foreign headers cannot use this path. Current
source checkpoint and artifact requirements remain unchanged. Source fences
recheck the complete inventory before archive and receipt publication. Unknown
children and other nonempty history directories remain blockers. The inventory
and historical headers or their explicit absence stay bound in replacement
validation. History-free manifests and receipts keep their exact
existing shape; current-controller-only evidence remains retained when a later
archive adds historical files. These archives do not become executable backups.
This maintenance inventory is limited to 128 entries, 16 MiB per file and 64 MiB
total. These bounds are intentionally smaller than the Runner control-plane
state's 256 MiB maximum. A larger otherwise valid epoch remains on the original
volume and blocks filesystem independence; it is never truncated or waived.
Source locks and a final comparison fence publication; original files, stamps,
warnings, failed statuses and session pointers remain unchanged. Startup can
validate the published receipt using only database bindings, without the old
volume, a fresh source witness, or storage reads. Changed or missing bindings
invalidate it. Existing resume and replacement policies remain authoritative,
including governed-wait failures and warm-session refusals. No provider history
is reconstructed or declared recovered.

The same original-volume maintenance owner has a separate `web_evidence` mode.
It stores a `paperclip.native-harness-web-evidence.v1` receipt. This mode proves
that the web server's retained files have durable byte coverage. It does not
require an external VM's termination receipt and does not settle that VM's
recovery obligation. It requires the same settled web controller, finalizer,
task and physical-writer fences. The encrypted `original_volume_source_evidence`
archive includes a closed inventory of all nonexcluded files under the canonical
session root, the separate warm supervisor, and each admitted skill manifest.
Files retain their bytes and modes, including local edits and a skill whose
version row was deleted. Such a skill remains forensic evidence: the owner does
not recreate its version or make it executable. Canonical credential exclusions
stay excluded. Unknown directories, symlinks, incomplete manifests, active web
writers and changed source facts fail closed. This WEB inventory permits at most
10,000 entries, 4 MiB of manifest metadata, and 4,096 bytes per path. The 16-MiB
per-file and 64-MiB total payload limits remain unchanged. Authority history keeps
its separate 128-entry and 32-epoch bounds.

A genuinely absent raw controller stays absent. A supervisor-only archive still
requires the exact durable controller checkpoint and source identity. Old
terminated-provider receipts and history-free manifests keep their existing
shape. External lease status and cleanup observations can change without
creating a new web filesystem dependency. Allocation, stamp, selected source,
checkpoint and admitted-input changes invalidate coverage. VM references,
recovery actions, warnings and continuation policies stay unchanged. Replacement
validation uses only the published archive and database bindings; it needs no
original-volume anchor or filesystem read. These validations add bounded
per-retained-scope database reads during startup. They do not add a worker or a
poll. Missing or invalid byte evidence remains an enrollment blocker.

Receipt validation adds bounded per-scope database reads to startup eligibility.
It does not add a recurring scan or network work. Qualification must measure the
selected cohort's startup latency on the serving revision before enrollment.

### Original local Git sources for archived workspaces

When an archived runtime branch has an exact successful deletion receipt, its
saved commit can be imported from the recorded original file-URL repository if
the canonical private/project cache is definitively absent. A present, corrupt,
foreign or unreadable primary source never falls through to this path.

This fallback requires the matching company/project source record, a real bare
repository under the same instance root, and the exact full saved base SHA matching
the deleted tip (`baseRefSnapshot.resolvedSha`, with the legacy `baseRefSha` form
accepted when no canonical snapshot exists). Conflicting records fail closed. It accepts self-contained SHA-1 storage with a bounded standard
configuration and at most 10,000 metadata entries. Aliases, special files,
alternates, replacement/graft/shallow state and execution hooks fail closed.
Every retained branch or lightweight tag must still name that full base commit.
Saved retries and final publication recheck that all recorded private and generated
primary sources remain absent. Returned or unreadable primary files block the
original-source path. Git reads use a restricted environment and local-file transport only.

Materialization uses private migration scratch. Existing encrypted snapshot
readback, journal identity, source reinspection and publication fences still
apply. Original repository bytes and cleanup history remain unchanged. This
imports the retained workspace tree; it does not turn a configured local file
URL into a portable source for future fresh project work.

### Proactive agent chat messages

Migration `0419_slippery_impossible_man.sql` adds an agent-scoped unique constraint
on `issue_comments(issue_id, author_agent_id, client_request_id)` alongside the
existing human request constraint. Proactive delivery stores a source-task-scoped
retry key and server-authored `metadata.chatMessage` provenance/content fingerprint.
The comment and audit record commit together; a retry returns the original receipt.
Conversation creation reuses the unique company/agent/human identity and existing
advisory-lock order. No message outbox is added.

Chat list/detail unread projections reuse `issue_read_states`, including chats
with no human participation. Read cutoffs use the exact PostgreSQL comment
timestamp; upserts take the greatest previous/new cutoff so delayed requests
cannot move a read receipt backward or clear a later unseen arrival.

Paperclip uses PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/). There are three ways to run the database, from simplest to most production-ready.

### Persistent case handoffs

Standalone `cases` add a nullable unique `work_issue_id`, a descriptive `phase`,
and an integer `handoff_version`. Historical passive records have no primary task;
native `create_case` requires kickoff plus explicit workflow text and creates its primary task atomically. This is
separate from `pipeline_cases`.

First-task `initialDocuments` use ordinary `documents`, `document_revisions`
and `issue_documents` in the case kickoff transaction. No case document copies,
pending seeds or new tables are introduced. Case read surfaces join accessible
linked task documents; historical `case_documents` records remain unchanged.
Required `workflow_document_text` uses the same tables, under ordinary task key
`workflow`. It is committed before delivery and contributes to the idempotency
fingerprint. Existing cases and tasks receive no inferred workflow or backfill.
Authoring guidance recommends both a Mermaid `stateDiagram-v2` map and prose
defining each transition. Neither representation is parsed into database states.

`case_handoffs` retains the task/agent identities, principal-scoped idempotency
key and request fingerprint, observed/applied bigint task status revisions,
instructions/comment, source run, and stable wakeup receipt. Partial unique
indexes permit only one pending handoff per task and case. The pending-attempt
index and expiring lease support bounded delivery across controller restarts.
The ledger states distinguish release waiting, assignment applied but admission
pending, queue acceptance, and cancellation. Provider execution remains in the
ordinary heartbeat tables.

`actor_context` retains a versioned, server-derived authorization context for
delayed assignment. It contains no credentials and is omitted from public
handoff responses. Applying a delayed transfer rechecks the original caller's
current assignment permissions. Historical pending transfers without this
context fail closed; an operator can cancel them and request a new handoff.

Terminal handoffs have `destination_kind = 'done'`, a null destination agent,
and states `awaiting_completion` / `completed` with `completed_at`. They share
pending task/case uniqueness with agent transfers but do not enter the delivery
lease index or wake queue. Accepted ordinary task completion and terminal case
closure commit together. No terminal intent is inferred from a case's status.

`case_access_sources` stores retained logical issue/project identities without
deletion cascades from those sources. A missing source denies access. The case
is readable only when every source's existing permissions allow it; unlinking a
task or changing presentation metadata cannot widen that set. The case handoff
migration backfills historical project and linked-task sources conservatively
and leaves all existing cases passive. Source identities are not grants.

### Task query performance

The cancelled workspace-preservation partial index and bounded run/activity
projections share the restore-failure allowlist. Changing those failure codes
also changes the index predicate; use the normal migration-generation workflow.
A required metadata repair is excluded from ordinary cancelled preservation work.

Native session resume selects its newest progress barrier within the existing
32-run task/session window in one SQL snapshot. Only the chosen checkpoint source
returns its saved native input, checkpoint, tool fingerprint, wake envelope, and
canonical task brief. Unused bootstrap candidates do not return full context or
profiles. Wrong runtime, nonterminal status, process identity, provider events,
invalid but non-null checkpoints, and future checkpoint barriers retain their
existing selection rules. Stored run payloads and history reads stay complete.
Run the synthetic PostgreSQL comparison with a pinned pre-change revision:
`pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-native-session-resume-reads.ts --baseline-ref=<commit>`.
An optional `PAPERCLIP_SESSION_RESUME_BENCHMARK_DATABASE_URL` must name a dedicated
test database ending in `_test`; otherwise the harness starts disposable PostgreSQL.

Agent request authentication uses a compact run-identity read. It omits saved
execution payloads, results, and log excerpts from the query response. The read
still locks the task before the run and reconciles pending steering from durable
acknowledgements on every request. Default identity reads retain the full run.
Stored payloads and separate native tool authorization checks remain unchanged.

Native event acknowledgements read a count and maximum through the existing
source-sequence index. A stream with gaps uses indexed lookups for its first
missing successor. The acknowledgement keeps its contiguous-prefix rule without
returning every historical sequence number. All events stay stored. Counting the
index entries still grows with the stream length.

Conversation recovery reads only the saved run fields used to settle a turn.
Settlement locks and reads current conversation state without loading the task
description or comment bodies. It still checks the durable reply or pending
interaction, session generation, owning run, and newer user messages. Saved
execution payloads, task text, and comments remain stored in full.

The attention feed checks for newer runs with company-scoped existence probes.
The probes match the failed run's agent and issue or task context. They preserve
the existing millisecond comparison and empty-context rules. Each batch holds
at most 1,000 failed runs. Retained run history stays in the database; this check
returns only the identifiers of failures that have a newer matching run.
For failures without a task key, it reads the latest keyless timestamp once per
agent. Unique agents are batched separately, so repeated failures do not repeat
the same history scan. Both paths retain the current millisecond comparison.

The issue-lock adapter's release read omits `result_json.stdout` and
`result_json.stderr` before transferring a run to the controller. Native context
also omits saved launch text, execution-continuation bodies, workspace and
environment payloads, and the launch wake envelope. Task identity, retry and
continuation controls, interaction and comment references, execution policy, unknown context fields, and every other
result key stay intact. Legacy reads retain full context. Stop, retry, lease,
and workspace-recovery checks do not change. Full inputs and output remain stored
for execution history and detail reads. Terminal telemetry loads only its run
identity, timestamps, usage, and typed task identifier.

Recovery's latest-run queries return the context fields used by recovery
decisions. Prompts, execution continuation bodies, and workspace setup payloads
remain in the stored run and its full detail reads. These queries also return
the PostgreSQL row version. Native blocked-wait repair compares that version
against a fresh full source read before applying changes. Any intervening row
update, including an edit outside the projection, defers repair to a fresh sweep.

The two preliminary reconciliation reads omit named launch renderings and
preparation payloads. Native profiles omit unused native execution input.
They retain all other context, full results, legacy profiles, task identity,
retry accounting, and unknown controls. Native runs still reach their native
recovery guard. Terminalization locks its current control state and returns
full rows from its writes. Stored input remains intact.

Execution-blocker reads select process, lifecycle, and task-binding fields rather
than full execution rows. Context retains typed task and pre-dispatch evidence;
Runner profiles retain the adapter type, native input schema, binding, provider,
workspace-access evidence, and complete workspace-sync receipts. Native task and
runtime prompt payloads are not needed for these checks. Missing fields and
malformed input values retain their original shape. Full result evidence stays
available to the existing retry and workspace checks. Stored context, profiles,
and output are unchanged.

Committed native finalization reads run identity and ownership state before it
claims the coordinator. It loads complete saved input only when finalization
still needs to process an accepted result. Review presentation retains the full
result. Muse settlement reads its exact provider binding. Cleanup reads fresh
status and ownership metadata; cancelled native workspace retention and legacy
Stop settlement still load complete run evidence. Workspace settlement reads the
saved sync descriptor, export retry, and first-heartbeat flag. These projections
leave stored prompts, logs, results, and recovery state unchanged.

Settled native process release locks run identity, terminal state, process
identity, and checkpoint presence without loading the checkpoint or execution
payloads. It retains current coordinator checks, provider evidence, local-host
identity checks, and every lease's termination receipt. The stop receipt and
process-field update remain in the same transaction.

Legacy terminalization locks runtime mode, status, full result evidence, and the
status-delivery token without loading unused input, profile, or log bodies.
It keeps the existing lock, full returned run, workspace-retention
receipts, and source-bound recovery holds. Stored payloads remain unchanged.

Conversation ownership checks select process identity and full recovery result
evidence without execution prompts or profiles. Committed native reply repair
selects its persisted result and identity bindings plus typed presentation flags.
It keeps its existing row locks, accepted-result digest checks, publication
authorization, and selected-answer protections. Full execution history stays in
storage.

Run-context lookups use expression indexes for both `context_snapshot.issueId`
and `context_snapshot.paperclipIssue.id`. Task creation provenance has its own
company-scoped expression index that follows the query's native issue ID and
legacy `issueId`/`taskId`/`taskKey` precedence. Migration 0345 builds the two new
indexes concurrently and can resume an interrupted build without blocking run
writes for the full build. The indexes add storage and run-write overhead; they
do not change task visibility or secret redaction.

The task Context row reads the agent's latest context-window reading through
two small partial indexes on `heartbeat_run_events`. One index covers only usage
items, by run and time. The other index covers only `context.compacted` events,
by company and normalized session. Migration 0432 builds both indexes
concurrently. A poll therefore reads a few index entries, not a run's full event
history.

A subtree pause release finds the runs that a dispatch gate refused for that pause
through the partial index `heartbeat_runs_tree_hold_suppression_idx`. The index
covers only cancelled runs with a `treeHoldSuppression` marker, keyed by company and
hold. Migration 0436 builds it concurrently.

The chat wake-notice sweep compares UUID columns directly against guarded,
canonical lowercase UUID payload values. Malformed and noncanonical payloads
still match nothing. The query can use existing primary keys without adding a
wakeup-history index.

To compare all three queries on the same disposable local PostgreSQL fixture:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-slow-queries.ts --baseline-ref=origin/master
```

Use a revision before these fixes for `--baseline-ref` after they merge. The
benchmark loads that revision's chat query, uses synthetic data only, compares
complete returned rows, and prints timings and `EXPLAIN (ANALYZE, BUFFERS)` plans.
Local results measure query execution, not staging request latency.

Run history defaults to 200 rows and permits at most 1,000 rows, including
direct service calls. The UI client requests 200 rows when its caller omits a
limit. Context summaries expand the stored JSON once per returned row, retaining
legacy text conversion and the first-class issue binding. Authorization and
secret redaction still run on the bounded result set.
Agent detail links fetch an older selected run by ID when it is outside the
history page, and verify that it belongs to the current company and agent.

Saved-run policy and parent-report lookups read only the `executionPolicy`
value or the legacy `issueId` and `taskId` values from a run context. PostgreSQL projects
those JSON values before it sends the row to the controller. Unused prompt and
launch context does not travel with each policy or parent-report check. JSON
types, task-key precedence, and company and agent identity checks are preserved.
Each decision still reads current data; this is not an authorization cache.

Restoring a saved monitor's receipt or completion proof creates a new native
assessment identity even when its scheduled deadline is unchanged. The saved
proof is part of the assessment input. Prior decisions and accepted results stay
intact, and an unchanged replay reuses the same assessment and decision.

Native tool authority lookups select current run identity, status, invocation,
responsible user, context, and receipt data. Saved profiles and output excerpts
stay in storage and are omitted from that read. Task and agent binding, current
status, budget, and task privacy checks retain their existing predicates.
Mutation transactions still lock and read complete run records. The unlocked
authority read also omits named launch renderings and preparation data that its
tools do not consume. Ordinary tool checks also omit the wake payload. Mail
checks load the current full wake to enforce external-chat restrictions. Other
context and result receipts remain available. The complete saved context stays
in storage for execution.

WebSocket delivery uses one fresh authorization batch for an event's task and
run bindings. When both bindings name the same task, the batch reads its current
authority once. Different task bindings must both pass. The batch is discarded
after that delivery; later events still recheck grants, membership, task
existence, and company boundaries.

Browser progress events update cached live run status directly. A successful
patch does not refetch task details, activity, or run history. Unknown runs
retain the existing refresh fallback. Run transitions, activity events, and
reconnect recovery still refresh their affected data.

Task run queries stop interval polling only after a successful empty response
and an open shared live connection for the current company and session. Initial
reads, active work, errors, connection setup, and disconnections retain their
existing polling cadence. Company or session changes require a new connection.
Views without an assigned agent retain polling. Matching run lifecycle events
refresh the displayed task's run queries independently of route and window
focus. Events that omit task identity conservatively refresh these queries,
including reviewer runs from another agent. One parent view owns both query
observers and reuses refreshes already covered by the focused-route handler. A
matching event that overlaps an older request queues a fresh read after that
request settles. Connection readiness also reconciles the displayed run
queries after any older request. Follow-up reads belong to the current mounted
scope and stop when it changes or unmounts. The first open and reconnect still
reconcile missed events.

Bundled skill release checks read the current stored version ID and a SHA-256
fingerprint of its file inventory. A per-database memo keeps at most 64 verified
snapshots. It reuses a verification only when the current database fingerprint
and current on-disk inventory hash both match. A changed or missing snapshot
still follows full validation or seeding. Company access and local source
reconciliation still run for each request; authorization is not cached.

Connection-assignment checks select profile bindings for the current company or
agent and read rules that can match the selected connection's catalog rows.
All five selector kinds, null application matching, exclusions, and profile
precedence retain their existing evaluator. Rule filtering uses the catalog
values already read by that check, so a later catalog change cannot drop an
exclusion from the decision being evaluated. There is no cross-call cache.

Filesystem preparation uses current task/run and selected-configuration checks.
Historical root-reader authorization has been retired; no retained-reader batch is
loaded at admission or publication. Workspace-record disclosure still uses task
privacy checks, independently of filesystem access.

Saved-message execution-wait scans read current run state, process ownership,
startup and cancellation receipts, task binding, and the recorded adapter kind.
Saved profiles, output excerpts, and unrelated launch context stay in storage.
Continuation admission and its locked mutation reads retain their existing gates.

Task creation provenance reads current run identity, scope, and task binding.
Legacy task references retain their typed values and existing precedence. Saved
profiles, output, and unrelated context stay in storage. Viewer access to the
source task and run is still checked before provenance is returned.

The initial agent JWT run lookup reads only the cancellation state and
conversation flag from saved run JSON. It does not transfer the full context or
result. Run status, responsible-user identity, company and agent boundaries,
and the cancellation response remain unchanged. Later identity refreshes keep
their current authorization and transaction boundaries.

Chat recovery ancestry selects task identifiers and source-run links instead
of full execution payloads. Instruction authorization selects current identity
fields and still rechecks accepted identity, key revocation, and membership.
Identity task locks and activation receipts project typed legacy task keys with
the native and first-class issue IDs. These projections preserve task binding
precedence and validation without transferring prompts or output.

Recovery's latest-run and legacy-continuation eligibility reads select structured
result fields for error families,
workspace/configuration receipts, cancellation attribution, retry deadlines, and
conversation finalization. The `adapter_failed`, `provider_quota`, and
`configuration_incomplete` classifiers retain full results because they inspect
arbitrary provider error text. Stored results and execution/detail reads remain
complete; no recovery decision is cached.

To measure authentication query responses on disposable synthetic data:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-agent-authentication.ts --baseline-ref=06689c1b3410000bcd65ff40cb469e600209c4db
```

This compares the current query with the original query in that revision. It
checks the complete authentication decision and reports returned JSON bytes,
local query timings, and execution plans. It does not measure request latency
or fleet-wide savings.

To compare the real summary and full history queries with an earlier revision:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-run-history.ts --baseline-ref=1e731520bb
```

The fixture has 1,400 synthetic runs with 192 KiB contexts. Both queries return
the same 200 complete rows. This benchmark excludes HTTP and redaction latency.

Workspace reads also compare retained task IDs as guarded, canonical UUIDs.
This lets PostgreSQL check each source task by primary key before it evaluates
task privacy. Casting the indexed task ID to text can instead evaluate privacy
across company history for each workspace. These predicates protect workspace-record disclosure and operation metadata;
repository admission does not use them to authorize filesystem contents. Missing, malformed, noncanonical, and foreign-company source
IDs still deny access.

The subsequent source-task enumeration also keeps `issues.id` as a UUID. Its
OR predicate combines the workspace binding index with the task primary key.
Casting that ID to text forces another scan of company history even after the
workspace privacy query has passed. The workspace authorization regression
suite checks both plans and verifies the attached and retained source results.

To compare this query on a disposable fixture with 13,429 tasks:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-workspace-authorization.ts --baseline-ref=5c7a025032
```

The benchmark loads the baseline authorization module with current dependencies,
compares complete workspace rows, and prints five warm samples and query plans.
It measures SQL execution, not the full repository admission or agent startup.

Native finalization retries preserve a run's terminal completion time when its
status is unchanged. A retry mints another status delivery only when the current
run's status, finalization metadata, phase, error fields, or missing completion
time changes. An unchanged projection retains its existing pending delivery ID,
including after a publish failure. Status delivery stays at least once; retry
deadlines, recovery, accepted results, and workspace cleanup still run normally.
Legacy recovery also retains the pending delivery when status is unchanged and
no patch was supplied. Explicit patches, new terminal statuses, and newly
retained workspace evidence still create a delivery. File retention, ownership
checks, failed write conditions, lock cleanup, and recovery holds still apply.
The retention-evidence write returns another full run only when that evidence
changes. An unchanged retry keeps the full run returned by the first write and
still processes retained leases and recovery holds.

Agent lists read the complete company roster once and use that same snapshot for
termination filtering and organization-chain normalization. Detail and plugin runtime reads
load only identity, company, name, status, and manager from other company agents
for chain checks. The selected agent's full configuration, current monthly spend,
and existing response redaction remain available. Every call reads current data;
these lookups do not cache authorization or agent configuration.

Queued-comment display filters wake requests by the current company, assigned
agent, status, and exact JSON string task identity in SQL. Other tasks' comment
identifiers stay in the database. The display projection, ordering, current run
ownership checks, and persisted wake payloads retain their existing contract.

## 1. Embedded PostgreSQL — zero config

If you don't set `DATABASE_URL`, the server automatically starts an embedded PostgreSQL instance and manages a local data directory.

```sh
pnpm dev
```

That's it. On first start the server:

1. Creates a `~/.paperclip/instances/default/db/` directory for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically for empty databases
4. Starts serving requests

Data persists across restarts in `~/.paperclip/instances/default/db/`. To reset local dev data, delete that directory.

Subscription reporting adds `ai_subscriptions` (company-scoped account identity),
`ai_subscription_prices` (immutable price revisions), and
`ai_subscription_connections` (selected grant-to-account bindings). New managed
subscription receipts also have a nullable `cost_events.subscription_id`.
Migration `0322_reflective_kree.sql` is replay-safe and leaves existing cost
amounts and receipts untouched. No historical account attribution is inferred.
Deleting a connection removes its binding but retains subscription price history;
disconnecting is not proof that provider billing ended. See
[subscription cost reporting](../connections/AI-CONNECTIONS.md#subscription-cost-reporting)
for the reporting and ownership rules.

If you need to apply pending migrations manually, run:

```sh
pnpm db:migrate
```

When `DATABASE_URL` is unset, this command targets the current embedded PostgreSQL instance for your active Paperclip config/instance.

Issue reference mentions follow the normal migration path: the schema migration creates the tracking table, but it does not backfill historical issue titles, descriptions, comments, or documents automatically.

To backfill existing content manually after migrating, run:

```sh
pnpm issue-references:backfill
# optional: limit to one company
pnpm issue-references:backfill -- --company <company-id>
```

Future issue, comment, and document writes sync references automatically without running the backfill command.

This mode is ideal for local development and one-command installs.

Docker note: the Docker quickstart image also uses embedded PostgreSQL by default. Persist `/paperclip` to keep DB state across container restarts (see `doc/DOCKER.md`).

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally, use the included Docker Compose setup:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Then set the connection string:

```sh
cp .env.example .env
# .env already contains:
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Run migrations:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  pnpm db:migrate
```

Start the server:

```sh
pnpm dev
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted PostgreSQL provider. [Supabase](https://supabase.com/) is a good option with a free tier.

### Setup

1. Create a project at [database.new](https://database.new)
2. Go to **Project Settings > Database > Connection string**
3. Copy the URI and replace the password placeholder with your database password

### Connection string

Supabase offers two connection modes:

**Direct connection** (port 5432) — use for migrations and one-off scripts:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**Connection pooling via Supavisor** (port 6543) — use for the application:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

### Configure

For the application runtime, use a direct PostgreSQL connection unless the database client has explicit prepared-statement configuration for your pooling mode:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

If you later run the app with a pooled runtime URL, set `DATABASE_MIGRATION_URL` to the direct connection URL. Paperclip uses it for startup schema checks/migrations and plugin namespace migrations, while the app continues to use `DATABASE_URL` for runtime queries:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
DATABASE_MIGRATION_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

If your transaction-mode pooler does not support protocol-level named prepared statements, set `DATABASE_PREPARED_STATEMENTS=false`. If your pooler supports them, you can opt in with `DATABASE_PREPARED_STATEMENTS=true`. Check your provider's pooler configuration before you enable this setting. Keep `DATABASE_MIGRATION_URL` on a direct connection. Do not edit database client source files as part of deployment setup.

### Client tuning (optional)

All of these are optional; when unset, the driver defaults apply and behavior is unchanged — typical self-hosted setups need none of them:

```sh
DATABASE_PREPARED_STATEMENTS=false   # use false when the pooler does not support named prepared statements
DATABASE_POOL_MAX=25                 # connection pool size; default: 10
DATABASE_IDLE_TIMEOUT_SECONDS=60     # close idle pooled connections; default: 60 (0 = keep open)
DATABASE_CONNECT_TIMEOUT_SECONDS=10  # default: 30
DATABASE_MAX_LIFETIME_SECONDS=1800   # recycle a pooled connection after this long; default: 30-60 min (random)
DATABASE_APPLICATION_NAME=paperclip  # application_name in pg_stat_activity; default: paperclip
```

An explicit `DATABASE_PREPARED_STATEMENTS=true` enables named prepared statements
for parameterized ORM queries, transactions, reserved connections, and dedicated
clients. Postgres.js manages the statement cache. This does not cache query
results. Bound values and returned data stay fresh. Explicit per-query options
still apply, including `prepare: false` and simple-protocol execution. With the
setting unset, ORM queries keep their existing unprepared behavior and tagged
SQL uses the driver default. With `false`, preparation stays disabled.

### Bounded response diagnostics

`PAPERCLIP_DB_RESPONSE_CAPTURE_WINDOW=<start>/<end>` enables one explicit UTC
window. Both timestamps use ISO format ending in `Z`. The window lasts at most
60 seconds and starts within 30 minutes. Unset, invalid, and expired windows
leave database construction unchanged. An expired window stays inactive after a
restart; remove the setting after the investigation.

The diagnostic measures awaited Postgres.js `unsafe` responses before Drizzle
column decoding. It issues no queries. Configuration is read when each database
client is created; setting the environment on an already-running process does
not install the capture on existing clients. Prepare the deployment artifact
before choosing the UTC window, then start the window after rollout and warm-up.

Server entry points use `withDatabaseOperation(owner, action)` to name the work
that executes queries. Owners are fixed semantic labels, never request paths,
company or run IDs, user input, or SQL. The execution owner is captured for each
query and retained through completion, including transactions and dedicated
pools. A prepared query reused by different operations keeps the owner of each
execution. The builder caller is separate from that execution owner.
Owner context is active while a valid future window is armed, up to 30 minutes
before its start, so work that crosses the start boundary keeps its owner. Query
accounting starts only at the window start. With no armed window, or after
expiry, the owner helper calls the action directly without a context scope.

The capture aggregates owner, static schema table, operation, calls, returned
rows, query errors, and total/maximum completion wall time. `totalWallMs` and
`maxWallMs` include pool, database, network, and event-loop waits; they are not
CPU measurements, and concurrent query durations overlap. Timing excludes the
capture's response sizing. Rank calls and returned rows both per second and per
completed service operation; a busy owner is not necessarily wasteful.

Response sizing samples successful results 1, 17, 33, and so on per aggregate
group (`sampleEvery: 16`). It examines at most
256 cells, 65,536 string code units, and 65,536 value bytes per sampled result;
an individual string over 16,384 code units is not measured. Parsed objects and
other complex values are not serialized. Oversized, complex, or unexamined
values leave an incomplete sample. `sampledValueBytes` is a lower bound over
sampled primitive values, not a total response-size estimate or network bytes.
Do not extrapolate it as the total bytes returned by the database. Inspect
`sampledResults`, `sampledRows`, `measuredValues`, `unmeasuredValues`, and
`incompleteSamples` alongside it. `sizingWallMs` records the diagnostic's sizing
work separately. Use a separate capture-disabled CPU profile to measure normal
processing cost.

The diagnostic emits at most 2,048 aggregate groups and a summary. Measurement
stops at the deadline. Environment-enabled
captures emit at most 64 records per second and can take another 33 seconds to
finish writing the bounded output. Wait for the summary before collecting it.
It never logs SQL, parameters, result
values, connection strings, or query errors. In-flight queries continue normally.

Semantic owners work in a bundled server without source maps. Specific owners
avoid stack capture. The generic `http.request` owner keeps its exact name but,
like an unowned query, also captures a bounded caller location during the window.
For wrapped query builders, a map-free hosted bundle retains one static generated
construction-site anchor (`dist-runtime/server.mjs`, `index.mjs`, or
`chunk-<build hash>.mjs`, with line and column). Correlate it with the exact serving
revision and bundle; it is not a TypeScript location or an execution-time CPU
owner. Capture wrapper frames are excluded before reading the stack, and deeper
frames in the same bundle are omitted.

Unscoped driver calls, including relational queries, do not accept generated
anchors: a bundled ORM helper could otherwise be mistaken for an application
caller. They can still retain existing public source/dist locations; linked
source maps and Node's `--enable-source-maps` may help resolve those locations.
Restore prior Node options after capture. Missing callers remain unknown and
still contribute to totals. Disabled, future and expired windows do not capture
stacks; wrappers installed for an armed window remain after expiry. Active census
stack capture, grouping and bounded sizing add measurement overhead. More caller
groups still share the existing group, page and output-rate caps. This diagnostic
is not a production performance improvement.

Look for `paperclip.db_response_capture.entry.v2` and
`paperclip.db_response_capture.summary.v2` in the process logs. Version 2 uses
sampled, bounded primitive-value sizing; do not interpret it as the version 1
all-result byte estimate. A log provider
can store `event` as a structured field instead of message text. Filter by that
field or read the bounded window from the exact deployment. Check the summary
and group totals, including the unattributed overflow group.

Fetch a complete capture as follows:

1. Read the summary events from the exact deployment and window. Keep each
   distinct `captureId` separately.
2. Each entry has a unique `groupIndex` within that capture and a `groupPage`.
   The summary gives `groupPageSize` (128) and `groupPages`. Fetch every page
   from zero through `groupPages - 1`, filtering on the entry event, `captureId`,
   and `groupPage`. Request at least `groupPageSize` matching records per page.
   A structured query can use
   `@event:paperclip.db_response_capture.entry.v2 AND @captureId:<id> AND @groupPage:0`.
3. If the provider's record limit is smaller than a page, fetch each
   `groupIndex` separately with the same capture ID. Each index matches one
   entry. Do not split by timestamp: entries can share a timestamp.
4. Deduplicate by `(captureId, groupIndex)`. Require every index from zero
   through `groups - 1`, with no gaps. Entry count must equal `groups`, summed
   `calls` must equal `completedQueries`, and summed `rows`, `sampledResults`,
   and `sampledValueBytes` must equal their summary totals. A missing page is an
   incomplete measurement. Keep overflow and unattributed groups visible.

Tagged raw-driver calls, streams, unawaited raw-driver
dispatch, and protocol overhead are not measured. Relational queries use a driver-level caller fallback.
Queries still in flight at the deadline are reported separately. The census does
not include every PostgreSQL statement or internal transaction command, so its
calls are not interchangeable with database-wide commit counters. It does not
measure SQL compilation, driver parsing CPU, or Drizzle row-mapping CPU. Use the
ranked owners to choose a narrow follow-up profile or synchronous-stage
measurement; do not attribute CPU by subtracting process CPU usage across an
asynchronous query. Remove the capture setting after collecting its final
summary; the absolute deadline already prevents further measurement.

### Push the schema

```sh
# Use the direct connection (port 5432) for schema changes
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@...5432/postgres \
  pnpm db:migrate
```

### Free tier limits

- 500 MB database storage
- 200 concurrent connections
- Projects pause after 1 week of inactivity

See [Supabase pricing](https://supabase.com/pricing) for current details.

## Connection loss and retries

HTTP access logs distinguish a completed response from a connection that closes
before or during the response. An aborted request has no success status in the
log message. The structured response status is null when headers were not sent;
after headers, it retains the status sent before the abort. These logs describe
HTTP delivery, not database settlement. A disconnected issue PATCH may continue
running, so an aborted response does not prove that its writes rolled back.

The database client does not replay arbitrary statements after a disconnect.
PostgreSQL may have committed a statement before the connection loses its
response. The postgres.js message `write CONNECTION_CLOSED` does not prove
that the statement was never sent: the driver also uses it when an in-flight
query loses its connection. SQL text cannot establish replay safety either;
a `SELECT` can call a function with side effects.

The affected operation fails and a new operation can reconnect through the
pool. Callers may retry only when the complete operation is idempotent or has
a durable receipt that prevents duplicate effects. Some transient statement
failures therefore reach the caller instead of being retried automatically.

When a database connection closes, its transaction fails. Paperclip does not
replay that transaction. New requests can use a fresh connection from the pool.
Queries from the failed transaction must keep failing, even after the pool
reconnects.

Source builds carry `patches/postgres@3.4.9.patch` for this behavior. It rejects
queued and later queries from a disconnected transaction or reserved connection,
and prevents a released, closed connection from returning to the open pool.
The patch covers both ESM and CommonJS. The regression suite terminates real
PostgreSQL backends and checks rejection, pool recovery, and transaction isolation.
Remove the patch when an upstream release passes these tests. Installs of the
unmodified `postgres` package outside this workspace do not include the patch.

The patch also preserves transaction connection reservation when pipelining is
disabled with `PGMAX_PIPELINE=0`. Without this fix, the driver's pipeline capacity
check skips the transaction reservation callback and `BEGIN` fails with
`UNSAFE_TRANSACTION`. Disabling pipelining makes a queued query wait for the next
available pool connection instead of sending it behind unrelated work on a busy
connection. This can help interactive requests that share a prepared-query pool
with slow background work. It does not make the SQL itself faster. The default
pipeline limit remains unchanged. Test transaction behavior before using this
setting with a driver build that does not include the patch.

Trusted-header actor synchronization retries transient connection failures,
including `CONNECT_TIMEOUT`, at most twice. This retry applies only to the
idempotent actor synchronization operations, not arbitrary transactions. A
persistent outage still fails the request after the bounded retries; each
connection attempt remains subject to the configured database connect timeout.

The dashboard's company lookup, agent and task counts, pending approval count,
monthly spend, and run activity aggregate each retry these connection errors
at most twice. The heartbeat run list and base issue lookup by UUID or identifier
use the same bounded retries. Each callback is read-only and rebuilds its query
for each attempt. A failed read does not replay completed reads, the budget
workflow, or issue label and watchdog enrichment. Missing resources,
authentication errors, and other database errors retain their usual behavior.
This does not enable general SQL replay or retry a full request.

The task run list also opts its execution-status projection into these bounded
retries. Each of its four read-only lookups rebuilds only the failed query;
completed lookups and the separate liveness backfill are not replayed. Projection
callers that use a transaction retain single-attempt reads. The opt-in is only
for a pooled database handle outside a transaction.

The heartbeat run read check uses the same bounded retries. Routes call it with
the pooled database handle. Its issue existence lookup and its `issue:read`
authorization decision retry separately, so a disconnect in the decision does not
replay the completed lookup. Both steps only read. Missing issues, denied
decisions, and other errors keep their usual behavior.

## Wake admission transactions

Wake admission reserves one database connection and locks the issue row.
Session workspace checks and responsible-user lookups use that same connection.
Their routine, parent, company, and membership lookups also use it.
A transaction must not wait for another connection from its own pool.
Concurrent admissions can occupy every connection and prevent either lookup from completing.

The `heartbeat-admission-pool.test.ts` suite admits N+1 candidates with N connections.
It checks isolated workspaces and both issue-scoped and unscoped wake admission.

## Tool profile reads

Tool profile list, detail, and new-tool review queries select only the catalog
identity, selector, and review fields that they use. They do not load tool input
or output schemas, annotations, or provider metadata. Application and connection
lookups for these paths read only IDs and display names. Profile entries,
bindings, counts, review descriptions, and company filters retain their existing
behavior. The full catalog and tool execution paths still read their schemas.
Attention counts use the same catalog projection and read only invocation IDs
and connection IDs to associate pending requests. Summary queries also omit
review titles and descriptions; the separate review query still returns them.

Internal effective-tool assignment lookups use the same catalog projection.
Run preparation, native runtime setup, and connection policy checks need tool
IDs and names, not complete tool definitions. They still resolve current profile
bindings, selectors, exclusions, and installed connections on every call. The
public effective-profile response continues to include complete tool schemas
and annotations.

Connection readiness checks use a scoped assignment reader. It applies the same
current profile precedence, selectors, and exclusions to the candidate connection
IDs. The reader selects rule match fields and catalog identities. It does not
load rule conditions, catalog schemas, profile summaries, or the company-agent
list. Installed connections and later identity and gateway checks remain fresh.
Full effective-profile and effective-tool responses keep their complete shape.
