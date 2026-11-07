# Upload receipts and bounded correlation

Task attachment uploads reserve an operation identity before the storage provider receives bytes.
The server writes immutable receipts into the existing `activity_log` table.
The receipt binds the company, issue, original run, provider, storage configuration, object key, length, and SHA-256.
These receipts stay in the instance database.

The upload request accepts `X-Paperclip-Upload-Operation-Id`, which contains a UUID.
The server generates an identity when the header is absent.
The response includes the header and `uploadOperationId` field.
A repeated identity returns `409` before provider dispatch.
This conflict never retries the upload or repairs a reference.

The artifact helper saves each future attempt's identity before its request.
It stores a separate `.operation.json` file under its helper state directory.
Its existing unknown-result marker continues to prevent automatic upload retries.
Every failed HTTP upload keeps that marker, including a registration rejection after storage succeeds.
Historical helper markers cannot reconstruct an absent operation identity.

## Correlation API

`GET /api/companies/:companyId/issues/:issueId/attachment-upload-correlation`

The endpoint requires board access, company access, issue visibility, and separate `audit:view_agent_actions` authority.
Local operators and instance administrators retain their existing audit authority.
Agent keys receive no new access.
The original run must belong to the exact company and issue.
Agent uploads require a running run that belongs to that agent and issue.
Board uploads cannot attribute an agent run through a caller-supplied header.

Query fields:

| Field | Meaning |
| --- | --- |
| `runId` | Required original run UUID. |
| `operationId` | Exact original upload UUID, when known. |
| `objectKey` | Exact recorded key. Required for byte comparison. |
| `verifyBytes` | `false` by default. `true` requests one complete byte comparison. |

The endpoint never accepts a replacement object binding.
It reads no general run log, bucket list, or unrelated object.
Registration requires an exact company, issue, run, provider, object, length, and hash match.

Results include the operation, object binding, registration, expected byte evidence, and complete actual byte evidence.

| Outcome | Meaning |
| --- | --- |
| `verified_bytes` | A complete stream matches the exact receipt's length and SHA-256. |
| `incomplete_evidence` | The identity, receipt, binding, or complete bytes remain unavailable or differ. |
| `access_denied` | Caller authority, scope, or provider access does not permit the read. |
| `operation_absent` | A durable server record proves that execution stopped before provider dispatch. |

A missing receipt, empty attachment list, or missing object never proves an absent upload operation.
A recorded hash alone never proves downloadable bytes.
Missing historical identities remain explicit null fields.
Correlation does not search by filename or hash to guess an identity.

Byte comparison streams one exact object.
It stops after 30 seconds or when bytes exceed the recorded length or deployment attachment limit.
It retains complete actual hashes only after the stream ends.
A changed storage configuration prevents reads through the new binding.
No result uploads bytes, deletes objects, creates attachments, or repairs work products.

## Failure retention and limits

Future task uploads preserve stored objects after uncertain provider responses and attachment registration failures.
This also preserves objects after a known registration rejection.
Cleanup requires separate operator authority and falls outside this API.
Other storage callers retain their existing cleanup behavior.

Receipts cannot recover historical evidence that the instance never stored.
Receipt retention follows the instance's activity data retention.
Missing or removed receipts always produce incomplete evidence.
An audit failure before dispatch prevents storage writes.
A later audit or response failure can leave a receipt without registration.

`verified_bytes` proves agreement with the receipt.
Delivery confirmation also requires comparison with the separately accepted manifest and expected hash.
Offline tests do not reconcile a live historical operation or authorize deployment.
