# Database: part 4

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

Older embedded databases can use `SQL_ASCII`. Test encoding-sensitive SQL on
both `SQL_ASCII` and UTF-8 databases. Migration `0355` constructs its whitespace
pattern from UTF-8 bytes so legacy databases can compile it, and matches whole
characters instead of trimming individual bytes. Its shipped hash remains a
valid migration receipt; otherwise an upgrade could replay its older connector
triggers over the replacements from `0356`. The encoding migration regression
checks both selector behavior and preservation of that later trigger definition.

The 0126 issue comment attribution backfill showed the failure mode this checklist is meant to prevent: each batch looked for the next rows with an unindexed predicate, so PostgreSQL repeatedly scanned the same table and the migration became O(n²) as the table grew.

When authoring migrations or one-time backfills:

- Create the supporting index for the batch predicate before the backfill loop runs.
- Bound batches by an indexed key, such as an id range or keyset pagination cursor. Do not use `OFFSET` pagination or a query shape that re-scans already-visited rows each batch.
- Avoid unbounded full-table `UPDATE` or `DELETE` statements. Add a selective predicate and process rows in bounded batches when table size can be large.
- Use `CREATE INDEX CONCURRENTLY` for large existing tables when the migration can run outside a transaction and must avoid long write locks.
- Split schema changes, index creation, and data backfill into separate phases so each step has clear locking and rollback behavior.
- Treat the `check:migrations` CI gate as the enforcement backstop for these rules. If it flags a migration, rewrite the migration or add a suppression comment with the indexed predicate, batch bound, and reason the remaining scan is safe.

Private-task migrations `0313` and `0314` are explicitly allowlisted in the
Paperclip executor to run outside a file-wide transaction. Their idempotent
keyset batches commit every 1,000 rows, and migration history is recorded only
when all batches finish. The executor repairs invalid concurrent indexes on
retry. A reserved connection holds a session advisory lock across all batch
commits, so concurrent migrators recheck history only after the preceding runner
finishes. Privacy triggers are replaced atomically. Bootstrap uses the same
executor; other migrations remain transactional
per file. Apply these migrations through `pnpm db:migrate` using a direct
connection, before enabling the new server and UI.

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
cleanup, feedback export, import cleanup, execution reconciliation, Muse maintenance, heartbeat
schedules, and automatic backups. Startup migrations, plugin installation, and
other one-time preparation still run. Normal anonymous health probes return
`warmStandby: true` without SQL or session lookups. This is application liveness,
not a current database connectivity check. Other API requests and WebSocket upgrades return 503 until
the signed claim succeeds. Page and asset requests serve only the static UI
router, bypassing session, bearer-key, tenant, and other dynamic handlers.

Muse defers its startup qualification-evidence update and recurring database
sweeps until standby ends. The first enabled sweep marks interrupted evidence
before it reconciles qualification deadlines or terminal assignments. Claimed
workspaces retain ordinary Muse maintenance even when idle task drain is active.

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

## Feedback history and idle sleep

Automatic idle checks treat private, unshared feedback as saved data. A sent
feedback export is history only when its completion timestamp exists and its
failure reason is clear. Pending, failed, unknown, and inconsistent exports
still keep the instance awake. These checks do not delete history or change
feedback sharing and retry behavior.
