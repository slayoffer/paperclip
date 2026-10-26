import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db, agents, instanceSettings, projects, activityLog,
  issueThreadInteractions, approvals, issueApprovals } from "@paperclipai/db";
import { isPullQueueEnabled } from "./pull-queue-policy.js";
import { issueTokenBudgetConfig, loadIssueTokenBudgetState, ISSUE_TOKEN_BUDGET_SKIP_REASON } from "./issue-token-budget.js";
import { isRecoveryIssueTokenBudgetBlocked } from "./recovery/issue-token-budget.js";
import { budgetService } from "./budgets.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { isHeartbeatWakeOnDemandEnabled } from "./heartbeat-policy.js";

type Issue = typeof issues.$inferSelect;
type Agent = typeof agents.$inferSelect;
const PARKED = "pull_queue.parked";

function digest(value: unknown): string {
  // JSONB key order must not change a saved condition's identity.
  return createHash("sha256").update(JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item)).digest("hex");
}

function waitFingerprint(issue: Issue) {
  return digest([issue.assigneeAgentId, issue.unblockDescriptor, issue.executionPolicy,
    issue.executionState, issue.monitorNextCheckAt, issue.monitorNotes]);
}

export async function pullQueueFingerprint(db: Db, issue: Issue, agent: Agent) {
  const [settings] = await db.select({ experimental: instanceSettings.experimental, general: instanceSettings.general })
    .from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).limit(1);
  const project = issue.projectId ? await db.select({ policy: projects.executionWorkspacePolicy,
    env: projects.env, status: projects.status, pausedAt: projects.pausedAt })
    .from(projects).where(and(eq(projects.companyId, issue.companyId), eq(projects.id, issue.projectId))).limit(1) : [];
  const cards = await db.select({ id: issueThreadInteractions.id, status: issueThreadInteractions.status,
    resolvedAt: issueThreadInteractions.resolvedAt }).from(issueThreadInteractions)
    .where(and(eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id)))
    .orderBy(asc(issueThreadInteractions.id));
  const gates = await db.select({ id: approvals.id, status: approvals.status }).from(issueApprovals)
    .innerJoin(approvals, and(eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, issue.companyId)))
    .where(and(eq(issueApprovals.companyId, issue.companyId), eq(issueApprovals.issueId, issue.id)))
    .orderBy(asc(approvals.id));
  return digest([waitFingerprint(issue), issue.status, issue.statusVersion, issue.executionState,
    issue.projectId, issue.projectWorkspaceId, issue.executionWorkspaceId, issue.executionWorkspaceSettings,
    issue.executionWorkspacePreference, issue.assigneeAdapterOverrides,
    agent.status, agent.reportsTo, agent.runtimeConfig, agent.adapterConfig, settings, project, cards, gates,
    process.env.PAPERCLIP_IN_WORKTREE, process.env.PAPERCLIP_INSTANCE_ID]);
}

/** Call inside the issue update transaction. A backlog disposition is a durable stop. */
export async function recordPullQueueParking(
  tx: Db, previous: Issue, next: Issue, requestedStatus?: string,
) {
  if (!isPullQueueEnabled() || next.status !== "backlog" || next.conversationAgentId
    || !next.assigneeAgentId || previous.assigneeAgentId !== next.assigneeAgentId) return;
  const explicitPark = requestedStatus === "backlog";
  const waitChanged = previous.status === "backlog" && waitFingerprint(previous) !== waitFingerprint(next);
  if (!explicitPark && !waitChanged) return;
  await tx.insert(agentWakeupRequests).values({ companyId: next.companyId, agentId: next.assigneeAgentId,
    source: "assignment", reason: PARKED, status: "skipped", requestedByActorType: "system",
    createdAt: sql`clock_timestamp()`, finishedAt: new Date(),
    // A changed wait resumes legacy work too. Save its old condition so the
    // compatibility path cannot replace it with a new stop for the new wait.
    payload: { issueId: next.id, pullQueueWait: waitFingerprint(explicitPark ? next : previous) } });
}

