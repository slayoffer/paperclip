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

## Remote workspace row locks

The runtime workspace service takes company `KEY SHARE`, current task `UPDATE`,
run `UPDATE`, then workspace `UPDATE` locks. It rechecks the run's task binding
under the run lock. A shared workspace can retain a different original source
task; new provisioning and snapshot operations belong to the current run's task.
Existing operation receipts keep their recorded attribution.

| Owning transaction | Locks after company, current task and run |
| --- | --- |
| Workspace reservation | Shared-selection advisory lock when needed, workspace |
| Preparation publication | Workspace, source lease, existing restore receipt |
| Snapshot reservation and publication | Workspace, operation and snapshot rows |
| Provisioning reservation | Workspace, existing operation or new receipt |

`workspace_operations` has ordinary company, task, run and workspace foreign
keys. An insert takes `KEY SHARE` locks on those parents even when the service
does not explicitly select them. Locking the parents first prevents their
foreign-key checks, or a later run-reference write, from reversing the order.
File preservation already takes task, run, workspace and lease locks in that
order. Confirmed lease destruction locks matching workspaces before the lease;
its workspace-location update takes no task or run lock afterward.

Provisioning settlement and save-invocation settlement lock the workspace and
update existing receipt metadata. They neither add a parent foreign-key
reference nor lock a task or run afterward. Snapshot upload and retention own
snapshot rows; the snapshot ledger has no parent foreign keys. These paths do
not need an otherwise unused parent lock.

Administrative import reservation takes company `KEY SHARE`, original source
task `UPDATE`, then workspace `UPDATE`, and rechecks that source binding. This
also applies to an already-imported no-op, which can overlap runtime saves.
Import publication takes the same company and recorded source-task locks before
its legacy coordinator and run locks, then the workspace and saved allocation
leases. Native claim, status and cancellation owners do not share one row-lock
order. Import therefore requests those legacy coordinator, run and lease locks
with `NOWAIT`. A real `55P03` aborts the publication transaction and reports
`remote_workspace_migration_blocked:execution_rows_busy`. The journal, uploaded
archive and local files remain available for a later administrative retry. Other
database errors propagate. No automatic retry or lock-strength reduction occurs.

Offline import can preserve an active task recovery hold after its exact native
workspace reference is finalized. It checks the terminal run, released controller
and coordinator ownership, task relationship, and any recorded file allocations.
An accepted result with a retrying coordinator also needs the successful
company/run/task `workspace_finalize` receipt consumed by the normal finalizer.
Historical receipts can have no workspace foreign key. Import retains recovery
rows, task pointers, results and coordinator phases. It does not establish provider
termination or resolve the hold. It locks and rechecks the saved evidence before
publication. An unrelated historical folder keeps the obligation on its real
source workspace.

Finalized file sources receive a separate `finalizedWorkspaceRecoveryMigration`
run marker and an exact migration-operation receipt. They do not receive the
legacy execution-replay suppression marker. Future recovery exports an immutable
snapshot of the recorded allocation instead of merging into the retired local
folder. The existing source, provider-stop and archive checks still apply.
Completed copyback recovery receipts remain valid. Unknown or unverified recovery
sources continue to block import.

Online import can preserve an established provider session's prepared source
after a terminal provider-artifact failure. It requires the exact board-owned
native failure block and the task's current blocked status version, released
controller and coordinator ownership, and all declared allocation bindings.
Source locks and the finalizer lock protect the full action, task and source
fingerprints through publication. Import saves only the current local files. It
retains the prepared reference, provider checkpoint, remote allocations and
recovery hold. The existing migration recipe routes later file recovery away
from the retired local destination. This neither declares preexecution nor
proves remote export, provider termination or permission to resume execution.

An exhausted prepared-export hold can also retain the canonical historical-source
marker added by recovery backfill. Its schema and run must match, and every unique
recorded lease must already belong to the proven prepared source or its declared
recovery allocations. The existing historical-source inspector verifies those
same allocation bindings. Unknown fields, malformed markers and foreign, duplicate
or uncovered lease references still block import.

The full historical marker stays in the action fingerprint. Existing source,
task, lifecycle and finalizer locks and publication reinspection remain required.
This permits preservation of the current local files only. It neither clears the
hold nor claims that remote files were copied or a provider stopped. Marked holds
add bounded database reads during maintenance inspection; they add no provider
calls or recurring background work.

The workspace fingerprint pins the recorded source. An arriving reservation can
reach a legacy workspace before refusing it, so publication must follow this
order too. The lifecycle advisory lock alone does not fence runtime operations.
Publication still rechecks current writers and unresolved work. Offline imports
also require the deployment-stopped maintenance fence. Ordinary save requires an
existing prepared remote location and refuses the unpublished legacy authority.

The workspace lock still serializes generations and publication. Foreign keys,
ownership and epoch checks, and transaction-aware work notifications remain in
place. Remote preparation, command execution, archive capture and object upload
run outside these transactions. No workspace or parent row lock spans that I/O.

## Execution admission accounting

The execution-admission module (`server/src/modules/execution-admission/`) owns
three tables. Nothing writes admissions or caps in production yet, and no claim
path enforces a project maximum.

- `project_task_execution_policies` stores a project's maximum concurrent tasks
  apart from `projects`, so project readers never return an unenforced cap. No
  row means never configured. A row with a null maximum means an explicit "no
  limit", which a later legacy migration must not overwrite. Maximums are
  positive. The row is deleted with its project.
