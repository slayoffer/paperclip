# Database: part 3

## Legacy controller ownership

Legacy run claims atomically record `controller_boot_id`, a database-clock
`controller_lease_expires_at`, and `execution_stage` before workspace provisioning.
The lease renews independently of output. A different container must not infer
controller death from its own process map or numeric PIDs. Expiration grants
cleanup authority; it does not prove that remote inference has stopped. Recovery
revokes the previous boot identity with a conditional update. Its own claim also
expires so another sweep can finish cleanup after a restart. Historical rows keep
null ownership fields and follow the previous recovery path.

## Agent file persistence and legacy revisions

Managed agent files are current filesystem contents, using the same persistent
instance storage as other workspaces. `agent_instruction_revisions` and
`agent_instruction_heads` are retained as read-only upgrade input. Their heads
are adopted once into the managed directory; new saves never append revisions.
`agent_instruction_working_copies` holds per-run baseline hashes, state, and
capture receipts. New receipts identify `paperclip.agent-files.v1`; historical
rows retain the instruction-only format. Completed directory runs discard their
baseline and private copies. See [Persistent agent files](../agent-files.md).

## Large API response snapshots

`assets.byte_size` uses PostgreSQL `bigint` so saved responses and byte ranges can
exceed 2 GiB. The API and Drizzle mapping continue to expose a JavaScript number;
response readers validate safe integer offsets. The type-widening migration
rewrites the asset metadata table and needs an exclusive table lock. File bytes
remain in local or object storage.

### Runner API response reservations

`runner_api_response_reservations` holds company-scoped API snapshot reservations.
Before a capture spills, the server locks company admission and counts stored
`runner-api` assets plus unattached reservations against a 20 GiB default quota.
A committed asset replaces its reservation in that total. The asset foreign key
cascades on deletion, while deleting a run sets `run_id` to null so an orphan
reservation cannot silently disappear. Failed cleanup or an ambiguous storage
write requires operator reconciliation before an unattached reservation is
removed. The table stores no response bodies. See `doc/runner-api-tools.md` for
limits and the operator override.

Project `privacy_owner_user_id` records who may manage its audience independently of project read membership. Creation assigns the authenticated user or run responsible user; migration recovers legacy ownership from creation audit evidence. Missing evidence leaves management with administrators.
## Internal agent commentary

The Audit viewer uses the existing company/kind/created index.
List reads select bounded previews; details load a single full body. Both reads
and list counts apply company and source-task visibility. The viewer requires
no experimental toggle. A permission-only migration grants `commentary:view` to
existing active human company members, including viewers, without changing
existing grants or the commentary schema.

`agent_commentary` stores company-scoped, attributed complaints and suggestions
as free-form text in the instance database. Legacy agents use the default
`complain` and `suggestion-box` runtime skills; native runs use dedicated tools
in standard, ask, and planning modes. Submission never changes task disposition
or routes feedback externally. See [Agent commentary](../agent-commentary.md) for
authentication, replay, document-sized limits, inspection, and deletion semantics.

## Agent identity keys and backups

`agent_identity_keys` stores one encrypted Ed25519 identity per agent. Its migration
creates schema only: existing agents provision on their next managed run. Public
reads and server startup do not provision them. Normal backups preserve identity
rows and need the matching secrets master key for recovery. Both development seed
modes omit identity rows, including with live-work preservation, so copied agents
get fresh identities. See [Agent cryptographic identity](../AGENT-IDENTITY.md).

### Slack app registration

`chat_slack_registrations` stores one company-scoped app registration per chat
endpoint. A composite foreign key binds `(company_id, endpoint_id)` to the
endpoint's company. It contains the creation request ID, immutable manifest
snapshot/hash, OAuth callback URI, app/client IDs, vault references, installation
identity, status, safe failure code, creator, and timestamps. It contains no
plaintext configuration token, OAuth code, signing/client secret, or bot token.

Creation records `creating` before dispatch. An interrupted attempt becomes
`uncertain`; a new request needs explicit confirmation that no app exists.
`install` means the app exists. `credentials_saved` means the OAuth bot token is
vaulted and connection checks can resume. `configured` means runtime credentials
are durably bound; staged duplicates are cleaned and the client secret remains
available for reauthorization. `removed` invalidates registration and keeps the
safe app management link for provider-side cleanup.

`chat_endpoints.setup.slackAvatar` records optional avatar provisioning as
`pending`, `uploaded` with its confirmation timestamp, or `failed` with a fixed
safe error code. It survives reloads and restarts. App credentials are durably
bound before icon upload; an interrupted upload never triggers another app
creation. This JSON state stores no token, image URL, or provider error payload.

