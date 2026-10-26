# External waits

An assigned agent can record an outside wait without a review handoff or a human card.
Send this shape through `PATCH /api/issues/{issueId}`:

```json
{
  "status": "blocked",
  "unblockDescriptor": {
    "kind": "external",
    "owner": "board",
    "action": "Wait for the vendor response. deadline: 2026-10-27T00:00:00Z"
  }
}
```

Replace the example deadline with a future ISO timestamp within seven days.
Use UTC for consistency with the watchdog. Explicit ISO offsets also qualify.
The action must contain exactly one `deadline: <ISO>` marker.
The server refuses missing, invalid, repeated, expired, and later deadlines with HTTP 422.
An `until` field does not replace the deadline in the action.

The authenticated agent must be the current assignee and remain assigned after the request.
Another agent or an assignment change returns HTTP 403.
Only `kind: "external"` and `owner: "board"` qualify for this exception.
Existing board-authored descriptors, agent-owned waits, and saved review waits retain their own rules.
Normal company access, checkout, issue authorization, and activity logging still apply.

The saved descriptor protects the blocked issue from disposition recovery and dependency release.
This protection works with either setting of `PAPERCLIP_BLOCKED_STATE_INTEGRITY`.
The wait grants no authority to perform the outside operation.
The board can explicitly resume the task through existing routes.

The external watchdog reads the deadline from the action and returns the task to `todo` at expiry.
The watchdog then requests the owner wake. This change adds no second deadline scheduler.
Keep the watchdog active for installations that use this contract.
Live qualification must show acceptance, no runs before the deadline, and a wake after expiry.
