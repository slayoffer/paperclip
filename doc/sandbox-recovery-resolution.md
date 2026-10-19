# Recovery resolution through the sandbox bridge

The run bridge permits these recovery routes:

- `GET /api/issues/:id/recovery-actions`
- `POST /api/issues/:id/recovery-actions/resolve`

Both queue and HTTP/2 transports use the same route policy. The server checks
company access, agent authority, and the run identifier. An assignee can resolve
its recovery action, including a board-escalated disposition repair. The source
issue must permit the requested status change. Existing checkout and execution
authority checks still apply.

For a completed task, the assignee can send this body to the resolution route:

```json
{
  "actionId": "<active recovery action ID>",
  "outcome": "restored",
  "sourceIssueStatus": "done",
  "resolutionNote": "The saved result meets the task requirements. Verification limits are recorded."
}
```

Use `done` only when the task requirements permit completion. Record verification
limits on the task before resolution. A normal completion needs no board card
for the recovery route itself. Existing task approval requirements still apply.
The server records `owner_completed` when the assignee completes the task.

The `false_positive` and `cancelled` outcomes remain board-only. The bridge does
not permit the board-only workspace export retry route. This change grants no
new issue reassignment rights.

Regression checks:

```sh
pnpm exec vitest run packages/adapter-utils/src/sandbox-callback-bridge-recovery.test.ts server/src/__tests__/issue-recovery-bridge.test.ts
pnpm exec vitest run packages/adapter-utils/src/sandbox-callback-bridge.test.ts server/src/__tests__/issue-recovery-actions.test.ts
```

The server test sends requests through the real queue worker and recovery
handler. It checks successful assignee resolution, audit records, and denied
requests. It needs embedded PostgreSQL support and reports skipped tests when
the host lacks that support.