`chat_endpoints.setup.slackAccount` stores the OAuth installer’s Slack ID, the
initiating Paperclip user ID, pending/linked status, durable welcome-DM and
optional verification-DM status, and the returned DM channel ID. It stores no
user OAuth token or provider payload.
The account uses the existing company-scoped `chat_identity_links` table; it
preserves conflicting/revoked links and does not change on reauthorization.
Both message dispatches move pending → sending before network I/O, then sent/failed;
a restart or ambiguous response moves sending → uncertain without replay.
Signed Request URL verification can precede installation. Internal setup state
retains a signing-secret fingerprint and observed URL so configuration preserves
that evidence only for the same secret and callback. No plaintext secret is stored
in setup state, and the fingerprint is excluded from endpoint responses.
For automatically registered apps, `webhookVerifiedAt` also records successful
delivery of an authenticated message/app-mention event to the current callback
URL. The current signing secret, saved app/workspace/bot binding, active connection,
and runtime generation are checked before recording it. This is Paperclip's
connection evidence, not Slack's settings-page URL-verification flag. Activity
identifies this evidence as `authenticated_event`; no message body is recorded.

Slack install attempts use `tool_oauth_states` with the `slack-install.` namespace.
They expire after ten minutes, bind the company/connection/endpoint, registration
request ID, app ID, initiating actor/session, callback URI, and requested scopes,
and are atomically deleted before code exchange. The `code_verifier` column holds
this non-secret binding for this namespace; Slack bot installation does not use
PKCE. Removal and manual recovery invalidate outstanding attempts under the same
credential-mutation lease used by configuration.

### Slack manager workspace grants

`chat_slack_manager_grants` stores a personal workspace authorization, scoped by
company, Paperclip user, Slack user, workspace and manager app. Access/refresh
credentials are references to user-scoped vault entries, never plaintext columns.
Revision fencing protects reauthorization from concurrent revocation. Per-method
rate-limit deadlines retain Slack's Retry-After across setup retries.

`chat_slack_registrations.manager_grant_id` is optional, with a composite company
foreign key. Existing registrations remain customer owned with a null reference.
Deleting one endpoint removes its registration credentials and attempts, but does
not revoke grants used by other bots. See [Slack setup](../connections/slack-setup.md).

## Transaction-aware delivery work signals

Durable delivery queues, including plugin resource lifecycle events, use process-local work signals to avoid empty
polling. Register work **before** writing a queue row, on that row's transaction:

```ts
await db.transaction(async tx => {
  await signalDatabaseWork(tx, "queue-topic");
  await tx.insert(existingQueueTable).values(row);
});
```

`createDb` instruments transaction callbacks and nested savepoints. Subscribers
receive intent immediately and settlement only after the outer transaction
finishes. Caller-owned transactions therefore need no extra post-commit wrapper.
Dedicated clients from `withDedicatedDbConnection` share the owner's signal
scope. No schema changes, triggers, dedicated listener connection, or periodic
queries are installed by this API.

The first registered write in a transaction fetches `pg_current_xact_id()`.
Awaiting registration is required: a failure at that point must prevent the
queue write. Unrelated transactions add no queries. If the transaction rejects,
the coordinator probes `pg_xact_status(xid)` through the root pool before scanning
the queue. An in-progress transaction remains unresolved even when the queue
currently looks empty. Committed/aborted results permit reconciliation; NULL
means PostgreSQL has discarded an old, no-longer-active transaction's outcome.
The existing durable queue supplies the work in either case. Probe failures
retain the idle hold and schedule another attempt. Work signals never replay
queries or convert a failed database operation into success.

This uses PostgreSQL's transaction-information functions (this path requires
PostgreSQL 14+; embedded PostgreSQL uses 18). See the
[PostgreSQL transaction information documentation](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-PG-SNAPSHOT).
The process-local intent survives coordinator replacement, but not process exit.
Startup scans recover committed queue rows. Independent DB clients, other
processes, late transactions from an old process, and database failover need an
explicit ownership/wake protocol; these signals are not cross-process messaging.
Use the same root client for in-process writers. New queue insertion paths must
register before writing, or they can remain unseen until the next startup or
another notification. Tests should verify both the producer and its outer
transaction boundary.

### Project repository skill synchronization

`project_skill_sources` stores durable workspace import jobs and originating project
access provenance. Active bindings track their repository/ref; inactive bindings retain
access to installed versions. Project deletion removes bindings, but retained skills
with `access_source_id` stay restricted when no originating project remains.
Removing a project source hides tracking using `company_skill_sources.removed_at`
while retaining its access identity for editable copies and forks. Bindings become
inactive and refresh leases are invalidated transactionally. Reattachment preserves
removal; explicit adoption creates or joins an active source with a separate identity.
Migration 0341 limits repository/ref uniqueness to active sources. Removed sources
retain their original project audience; editable forks capture independent retained
provenance so later attachments cannot expose their local edits. Membership and
project visibility are still evaluated dynamically.

