import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
import { and, eq, gt, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, projectWorkspaces, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { closeExecutionWorkspace } from "./execution-workspace-close.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { isProcessAlive } from "./heartbeat/recovery.js";
import { hasRetainedNativeProvider } from "./issue-terminal-native-owners.js";
import { isProcessGroupAlive } from "./local-service-supervisor.js";

const execFileAsync = promisify(execFile);
const terminalStatuses = ["done", "cancelled"];
const activeRunStatuses = ["queued", "running", "scheduled_retry"];
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
  const containsPath = async (value: string) => {
    const resolved = await identity(value);
    return [...paths].some((root) => {
      const suffix = relative(root, resolved);
      return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
    });
  };
  const candidates = await db.select({
    id: executionWorkspaces.id, sourceIssueId: executionWorkspaces.sourceIssueId,
    status: executionWorkspaces.status,
    cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef,
    metadata: executionWorkspaces.metadata, mode: executionWorkspaces.mode,
    strategyType: executionWorkspaces.strategyType, providerType: executionWorkspaces.providerType,
  }).from(executionWorkspaces);
  const workspaceIds = new Set([workspace.id]);
  const boundWorkspaceIds = new Set([workspace.id]);
  const sourceIssueIds = new Set([input.issueId, ...(workspace.sourceIssueId ? [workspace.sourceIssueId] : [])]);
  for (const candidate of candidates) {
    for (const value of [candidate.cwd, candidate.providerRef]) {
      if (value && await containsPath(value)) {
        boundWorkspaceIds.add(candidate.id);
        if (candidate.status === "archived") break;
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
  const boundToWorkspace = or(
    sql`exists (select 1 from ${issues} run_issue
      where run_issue.company_id = ${heartbeatRuns.companyId}
        and ${inArray(sql`run_issue.id`, relatedIssues.map((related) => related.id))}
        and (run_issue.id = ${heartbeatRuns.issueId} or run_issue.id = ${heartbeatRuns.nativeIssueId}
          or run_issue.id::text = ${heartbeatRuns.contextSnapshot}->>'issueId'
          or run_issue.execution_run_id = ${heartbeatRuns.id} or run_issue.checkout_run_id = ${heartbeatRuns.id}))`,
    inArray(sql`${heartbeatRuns.contextSnapshot}->>'executionWorkspaceId'`, [...boundWorkspaceIds]),
    inArray(sql`${heartbeatRuns.runnerProfileJson}#>>'{nativeExecutionInput,binding,executionWorkspaceId}'`, [...boundWorkspaceIds]),
  );
  const now = new Date();
  const nativeCwd = sql<string | null>`${heartbeatRuns.runnerProfileJson}#>>'{nativeExecutionInput,workspace,cwd}'`;
  const legacyCwd = sql<string | null>`${heartbeatRuns.contextSnapshot}#>>'{paperclipWorkspace,cwd}'`;
  const relatedRuns = await db.select({
    run: { id: heartbeatRuns.id, runtimeMode: heartbeatRuns.runtimeMode, runnerProfileJson: heartbeatRuns.runnerProfileJson, status: heartbeatRuns.status, processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
      controllerBootId: heartbeatRuns.controllerBootId, controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt },
    coordinator: { leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt },
    bound: sql<boolean>`coalesce(${boundToWorkspace}, false)`, nativeCwd, legacyCwd,
  }).from(heartbeatRuns).leftJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id)).where(and(
    or(boundToWorkspace, isNotNull(nativeCwd), isNotNull(legacyCwd)),
    or(eq(heartbeatRuns.runtimeMode, "native"), inArray(heartbeatRuns.status, activeRunStatuses), isNotNull(heartbeatRuns.processPid), isNotNull(heartbeatRuns.processGroupId),
      and(isNotNull(heartbeatRuns.controllerBootId), gt(heartbeatRuns.controllerLeaseExpiresAt, now)),
      and(isNotNull(nativeRunFinalizations.leaseOwner), gt(nativeRunFinalizations.leaseExpiresAt, now))),
  ));
  // Native coordinator PIDs identify the server and survive lease release.
  for (const { run, coordinator, bound, nativeCwd: cwd, legacyCwd: savedCwd } of relatedRuns) {
    if (!bound && !(cwd && await containsPath(cwd)) && !(savedCwd && await containsPath(savedCwd))) continue;
    const live = activeRunStatuses.includes(run.status)
      || isProcessAlive(run.processPid) || isProcessGroupAlive(run.processGroupId)
      || (run.controllerBootId && run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > now)
      || (coordinator?.leaseOwner && coordinator.leaseExpiresAt && coordinator.leaseExpiresAt > now)
      || await hasRetainedNativeProvider(db, run);
    if (live) {
      reasons.push("An issue run still uses this workspace.");
      break;
    }
  }
  // Display readiness excludes services removed from the current configuration.
  const persistedServices = await db.select({
    executionWorkspaceId: workspaceRuntimeServices.executionWorkspaceId, cwd: workspaceRuntimeServices.cwd,
  }).from(workspaceRuntimeServices).where(ne(workspaceRuntimeServices.status, "stopped"));
  for (const service of persistedServices) {
    if ((service.executionWorkspaceId && boundWorkspaceIds.has(service.executionWorkspaceId))
      || (service.cwd && await containsPath(service.cwd))) {
      reasons.push("A runtime service still uses this checkout.");
      break;
    }
  }
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
    if (primary.cwd && await containsPath(primary.cwd)) {
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
