# Bounded credential transfer candidate

This candidate contains the execution service, database journal, approval checks, and failure tests.
The application registers `POST /api/companies/:companyId/credential-transfers`.
The application connects the production adapter factory to this route.
It ships without a qualified provider registry, so the route returns `422 provider_guarantees_unqualified`.
That refusal happens before any gateway call, credential read, or provider call.
The route without a factory still returns `503`.
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
Live integration requires a qualified provider registry, separate review, and exact operation approval.

## Production adapter

`server/src/services/credential-transfer-providers.ts` implements `TransferProviders`.
`server/src/services/credential-transfer-cleanup.ts` holds the cleanup contract and the provider-enforced ticket protocol.
`credentialTransferServiceFactory` in the providers file connects both to the existing authority checks and journal.

A provider registry has three parts:

1. `clients`: reviewed in-process clients for Cloudflare (`R2Admin`), Infisical (`VaultAdmin`), and the cleanup controller.
2. `tools`: the server-owned gateway tool mapping for each provider operation.
3. `contract`: evidence and a numerical bound for each provider guarantee.

The shipped registry is `UNQUALIFIED_PROVIDER_REGISTRY`. It has no clients, no tools, and no guarantees.

### Bindings

The authority binds the authenticated actor, the issue, both accepted revisions, and both connection versions.
After that check, `resolveTransferCredentials` reads the bound personal credentials through `connection-credentials.ts`.
It pins each secret to the version in the request binding. It refuses a grant of another person.
Credential values stay in the server process. They never enter gateway arguments, the journal, or logs.

### Inspection

The adapter reads metadata only. It refuses activation when any of these checks fail:

- Every inventory page is present, and no provider read was denied.
- Both bound principals are known and exclusive.
- The bucket exists in the approved account and jurisdiction.
- The provider confirms permission group `6a018a9f2fc74eb6b293b0c548f38b39` as "Workers R2 Storage Bucket Item Read".
- Neither destination name exists at `synthiq-infra/prod /clpn-ha`.
- Every baseline grant identifier is 32 hexadecimal characters. Infisical UUIDs lose their dashes.

### Issuance and storage

The adapter creates one token with one policy: Object Read on the approved bucket resource.
The token expiry equals the approved expiry, which the service limits to 90 days.
It derives the S3 values in process. The access key ID is the token ID. The secret is the SHA-256 of the token value.
The journal and the receipt keep only a one-way fingerprint of the token ID.
Before issuance, the adapter reads the provider ticket. An earlier accepted issuance request prevents another one.
Storage is create-only for the two approved names. A collision fails, and the adapter never updates or deletes an entry.

### Cleanup contract

The contract maps to the gaps of the SYNA-3090 qualification record:

| Key | Gap | Term |
|---|---|---|
| `sourceGrantExpiry` | G1: Cloudflare grant expiry or bounded removal | M |
| `destinationGrantExpiry` | G2: Infisical privilege expiry | M |
| `completeInventory` | G3: complete inventory and effective grants | |
| `issuanceOwnership` | G4: ticket ownership of an issued token after a lost response | M |
| `lateEffectFence` | G5: provider fence or settlement bound for accepted requests | S |
| `recovery`, `clockUncertainty`, `coordination` | G6: total deadline | R, C, Q |
| `scopedRemoval` | G7: removal of only ticket-owned grants | |

A missing key, empty evidence, or a bound that is not a non-negative integer is unsupported.
An unsupported guarantee prevents activation. The sum S + R + M + C + Q must stay below 60 minutes.

The protocol has these steps:

1. Arm: register the provider ticket with the absolute deadline and the baseline before any grant can apply.
   The deadline is at most 60 minutes after arming, and the complete budget must fit before it.
2. Dispatch guard: before each activation, issuance, storage, and read call, require now + budget <= deadline.
3. Cleanup: close the provider ticket first. Then read the provider evidence for the ticket.
   Unsettled requests, a baseline grant reported as ticket-owned, or two credentials stop cleanup without changes.
   Otherwise remove only the ticket-owned grants. On failure, revoke only the ticket-owned credential.
4. Recovery: `credentialTransferService.recover` calls the same cleanup. It needs no process memory.

The provider controller supplies the independent guarantee. The application adds no timer and no second executor.
Provider expiry removes the temporary grants even when this server never restarts.
An issued but unstored credential still needs recovery cleanup for revocation. G4 bounds that step.

### Remaining limits

- No reviewed Cloudflare, Infisical, or cleanup-controller client exists. G1-G7 remain unqualified.
- The exact connection versions, principals, and installed provider versions remain unverified.
- No server startup task calls `recover`. Recovery runs only when an operator or a later change calls it.
- The tests prove the protocol against simulated providers. They prove no real provider guarantee.

## Focused verification

Run each command from `server/`:

```sh
../node_modules/.bin/vitest run src/__tests__/credential-transfer.test.ts
../node_modules/.bin/vitest run src/__tests__/credential-transfer-routes.test.ts
../node_modules/.bin/vitest run src/__tests__/credential-transfer-authority.test.ts
../node_modules/.bin/vitest run src/__tests__/credential-transfer-providers.test.ts
../node_modules/.bin/vitest run src/__tests__/credential-transfer-cleanup.test.ts
```

The last suite uses an isolated PostgreSQL database and applies the generated migration.
It checks saved approvals, connection versions, company isolation, concurrency, replay, and restart cleanup.
It also checks argument-dependent denial, delayed providers, lost lock backends, and company removal.
The other suites check failure injection, deadlines, partial storage, and secret canaries.
The adapter suites add wrong bindings, denied access, late effects, provider expiry, and lost issuance after restart.
The repository test runner discovers these files for its existing continuous integration groups.
