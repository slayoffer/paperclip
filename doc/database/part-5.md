# Database: part 5

### Execution recovery query performance

Conversation recovery keeps indexed run and task UUID columns as UUIDs. Saved
JSON identifiers pass a canonical lowercase UUID guard before conversion.
Malformed, uppercase, numeric and cross-company values retain their old behavior.
Ownership candidate reads split native and legacy issue bindings so existing
indexes can filter candidates before reading large contexts. Native bindings
continue to override legacy context IDs. No new index or migration is needed.

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-recovery-queries.ts --baseline-ref=1e731520bb
```

This disposable fixture compares the real ownership, recovery-action and status
delivery queries, including complete positional results and database plans.
All data is synthetic. Query timings exclude process liveness probes, HTTP and
provider work.

### Agent runtime synchronization journal

Migration 0347 adds the opt-in `agent_runtime` resource stream. Database triggers
record content-free configuration invalidations and managed file audit events in
`resource_lifecycle_events`. They share the mutation transaction and fail the
mutation if journal insertion fails. An INSERT trigger sends an empty PostgreSQL
notification on `paperclip_plugin_lifecycle` after commit. The host subscribes
only when a ready runtime subscriber is installed. This feature requires a
session-compatible database connection; do not enable it through a transaction
pooler. Reconnection scans the durable journal. Existing process-local work
signals continue to serve other delivery queues. See
[the plugin contract](../plugins/AGENT_RUNTIME_SYNC.md).

Migration 0354 extends this stream to standing connection assignments. Statement
triggers compare the fields returned by the assignment snapshot and coalesce
company invalidation within the mutation transaction. Agent runtime journaling
uses ordered `FOR NO KEY UPDATE` locks, which remain compatible with foreign-key
references while excluding runtime readers' `FOR SHARE` locks. Connector feature
switches use the same journal; process-start overlays receive a delivery baseline.

Migration 0355 extends connector invalidation to tool definitions and
configuration. Statement triggers cover applications, connections, catalogs,
profiles and entries, bindings, policies, and MCP gateways. They ignore health
bookkeeping and trust-rule usage counters. Profile creation alone does not change
an agent's runtime; its assignment does. Entry changes resolve standing profile
bindings; policies resolve old and new agent selectors. Both retain scoped
recipients. Credential-only fields remain outside this migration's coverage.

Migration 0356 adds access, referenced credentials and vaults, and chat/email
endpoint configuration to connector runtime invalidation. Grant and membership
changes retain company scope. Agent secret bindings and new personal delegations
use agent scope. Credential values remain outside the journal. Endpoint activity,
vault health, and other bookkeeping fields remain excluded.

## Retired Pipelines storage

The Pipelines experiment has been removed from the application, API, CLI, and
experimental settings. Its `pipelines` and `pipeline_*` tables, schema definitions,
and migration history remain so existing records, documents, and links are preserved
and future schema generation does not drop them. No removal migration or data
cleanup runs. These tables remain part of normal database backups; the separate
Cases feature is unaffected.

### Prompt injection classification

`company_prompt_injection_prevention` stores optional shared connection/model
preferences without backfilling existing companies. `prompt_injection_invocations`
stores content-free classification verdicts, provider receipts and archival
identity references. Budget reservations have a distinct classifier invocation
source, and cost events accept `prompt_injection`. Unknown charges retain their
holds through agent deletion attempts and settle through billing correction.
See [service behavior](../prompt-injection-prevention.md).

### Deferred conversation requests

`issue_thread_interactions.dismissed_at` and `dismissed_by_user_id` record a
human's decision to leave a pending request in history. They are independent of
`status`, `result`, and `resolved_at`: dismissal is neither an answer nor approval.
The board-only dismissal path locks the task then interaction, checks audience,
and never enqueues a continuation. Ordinary deferred requests are excluded from
completion arbitration; protected authorization gates remain active.

### GitHub inherited review-wait reads

Passive GitHub review waits select only the assessment's `reviewedCommit` JSON
value. The read preserves its JSON type for strict comparison with the review
head. It still checks current requester provenance, company and agent bindings,
connection state, repository identity, latest review, and processed publication.
The complete assessment remains stored for review and publication.

The synthetic PostgreSQL benchmark captures the service-generated baseline and
treatment queries, compares complete outputs, and measures raw DataRow bytes:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-github-review-wait.ts --baseline-ref=663fe667d66d3863d0919a8724f1d99500feef0b
```

