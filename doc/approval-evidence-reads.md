# Saved approval evidence

Runs use these read-only paths:

```text
GET /api/issues/{id}/interactions
GET /api/issues/{id}/interactions/{interactionId}
```

Both paths require issue access within the caller's company. The exact lookup
also checks the saved card's issue and company. Missing cards return `404`.
Authorization failures and storage failures do not return approval evidence.

Responses preserve saved `status`, `payload.target`, `resolvedByUserId`,
`resolvedByAgentId`, and `resolvedByRunId`. A document target includes
`revisionId` and can include `revisionNumber`. The resolver fields record the
authenticated resolution actor. A requested addressee is not a resolver.

A pending card permits the existing `blocked` transition for its issue.
Accepted, expired, missing, and other-issue cards do not provide that waiting
path. Other valid waiting paths still apply, such as unresolved dependencies.

A successful read does not authorize a dispatch. The caller must check the
saved outcome, target revision, resolver identity, resolver policy, and current
downstream approval requirements. Missing or unreadable evidence never grants
authority. Reads do not resolve cards or replace the human-only gate.

## Release route

The server needs a release that contains both read routes. The callback bridge
already permits both paths. The native API catalog derives both operations from
the server's OpenAPI document. No database migration is necessary.

For the Guild fork, review the repair against `synthiq/2026.1012.0`. Publish the
approved server build through the governed release process. The homelab owner
performs the server cutover on Anton's deploy card. This source repair does not
authorize deployment, card replacement, or workflow dispatch.

The source baseline already defines the list route and the pending-card wait
guard. An `API route not found` response for the list therefore requires a
runtime version or routing check. The missing exact route is a separate source
gap. Do not treat publication of source as proof of a live repair.

## Verification

The synthetic acceptance suite uses real authenticated routes and a disposable
database:

```sh
pnpm exec vitest run server/src/services/native-runtime/approval-evidence-api.integration.test.ts
```

The route failure tests cover unreadable evidence and denied issue access:

```sh
pnpm exec vitest run server/src/__tests__/issue-interaction-reads.test.ts
```
