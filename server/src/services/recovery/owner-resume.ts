import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { requiresRestartReconciliation } from "../conversation-continuation.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** This switch changes the prompt contract. Dispatch retains its existing gates. */
export function ownerRecoveryResumeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["false", "0"].includes(env.PAPERCLIP_OWNER_RECOVERY_RESUME_ENABLED?.trim().toLowerCase() ?? "");
}

const OWNER_CONTINUATION_CAUSES = new Set([
  "process_lost", "server_shutdown_interrupted", "duplex_channel_lost",
  "stranded_assigned_issue", "deliberate_wait_without_target",
]);

/** Select the contract from current rows. Wake data cannot select another owner. */
export async function buildOwnerRecoveryWake(db: Db, input: {
  companyId: string;
  agentId?: string | null;
  runId?: string | null;
  contextSnapshot: Record<string, unknown>;
}) {
  const context = input.contextSnapshot;
  const issueId = text(context.issueId);
  const actionId = text(context.recoveryActionId);
  const recoveryCause = text(context.recoveryCause) ??
    (context.wakeReason === "source_scoped_recovery_action" ? "stranded_assigned_issue" : null);
  const action = actionId && issueId ? await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.id, actionId), eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
  )).then(rows => rows[0] ?? null) : null;
  const evidence = record(action?.evidence);
  if (action?.status === "resolved" && evidence.executionReconciliation) return null;
  if (!action && !recoveryCause) return null;
  const historical = action && ["resolved", "cancelled"].includes(action.status);
  const cause = historical ? recoveryCause ?? "stranded_assigned_issue" : action?.cause ?? recoveryCause;
  const originalOwnerId = action?.returnOwnerAgentId ?? action?.previousOwnerAgentId ?? null;
  const originalOwner = originalOwnerId ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(
    eq(agents.id, originalOwnerId), eq(agents.companyId, input.companyId),
  )).then(rows => rows[0] ?? null) : null;
  let ownerResume = false;
  if (ownerRecoveryResumeEnabled() && input.agentId && input.runId && issueId && cause &&
      context.recoveryIntent !== "status_only" && context.allowDeliverableWork !== false &&
      record(evidence.automaticRecovery).replay !== "blocked" &&
      OWNER_CONTINUATION_CAUSES.has(cause)) {
    const [task] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)));
    // A board action can contain a real decision. Never infer approval from its cause.
    const active = await issueRecoveryActionService(db).getActiveForIssue(input.companyId, issueId);
    const governingAction = active ?? (historical ? null : action);
    const actionAllowsWork = !governingAction ||
      (governingAction.ownerType === "agent" && governingAction.ownerAgentId === input.agentId &&
        OWNER_CONTINUATION_CAUSES.has(governingAction.cause));
    if (task?.assigneeAgentId === input.agentId && task.executionRunId === input.runId && !task.assigneeUserId &&
        ["todo", "in_progress"].includes(task.status) && actionAllowsWork) {
      const sourceId = text(context.retryOfRunId) ?? text(evidence.latestRunId) ?? text(evidence.runId);
      const [source] = sourceId ? await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, sourceId), eq(heartbeatRuns.companyId, input.companyId),
      )) : [];
      ownerResume = !sourceId || Boolean(source && source.agentId === input.agentId &&
        (source.nativeIssueId ?? source.contextSnapshot?.issueId) === issueId &&
        !hasWorkspaceRestoreFailure(source.resultJson) && !requiresRestartReconciliation(source.resultJson));
    }
  }
  return {
    cause,
    ...(ownerResume ? { executionMode: "owner_resume" as const } : {}),
    failureSummary: text(evidence.failureSummary),
    originalAssignee: originalOwner ? { id: originalOwner.id, name: originalOwner.name }
      : originalOwnerId ? { id: originalOwnerId, name: null } : null,
    attemptCount: action?.attemptCount ?? null,
    maxAttempts: action?.maxAttempts ?? null,
    nextAction: historical ? null : action?.nextAction ?? null,
    routingFallbackReason: text(evidence.routingFallbackReason),
  };
}
