import { and, eq, inArray, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { persistActivity } from "./activity-log.js";
import { isPreDispatchDependencyWait, isPreDispatchWaitVerified } from "./pre-dispatch-review-wait.js";

/** Resolve historical false holds through the same retained dispatch proof. */
export async function resolveSuppressedDependencyRecoveries(db: Db, companyId: string, issueId: string) {
  return db.transaction(async tx => {
    const actions = await tx.select({ action: issueRecoveryActions, run: heartbeatRuns })
      .from(issueRecoveryActions).innerJoin(heartbeatRuns, and(
        eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
        sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'`,
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueRecoveryActions.sourceIssueId}::text`,
      )).where(and(
        eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.kind, "active_run_watchdog"),
        eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
        or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
          sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`),
        eq(heartbeatRuns.errorCode, "issue_dependencies_blocked"),
      )).for("update", { of: issueRecoveryActions });
    let resolved = 0;
    for (const { action, run } of actions) {
      if (action.evidence.workspaceRestoreFailure || !isPreDispatchDependencyWait(run) ||
        !(await isPreDispatchWaitVerified(tx as unknown as Db, run))) continue;
      const now = new Date();
      const [updated] = await tx.update(issueRecoveryActions).set({
        status: "resolved", outcome: "cancelled", resolvedAt: now, updatedAt: now,
        wakePolicy: null, monitorPolicy: null,
        nextAction: "No provider actions need reconciliation.",
        resolutionNote: "The dependency gate stopped this run before provider execution.",
        evidence: { ...action.evidence, automaticRecovery: {
          ...(action.evidence.automaticRecovery as Record<string, unknown> ?? {}),
          replay: "not_required", actionOutcome: "not_started",
        }, dependencyResolution: { runId: run.id, providerWorkStarted: false } },
      }).where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.id, action.id))).returning();
      if (!updated) continue;
      resolved++;
      await persistActivity(tx as unknown as Db, { companyId, actorType: "system", actorId: "dependency_release",
        action: "issue.execution_recovery_settled", entityType: "issue", entityId: issueId,
        details: { recoveryActionId: action.id, runId: run.id, outcome: "not_started" } });
    }
    return resolved;
  });
}