/** Selection receipts restrict automatic pulls only. Ordinary admission remains authoritative. */
export async function pullQueueCandidateBlocked(db: Db, issue: Issue, agent: Agent, fingerprint: string): Promise<boolean> {
  const scope = and(eq(agentWakeupRequests.companyId, issue.companyId),
    eq(agentWakeupRequests.agentId, agent.id), sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`);
  if (issue.status === "backlog") {
    const [park] = await db.select().from(agentWakeupRequests).where(and(scope,
      eq(agentWakeupRequests.reason, PARKED))).orderBy(desc(agentWakeupRequests.createdAt), desc(agentWakeupRequests.id)).limit(1);
    if (park?.payload?.pullQueueWait === waitFingerprint(issue)) return true;
    // Old parking decisions predate these receipts. A prior run alone is not
    // a parking decision: require recorded backlog intent after that run began.
    if (!park) {
      const [prior] = await db.select({ startedAt: heartbeatRuns.startedAt, createdAt: heartbeatRuns.createdAt })
        .from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agent.id),
        sql`(${heartbeatRuns.nativeIssueId} = ${issue.id} or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id})`,
      )).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id)).limit(1);
      if (prior) {
        const [decision] = await db.select({ details: activityLog.details }).from(activityLog).where(and(
          eq(activityLog.companyId, issue.companyId), eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issue.id),
          sql`${activityLog.action} in ('issue.updated', 'issue.status_decision_recorded')`,
          sql`${activityLog.createdAt} >= ${(prior.startedAt ?? prior.createdAt).toISOString()}::timestamptz`,
          sql`(${activityLog.details}->>'status' is not null or ${activityLog.details}->>'toStatus' is not null)`,
        )).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(1);
        if (decision?.details?.status === "backlog" || decision?.details?.toStatus === "backlog") {
          await recordPullQueueParking(db, issue, issue, "backlog");
          return true;
        }
      }
    }
  }

  if (await isRecoveryIssueTokenBudgetBlocked(db, issue)) return true;
  const [last] = await db.select().from(agentWakeupRequests).where(scope)
    .orderBy(desc(agentWakeupRequests.createdAt), desc(agentWakeupRequests.id)).limit(1);
  if (last?.status !== "skipped" || last.reason === PARKED) return false;
  // Recheck budget grants, rolling windows, and budget edits. A receipt alone
  // cannot keep a cleared budget gate closed.
  if (last.reason === ISSUE_TOKEN_BUDGET_SKIP_REASON) {
    const config = issueTokenBudgetConfig();
    return config ? (await loadIssueTokenBudgetState(db, {
      companyId: issue.companyId, issueId: issue.id, config,
    })).exceeded : false;
  }
  if (last.reason === "budget.blocked") return Boolean(await budgetService(db).getInvocationBlock(
    issue.companyId, agent.id, { issueId: issue.id, projectId: issue.projectId }));
  if (last.reason === "issue_tree_hold_active") return Boolean(await issueTreeControlService(db)
    .getActivePauseHoldGate(issue.companyId, issue.id));
  if (last.reason === "execution_reconciliation_required") return Boolean(await getExecutionBlocker(
    db, issue.companyId, issue.id, { readProjection: true }));
  if (last.reason === "agent.not_invokable") return !(await evaluateAgentInvokabilityFromDb(db, agent)).invokable;
  if (last.reason === "heartbeat.wakeOnDemand.disabled") return !isHeartbeatWakeOnDemandEnabled(agent);
  // The selector already rechecked these gates. Their old receipt is stale.
  if (["issue_dependencies_blocked", "company.inactive", "heartbeat.scheduling_suppressed"].includes(last.reason ?? "")) return false;
  if (last.payload?.pullQueueFingerprint !== fingerprint) return false;
  const skip = last.payload?.heartbeatSkip as Record<string, unknown> | undefined;
  if (typeof skip?.nextAllowedAt === "string") return Date.parse(skip.nextAllowedAt) > Date.now();
  if (last.reason?.startsWith("heartbeat.daily_")) {
    return last.createdAt.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
  }
  return true;
}

export async function pullQueueWakeWasSkipped(db: Db, issue: Issue, agent: Agent, fingerprint: string) {
  const [last] = await db.select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, issue.companyId),
      eq(agentWakeupRequests.agentId, agent.id), sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`))
    .orderBy(desc(agentWakeupRequests.createdAt), desc(agentWakeupRequests.id)).limit(1);
  return last?.status === "skipped" && last.payload?.pullQueueFingerprint === fingerprint;
}
