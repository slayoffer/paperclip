# Database: part 2

## Resource membership tables

Paperclip stores current-user sidebar membership state in:

- `project_memberships`
- `agent_memberships`

These rows are company-scoped and user-scoped. A missing row means the user is joined, so existing users keep seeing projects and agents in the sidebar until they explicitly leave them. Rows only control sidebar visibility; they do not affect project/agent detail access, all-pages, selectors, assignment flows, or existing company permissions.

Both tables use a unique key on `(company_id, user_id, resource_id)` and keep `state` as `joined` or `left`. Join/leave mutations are idempotent board-user `/me` operations and write activity entries when the effective state changes.

## Decision training snapshot retention

`decision_training_examples` stores a point-in-time copy of an issue, its comments, relevant runs, and the selected decision. Each row carries the `scrub_deleted_comments_v1` retention policy marker, and JSONL exports include that marker alongside the snapshot.

- Deleting a captured source comment transactionally replaces that comment in every affected snapshot with a content-free redaction tombstone. The original body, presentation, and metadata are not retained in the training record.
- Deleting an issue deletes its decision-training examples through the `issue_id` foreign-key cascade.
- Deleting a training example deletes only that example and does not mutate the source issue.

This policy makes training exports self-describing while keeping the decision record usable after a comment deletion without retaining content the author removed.

## Decision queues and triage provenance

The decisions desk stores queue membership, decide-by/snooze state, and retention state in `decision_queues`, `decision_queue_items`, `decision_triage`, and `decision_retention`. These sidecars use the stable attention identity `(source_kind, source_id)` so all attention source kinds can participate without copying source titles, bodies, projects, or other visibility-sensitive data.

`decision_triage_events` is append-only history for queue and triage changes. Current rows and history both carry server-derived user/agent, heartbeat run, API-key, and responsible-user attribution where applicable. Queue reads must resolve and authorize their source rows at read time; a sidecar row is never a visibility grant.

Triage writes serialize on the company and attention-source identity so concurrent partial updates preserve both fields and produce monotonic history versions.

`decision_retention` tracks the last observed source `activityAt`, Keep, reversible archive provenance, and monotonic source/archive versions. `decision_archive_notification_outbox` has a unique key over company, source identity, archive version, and immutable origin agent so repeated sweeps cannot enqueue duplicate notifications; delivery claims are retryable and coalesced per agent.

## Native runner persistence

Native runner state is additive to the existing heartbeat tables. Every existing
`heartbeat_runs` row defaults to `runtime_mode = 'legacy'`; adding these columns
does not select the native runtime or start a runner process. Native execution can
record its resolved runtime profile, provider session, driver, completion
contract, durable event cursor, and finalization phase on the run when a later
rollout explicitly selects it.

`completion_contracts`, `native_run_results`, `native_run_finalizations`,
`work_assessments`, `status_decisions`, and `status_decision_effects` form the
append-oriented evidence and status-decision chain. Unique fingerprints,
versions, ordinals, and idempotency keys make retries deterministic. Composite
foreign keys bind every contract, result, assessment, decision, effect, and
finalization to one company, issue, and run. The database rejects mixed-owner
evidence even when every referenced ID exists. Native source identities on
`heartbeat_run_events` are nullable so legacy events remain readable without
rewriting historical rows. Per-run native source identifiers are unique, while
the existing legacy sequence behavior remains unchanged. The hidden native
coordinator serializes on its bound `heartbeat_runs` row, allocates
`next_event_seq`, and commits a validated PRP event before the transport sends
its cumulative ACK. Byte-equivalent source retries return the existing cursor;
gaps and conflicting replays fail closed. Accepted structured results enter the
finalization ledger, whose retry time and owner lease are checked under a row
lock. None of these writes selects a runtime or changes a legacy run's execution
path.

Durable agent session goals are an additive projection on
`agent_task_sessions`, distinct from the business-goal hierarchy. The row stores
the negotiated goal capability, normalized snapshot and status, desired state,
provider source cursor, monotonic projection revision, and observation time.
`agent_session_goal_actions` is the control outbox: `(session_id, request_id)`
is unique, so retries return the original accepted action. Provider source
ordering fences duplicate and stale updates, and a cleared projection retains
its revision/cursor tombstone so an older provider event cannot resurrect it.

