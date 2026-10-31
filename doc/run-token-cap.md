# Codex per-run soft token cap

The fork can stop automatic Codex exec work at a completed turn boundary.
The switch is off by default. It does not change tool admission.

## Configuration

Set both variables on the Paperclip server when you choose to enable the feature:

```sh
PAPERCLIP_RUN_TOKEN_CAP_MODE=dry_run
PAPERCLIP_RUN_TOKEN_CAP_INPUT_TOKENS=2000000
```

`PAPERCLIP_RUN_TOKEN_CAP_MODE` accepts `off`, `dry_run`, or `enforce`.
Missing or invalid values disable the feature. The token limit must be a positive safe integer.
These are server switches. An agent's adapter environment does not select this policy.

| Mode | Behavior after input tokens exceed the limit |
| --- | --- |
| `off` | Keep the existing execution and recovery behavior. |
| `dry_run` | Log `would stop` and store a diagnostic receipt. Keep the existing recovery behavior. |
| `enforce` | Store `resultJson.stopReason = run_token_cap`. Write the continuation summary and admit at most one successor. |

Use `dry_run` first. Change the mode to `enforce` only after you inspect the receipts.
Set the mode to `off` to disable future cap decisions.
Already recorded cap stops retain their continuation ownership and duplicate protection.

**Proposed starting limit: 2,000,000 input tokens per run.** This is a proposal, not a default.
The configured default remains off. Cached input tokens count fully toward this run limit.
The separate issue budget retains its configured cached-token weight.

## Boundary and accounting

This feature applies to `codex_local` with the exec JSON transport.
It does not apply to ACP or native Runner transports.
Codex exec emits `turn.completed` after its agentic turn, then exits.
That turn can contain many model requests and tool calls.
The adapter waits for the normal process exit. It sends no signal and interrupts no tool or write.

The `turn.completed.usage.input_tokens` counter is session cumulative.
The server supplies the last valid usage sample for the same provider session.
The adapter sums positive counter deltas from that baseline.
A counter reset starts a new counter segment. Repeated equal totals add zero.
Fresh sessions start at zero. Failed runs retain their normal failure behavior.
An exact match with the limit does not trigger the cap. The count must exceed the limit.

**This limit cannot bound the cost of one agentic turn.** Usage arrives at its end.
The run can exceed the limit by the entire cost of that turn.
The receipt records the boundary, mode, limit, and input tokens for inspection.

## Handoff and continuation

The existing issue continuation-summary document stores the objective, acceptance criteria,
latest agent message, recent work, and next action. The provider session also retains the transcript.
Paperclip saves the source session ID with the terminal run and writes the summary before the continuation wake.
The wake names that run through the existing `resumeFromRunId` path, which checks the source's company and agent.
After a restart, that path restores the source session even if the task-session checkpoint is absent or stale.
A missing source session ID or a failed summary write cannot admit a successor.
The recovery sweep can repair a missing summary and retry delivery after a server restart.

Each source run uses the key `run_token_cap:<company>:<issue>:<run>`.
A transaction lock and persisted wake receipt prevent duplicate delivery.
The successor carries `runTokenCapSourceRunId`. It cannot create another automatic cap continuation.
An explicit later run can start a new cap chain.

Only active work still assigned to the same agent can continue.
Terminal, blocked, review, user-owned, and conversation issues do not receive this wake.
The wake carries an issue-state guard and passes normal admission checks.
Those checks retain pause, stop, approval, dependency, and budget rules.
The issue token budget includes usage from the completed capped run.
A spent budget admits no cap continuation.

A cap stop remains `succeeded`. Its liveness reason is `run_token_cap`.
It does not count as an adapter failure or enter missing-comment or disposition-repair loops.
The one successor also stays outside those successful-run repair loops.
If that successor leaves work unfinished, a person must start the next run.

## Verification

The adapter tests cover modes, cumulative deltas, resets, equality, failed exits,
and unfinished tool events. The server tests use PostgreSQL for duplicate delivery,
handoff persistence, restart delivery, ownership checks, and the issue budget.
The heartbeat restart test uses real wake admission with absent and stale task-session checkpoints.
Tests use fake provider results. They do not start Codex.

```sh
pnpm exec vitest run packages/adapters/codex-local/src/server/run-token-cap.test.ts
pnpm exec vitest run server/src/services/run-token-cap.test.ts
pnpm exec vitest run server/src/__tests__/heartbeat-run-token-cap-restart.test.ts
```

Run full repository checks on the configured test host or through fork CI.
