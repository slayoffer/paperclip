import { and, eq, inArray, or, sql } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@paperclipai/db";
import { persistActivity } from "./activity-log.js";

/** Reset disposition bookkeeping only. Execution and workspace safety holds remain active. */
export async function resetBridgeDispositionRecovery(db: Db, companyId: string, issueId: string, reason: string) {
  const rows = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    eq(issueRecoveryActions.kind, "deliberate_wait_without_target"),
    or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`),
  )).for("update");
  for (const action of rows) {
    if (action.evidence.workspaceRestoreFailure) continue;
    await db.update(issueRecoveryActions).set({
      status: "resolved", outcome: "restored", resolvedAt: new Date(), updatedAt: new Date(),
      nextAction: "The owner can continue after the recorded bridge wait.",
      resolutionNote: reason, wakePolicy: null, monitorPolicy: null,
      evidence: { ...action.evidence, automaticRecovery: {
        ...(action.evidence.automaticRecovery as Record<string, unknown> ?? {}), replay: "not_required",
      } },
    }).where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.id, action.id)));
    await persistActivity(db, { companyId, actorType: "system", actorId: "review_bridge",
      action: "issue.disposition_repair_resolved", entityType: "issue", entityId: issueId,
      details: { recoveryActionId: action.id, reason } });
  }
}
