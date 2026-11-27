import { SshTransportError } from "@paperclipai/adapter-utils/ssh-transport";
import type { heartbeatRuns } from "@paperclipai/db";
import { executionRetryAttemptCount, SSH_TRANSPORT_WAIT } from "../execution-recovery-attempt.js";
import type { HeartbeatRunCompletionDependencies } from "./run-completion.js";

type Dependencies = Pick<HeartbeatRunCompletionDependencies,
  "setRunStatusIfRunning" | "setWakeupStatus" | "getAgent" | "scheduleBoundedRetryForRun" |
  "appendRunEvent" | "finalizeAgentStatus" | "releaseIssueExecutionAndPromote" | "timerClaimWasFirstHeartbeat">;

export async function deferSshSetupFailure(
  run: typeof heartbeatRuns.$inferSelect,
  error: unknown,
  deps: Dependencies,
): Promise<boolean> {
  if (!(error instanceof SshTransportError)) return false;
  const now = new Date();
  const message = "Execution-target SSH is unavailable. Setup will retry automatically.";
  const write = await deps.setRunStatusIfRunning(run.id, "cancelled", {
    error: message, errorCode: SSH_TRANSPORT_WAIT, finishedAt: now,
    resultJson: {
      ...run.resultJson,
      executionRecovery: { kind: "ssh_transport_wait", providerWorkStarted: false },
      cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
        reason: message, recordedAt: now.toISOString() },
    },
  });
  if (!write.updated || !write.run) return true;
  const cancelledRun = write.run;
  await deps.setWakeupStatus(run.wakeupRequestId, "cancelled", { finishedAt: now, error: message });
  let scheduled = false;
  try {
    const agent = await deps.getAgent(run.agentId);
    if (agent) {
      const attempt = executionRetryAttemptCount(cancelledRun, SSH_TRANSPORT_WAIT) + 1;
      const retry = await deps.scheduleBoundedRetryForRun(cancelledRun, agent, {
        now, retryReason: SSH_TRANSPORT_WAIT, wakeReason: "ssh_transport_retry",
        maxAttempts: attempt, delayMs: Math.min(300_000, 30_000 * 2 ** Math.min(attempt - 1, 4)),
      });
      scheduled = retry.outcome === "scheduled";
    }
    await deps.appendRunEvent(cancelledRun, {
      eventType: "lifecycle", stream: "system", level: "info",
      message: scheduled ? message : "SSH setup retry was not admitted by the run scheduler.",
      payload: { retryScheduled: scheduled },
    });
  } finally {
    try {
      if (!scheduled) await deps.releaseIssueExecutionAndPromote(cancelledRun, { suppressImmediateRecovery: true });
    } finally {
      await deps.finalizeAgentStatus(run.agentId, "cancelled", null,
        { wasFirstHeartbeat: deps.timerClaimWasFirstHeartbeat(run) });
    }
  }
  return true;
}
