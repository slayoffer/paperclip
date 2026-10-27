# Database: part 1

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

## Wake admission transactions

Wake admission reserves one database connection and locks the issue row.
Session workspace checks and responsible-user lookups use that same connection.
Their routine, parent, company, and membership lookups also use it.
A transaction must not wait for another connection from its own pool.
Concurrent admissions can occupy every connection and prevent either lookup from completing.

The `heartbeat-admission-pool.test.ts` suite admits N+1 candidates with N connections.
It checks isolated workspaces and both issue-scoped and unscoped wake admission.

## Execution identity row locks

The offline publication authority also locks current issue, run, agent, company,
and repository rows before its dispatch decision. Ordinary updates and deletions
use incompatible row locks. Three new company-scoped tables store protected
clock state, synthetic broker registrations, and immutable publication requests.
A database trigger prevents binding changes, dispatch resets, request deletion, and table truncation. A partial
unique index blocks another outstanding dispatch to the same repository branch.
This source has no production route. See [Offline publication authority](../publication-authority.md)
for lock order, synthetic tests, clock limits, and remaining production work.

Identity initialization, credential acquisition, and steering reconciliation lock
the task before its run. These operations use `FOR NO KEY UPDATE`: they change
identity state, not parent keys. The lock still serializes identity writers and
blocks concurrent task or run updates. It allows audit inserts to retain their
foreign-key `KEY SHARE` locks without waiting on identity acquisition. The audit
foreign keys and their deletion behavior remain enforced.

## Switching between modes

The database mode is controlled by `DATABASE_URL`:

| `DATABASE_URL` | Mode |
|---|---|
| Not set | Embedded PostgreSQL (`~/.paperclip/instances/default/db/`) |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

Your Drizzle schema (`packages/db/src/schema/`) stays the same regardless of mode.

## Migration authoring checklist

The 0126 issue comment attribution backfill showed the failure mode this checklist is meant to prevent: each batch looked for the next rows with an unindexed predicate, so PostgreSQL repeatedly scanned the same table and the migration became O(n²) as the table grew.

When authoring migrations or one-time backfills:

- Create the supporting index for the batch predicate before the backfill loop runs.
- Bound batches by an indexed key, such as an id range or keyset pagination cursor. Do not use `OFFSET` pagination or a query shape that re-scans already-visited rows each batch.
- Avoid unbounded full-table `UPDATE` or `DELETE` statements. Add a selective predicate and process rows in bounded batches when table size can be large.
- Use `CREATE INDEX CONCURRENTLY` for large existing tables when the migration can run outside a transaction and must avoid long write locks.
- Split schema changes, index creation, and data backfill into separate phases so each step has clear locking and rollback behavior.
- Treat the `check:migrations` CI gate as the enforcement backstop for these rules. If it flags a migration, rewrite the migration or add a suppression comment with the indexed predicate, batch bound, and reason the remaining scan is safe.

## Wake lookup index

`agent_wakeup_requests_company_idempotency_idx` covers company-scoped wake lookups
with one idempotency key or several keys. The index has no predicate and permits
duplicate keys. The existing partial unique indexes still enforce delivery rules.

The startup migration creates the index inside a transaction. Index creation
blocks writes to this table until the transaction commits. Operators must account
for this lock during deployment. Rollback can retain the index safely.
After deployment, check both query shapes with `EXPLAIN (ANALYZE, BUFFERS)`.
Confirm that each lookup uses the index and takes less than 50 ms.

## Heartbeat issue and recovery indexes

Three expression indexes support company-scoped heartbeat lookups:

- `heartbeat_runs_company_issue_coalesce_idx` selects the native issue before the snapshot issue.
- `heartbeat_runs_company_recovery_action_idx` selects the snapshot recovery action.
- `heartbeat_runs_company_issue_task_coalesce_idx` selects the snapshot issue, snapshot task, then native issue.