- `execution_admissions` stores one admission attempt of a run. A run can be
  released before dispatch and admitted again, so `(run_id, attempt)` is unique
  and a partial unique index allows one unsettled attempt per run. The row keeps
  the context revision, the nullable primary project as provenance (no foreign
  key) and the settlement identity, which is set together with `settled_at`.
  `admitted_project_ids` is the complete admitted project set, sorted, kept
  after settlement and immutable (a trigger rejects any change). It has no
  project foreign key, so settled history never blocks project deletion and
  keeps the deleted project's ID. `{}` is a known empty set. Null means
  unknown and is allowed only on settled rows: migration `0428` filled it from
  the charges of unsettled rows, but settled `0426` rows had already lost
  their set. A retained provider session resumes with the previous set ∪ the
  current references; an unknown previous set requires a fresh context, never
  an empty or primary-only guess.
- `execution_admission_project_charges` stores one row per distinct admitted
  project, including unlimited projects. An admission without projects has no
  rows. Composite `(company_id, …)` foreign keys keep admissions and projects in
  one company. Rows are the only active capacity and exist only while the
  admission is unsettled: settlement deletes the whole set in one transaction,
  and `(company_id, project_id)` is indexed for active counts, so lookups
  scale with active work, not history.

Archiving a project changes no charge. Deleting a project with a charge returns
`409 project_execution_admission_pending`; the foreign key is the backstop.
Deleting an agent refuses unsettled admissions on its runs and removes settled
ones, with their sets, together with the runs. Company deletion removes the company's admissions before its runs and
projects.

The proposed global lock order for the admission transaction is: company row
(`FOR NO KEY UPDATE`), native finalization recovery owner, the whole project set
in ascending ID order (`FOR NO KEY UPDATE`, one statement), issues, wake
requests, the run, the external-admission advisory lock, the admission row and
its charges, then budget reservations. Policy updates take the same project
lock. Settlement takes no project lock. Only the project-set step is implemented
so far; claim paths keep their current locks until they are integrated.

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

## Managed adapter settings

Cloud-managed instances keep adapter selection preferences in the private
`instance_settings` singleton `adapter-settings:v1`. Its `general` JSON contains
`version: 1`, a monotonic `revision`, and `disabledTypes`. It is separate from
the public `default` settings row and never appears in the instance settings API.
Each update locks this row in a transaction. The update and company activity
records commit together. Discovery and new-agent admission read the database
at their asynchronous operation boundaries; no polling or mutable settings cache
is used. Disabled adapters remain available to existing agents.

`PAPERCLIP_ADAPTERS` and `PAPERCLIP_ADAPTERS_FILE` declare the effective operator
adapter list. The declaration is parsed once for a process configuration and
validated at startup. It does not rewrite stored preferences. A conflicting
adapter toggle returns 403. Removing the declaration restores saved choices.
Operator file edits require a restart. Self-hosted instances continue to use
`adapter-settings.json` for saved preferences.

The server-only adapter settings service exposes `inspectStored()` and
`seedIfAbsent({ disabledTypes }, transaction?)` for migration tooling. Seeding
uses the unique singleton key, returns `{ seeded, current }`, and never replaces
an existing record. The caller can use the same transaction for its import
receipt. Before admission, `initializeAdapterSettings` checks the durable row.
When absent, it imports a valid legacy settings file once, retaining unknown
adapter types, or seeds empty preferences if no file exists. It rejects files
larger than 64 KiB, malformed input, and read failures. An existing durable row
wins over every stale file. Ordinary Cloud reads do not read a legacy file.

The focused PostgreSQL suite can use an owned disposable PostgreSQL database via
`PAPERCLIP_ADAPTER_SETTINGS_TEST_DATABASE_URL` when embedded PostgreSQL is
unavailable. It applies migrations and inserts test data, so never point this
variable at an existing application database.

## Cloud configuration migration receipt

The private `instance_settings` singleton `cloud-configuration-migration:v1`
records atomic import completion, semantic source digests, imported revisions,
and metadata-only external adapter blockers. It composes the adapter and
startup-config owners without replacing an existing authoritative row. Receipt
locking and the import transaction handle concurrent attempts and retries; no
local completion marker participates in conflict resolution.

Qualification records current configuration revisions and selected image package
evidence before normal plugin reconciliation. Image inspection does not hold
admin write locks; configuration and registration snapshots are rechecked in a
short transaction before the report is saved. A historical successful report
never grants current eligibility. External metadata blockers survive loss of the
legacy home and require a deliberate revision-checked recheck of a present valid
original source file. Package mismatches remain recorded after maintenance
reconciliation. See the [bounded migration and qualification procedure](../cloud-configuration-migration.md)
for the stopped-writer prerequisite, commands, retry semantics, integrity limits,
and the explicit exclusion of secret bytes, whole-server zero downtime, and
volume removal.

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

## Native finalization history and idle sleep

Idle sleep retains committed native finalization records as audit history.
A record permits sleep only after its owned run, accepted result, assessment,
applied status decision, and effect deliveries agree on completion. Leases,
retries, recovery requests, unfinished accounting, and incomplete run projections
keep the instance awake. Historical controller identity alone does not block sleep.
The exact run also needs its successful workspace-finalization receipt. Pending
final-reply recovery shares its discovery predicate with the recovery worker, and
live warm sessions remain local work through close/checkpoint completion.

## Feedback history and idle sleep

Automatic idle checks treat private, unshared feedback as saved data. A sent
feedback export is history only when its completion timestamp exists and its
failure reason is clear. Pending, failed, unknown, and inconsistent exports
still keep the instance awake. These checks do not delete history or change
feedback sharing and retry behavior.
