# Bounded credential transfer candidate

This candidate contains the execution service, database journal, approval checks, and failure tests.
The application registers `POST /api/companies/:companyId/credential-transfers`.
The default route returns `503`. No live provider adapter is registered.
The tests use fake providers. They create no live credential or permission.

The request accepts an issue, two saved connection bindings, and two approval revision references.
The operation documents must contain identical bindings and targets.
One document approves the permission window. The other approves credential creation and storage.
Both confirmations must have human-only resolution and acceptance from the responsible person.
A later document revision invalidates the earlier approval.
The service checks current grants, credential ownership, versions, and gateway policy before each effect.
An operation approval cannot replace an Off or Ask first tool policy.

The only destination is `synthiq-infra/prod /clpn-ha`.
The only names are `CLPN_R2_MONITOR_ACCESS_KEY_ID` and `CLPN_R2_MONITOR_SECRET_ACCESS_KEY`.
The credential permits Object Read for one approved R2 bucket and jurisdiction.
Its lifetime cannot exceed 90 days. The temporary grant window cannot exceed 60 minutes.
The service rejects incomplete inventory, shared identities, changed bindings, and existing destination entries.
It never overwrites or adopts an existing entry.

The journal permits one executor per company and one use of each approval.
It contains references, deadlines, identifiers, and fixed outcomes. It contains no secret values or provider errors.
The executor persists a cleanup ticket before permission activation.
Failure cleanup revokes only the new credential and removes only the ticket's temporary grants.
It preserves baseline grants, unrelated grants, and partial destination entries.
Recovery reads the journal and performs cleanup only. Recovery never repeats issuance or storage.
HTTP logs omit transfer bodies and gateway headers.

## Provider requirements before live execution

A production adapter must supply complete provider inventory and effective permissions.
It must use the selected personal connection credentials inside the server process.
It must perform create-only storage and compare the stored values inside that process.
It must never pass credential values through gateway arguments, shell commands, or logs.

The adapter must arm independent durable cleanup before activation.
Cleanup must survive server restart and run within the approved deadline.
The ticket must fence late activation, issuance, and storage calls.
It must identify and revoke an issued credential when the issuance response is lost.
It must never issue another credential to recover a lost secret.
An adapter must reject execution when it cannot guarantee these properties.

These guarantees are exercised with fake providers. Real provider guarantees remain unqualified.
This candidate does not authorize provider access, permission changes, publication, or deployment.
Live integration requires a separately reviewed adapter and exact operation approval.

## Focused verification

Run each command from `server/`:

```sh
../node_modules/.bin/vitest run src/__tests__/credential-transfer.test.ts
../node_modules/.bin/vitest run src/__tests__/credential-transfer-routes.test.ts
../node_modules/.bin/vitest run src/__tests__/credential-transfer-authority.test.ts
```

The last suite uses an isolated PostgreSQL database and applies the generated migration.
It checks saved approvals, connection versions, company isolation, concurrency, replay, and restart cleanup.
The other suites check failure injection, deadlines, partial storage, and secret canaries.
The repository test runner discovers these files for its existing continuous integration groups.
