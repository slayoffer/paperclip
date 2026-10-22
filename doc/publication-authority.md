# Offline publication authority

This source slice stores publication requests and tests their dispatch decisions.
Production startup exposes no authority route or listener.
Synthetic callers construct the service or the isolated test listener directly.
The source listener has no registration API, credential adapter, or remote publication writer.
Existing publication, review, merge, and deployment gates remain effective.

## Records and policy

`publicationAuthorityService` uses three company-scoped tables:

- `publication_authority_clocks` stores the authority time watermark, monotonic watermark, clock epoch, and uncertainty latch.
- `publication_brokers` stores protected synthetic certificate mappings, validity, broker revocation, and issuer revocation.
- `publication_requests` stores immutable bindings, lifetime, state, dispatch time, revocation, and reconciliation evidence identifiers.

The shared validator binds company, broker, agent, run, issue, repository, operation, review branch, and full commit.
Pushes also bind the expected old commit.
Pull requests bind the source repository, branch, head, and number when present.
The repository must match a stored workspace of the current issue's project.
Bindings accept only lowercase `owner/name` identities without the `.git` suffix.
Workspace URLs may include `.git`. That suffix does not create a separate request identity.
Database checks enforce the same canonical form and require repository columns and bindings to match.
Pull request source bindings must use that same identity.
The branch must be `review/<issue identifier>`.
The issue must belong to the current agent and running run, including both execution and checkout locks.
The company and agent must permit work.

An existing request returns its state. It never returns another dispatch permission.
A database trigger prevents changes to bindings, lifetime, dispatch time, and recorded revocation.
The trigger also prevents state resets after dispatch.
It rejects request deletion and table truncation. History remains after a definite result.
These guards extend the unreleased initial migration. They do not upgrade databases that already applied its earlier draft.
A partial unique index permits only one outstanding dispatch per company, repository, and branch.
Unreported and unknown outcomes block subsequent requests at dispatch, including after expiry and revocation.
A protected synthetic verifier must establish a definite result before reconciliation releases that block.
`publicationReconciliationService` holds this separate capability. Broker services expose no reconciliation method.
Protected construction supplies its company scope, verifier identifier, and observation callback.
Request fields cannot select or replace that capability.
Reconciliation checks the company and all stored bindings under request locks before and after observation.
It works after certificate expiry, broker revocation, assignment changes, run completion, and clock uncertainty.
It grants no dispatch permission and restores no broker authority.
Its audit record names the protected verifier and retains the original agent and run identifiers.
Broker result reports cannot resolve an unknown result. The old request never becomes reusable.
Each request, dispatch, result, revocation, and reconciliation writes an activity record in the same transaction.

## Serialization

Dispatch locks rows with `FOR NO KEY UPDATE` in this order:

1. Issue.
2. Run.
3. Agent.
4. Company.
5. Project workspaces.
6. Authority clock.
7. Broker registration.
8. Request.

Ordinary PostgreSQL updates and deletions acquire incompatible row locks automatically.
Existing writers therefore need no new application lock or changes in `issues.ts`.
This covers assignment, release, force-release, issue cancellation, run cancellation, pauses, and repository edits.
Synthetic broker, issuer, certificate, clock, and request revocation writers use the same stored rows.
Tests inspect `pg_blocking_pids` while transactions hold these locks.
They prove that earlier committed changes prevent dispatch.
They also prove that a later assignment or revocation can follow an authorized dispatch.
No transaction spans the authority and the remote publication service.
Future writers that change authority through other records must extend this protocol before production use.
Inconsistent external lock orders can cause transaction aborts. An abort supplies no dispatch permission.

## Time and restart

Requests expire within 30 seconds of authority wall time and authority monotonic time.
The smaller remaining lifetime controls dispatch. Certificate expiry can shorten that lifetime further.
An unobserved wall-clock correction cannot extend monotonic expiry.
Observed rollback, missing time, or a changed clock epoch latches uncertainty in the database.
The default clock reads PostgreSQL wall time and process monotonic time.
It uses a process-specific epoch. A process restart therefore fails closed until protected provisioning restores a valid reference.
The source provides no automatic clock reset or production provisioning path.
Synthetic clock providers permit controlled tests without changes to host time.

The broker starts its monotonic timer before the dispatch-check request.
At the actual write boundary, it requires `elapsed < min(1000 ms, remainingLifetimeMs)`.
Response delay, preparation, and queue delay all count.
The shared predicate implements this calculation. The broker must reject a lost clock reference or restart.
The interval bounds write initiation. It does not guarantee remote completion or cancellation.

## Verification and remaining boundaries

### Isolated transport source