Issue `status_version` advances only when `status` changes. The JavaScript backup
path includes user-defined functions and triggers so a restored database keeps
that invariant. Removing or disabling a future native rollout flag must not
delete these records; persisted experimental runs remain available for recovery
and inspection.

`native_run_finalizations` also stores restart ownership and recovery state.
The controller owner is a server boot id, PID, operating-system process-start
timestamp, and monotonically increasing controller generation. Recovery writes
its correlated request id, current state, and a bounded JSON history. A
successor can take the lease immediately only when coordinated handoff or PID
and process-start evidence proves the prior controller is gone, or when the
lease expires. Recovery generation changes do not increment the independent
provider-attempt counter.

## Chat communication snapshots

Chat communication guidance uses two additive columns: endpoint
`communication_instructions` defaults to empty, and conversation
`communication_guidance` holds the immutable initial task snapshot. Existing
conversations retain a null snapshot; there is no backfill that changes an
ongoing conversation. New Slack tasks receive built-in guidance even when the
endpoint has no additional instructions.

## Telegram private draft identities

`chat_telegram_draft_ids` is a content-free, instance-wide PostgreSQL sequence,
not a company-owned record. Telegram's native Stop callback carries a draft ID
but no actor or Paperclip generation. IDs therefore must not be recycled when
a transaction rolls back or an endpoint/company is deleted and its bot is
connected again. The sequence allocates positive 31-bit IDs without cycling;
exhaustion refuses new draft allocation rather than wrapping or falling back to
random IDs. Never reset it as part of chat cleanup.

The matching `chat_actions` entry remains company/endpoint-scoped and binds the
draft to its exact conversation, publication attempt, runtime, credential and
approved text. Stop can suppress that private draft's final publication; it
cannot cancel a task or model run. Logical backups preserve the sequence, but
restoring an older database may roll back its high-water mark: disaster recovery
must not assume stale provider Stop events are safe to reuse. That restore
boundary is not qualified by the rollback/concurrency regression.

## Attachment upload provenance

`issue_attachments.originating_run_id` records server-derived run attribution at
upload time. It is not writable through attachment or work-product update APIs.
Legacy attachments and uploads without a registered run keep a null value; the
migration deliberately does not infer attribution from mutable work products.
Deleting the originating run clears the reference and fails closed for automatic
chat handoff. An agent's external file selection must match the attachment's
company, task, agent, and originating run. Editing or recreating a work-product
record cannot reassign that authority to a later run.

## Question-response delivery receipts

`issue_question_response_deliveries` is the retry-safe, content-free outbox for
answered `ask_user_questions` interactions. Its unique interaction and correlation
indexes enforce one causal delivery per response. It records source and target
run/turn ids, payload digest, attempt/acknowledgement state, and one of `steered`,
`coalesced`, or `wake_fallback`; answer content remains only in
`issue_thread_interactions.result`. Deleting the interaction cascades its receipt,
while deleting a referenced run clears that run pointer without deleting history.

## Plugin database namespaces

The plugin runtime tracks plugin-owned database namespaces and migrations in `plugin_database_namespaces` and `plugin_migrations`. Hosted deployments that separate runtime and migration connections should set `DATABASE_MIGRATION_URL`; plugin namespace migration work uses the migration connection when present.

## Backups

Paperclip supports automatic and manual logical database backups. These dumps include
non-system database schemas such as `public`, the Drizzle migration journal, and
plugin-owned database schemas. See `doc/DEVELOPING.md` for the current
`paperclipai db:backup` / `pnpm db:backup` commands and backup retention
configuration.

Database backups do not include non-database instance files such as local-disk
uploads, workspace files, or the local encrypted secrets master key. Back those paths
up separately when you need full instance disaster recovery.

## Secret storage

Paperclip stores secret metadata and versions in:

- `user_secret_definitions`
- `user_secret_declarations`
- `company_secrets`
- `company_secret_versions`
- `company_secret_bindings`
- `secret_access_events`

Company secrets use `company_secrets.scope = 'company'` and are bound directly
through `company_secret_bindings`. User-specific secrets reuse the same provider
and version storage, but each value is a `company_secrets.scope = 'user'` row
with `owner_user_id` and `user_secret_definition_id` set. Definitions describe
the reusable company-level slot, declarations record where `user_secret_ref`
bindings are required, and the concrete value is selected later for the
responsible user.

