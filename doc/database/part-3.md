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

`agent_commentary` stores company-scoped, attributed complaints and suggestions
as free-form text in the instance database. Legacy agents use the default
`complain` and `suggestion-box` runtime skills; native runs use dedicated tools
in standard, ask, and planning modes. Submission never changes task disposition
or routes feedback externally. See [Agent commentary](agent-commentary.md) for
authentication, replay, document-sized limits, inspection, and deletion semantics.

## Agent identity keys and backups

`agent_identity_keys` stores one encrypted Ed25519 identity per agent. Its migration
creates schema only: existing agents provision on their next managed run. Public
reads and server startup do not provision them. Normal backups preserve identity
rows and need the matching secrets master key for recovery. Both development seed
modes omit identity rows, including with live-work preservation, so copied agents
get fresh identities. See [Agent cryptographic identity](AGENT-IDENTITY.md).

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


## Transaction-aware delivery work signals

Five existing delivery queues use process-local work signals to avoid empty
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
