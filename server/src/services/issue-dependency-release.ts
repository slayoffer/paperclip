import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { approvals, heartbeatRuns, issueApprovals, issueRecoveryActions, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { listIssueDependencyReadinessMap } from "./issue-dependency-readiness.js";
import { resolveSuppressedDependencyRecoveries } from "./dependency-recovery-resolution.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./recovery/pause-hold-guard.js";

/** Only the dependency relation can be the remaining declared wait. */
export async function releaseReadyDependencyWait(db: Db, companyId: string, issueId: string): Promise<boolean> {
  await resolveSuppressedDependencyRecoveries(db, companyId, issueId);
  if (await isAutomaticRecoverySuppressedByPauseHold(db, companyId, issueId)) return false;
  const result = await db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId),
      eq(issues.id, issueId))).for("update");
    if (issue && ["todo", "in_progress", "in_review"].includes(issue.status)) return true;
    if (!issue || issue.conversationAgentId || issue.status !== "blocked" || issue.unblockDescriptor ||
      issue.executionRunId || issue.checkoutRunId || issue.monitorNextCheckAt ||
      issue.executionState?.status === "pending") return null;
    const readiness = (await listIssueDependencyReadinessMap(tx, companyId, [issueId])).get(issueId);
    if (!readiness?.isDependencyReady || !readiness.blockerIssueIds.length) return null;
    const [interaction] = await tx.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.status, "pending"))).limit(1);
    const [approval] = await tx.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals,
      eq(issueApprovals.approvalId, approvals.id)).where(and(eq(issueApprovals.companyId, companyId),
      eq(approvals.companyId, companyId), eq(issueApprovals.issueId, issueId), eq(approvals.status, "pending"))).limit(1);
    const [recovery] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
      or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`))).limit(1);
    const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      or(eq(heartbeatRuns.nativeIssueId, issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`))).limit(1);
    if (interaction || approval || recovery || run) return null;
    await tx.update(issues).set({ status: "todo", updatedAt: new Date(),
      statusVersion: sql`${issues.statusVersion} + 1`, unblockDescriptor: null,
    }).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId), eq(issues.status, "blocked"),
      isNull(issues.unblockDescriptor)));
    return persistActivity(tx as unknown as Db, { companyId, actorType: "system", actorId: "dependency_release",
      action: "issue.updated", entityType: "issue", entityId: issueId,
      details: { status: "todo", previousStatus: "blocked", reason: "issue_blockers_resolved",
        blockerIssueIds: readiness.blockerIssueIds } });
  });
  if (result && result !== true) publishActivity(result.publication);
  return Boolean(result);
}
