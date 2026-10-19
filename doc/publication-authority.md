# Offline publication authority

This source slice stores publication requests and tests their dispatch decisions.
It has no production route, listener, registration API, credential adapter, or network writer.
Synthetic callers construct the service directly. Caller fields do not authenticate a live broker or run.
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
The branch must be `review/<issue identifier>`.
The issue must belong to the current agent and running run, including both execution and checkout locks.
The company and agent must permit work.

An existing request returns its state. It never returns another dispatch permission.
A database trigger prevents changes to bindings, lifetime, dispatch time, and recorded revocation.
The trigger also prevents state resets after dispatch.
A partial unique index permits only one outstanding dispatch per company, repository, and branch.
Unreported and unknown outcomes block subsequent requests at dispatch, including after expiry and revocation.
A protected synthetic verifier must establish a definite result before reconciliation releases that block.
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

Run the focused tests on an approved build host with Node.js 24.11 or later:

```sh
pnpm exec vitest run --project @paperclipai/server \
  server/src/services/publication-authority.test.ts \
  server/src/services/publication-authority-races.test.ts
```

The tests start isolated PostgreSQL databases and apply the real migration chain.
On a host with slow temporary disk storage, use `TMPDIR=/dev/shm` when sufficient memory exists.
These tests prove transaction behavior and persistence across new service and connection instances.
They do not prove power-loss durability, certificate authentication, host isolation, remote publication, or live containment.

Production integration still requires protected certificate issuance, trust lifecycle records, and verified run authentication.
It also requires clock provisioning, approval enforcement, credential mediation, and a protected reconciliation verifier.
The broker must enforce remote expected-head and fast-forward conditions, source bindings, and the actual dispatch deadline.
Host coverage, alternate publication paths, network failures, and both vendor runtimes need separate live evidence.
No live migration, listener, credential change, host change, deployment, or rollout is authorized by this slice.
