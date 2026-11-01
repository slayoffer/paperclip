import { and, eq } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import { asBoolean, asNumber, parseObject } from "../../adapters/utils.js";
import { logActivity } from "../activity-log.js";
import { resolveTimerDriverIssueId } from "../heartbeat/timer-driver-issue.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import type { issueService } from "../issues.js";

export async function hasStandingTimerContinuation(
  db: Db,
  issuesSvc: Pick<ReturnType<typeof issueService>, "listDependencyReadiness">,
  issue: typeof issues.$inferSelect,
): Promise<boolean> {
  if (issue.status !== "in_progress" || !issue.assigneeAgentId) return false;
  const [agent] = await db.select().from(agents).where(and(
    eq(agents.companyId, issue.companyId), eq(agents.id, issue.assigneeAgentId),
  )).limit(1);
  if (!agent) return false;
  const heartbeat = parseObject(parseObject(agent.runtimeConfig).heartbeat);
  if (!asBoolean(heartbeat.enabled, false) || asNumber(heartbeat.intervalSec, 0) <= 0) return false;
  return await resolveTimerDriverIssueId(db, issuesSvc, agent) === issue.id;
}

export async function resolveDispositionRepairActionAsCovered(
  db: Db,
  issue: typeof issues.$inferSelect,
  reason: string,
) {
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const active = await recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id);
  if (!active || active.kind !== "deliberate_wait_without_target") return;
  await recoveryActionsSvc.resolveActiveForIssue({
    companyId: issue.companyId,
    sourceIssueId: issue.id,
    actionId: active.id,
    status: "resolved",
    outcome: "restored",
    resolutionNote: reason,
  });
  await logActivity(db, {
    companyId: issue.companyId,
    actorType: "system",
    actorId: "recovery",
    agentId: null,
    runId: null,
    action: "issue.disposition_repair_resolved",
    entityType: "issue_recovery_action",
    entityId: active.id,
    details: { sourceIssueId: issue.id, sourceIdentifier: issue.identifier, reason },
  });
}
