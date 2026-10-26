# Wakeup skip diagnostics

`POST /api/agents/:id/wakeup` returns HTTP 202 when admission skips a wake.
The response contains the stored reason and safe details for that exact request.
Successful wakes still return the heartbeat run.

The skipped response retains its existing fields:

- `status`: `skipped`.
- `reason`: the stored reason code.
- `message`: the stored error text, or a message about the gate.
- `issueId` and the execution fields retain their existing types.

Recorded skips also return these fields:

- `wakeupRequestId`: the exact request receipt identifier.
- `error`: the stored error text, or `null`.
- `details`: diagnostic fields from an explicit allowlist.

A token budget skip includes `details.budget`:

```json
{
  "used": 75854317,
  "limit": 50000000,
  "windowStart": "2026-10-23T03:49:18.000Z"
}
```

A dependency skip includes `details.unresolvedBlockerIssueIds` and `details.unresolvedBlockers`.
Each blocker contains `id`, `identifier`, and current `status`.
The server resolves blockers only within the agent's company.

Other gates can include `details.heartbeatSkip` or `details.executionWait`.
These objects contain safe gate information, such as cap figures or a recovery action identifier.
The response excludes raw wake payloads, prompts, context snapshots, and credentials.
The server applies credential redaction to diagnostic text.

Existing HTTP 409 refusals retain that status.
These include paused agents and invocation budget refusals.
When admission records a receipt, the error response includes its diagnostics in `details.wakeup`.
Work limits on issue assignment and queue pulls retain their existing HTTP 409 behavior.
This change does not change scheduling, approval, or budget policy.

Legacy `POST /api/agents/:id/heartbeat/invoke` retains its existing response shape.
