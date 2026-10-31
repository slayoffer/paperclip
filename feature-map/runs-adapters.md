# Runs, harnesses, and model accounts

Operators choose an agent harness and model account, inspect execution history and transcripts, and distinguish a working configuration from a successful task result.

Implementation: [adapter manager](../ui/src/pages/AdapterManager.tsx), [run host](../ui/src/pages/AgentDetail.tsx), [configuration](../ui/src/components/AgentConfigForm.tsx).

## Sub-features

- `availability`: discover installed adapters and available models/accounts.
- `validation`: test an adapter in the selected execution environment and surface authentication failures.
- `runs`: inspect run status, events, output, costs, and the source task.
- `session`: preserve or reset execution context through supported lifecycle actions.
- `soft-token-cap`: optionally mark a completed Codex exec turn and continue once from its saved handoff. See [configuration and limits](../doc/run-token-cap.md).

## How to get to it (user POV)

### `adapter-setup`

Open an agent’s model/adapter configuration or the instance adapter settings page when permitted.

### `run-history`

Open an agent run at `/agents/:agentId/runs/:runId` from the agent or task activity.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Record adapter, model, account, native/legacy runtime, and environment. Capabilities vary; one harness result is not a matrix-wide qualification.

### `adapter-setup`

Automated: [adapter validation routes](../server/src/__tests__/agent-adapter-validation-routes.test.ts) and [model refresh](../server/src/__tests__/adapter-model-refresh-routes.test.ts) cover server behavior.

Manual: Select the intended adapter and account, refresh model choices, and run its environment test. Save, reload, then execute a small task. Repeat with a deliberately unavailable account and verify the failure remains visible.

### `run-history`

Automated: [live run routes](../server/src/__tests__/agent-live-run-routes.test.ts) and [run event sequencing](../server/src/__tests__/heartbeat-run-event-sequencing.test.ts) cover run data contracts.

The [adapter cap tests](../packages/adapters/codex-local/src/server/run-token-cap.test.ts) cover usage and mode selection. The [server cap tests](../server/src/services/run-token-cap.test.ts) cover handoffs, duplicate wakes, budgets, and recovery exclusion. These tests use fake provider results.
The [restart tests](../server/src/__tests__/heartbeat-run-token-cap-restart.test.ts) use real wake admission to hold absent or stale checkpoints. The [finalization tests](../server/src/__tests__/heartbeat-run-token-cap-finalization.test.ts) check checkpoint ordering at the terminal database write and execute simulated task and owner successors.

Manual: Start a disposable task, open its running transcript, and follow it to a terminal outcome. Reload and compare task/run IDs, status, output, and cost. Verify a failed run remains distinguishable from a completed run with useful output.

## Gotchas

- The run log is instance database data; it is not the opt-out first-party Telemetry system or operator-configured OpenTelemetry tracing.
- Authentication/model discovery does not establish tool, image, steering, or resumption capability parity.
- Use [recovery](./recovery.md) for interrupted runs and [execution environments](./execution-environments.md) for local/SSH/sandbox differences.
