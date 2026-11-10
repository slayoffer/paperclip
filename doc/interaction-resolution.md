# Interaction resolution requests

Interaction reads include `revision`, an opaque UUID. Treat it as a token, not a timestamp.
Every database update advances it. This includes direct lifecycle and provider writes.
The Attention feed also includes the token in the interaction subject metadata.

Use the existing routes. Company access and resolver restrictions still apply.

Resolution reads include `resolvedVia` and `resolvedViaKeyId`. The server records
the authenticated channel and board-key ID when it saves the resolution:

| Value | Authentication channel |
| --- | --- |
| `user_session` | Signed-in user session, including a TMA request authenticated with that session |
| `board_api_key` | Board API key, even when its owner is the addressed user |
| `agent_key` | Agent API key or authenticated agent run JWT |
| `chat_channel` | Paperclip's native chat or voice callback |
| `system` | Automatic cleanup or sweep |
| `null` | Unknown channel, including old rows and internal calls without authentication provenance |

Request bodies cannot set either field. `resolvedViaKeyId` is non-null only for
`board_api_key`, and stores the authenticated key's ID, never its value. It has no
foreign key, so key deletion does not remove the evidence. A user ID alone does
not prove a session. Local implicit access, cloud tenant claims, public assistant
OAuth, provider callbacks, and plugin calls without channel evidence remain unknown.

A TMA relay that uses a board key records `board_api_key`. A Telegram tap alone
does not change that channel. Count a board-key resolution as Anton's own tap
only after the operator verifies that the recorded key ID belongs to a key used
exclusively by the TMA. Different automation and TMA key IDs do not prove this
exclusivity: another process can still use the TMA key. Until exclusive use is
verified, only `user_session` is human proof. `chat_channel`, `system`, and null
are never human proof. This PR does not change a verifier or `human_only` policy.

Both fields are saved with `resolvedAt` and the existing resolver IDs. Partial
item verdicts keep them null until completion. Retries return the first values.
A database trigger prevents either value from changing while a row stays resolved,
including relabeling a legacy null. Reopening a row by clearing `resolvedAt`
clears both provenance fields; the next resolution records its own channel.
The migration has no default or backfill. List, single-interaction, and company
reads expose both fields. Resolver permissions and existing identity fields keep
their current behavior, including existing resolver IDs on reopened rows.

An authenticated comment, document change, or issue closure can expire a card.
These implicit resolutions record the initiating authentication channel too.
Historical comment sweeps and deferred Agent Chat `/new` commands have no live
authenticated channel and record null. OAuth provider callbacks also record null
on first resolution and preserve existing attribution on late result updates.
An authorization retry reopens the existing card and clears its provenance through
the database trigger. Repeated requests retain the same card ID.
An existing limitation remains: reopening retains the previous resolution receipt
and outbox entry. A second revision-protected confirmation answer can fail with an
outbox primary key conflict. Provenance reset does not repair that answer lifecycle.

| Method | Path | Answer fields |
| --- | --- | --- |
| POST | `/api/issues/:issueId/interactions/:interactionId/accept` | Existing confirmation or suggestion fields |
| POST | `/api/issues/:issueId/interactions/:interactionId/reject` | Optional `reason` |
| POST | `/api/issues/:issueId/interactions/:interactionId/respond` | Existing `answers` |

Each request accepts these additional fields:

```json
{
  "expectedRevision": "e1622a78-2b67-43bd-84f3-8607d6a992cd",
  "idempotencyKey": "client-request-7"
}
```

For a question response:

```json
{
  "expectedRevision": "e1622a78-2b67-43bd-84f3-8607d6a992cd",
  "idempotencyKey": "client-request-8",
  "answers": [{ "questionId": "scope", "optionIds": ["first"] }]
}
```

Send the revision from the displayed card. Generate one key for each answer attempt.
Retain the same body and key when a response is lost. Keys have at most 200 characters.
Do not replace the revision automatically after a conflict. Read the current card before another decision.

The server locks the issue, attributed run, linked secret proposal, and interaction in that order.
It checks the company and audience before revision comparisons or receipt reuse.
Question and option validation uses the protected row. Target checks use the same transaction.
Document targets also retain their document lock through resolution.
Failed preconditions create no answer delivery, approval effect, continuation, or successful-answer audit record.

A changed pending revision returns HTTP `409` with `details.code: "interaction_revision_conflict"`.
A terminal interaction retains its existing conflict, including `interaction_already_resolved`.
Issue closure retains `interaction_issue_closed`. Existing expiry and target denials also remain.
Authorization denials retain their existing HTTP status and code.

An identical keyed retry by the same actor reuses the committed resolution.
It creates no duplicate answer delivery, audit entry, wake, or tool execution.
A changed operation, answer body, revision, or actor under that interaction's saved key
returns HTTP `409` with `details.code: "interaction_idempotency_conflict"`.
Receipts store a request digest. Reads do not expose the receipt.

For revision or keyed requests, the answer transaction also saves its audit record and durable continuation intent.
An audit failure rolls back the answer and its receipt. The same displayed revision remains valid after that rollback.
Confirmation continuations use `interaction_resolution_outbox`. Question responses retain their existing delivery outbox.
The startup and periodic delivery sweeps retry pending intents. An identical answer retry also attempts delivery.
The wake queue's existing interaction keys prevent duplicate admission after a lost delivery response.
Queue suppression keeps an intent pending. A successful HTTP answer does not mean the agent already started.
Both outboxes check the target issue token budget before wake admission.
A budget stop creates no wake receipt and consumes no question delivery attempt or error retry.
Budget acceptance retries the issue's pending outboxes after commit, including on an acceptance replay.
Known holds reported for the exact question wake keep the answer pending without consuming an error retry.
Only unexplained null question wakes use the bounded five-error retry limit.
Budget-grant retries catch and log each row's delivery failure. Acceptance still succeeds and later rows are attempted.
Confirmation intents retain their pending state and fair traversal after other admission suppression.

Legacy callers can omit both fields. They retain pending-state, audience, expiry,
and target checks, but receive no displayed-revision protection or keyed retry guarantee.
Board clients send the displayed revision. A relay must require `expectedRevision`.
A relay must not retry a conflict automatically.

The schema migration installs a database trigger for revision changes.
Tests apply it only to isolated databases. Production migration and deployment need their normal release gates.

### Binding execution recovery and fair delivery

A revision-protected acceptance saves its binding execution intent in the continuation outbox.
It saves this intent even when no continuation wake is requested.
The private outbox stores the authenticated server actor in `authorization_context`.
This context includes the original actor source and authorization restrictions.
The request body cannot supply or replace this context.
A receipt retry or background delivery worker resumes the accepted binding before the continuation.
The worker locks the issue and proposal in the existing order.
It rechecks the linked target, issue state, expiry, and configuration permission with the saved actor.
It preserves `local_implicit` authority and the `cloud_tenant` exclusion of legacy administrator rows.
It also preserves `ignoreInstanceAdmin` and delegated authorization restrictions.
An old intent without its original context fails closed. Recovery never assumes a session actor.
Binding approval and the execution result commit in one transaction.
Database failures leave the intent pending. Permission and proposal expiry failures can record a failed execution.
Closed issues prevent binding execution.
Concurrent retries cannot apply the binding twice.

Both outbox workers traverse pending rows by creation time and interaction identifier.
PostgreSQL compares the exact timestamp precision.
It advances its cursor after suppressed admissions and failed attempts.
It returns to the oldest pending rows after it reaches the end.
The cursor belongs to the worker instance. A server restart starts traversal from the oldest pending row.
The question worker shares each issue's budget result within one page and reads it again on the next page.
