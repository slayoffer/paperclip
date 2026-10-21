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