It uses disposable embedded PostgreSQL by default. A disposable local database
named `review_wait_benchmark...` can be supplied through
`PAPERCLIP_TEST_DATABASE_URL` to compare another PostgreSQL major version.
DataRow bytes exclude response metadata and transport overhead.

### Sandbox creation ownership

Migration 0418 adds `sandbox_creation_operations`. Admission commits company,
original environment, run, request key and provider identity before external
creation. Configuration contains nonsecret values and existing secret references.
The original identity survives environment, run, task and company deletion; only
the optional live environment FK uses SET NULL. Company/run deletion must not
erase an outstanding remote-resource obligation.

The unique company/environment/run/request index fences duplicate creation and
ambiguous successful lease commits. Normal lease attachment and operation transfer
share a transaction. Recovery transfers one claimed cleanup lease after provider
ownership lookup. The pending deadline index drives the existing cleanup worker.
`needs_reconciliation` is a durable manual outcome, not an automatic retry or an
idle blocker. See [cleanup ownership](../idle-environment-cleanup.md).

## Object-backed run evidence

Optional segmented run logs and raw provider traces store their payloads and
range indexes directly in S3-compatible storage. Existing `heartbeat_runs` and
`provider_trace_records` contain backend/reference and lifecycle metadata;
there is no new payload table or per-segment SQL publication. Object manifests
use conditional writes to fence publication. Existing structured events retain
their database append contract. See [run evidence storage](../run-evidence-storage.md).

## Cloud runtime configuration singleton

The private `instance_settings` key `cloud-runtime-config:v1` holds a strictly
validated, versioned nonsecret configuration and revision. It is separate from
the ordinary instance settings API. Seed inserts preserve an existing winner;
replacements lock the row and reject stale revisions. Database/transaction
handles permit atomic migration receipts. Connection URLs, API keys and unknown
fields are excluded. See [field ownership and startup order](../cloud-runtime-configuration.md).

## Independent accounting and budget evaluation

`budget_evaluation_work` holds independent pending inputs for committed exposure
changes, with company and captured agent/project attribution. Producers append
in their financial transaction after registering transaction-aware notification.
The worker evaluates a consistent snapshot, fences policy publication through
`budget_policies.evaluation_version`, and deletes only its selected committed
input IDs in the publication transaction. A later commit with an older allocated
ID remains pending. Policy creation/edits also append inputs, so a previously
consumed no-policy batch cannot hide a newly applicable threshold.

No financial commit increments a company/agent spend counter or company dirty
version. Monthly API totals aggregate `cost_events`; runtime totals use existing
`accounting_runtime_baselines` plus acknowledged v2 run ledger. Retained counter
columns are non-authoritative. Invoice and verified late-receipt corrections
retain append-only `cost_adjustments` evidence and immutable reported amounts.
`cost_events.reported_usage_json` retains original placeholder usage before a
verified late receipt updates effective token/request fields; each adjustment
retains its previous usage in `previous_usage_json`.
Unknown late run receipts remain durable per-receipt debt; resolving one receipt
cannot clear another unresolved receipt.

Upgrade all controllers/workers to this accounting contract and drain incompatible
pre-upgrade database transactions before enabling independent writers. Do not run
pre-upgrade synchronous counter/evaluation writers beside unlocked writers.
Rollback must use a compatible version that reads the ledger and retains the
durable evaluation feed; a pre-contract binary is not a safe rollback target.

## Standard workspace and Classic opt-in

Migration `0433_workspace_defaults.sql` adds `classic_workspace_enabled`, default
false, to personal workspace preferences and sets the legacy Coordinator column's
default to true. Existing rows retain their old Coordinator experiment values,
but those values no longer select the active workspace. API reads derive
`coordinatorWorkspaceEnabled` from the inverse of the Classic choice. Saves
retain the existing account and company-audit checks. Replaying the migration
preserves explicit Classic choices. Agent Chat ignores its retired stored flag
without rewriting instance settings. No task, agent, or execution state changes.
