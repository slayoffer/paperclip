import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { claimedAdapterType } from "./conversation-continuation.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { canContinueCancelledRun } from "./run-cancellation.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { nativeSessionProviderEvidence } from "./native-runtime/native-session-resume.js";
import type { NativeRestartRecoveryClaim } from "./native-runtime/native-restart-recovery.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;

/** Close only this controller's unused budget-stopped bootstrap, after cleanup. */
export async function settleBudgetStoppedNativeStartup(
  db: Db, identity: { id: string; companyId: string }, recovery?: NativeRestartRecoveryClaim,
): Promise<Run | null> {
  return db.transaction(async tx => {
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, identity.companyId), eq(nativeRunFinalizations.runId, identity.id),
    )).for("update");
    if (!coordinator || coordinator.phase !== "observed" || coordinator.resultId || coordinator.failureDetail?.successorRunId) return null;
    const ownsBootstrap = recovery?.kind === "bootstrap_incomplete" && recovery.runId === identity.id &&
      coordinator.leaseOwner === recovery.leaseOwner && coordinator.controllerGeneration === recovery.controllerGeneration &&
      coordinator.attempt === recovery.providerAttempt && coordinator.leaseExpiresAt && coordinator.leaseExpiresAt > new Date();
    const unclaimed = !recovery && coordinator.attempt === 0 && coordinator.controllerGeneration === 0 &&
      !coordinator.controllerBootId && !coordinator.controllerPid && !coordinator.leaseOwner && !coordinator.leaseExpiresAt;
    if (!ownsBootstrap && !unclaimed) return null;
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, identity.companyId), eq(heartbeatRuns.id, identity.id),
    )).for("update");
    const evidence = run?.resultJson?.executionRecovery as Record<string, unknown> | undefined;
    if (!run || run.runtimeMode !== "native" || run.status !== "cancelled" || run.errorCode !== "issue.token_budget_exceeded" ||
        evidence?.kind !== "bootstrap" || evidence.providerWorkStarted !== false ||
        run.processPid || run.processGroupId || run.processStartedAt ||
        (await nativeSessionProviderEvidence(tx, [run.id])).has(run.id)) return null;
    const now = new Date();
    await tx.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null,
      controlDeadlineAt: null, nextAttemptAt: null, failureCode: run.errorCode,
      failureDetail: { ...coordinator.failureDetail, budgetStopBeforeProvider: {
        runId: run.id, companyId: run.companyId, issueId: run.nativeIssueId,
        attempt: coordinator.attempt, controllerGeneration: coordinator.controllerGeneration, settledAt: now.toISOString(),
      } }, updatedAt: now,
    }).where(eq(nativeRunFinalizations.runId, run.id));
    const [settled] = await tx.update(heartbeatRuns).set({ nativePhase: "terminal_failure", nativePhaseUpdatedAt: now })
      .where(eq(heartbeatRuns.id, run.id)).returning();
    return settled;
  });
}

/** Candidate for explicit user Retry only, never automatic replay after Stop. */
export async function canRetryStoppedRun(db: Db, run: Run): Promise<boolean> {
  if (run.errorCode === "native_session_cleanup_quarantined") return false;
  if (["failed", "timed_out"].includes(run.status) || canContinueCancelledRun(run)) return true;
  if (run.status !== "cancelled" || !run.finishedAt || run.processPid || run.processGroupId ||
      run.processStartedAt || run.sessionIdAfter) return false;
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  ));
  return isCancelledNativeStartup(db, run, coordinator);
}

/** Caller holds the coordinator and run locks when using this proof to admit
 * work. Attempt zero is a durable never-claimed receipt: every native executor
 * commits its first claim before it can start or attach a provider. */
export async function isCancelledNativeStartup(db: Db, run: Run, coordinator: Coordinator | undefined) {
  if (run.status !== "cancelled" || !run.finishedAt || run.processPid || run.processGroupId ||
      run.processStartedAt || run.sessionIdAfter) return false;
  const cancellation = run.resultJson?.startupCancellation as Record<string, unknown> | undefined;
  // Older builds could omit the cancellation fence or its unwind marker. Their immutable
  // native-adapter claim and unresolved preparation stage still prove that
  // provider dispatch did not begin. Require an expired owner from another
  // server boot; neither a missing PID nor mutable agent settings is proof.
  const historicalBeforeSelection = run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt &&
    run.executionStage === "preparing" && !run.nativeIssueId && !run.nativeSessionId && !coordinator &&
    claimedAdapterType(run) === "paperclip_runner" && run.errorCode === "operator_interrupted" &&
    (run.resultJson === null || cancellation?.beforeNativeSelection === true) &&
    Boolean(run.controllerBootId && run.controllerBootId !== legacyControllerBootId &&
      run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt <= new Date());
  const beforeReviewDispatch = isPreDispatchReviewWait(run) && !coordinator;
  const beforeSelection = beforeReviewDispatch || historicalBeforeSelection || run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt &&
    !run.nativeSessionId && !coordinator && claimedAdapterType(run) === "paperclip_runner" &&
    cancellation?.beforeNativeSelection === true;
  const neverClaimed = run.runtimeMode === "native" && coordinator &&
    ["observed", "terminal_failure"].includes(coordinator.phase) && coordinator.attempt === 0 &&
    coordinator.controllerGeneration === 0 && !coordinator.controllerBootId &&
    !coordinator.controllerPid && !coordinator.leaseOwner && !coordinator.leaseExpiresAt &&
    !coordinator.resultId && !coordinator.failureDetail?.successorRunId;
  const budgetReceipt = coordinator?.failureDetail?.budgetStopBeforeProvider as Record<string, unknown> | undefined;
  const budgetBootstrapSettled = run.runtimeMode === "native" && run.errorCode === "issue.token_budget_exceeded" && coordinator?.phase === "terminal_failure" &&
    coordinator.failureCode === run.errorCode && !coordinator.leaseOwner && !coordinator.leaseExpiresAt && !coordinator.resultId &&
    !coordinator.failureDetail?.successorRunId && budgetReceipt?.runId === run.id && budgetReceipt.companyId === run.companyId &&
    budgetReceipt.issueId === run.nativeIssueId && budgetReceipt.attempt === coordinator.attempt &&
    budgetReceipt.controllerGeneration === coordinator.controllerGeneration && typeof budgetReceipt.settledAt === "string" &&
    (run.resultJson?.executionRecovery as Record<string, unknown> | undefined)?.providerWorkStarted === false;
  if (!beforeSelection && !neverClaimed && !budgetBootstrapSettled) return false;
  const settled = beforeReviewDispatch || typeof run.resultJson?.startupPreparationSettledAt === "string";
  // The old preparer can still be unwinding even though the run is terminal.
  if (!settled && run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if ((!settled && leases.length === 0 && !historicalBeforeSelection) || leases.some(lease =>
    lease.provider === "local"
      ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
      : !hasRemoteTerminationReceipt(lease))) return false;
  // Reject contradictory retained evidence, including a crash after a launch
  // request but before the PID callback. Provider events never certify a stop.
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
        "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
        "provider.event", "provider.rpc_result", "tool.execution.started"])),
  )).limit(1);
  return !execution;
}