The first two indexes also order rows by creation time, newest first.
The startup migration creates all three inside one transaction.
This operation scans existing snapshots and blocks table writes until commit.
Schedule deployment for this lock. There is no data backfill.
After deployment, check these expressions with `EXPLAIN (ANALYZE, BUFFERS)`.
Homelab can remove equivalent temporary indexes after these indexes exist and serve the queries.
Rollback can retain the indexes safely.

Ownership projections reuse checks for the same company and issue within one second.
Recovery reuses checks within one transaction pass.
Execution admission always checks current process and lease ownership.
Successful HTTP requests above two seconds produce warnings, including silent polling routes.
The warning includes the method, sanitized path, status, and duration in milliseconds.

## Migration snapshots

`drizzle-kit generate` diffs `packages/db/src/schema/` against the newest snapshot in `packages/db/src/migrations/meta/`. That snapshot must describe the schema that every migration produces when they run in order. A snapshot that drifts from the schema makes the *next* migration wrong, because `generate` folds the drift into it. The drift can add a column that an earlier migration already created, which makes that migration fail on a fresh database. It can also drop a column that the schema still uses.

- Create every migration with `pnpm --filter @paperclipai/db generate`. Do not hand-write a snapshot.
- Do not hand-edit a snapshot to resolve a merge conflict. Renumber your migration and run `generate` again, as `packages/db/.gitattributes` describes.
- The repo keeps only the newest 5 snapshots. `generate` runs `prune:snapshots` afterwards to delete older ones. Drizzle only reads the newest snapshot, and each snapshot is a full copy of the schema (over 1 MB each). Older snapshots are still in git history.
- `packages/db/src/migration-snapshot-drift.test.ts` is the enforcement backstop. It repeats the diff that `generate` performs and fails when the newest snapshot no longer matches `packages/db/src/schema/`.

## Cloud runtime identity singleton

The private `instance_settings` row whose singleton key is
`cloud-runtime-identity/v1` records the immutable Cloud stack id, warm-pool
claim id, previous pool origin, canonical origin, and stack slug accepted from
Cloud's signed pre-activation assertion. It is separate from the normal
`default` settings row and never appears in the settings API. This is
intentionally instance-scoped rather than company-scoped: an instance has one
public identity, and the existing unique singleton-key index makes concurrent
or later attempts to replace it fail closed. The server loads the row before
constructing URL-dependent runtime services on every boot.

### Unclaimed Cloud warm standby

`PAPERCLIP_CLOUD_WARM_STANDBY=1` is an opt-in control-plane marker for an
unclaimed warm application. It requires Cloud configuration, a stack identity,
and runtime identity verification keys. After restoring the durable identity,
startup checks once for company data. Existing companies or a persisted claim
keep the application fully active. A failed database check fails startup.

An empty unclaimed application keeps its HTTP server and sandbox plugins ready,
but skips recurring database work: chat/email delivery, plugin jobs, browser
cleanup, feedback export, import cleanup, execution reconciliation, heartbeat
schedules, and automatic backups. Startup migrations, plugin installation, and
other one-time preparation still run. Normal anonymous health probes return
`warmStandby: true` without SQL or session lookups. This is application liveness,
not a current database connectivity check. Other API requests and WebSocket upgrades return 503 until
the signed claim succeeds. Page and asset requests serve only the static UI
router, bypassing session, bearer-key, tenant, and other dynamic handlers.

The existing signed claim on `GET /api/health` writes the identity durably before
normal requests and polling resume. No polling discovers claims and no process
restart is required. Timers resume on their next normal tick; request-driven
work can proceed immediately. Claim failure leaves standby intact. A restart
restores the claim even if provider environment alignment has not completed.
Deleting a claimed workspace's last company never puts it back into standby.

Deploy support before enabling the marker. Validate idle database transactions
and health probes, claim/bootstrap latency, recurring work after claim, and a
restart with stale provider variables on an isolated warm application first.
Rollback by setting the marker to `0` and restarting. No schema changes are
required. This mechanism does not sleep claimed workspaces or replace a durable
scheduler for their background work.
