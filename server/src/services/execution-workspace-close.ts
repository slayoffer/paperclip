import { and, eq } from "drizzle-orm";
import { issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import type { ExecutionWorkspace, ExecutionWorkspaceCloseReadiness } from "@paperclipai/shared";
import { executionWorkspaceService, readExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { workspaceRuntimeLeaseService } from "./workspace-runtime-leases.js";
import { cleanupExecutionWorkspaceArtifacts, stopRuntimeServicesForExecutionWorkspace } from "./workspace-runtime.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

type CloseResult =
  | { outcome: "closed"; workspace: ExecutionWorkspace; cleanupWarnings: string[] }
  | { outcome: "blocked"; reasons: string[]; closeReadiness?: ExecutionWorkspaceCloseReadiness }
  | { outcome: "not_found" }
  | { outcome: "failed"; error: string };

/** The archive route and terminal-issue cleanup share this lifecycle. */
export async function closeExecutionWorkspace(db: Db, input: {
  workspace: ExecutionWorkspace;
  patch?: Parameters<ReturnType<typeof executionWorkspaceService>["update"]>[1];
  pluginWorkerManager?: PluginWorkerManager;
  automaticGuard?: (workspace: ExecutionWorkspace) => Promise<string[]>;
}): Promise<CloseResult> {
  const svc = executionWorkspaceService(db);
  const existing = input.workspace;
  const patch = input.patch ?? {};
  const readiness = await svc.getCloseReadiness(existing.id);
  if (!readiness) return { outcome: "not_found" };
  if (readiness.state === "blocked") {
    return { outcome: "blocked", reasons: readiness.blockingReasons, closeReadiness: readiness };
  }
  const closedAt = new Date();
  const archive = await svc.archiveWorkspaceUnderLifecycleLock({
    id: existing.id, patch, closedAt, guard: input.automaticGuard,
  });
  if (!archive) return { outcome: "not_found" };
  if (archive.outcome === "blocked") return archive;
  if (archive.outcome === "reopen_pending") {
    return { outcome: "blocked", reasons: ["Execution workspace was reopened and cannot be archived right now"] };
  }
  let workspace = archive.workspace;
  const capturedGeneration = archive.capturedGeneration;
  const config = readExecutionWorkspaceConfig(patch.metadata ?? existing.metadata);
  let cleanupWarnings: string[] = [];
  try {
    await workspaceRuntimeLeaseService(db).release({ executionWorkspaceId: existing.id, force: true });
    if (existing.mode === "shared_workspace") {
      await db.update(issues).set({ executionWorkspaceId: null, updatedAt: new Date() })
        .where(and(eq(issues.companyId, existing.companyId), eq(issues.executionWorkspaceId, existing.id)));
    }
    const projectWorkspace = existing.projectWorkspaceId
      ? await db.select({ cwd: projectWorkspaces.cwd, cleanupCommand: projectWorkspaces.cleanupCommand })
          .from(projectWorkspaces)
          .where(and(eq(projectWorkspaces.id, existing.projectWorkspaceId), eq(projectWorkspaces.companyId, existing.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const projectPolicy = existing.projectId
      ? await db.select({ executionWorkspacePolicy: projects.executionWorkspacePolicy }).from(projects)
          .where(and(eq(projects.id, existing.projectId), eq(projects.companyId, existing.companyId)))
          .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
      : null;
    // A reopen fences both sandbox lease teardown and filesystem destruction.
    const fenced = await svc.fenceClosedWorkspaceDestruction({
      workspaceId: existing.id,
      capturedGeneration,
      destroy: async () => {
        await environmentRuntimeService(db, { pluginWorkerManager: input.pluginWorkerManager })
          .destroyReusableSandboxLeases({ companyId: existing.companyId,
            executionWorkspaceId: existing.id, failureReason: "execution_workspace_closed" });
        await stopRuntimeServicesForExecutionWorkspace({ db, executionWorkspaceId: existing.id, workspaceCwd: existing.cwd });
        return cleanupExecutionWorkspaceArtifacts({
          workspace: existing, projectWorkspace,
          teardownCommand: config?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
          cleanupCommand: config?.cleanupCommand ?? null,
          recorder: workspaceOperationService(db).createRecorder({
            companyId: existing.companyId, executionWorkspaceId: existing.id,
          }),
          // The manual route retains its force-close behavior. Automatic close
          // rechecks its guards before removal and never forces a dirty worktree.
          ...(input.automaticGuard ? {
            forceWorktreeRemoval: false,
            assertSafeToCleanup: async () => {
              const reasons = await input.automaticGuard!(existing);
              if (reasons.length) throw new Error(reasons.join(" | "));
            },
          } : {}),
        });
      },
    });
    if (fenced.skippedReopened) {
      workspace = (await svc.getById(existing.id)) ?? workspace;
    } else {
      cleanupWarnings = fenced.result.warnings;
      if (cleanupWarnings.length || !fenced.result.cleaned) {
        workspace = (await svc.applyClosedWorkspaceCleanupOutcome({
          id: existing.id, closedAt, capturedGeneration,
          cleanupReason: cleanupWarnings.length ? cleanupWarnings.join(" | ") : null,
          markCleanupFailed: !fenced.result.cleaned,
        })) ?? (await svc.getById(existing.id)) ?? workspace;
      }
    }
    return { outcome: "closed", workspace, cleanupWarnings };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    await svc.applyClosedWorkspaceCleanupOutcome({
      id: existing.id, closedAt, capturedGeneration, cleanupReason: failureReason, markCleanupFailed: true,
    });
    return { outcome: "failed", error: `Failed to archive execution workspace: ${failureReason}` };
  }
}
