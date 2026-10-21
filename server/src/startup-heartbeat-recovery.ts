import type { heartbeatService } from "./services/index.js";
import { logger } from "./middleware/logger.js";

export async function runStartupHeartbeatRecoverySteps(
  heartbeat: ReturnType<typeof heartbeatService>,
) {
  // Each reconcile step below runs again in the periodic scheduler. A
  // failed step is logged and the next step runs. A rethrow here exits
  // the server, and the same stored record fails again on every restart
  // (SYNA-2368: 44 restarts in 30 min on one blocking cycle).
  const runStartupRecoveryStep = async (
    step: string,
    fn: () => Promise<void>,
  ) => {
    try {
      await fn();
    } catch (err) {
      logger.error(
        { err, step },
        "startup heartbeat recovery step failed; continuing startup, the periodic scheduler retries it",
      );
    }
  };

  let promotion: Awaited<ReturnType<typeof heartbeat.promoteDueScheduledRetries>> | null = null;
  await runStartupRecoveryStep("promoteDueScheduledRetries", async () => {
    promotion = await heartbeat.promoteDueScheduledRetries();
  });
  await runStartupRecoveryStep("resumeQueuedRuns", async () => {
    await heartbeat.resumeQueuedRuns();
  });
  await runStartupRecoveryStep("recoverPendingSessionGoalActions", async () => {
    const recoveredGoalActions = await heartbeat.recoverPendingSessionGoalActions();
    if (
      recoveredGoalActions.enqueued > 0 ||
      recoveredGoalActions.invalid > 0
    ) {
      logger.warn(
        recoveredGoalActions,
        "startup session-goal action outbox recovery reconciled pending controls",
      );
    }
  });
  await runStartupRecoveryStep("recoverActiveSessionGoals", async () => {
    const recoveredGoals = await heartbeat.recoverActiveSessionGoals();
    if (recoveredGoals.enqueued > 0) {
      logger.warn(
        recoveredGoals,
        "startup session-goal recovery resumed durable agent goals",
      );
    }
  });
  await runStartupRecoveryStep("reconcileStrandedAssignedIssues", async () => {
    const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
    const promoted: { promoted: number; runIds: string[] } =
      promotion ?? { promoted: 0, runIds: [] };
    if (
      promoted.promoted > 0 ||
      reconciled.assignmentDispatched > 0 ||
      reconciled.dispatchRequeued > 0 ||
      reconciled.continuationRequeued > 0 ||
      reconciled.successfulRunHandoffEscalated > 0 ||
      reconciled.successfulRunHandoffRetried > 0 ||
      reconciled.escalated > 0 ||
      reconciled.failed > 0
    ) {
      logger.warn(
        { promotedScheduledRetries: promoted.promoted, promotedScheduledRetryRunIds: promoted.runIds, ...reconciled },
        "startup heartbeat recovery changed assigned issue state",
      );
    }
  });

  await runStartupRecoveryStep("reconcileResolvedDependencyWakes", async () => {
    const dependencyWakesReconciled = await heartbeat.reconcileResolvedDependencyWakes();
    if (dependencyWakesReconciled.healed > 0) {
      logger.warn(
        { ...dependencyWakesReconciled },
        "startup dependency-wake reconciliation restored task execution paths",
      );
    }
  });

  await runStartupRecoveryStep("reconcileTaskWatchdogs", async () => {
    const taskWatchdogsReconciled = await heartbeat.reconcileTaskWatchdogs();
    if (taskWatchdogsReconciled.triggered > 0) {
      logger.warn(
        { ...taskWatchdogsReconciled },
        "startup task-watchdog reconciliation triggered watchdog work",
      );
    }
  });

  await runStartupRecoveryStep("scanSilentActiveRuns", async () => {
    const scanned = await heartbeat.scanSilentActiveRuns();
    if (scanned.created > 0 || scanned.escalated > 0) {
      logger.warn({ ...scanned }, "startup active-run output watchdog created review work");
    }
  });

  await runStartupRecoveryStep("sweepStaleIssueLocks", async () => {
    const swept = await heartbeat.sweepStaleIssueLocks();
    if (swept.cleared > 0) {
      logger.warn({ ...swept }, "startup stale-lock sweeper cleared issue locks");
    }
  });
}