Secret-aware env bindings are supported by agents, projects, and routines. Routine env lives in `routines.env`, is captured in `routine_revisions.snapshot`, and routine dispatches store `routine_runs.routine_revision_id` so runtime secret resolution uses the env snapshot that existed when the run was created. Routine secret refs bind with `target_type = 'routine'`, `target_id = routines.id`, and `config_path` values under `env.*`.

For local/default installs, the active provider is `local_encrypted`:

- Secret material is encrypted at rest with a local master key.
- Default key file: `~/.paperclip/instances/default/secrets/master.key` (auto-created if missing).
- CLI config location: `~/.paperclip/instances/default/config.json` under `secrets.localEncrypted.keyFilePath`.
- Backup/restore requires both the database metadata and the local master key file; either artifact alone is insufficient.
- The server best-effort enforces `0600` key file permissions and provider health reports permission warnings.
- User-scoped values use the same local encrypted provider path. Database
  backups preserve definitions, declarations, owner metadata, version metadata,
  and access events, but restored user-scoped values are decryptable only when
  the matching local master key is restored with the database.

Optional overrides:

- `PAPERCLIP_SECRETS_MASTER_KEY` (32-byte key as base64, hex, or raw 32-char string)
- `PAPERCLIP_SECRETS_MASTER_KEY_FILE` (custom key file path)

Strict mode to block new inline sensitive env values:

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

You can set strict mode and provider defaults via:

```sh
pnpm paperclipai configure --section secrets
```

Inline secret migration command:

```sh
npx paperclipai secrets migrate-inline-env --company-id <company-id> --apply

# direct database maintenance fallback
pnpm secrets:migrate-inline-env --apply
```

Hosted AWS provider notes live in [SECRETS-AWS-PROVIDER.md](.././SECRETS-AWS-PROVIDER.md).

### Persistent agent conversations

Migration `0274_agent_chat.sql` adds conversation identity/state and session generation/boundary columns to `issues`, plus idempotent client request IDs and processed session-boundary generations to `issue_comments`. The company/agent/user unique index resolves concurrent first writes to one issue. A check constraint preserves the assigned-agent identity and prevents terminal conversation status. Comment request IDs are unique per issue and user. There is no separate chat/message store. Provider sessions continue to use `agent_task_sessions`; `/new` removes only the matching conversation session, and session writers fence stale generations against the issue row.

## Resource lifecycle events

`resource_lifecycle_events` records content-free lifecycle hooks in the same
transaction as the resource change. Hired agents and new projects emit `create`.
Pending hires emit creation only when `activatePendingApproval` succeeds.
Rejected hires emit termination without creation. Agents created as terminated
emit no creation event. Capture is generic and works on self-hosted and managed
instances; recording an event does not authorize a provider operation.

A partial unique `(company_id, resource_type, resource_id)` index deduplicates
creation. Each actual agent pause, resume, or termination appends another event,
including budget actions and generic status updates. The agent row stays locked
until status and event commit, so concurrent repeat requests emit one hook.
Project edits and workspace additions, updates, and removals append `update`.
Repository replacement emits one aggregate update; project creation with repositories
emits only creation. Project mutations hold the project row lock until their record
commits. An archive-only change emits nothing and preserves workspace records.
Termination commits API-key revocation in that same transaction.
Hire approval and rejection commit with agent activation or termination, so a
failed event write leaves the decision pending and retryable.

The numeric event ID orders transitions for a resource. Future plugin delivery
must enforce company scope, preserve resource order, and track acknowledgments
per plugin. A global high-water mark can skip transactions that have not yet
committed; it is not a safe delivery cursor. The journal stores only identity,
action, and timestamps, not repository snapshots, credentials, provider config,
or resource health. Company deletion cascades to its events. Resource deletion
retains events, so consumers must revalidate existence and eligibility and load
current authorized repository data. A termination hook does not authorize
removing persistent VM or project data.

The migration creates an empty table. It does not scan or backfill existing
installs. Plugin delivery, retention, retries, and provider integration are
separate work. This change makes no provider calls and adds no plugin read API.
