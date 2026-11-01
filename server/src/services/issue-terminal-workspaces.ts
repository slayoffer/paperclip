import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { closeExecutionWorkspace } from "./execution-workspace-close.js";
import { executionWorkspaceService } from "./execution-workspaces.js";

const execFileAsync = promisify(execFile);
const terminalStatuses = ["done", "cancelled"];
// Share the queue across requests and service instances on this host process.
let cleanupQueue: Promise<void> = Promise.resolve();

export function closeTerminalIssueWorkspaces(db: Db, input: { companyId: string; issueId: string }): Promise<void> {
  const job = cleanupQueue.then(() => closeWorkspaces(db, input)).catch((err) => {
    logger.warn({ err, ...input }, "Could not close terminal issue workspaces");
  });
  cleanupQueue = job;
  return job;
}

async function closeWorkspaces(db: Db, input: { companyId: string; issueId: string }) {
  const [issue] = await db.select().from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue || !terminalStatuses.includes(issue.status)) return;
  const candidates = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId),
    or(eq(executionWorkspaces.sourceIssueId, issue.id),
      ...(issue.executionWorkspaceId ? [eq(executionWorkspaces.id, issue.executionWorkspaceId)] : [])),
    eq(executionWorkspaces.mode, "isolated_workspace"),
    eq(executionWorkspaces.strategyType, "git_worktree"),
    eq(executionWorkspaces.providerType, "git_worktree"),
    inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
  )).orderBy(executionWorkspaces.createdAt, executionWorkspaces.id);
  const svc = executionWorkspaceService(db);
  for (const candidate of candidates) {
    try {
      const workspace = await svc.getById(candidate.id);
      if (!workspace) continue;
      const result = await closeExecutionWorkspace(db, {
        workspace,
        automaticGuard: (fresh) => automaticCloseReasons(db, fresh, input),
      });
      if (result.outcome === "blocked") {
        logger.warn({ ...input, workspaceId: candidate.id, reasons: result.reasons }, "Skipped terminal workspace close");
      } else if (result.outcome === "failed") {
        logger.warn({ ...input, workspaceId: candidate.id, error: result.error }, "Terminal workspace close failed");
      } else if (result.outcome === "closed") {
        if (result.workspace.status === "cleanup_failed" || result.cleanupWarnings.length) {
          logger.warn({ ...input, workspaceId: candidate.id, reasons: result.cleanupWarnings }, "Terminal workspace cleanup needs attention");
        }
        await logActivity(db, {
          companyId: input.companyId, actorType: "system", actorId: "issue_terminal",
          action: "execution_workspace.updated", entityType: "execution_workspace", entityId: candidate.id,
          details: { source: "issue_terminal", issueId: input.issueId,
            status: result.workspace.status, cleanupWarnings: result.cleanupWarnings },
        });
      }
    } catch (err) {
      logger.warn({ err, ...input, workspaceId: candidate.id }, "Terminal workspace close failed");
    }
  }
}

async function automaticCloseReasons(
  db: Db, workspace: ExecutionWorkspace, input: { companyId: string; issueId: string },
): Promise<string[]> {
  const reasons: string[] = [];
  const [issue] = await db.select({ status: issues.status }).from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue || !terminalStatuses.includes(issue.status)) reasons.push("The issue is no longer terminal.");
  if (workspace.mode !== "isolated_workspace" || workspace.strategyType !== "git_worktree"
    || workspace.providerType !== "git_worktree") reasons.push("This workspace is not an isolated Git worktree.");
  if (typeof workspace.metadata?.taskEnvironmentSourceWorkspaceId === "string") {
    reasons.push("This environment borrows another workspace.");
  }
  // Paths are host resources. Check aliases across companies without exposing
  // the other company's issue or workspace details in logs or responses.
  const [owner] = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces)
    .where(and(
      sql`${executionWorkspaces.status} <> 'archived'`,
      or(
        ...(workspace.cwd ? [eq(executionWorkspaces.cwd, workspace.cwd)] : []),
        ...(workspace.providerRef ? [eq(executionWorkspaces.cwd, workspace.providerRef),
          eq(executionWorkspaces.providerRef, workspace.providerRef)] : []),
      ),
      sql`exists (select 1 from ${issues} owner_issue
        where (owner_issue.id = ${executionWorkspaces.sourceIssueId}
          or owner_issue.execution_workspace_id = ${executionWorkspaces.id})
        and owner_issue.status not in ('done', 'cancelled'))`,
    )).limit(1);
  if (owner) reasons.push("Another open issue uses this workspace path.");
  const [activeRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
    sql`exists (select 1 from ${issues} run_issue
      where run_issue.company_id = ${input.companyId}
        and (run_issue.id = ${input.issueId} or run_issue.id = ${workspace.sourceIssueId}
          or run_issue.execution_workspace_id = ${workspace.id})
        and (run_issue.id = ${heartbeatRuns.issueId} or run_issue.id = ${heartbeatRuns.nativeIssueId}
          or run_issue.id::text = ${heartbeatRuns.contextSnapshot}->>'issueId'
          or run_issue.execution_run_id = ${heartbeatRuns.id} or run_issue.checkout_run_id = ${heartbeatRuns.id}))`,
  )).limit(1);
  if (activeRun) reasons.push("An issue run still uses this workspace.");
  const readiness = await executionWorkspaceService(db).getCloseReadiness(workspace.id);
  if (!readiness) return [...reasons, "The workspace no longer exists."];
  reasons.push(...readiness.blockingReasons);
  if (readiness.isProjectPrimaryWorkspace) reasons.push("This is the primary project checkout.");
  if (readiness.runtimeServices.some((service) => service.status !== "stopped")) reasons.push("Runtime services are still live.");
  if (readiness.git?.hasDirtyTrackedFiles || readiness.git?.hasUntrackedFiles) reasons.push("The worktree has uncommitted files.");
  const cwd = workspace.providerRef ?? workspace.cwd;
  try {
    if (!cwd) throw new Error("No workspace path");
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (Number(stdout.trim()) !== 0) reasons.push("The worktree has unpushed commits.");
  } catch {
    reasons.push("Could not verify that the worktree commits were pushed.");
  }
  return reasons;
}