`company_skill_sources` stores automatic-update and future-import preferences, setup
user/agent and connection/grant IDs, next-check time, failure count and existing refresh
leases. Existing sources default to automatic updates with their selection preserved.
Credential values remain in the connection secret system. No project membership lists
are copied into skills. Background publication uses normal immutable versions and
transactional activity attribution. Setup agent and connection identifiers remain after
those identities are deleted. Refresh then requires explicit repair; deletion cannot
silently substitute board authority or another connection. Execution snapshots keep
only the delivered skill keys and their immutable version IDs. New executions resolve
the latest installed versions without an upstream fetch.

Project-derived sources retain `HEAD` for an unspecified repository ref. It follows
GitHub's current default branch. An explicitly configured branch has a separate
source identity even if it currently resolves to that default branch. API-key
agents without an authenticated run may attach repositories; their durable import
jobs have no setup person and require adoption by an authorized person.

Independent sources can change their tracked branch or revision through source
settings, including `HEAD` to follow the default branch. Validate the repository
identity and the requested commit read
before changing the ref; preserve installed skill IDs, versions and selection. Active
project bindings must change their ref through the project configuration. `HEAD`
remains the default-branch alias after refresh, including for independent sources.
Branch changes use the source revision and lease fence, reject duplicate repository/ref
sources, keep installed version rows unchanged, and enqueue the normal refresh path.
Branch listing uses the caller's authorized connection, not the stored setup identity.

### Task workspace records (2026-10-09)

Migration [0336_big_crystal.sql](../../packages/db/src/migrations/0336_big_crystal.sql) makes `execution_workspaces.project_id` nullable and changes its project reference to `ON DELETE RESTRICT`: source-project policy cannot disappear while a workspace still depends on it. `issues.execution_workspace_id` remains the sole active task binding. Versioned selection/pending-selection JSON and a binding revision record intent and protect transitions; they are not additional active bindings. Accepting a new pending choice advances the revision without changing the active folder. Its receipt retains the original request revision, so current-choice retries are idempotent and superseded retries fail the revision check.

`execution_workspace_repositories` is company-scoped inventory beneath an execution workspace. It records repository identity, contained relative path, requested ref, pinned commit, preparation state and idempotency receipts. Credentials are resolved at use and are never stored in this inventory. Connection/destination `execution_defaults` JSON contains optional typed project/workspace choices, never arbitrary host paths or commands.

The physical-root tables introduced by migrations
[0337_exotic_proemial_gods.sql](../../packages/db/src/migrations/0337_exotic_proemial_gods.sql)
and [0338_absurd_vengeance.sql](../../packages/db/src/migrations/0338_absurd_vengeance.sql)
are legacy: `execution_workspace_repository_roots` and
`execution_workspace_repository_access` remain in the schema with their existing
data, but runtime services neither read nor write them. There is no backfill,
cleanup job, startup DDL, or schema migration for this retirement. Historical
`anonymous_only` / `managed` classifications and source/reader identities have no
effect on new operations.

`execution_workspace_repositories` remains active and records actual repository
requests, pins, preparation state, and idempotency. Shared publication recovery
uses the current receipt and the exact receipt named by the checkout's bounded
ownership marker, with company, origin, ref, path, and pin integrity checks.

The disposable preparation benchmark compares a pinned pre-removal commit with
the checked-out implementation using 8,500 workspaces, 4,800 shared-root records,
5,300 retained sources, and 50 readers. It reports two warmups and five measured
samples, phase medians/ranges, SQL fingerprints, and canonicalization counts.
Both retired-table query counts must remain zero, and increasing peer history
must not increase preparation authorization or path checks. Record the exact
treatment commit and measured improvement in the change's verification report.
These service measurements exclude network acquisition, copying, environment
acquisition, and provider startup. Reproduce with:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-workspace-preparation-history.ts --baseline-ref=df80616d98119cbf5abd40549794d9980a5fabf6
```

Workspace-record and workspace-operation `_issuePrivacySources` /
`_runPrivacySources` metadata and their migration 0313 triggers remain app-data
privacy controls. They do not authorize filesystem access. Current run identity,
selected project policy, acquisition/credential authority, concrete copy identity,
path containment, and lifecycle serialization remain enforced. Low-trust execution
still suppresses controller provisioning according to the selected environment.

No migration scans or copies existing agent home directories. Keep admitted native descriptors and recovery references until compatible controllers finish their persistence obligations. See [the architecture rollout contract](../plans/2026-10-09-task-workspaces.md).

Migration 0341 stores the last scanned Git tree and a durable automatic-refresh
work allowance. The allowance starts at 512 MiB, refills at 512 MiB/hour, and
reserves the existing 128 MiB upper bound before automatic downloads. Completed
small scans refund unused capacity; interrupted/failed work keeps its bounded
reservation. These internal fields do not appear in source responses.

Automatic initial repository imports reserve durable company work credits before
provider reads: 512 MiB capacity, refilling 512 MiB per hour, with a 128 MiB
reservation per attempt. Failed downloads and package fallback keep the full
reservation. Successfully linked small imports refund unused measured work.
Completed bindings do not reset company credits; waiting jobs retry on refill.
The company_skill_import_budgets table stores no credentials or source contents.
