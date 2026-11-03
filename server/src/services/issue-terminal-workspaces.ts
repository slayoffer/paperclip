import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, projectWorkspaces, type Db } from "@paperclipai/db";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { closeExecutionWorkspace } from "./execution-workspace-close.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { isProcessAlive } from "./heartbeat/recovery.js";
import { isProcessGroupAlive } from "./local-service-supervisor.js";

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
  // Paths are host resources. Resolve aliases across companies without exposing
  // another company's details. Cache identities only for this close check.
  const identities = new Map<string, Promise<string>>();
  const identity = (value: string) => {
    let resolved = identities.get(value);
    if (!resolved) {
      resolved = realpath(value).catch(() => value);
      identities.set(value, resolved);
    }
    return resolved;
  };
  const paths = new Set(await Promise.all(
    [workspace.cwd, workspace.providerRef].filter((value): value is string => Boolean(value)).map(identity),
  ));
  const candidates = await db.select({
    id: executionWorkspaces.id, sourceIssueId: executionWorkspaces.sourceIssueId,
    cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef,
    metadata: executionWorkspaces.metadata, mode: executionWorkspaces.mode,
    strategyType: executionWorkspaces.strategyType, providerType: executionWorkspaces.providerType,
  }).from(executionWorkspaces).where(sql`${executionWorkspaces.status} <> 'archived'`);
  const workspaceIds = new Set([workspace.id]);
  const sourceIssueIds = new Set([input.issueId, ...(workspace.sourceIssueId ? [workspace.sourceIssueId] : [])]);
  for (const candidate of candidates) {
    for (const value of [candidate.cwd, candidate.providerRef]) {
      if (value && paths.has(await identity(value))) {
        workspaceIds.add(candidate.id);
        if (candidate.sourceIssueId) sourceIssueIds.add(candidate.sourceIssueId);
        if (candidate.mode !== "isolated_workspace" || candidate.strategyType !== "git_worktree"
          || candidate.providerType !== "git_worktree"
          || typeof candidate.metadata?.taskEnvironmentSourceWorkspaceId === "string") {
          reasons.push("Another workspace protects this checkout.");
        }
        break;
      }
    }
  }
  if (workspaceIds.size > 1) {
    reasons.push("Multiple workspace rows own this checkout. Resolve them before automatic close.");
  }
  const relatedIssues = await db.select({ id: issues.id, status: issues.status }).from(issues).where(or(
    inArray(issues.id, [...sourceIssueIds]), inArray(issues.executionWorkspaceId, [...workspaceIds]),
  ));
  const owner = relatedIssues.find((related) => !terminalStatuses.includes(related.status));
  if (owner) reasons.push("Another open issue uses this workspace path.");
  const relatedRuns = await db.select({ run: heartbeatRuns, coordinator: nativeRunFinalizations }).from(heartbeatRuns)
    .leftJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id)).where(
    sql`exists (select 1 from ${issues} run_issue
      where run_issue.company_id = ${heartbeatRuns.companyId}
        and ${inArray(sql`run_issue.id`, relatedIssues.map((related) => related.id))}
        and (run_issue.id = ${heartbeatRuns.issueId} or run_issue.id = ${heartbeatRuns.nativeIssueId}
          or run_issue.id::text = ${heartbeatRuns.contextSnapshot}->>'issueId'
          or run_issue.execution_run_id = ${heartbeatRuns.id} or run_issue.checkout_run_id = ${heartbeatRuns.id}))`,
  );
  const now = new Date();
  if (relatedRuns.some(({ run, coordinator }) =>
    ["queued", "running", "scheduled_retry"].includes(run.status)
    || isProcessAlive(run.processPid) || isProcessGroupAlive(run.processGroupId)
    || (run.controllerBootId && run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > now)
    || isProcessAlive(coordinator?.controllerPid)
    || (coordinator?.leaseOwner && coordinator.leaseExpiresAt && coordinator.leaseExpiresAt > now)
  )) reasons.push("An issue run still uses this workspace.");
  // Cleanup acts on a physical checkout, so every alias must satisfy readiness.
  const svc = executionWorkspaceService(db);
  for (const workspaceId of workspaceIds) {
    const readiness = await svc.getCloseReadiness(workspaceId);
    if (!readiness || readiness.blockingReasons.length > 0 || readiness.isSharedWorkspace
      || readiness.isProjectPrimaryWorkspace || readiness.runtimeServices.some((service) => service.status !== "stopped")
      || readiness.git?.hasDirtyTrackedFiles || readiness.git?.hasUntrackedFiles) {
      reasons.push("A workspace using this checkout is not ready for automatic close.");
    }
  }
  // Readiness compares saved paths lexically. A primary checkout can have a symlink alias.
  const primaryPaths = await db.select({ cwd: projectWorkspaces.cwd }).from(projectWorkspaces)
    .where(eq(projectWorkspaces.isPrimary, true));
  for (const primary of primaryPaths) {
    if (primary.cwd && paths.has(await identity(primary.cwd))) {
      reasons.push("This checkout is a primary project workspace.");
      break;
    }
  }
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