`createPublicationAuthorityListener()` returns `null` by default.
Only explicit protected construction with `enabled: true` creates an HTTPS server.
The caller must then bind that server to a fixture endpoint.
No production module imports the factory. No environment setting enables it.
The ordinary application router exposes no authority routes.

The listener requires mutual Transport Layer Security (TLS) version 1.3 and an explicit issuer bundle.
It requires a client certificate with the client authentication purpose.
It verifies the direct issuer signature and the complete certificate fingerprint against protected registrations.
Certificate names, serial numbers, request fields, and caller identity headers supply no authority.
The listener rejects proxy identity headers and resumed TLS sessions.
Existing connections undergo the same current trust checks on each operation.
The synthetic client verifies the authority certificate and its expected server name.

Protected construction supplies `readTrust(transaction)`. No request can select or replace this reader.
The reader supplies registrations and the currently revoked issuer identifiers.
Each registration binds one certificate fingerprint to a broker, host, company, and existing authority registration.
The existing `certificateId` and `issuerId` remain opaque identifiers in the durable broker record.
The transport adds the cryptographic fingerprint binding without changing the accepted request schema.
Ambiguous fingerprints, companies, hosts, or broker identities cause refusal.
Renewal permits one active certificate and retiring certificates with explicit overlap deadlines.
The old certificate loses authority at its overlap deadline.
Renewal preserves the broker, host, company, and existing durable request history.

The reader must use protected records or immutable protected configuration.
Mutable readers and trust writers must use the same broker row lock as dispatch.
Issuer revocation must disable all affected registrations in the same authoritative transaction.
The reader must return `null` or throw when current trust is unavailable.
The source tests supply synthetic registrations. This slice selects no live registration store or administrative delivery path.
Existing durable broker and issuer revocation flags remain authoritative under their existing database locks.
Broker revocation disables every certificate for that broker.
An issuer entry in the current trust snapshot disables every certificate for that issuer.

A signed standard run token separately authenticates the agent, run, and company.
The certificate registration supplies the broker, host, and company.
Current authority checks validate the issue, assignment, repository, and immutable bindings.
The effective certificate, issuer, registration, and overlap expiry can shorten the remaining dispatch lifetime.
Trust reads and database lock waits count toward expiry.
Missing trust, durable records, or reliable authority time prevents dispatch.

All operations use `POST` with the unchanged binding object and `Content-Type: application/json`:

| Fixture route | Existing service operation |
|---|---|
| `/v1/publication/request` | Record a request with a maximum lifetime of 30 seconds. |
| `/v1/publication/dispatch` | Record at most one dispatch after current authorization. |
| `/v1/publication/revoke` | Revoke the bound request. |
| `/v1/publication/result/succeeded` | Record a definite successful result. |
| `/v1/publication/result/refused` | Record a definite refusal. |
| `/v1/publication/result/unknown` | Preserve an uncertain result until protected reconciliation. |

Only dispatch can return `dispatch: true`. A replay never grants another write.
There is no transport route for reconciliation or registration.
The broker must still apply the monotonic deadline at the actual remote write boundary.
This source adds no publication permission or broker client.

Run the focused tests on an approved build host with Node.js 24.11 or later:

```sh
pnpm exec vitest run --project @paperclipai/server \
  server/src/services/publication-authority.test.ts \
  server/src/services/publication-authority-races.test.ts \
  server/src/services/publication-authority-reconciliation.test.ts \
  server/src/services/publication-authority-repositories.test.ts \
  server/src/services/publication-authority-transport.test.ts \
  server/src/services/publication-authority-transport-revocation.test.ts
```

The tests start isolated PostgreSQL databases and apply the real migration chain.
The fork workflow `synthiq-publication-authority.yml` runs these suites on Node.js 24 for release-target pull requests.
Repository tests cover aliases, direct database writes, outstanding uniqueness, and protected reconciliation after unresolved results.
On a host with slow temporary disk storage, use `TMPDIR=/dev/shm` when sufficient memory exists.
These tests prove transaction behavior and persistence across new service and connection instances.
Transport tests create temporary synthetic certificates with OpenSSL and remove their keys after the suite.
They exercise local HTTPS endpoints, existing connections, attempted session resumption, renewal overlap, and current revocation.
They do not prove power-loss durability, live certificate provisioning, host isolation, remote publication, or live containment.

Production integration still requires protected certificate issuance, a concrete trust store, and administrative trust delivery.
It also requires clock provisioning, approval enforcement, credential mediation, and a protected reconciliation verifier.
The broker must enforce remote expected-head and fast-forward conditions, source bindings, and the actual dispatch deadline.
Host coverage, alternate publication paths, network failures, and both vendor runtimes need separate live evidence.
No live migration, listener, credential change, host change, deployment, or rollout is authorized by this slice.
