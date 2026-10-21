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
Policy checks receive the approved operation fields, including the destination path.
These checks run before inventory, cleanup arming, activation, issuance, storage, and verification.
Each provider operation consumes quota through its server-owned tool mapping.
The gateway uses the existing atomic policy counter before each operation.
Repeated authority checks validate policy without inspecting or consuming that quota.
The adapter must map inventory, arming, activation, issuance, each create call, and each verification read.
Missing mappings stop execution. Cleanup does not consume quota because it must remain available after exhaustion.
A condition on an unavailable argument causes denial. Secret values never enter policy arguments.

The only destination is `synthiq-infra/prod /clpn-ha`.
The only names are `CLPN_R2_MONITOR_ACCESS_KEY_ID` and `CLPN_R2_MONITOR_SECRET_ACCESS_KEY`.
The credential permits Object Read for one approved R2 bucket and jurisdiction.
Its lifetime cannot exceed 90 days. The temporary grant window cannot exceed 60 minutes.
The service rejects incomplete inventory, shared identities, changed bindings, and existing destination entries.
It never overwrites or adopts an existing entry.

The journal permits one executor per company and one use of each approval.
It contains references, deadlines, identifiers, and fixed outcomes. It contains no secret values or provider errors.
A reserved database connection holds the execution lock throughout provider calls.
The lock connection disables idle reaping and maximum lifetime closure.
The executor checks lock ownership before each provider effect.
A lost backend cannot reconnect or permit more activation, issuance, or storage calls.
Failure cleanup remains available through the durable ticket.
Company removal deletes settled journal rows. It rejects removal while any transfer needs cleanup.
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
It also checks argument-dependent denial, delayed providers, lost lock backends, and company removal.
The other suites check failure injection, deadlines, partial storage, and secret canaries.
The repository test runner discovers these files for its existing continuous integration groups.
