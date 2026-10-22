import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { agentWakeupRequests, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";
import { isDeferredBridgeReceipt } from "./review-bridge-wakes.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">;
export interface QueuedRunRecoveryDependencies {
  getSchedulingSuppression: () => Promise<{ suppressed: boolean }>;
  resumeExecutionWaitComments: () => Promise<void>;
  getWorktreeExecutionCutoff: () => Promise<Date | null>;
  resumeQueuedCommentInterrupt: (companyId: string, queueId: string) => Promise<void>;
  readQueuedInteractionResponse: (db: Db, companyId: string, issueId: string, payload: unknown) => Promise<unknown>;
  isHeartbeatRunTerminalStatus: (status: string) => boolean;
  resumeSavedLegacyComments: (companyId: string, queueId: string) => Promise<void>;
  releaseIssueExecutionAndPromote: (run: Run, options: { suppressImmediateRecovery: boolean }) => Promise<void>;
  resumeDeferredBridgeReceipt: (companyId: string, queueId: string) => Promise<void>;
  startNextQueuedRunForAgent: (agentId: string) => Promise<unknown>;
}

export async function recoverQueuedRuns(db: Db, deps: QueuedRunRecoveryDependencies) {
  const { getSchedulingSuppression, resumeExecutionWaitComments, getWorktreeExecutionCutoff,
    resumeQueuedCommentInterrupt, readQueuedInteractionResponse, isHeartbeatRunTerminalStatus,
    resumeSavedLegacyComments, releaseIssueExecutionAndPromote, startNextQueuedRunForAgent, resumeDeferredBridgeReceipt } = deps;
  if ((await getSchedulingSuppression()).suppressed) return;
  await resumeExecutionWaitComments();
  const cutoff = await getWorktreeExecutionCutoff();
  const pendingInterrupts = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId })
    .from(agentWakeupRequests).innerJoin(companies, eq(companies.id, agentWakeupRequests.companyId))
    .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
      eq(companies.status, "active"),
      sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null`,
      lte(agentWakeupRequests.updatedAt, new Date(Date.now() - 30_000)),
      cutoff ? gte(agentWakeupRequests.requestedAt, cutoff) : undefined))
    .orderBy(asc(agentWakeupRequests.updatedAt)).limit(50);
  for (const wake of pendingInterrupts) {
    await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(and(
      eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
    await resumeQueuedCommentInterrupt(wake.companyId, wake.id).catch(err => {
      logger.warn({ err, queueId: wake.id }, "failed to resume interrupted comment queue");
    });
  }
  // A server restart or a message/cleanup race can leave a deferred wake
  // after terminalization, before or after the issue lock clears. Use normal
  // release admission, so recovery holds and operator Stops still apply.
  const strandedQueues = await db.select({ wake: agentWakeupRequests, bridgeReceipt: isDeferredBridgeReceipt() })
    .from(agentWakeupRequests)
    .innerJoin(issues, and(eq(issues.companyId, agentWakeupRequests.companyId),
      sql`${issues.id}::text = ${agentWakeupRequests.payload}->>'issueId'`,
      eq(issues.assigneeAgentId, agentWakeupRequests.agentId)))
    .innerJoin(companies, and(eq(companies.id, issues.companyId), eq(companies.status, "active")))
    .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
      or(isNull(issues.executionRunId), isDeferredBridgeReceipt()),
      or(isDeferredBridgeReceipt(), and(
        sql`jsonb_typeof(${agentWakeupRequests.payload} #> '{_paperclipWakeContext,wakeCommentIds}') = 'array'`,
        sql`${agentWakeupRequests.payload} #> '{_paperclipWakeContext,wakeCommentIds}' <> '[]'::jsonb`,
      ), sql`${agentWakeupRequests.payload}->>'mutation' = 'interaction'`),
      sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is null`,
      cutoff ? gte(agentWakeupRequests.requestedAt, cutoff) : undefined))
    .orderBy(asc(agentWakeupRequests.updatedAt), asc(agentWakeupRequests.id)).limit(50);
  for (const { wake, bridgeReceipt } of strandedQueues) {
    // Rotate every attempted receipt, including admission that remains deferred.
    // Otherwise 50 waiting bridge receipts can exclude later ready work forever.
    await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(and(
      eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
    if (bridgeReceipt) {
      await resumeDeferredBridgeReceipt(wake.companyId, wake.id).catch(err => {
        logger.warn({ err, queueId: wake.id }, "failed to admit deferred bridge receipt");
      });
      continue;
    }
    if (!queuedCommentIdsFromWakePayload(wake.payload).length &&
        !await readQueuedInteractionResponse(db, wake.companyId, String(wake.payload?.issueId), wake.payload)) continue;
    const [latest] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, wake.companyId), eq(heartbeatRuns.agentId, wake.agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${String(wake.payload?.issueId)}`,
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    if (!latest || latest.runtimeMode !== "legacy" || !isHeartbeatRunTerminalStatus(latest.status)) continue;
    const cancelledAdmission = latest.status === "cancelled" && !latest.startedAt &&
      latest.errorCode === "execution_reconciliation_required";
    if ((latest.status !== "cancelled" || cancelledAdmission) && await getExecutionBlocker(db, wake.companyId, String(wake.payload?.issueId))) {
      await resumeSavedLegacyComments(wake.companyId, wake.id).catch(err => {
        logger.warn({ err, queueId: wake.id }, "failed to deliver saved legacy comment after recovery stopped");
      });
    }
    await releaseIssueExecutionAndPromote(latest, { suppressImmediateRecovery: true }).catch(err => {
      logger.warn({ err, queueId: wake.id }, "failed to promote stranded execution wakes");
    });
  }

  // The cancellation marker is durable intent. Retry while its exact queue
  // is still deferred, including after a failed cleanup promotion or restart.
  // Normal admission still checks process ownership, leases, pauses, and scope.
  const interruptedQueues = await db
    .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId })
    .from(agentWakeupRequests)
    .innerJoin(heartbeatRuns, and(
      sql`${heartbeatRuns.resultJson}->>'queuedCommentInterruptQueueId' = ${agentWakeupRequests.id}::text`,
      eq(heartbeatRuns.companyId, agentWakeupRequests.companyId),
      eq(heartbeatRuns.agentId, agentWakeupRequests.agentId),
    ))
    .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
    .where(and(
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
      eq(heartbeatRuns.status, "cancelled"),
      eq(heartbeatRuns.runtimeMode, "legacy"),
      eq(companies.status, "active"),
      cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
    ));
  for (const run of interruptedQueues) {
    await releaseIssueExecutionAndPromote(run, { suppressImmediateRecovery: true }).catch((err) => {
      logger.error({ err, runId: run.id }, "failed to retry interrupted comment queue");
    });
  }

  const queuedRuns = await db
    .select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
    .where(
      and(
        eq(heartbeatRuns.status, "queued"),
        eq(companies.status, "active"),
        cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
      ),
    );

  const agentIds = [...new Set(queuedRuns.map((r) => r.agentId))];
  for (const agentId of agentIds) {
    await startNextQueuedRunForAgent(agentId);
  }
}
