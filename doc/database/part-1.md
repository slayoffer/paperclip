# Database: part 1

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

Run-context lookups use expression indexes for both `context_snapshot.issueId`
and `context_snapshot.paperclipIssue.id`. Task creation provenance has its own
company-scoped expression index that follows the query's native issue ID and
legacy `issueId`/`taskId`/`taskKey` precedence. Migration 0345 builds the two new
indexes concurrently and can resume an interrupted build without blocking run
writes for the full build. The indexes add storage and run-write overhead; they
do not change task visibility or secret redaction.

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

Filesystem preparation uses current task/run and selected-configuration checks.
Historical root-reader authorization has been retired; no retained-reader batch is
loaded at admission or publication. Workspace-record disclosure still uses task
privacy checks, independently of filesystem access.

The initial agent JWT run lookup reads only the cancellation state and
conversation flag from saved run JSON. It does not transfer the full context or
result. Run status, responsible-user identity, company and agent boundaries,
and the cancellation response remain unchanged. Later identity refreshes keep
their existing transaction and data reads.

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

If your hosted database requires transaction-pooling-only connections (pgbouncer transaction mode, Supavisor port 6543, Neon `-pooler` endpoints), set `DATABASE_PREPARED_STATEMENTS=false` so the client does not rely on session-scoped prepared statements, and keep `DATABASE_MIGRATION_URL` on a direct connection. Do not edit database client source files as part of deployment setup.

### Client tuning (optional)

All of these are optional; when unset, the driver defaults apply and behavior is unchanged — typical self-hosted setups need none of them:

```sh
DATABASE_PREPARED_STATEMENTS=false   # required for transaction-mode poolers; default: enabled
DATABASE_POOL_MAX=25                 # connection pool size; default: 10
DATABASE_IDLE_TIMEOUT_SECONDS=60     # close idle pooled connections; default: 60 (0 = keep open)
DATABASE_CONNECT_TIMEOUT_SECONDS=10  # default: 30
DATABASE_MAX_LIFETIME_SECONDS=1800   # recycle a pooled connection after this long; default: 30-60 min (random)
DATABASE_APPLICATION_NAME=paperclip  # application_name in pg_stat_activity; default: paperclip
```

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
