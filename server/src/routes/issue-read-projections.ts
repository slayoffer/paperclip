import type { ExecutionWorkspace, ProjectWorkspace, WorkspaceRuntimeService } from "@paperclipai/shared";
import type { projectService } from "../services/projects.js";

export function compactIssueProjectWorkspace(
  workspace: ProjectWorkspace | null | undefined,
) {
  if (!workspace) return null;
  return {
    id: workspace.id,
    companyId: workspace.companyId,
    projectId: workspace.projectId,
    name: workspace.name,
    sourceType: workspace.sourceType,
    cwd: workspace.cwd,
    repoUrl: workspace.repoUrl,
    repoRef: workspace.repoRef,
    defaultRef: workspace.defaultRef,
    visibility: workspace.visibility,
    setupCommand: workspace.setupCommand,
    cleanupCommand: workspace.cleanupCommand,
    remoteProvider: workspace.remoteProvider,
    remoteWorkspaceRef: workspace.remoteWorkspaceRef,
    sharedWorkspaceKey: workspace.sharedWorkspaceKey,
    runtimeConfig: workspace.runtimeConfig,
    isPrimary: workspace.isPrimary,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

export function compactIssueProject(
  project: Awaited<ReturnType<ReturnType<typeof projectService>["getById"]>>,
) {
  if (!project) return null;
  return {
    id: project.id,
    companyId: project.companyId,
    urlKey: project.urlKey,
    goalId: project.goalId,
    goalIds: project.goalIds,
    goals: project.goals,
    name: project.name,
    description: project.description,
    status: project.status,
    leadAgentId: project.leadAgentId,
    targetDate: project.targetDate,
    color: project.color,
    icon: project.icon,
    env: null,
    pauseReason: project.pauseReason,
    pausedAt: project.pausedAt,
    executionWorkspacePolicy: project.executionWorkspacePolicy,
    codebase: project.codebase,
    workspaces: (project.workspaces ?? []).map(compactIssueProjectWorkspace),
    primaryWorkspace: compactIssueProjectWorkspace(project.primaryWorkspace),
    managedByPlugin: project.managedByPlugin ?? null,
    taskCount: project.taskCount,
    budget: project.budget,
    archivedAt: project.archivedAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function compactIssueRuntimeService(service: WorkspaceRuntimeService) {
  return {
    id: service.id,
    companyId: service.companyId,
    projectId: service.projectId,
    projectWorkspaceId: service.projectWorkspaceId,
    executionWorkspaceId: service.executionWorkspaceId,
    issueId: service.issueId,
    scopeType: service.scopeType,
    scopeId: service.scopeId,
    serviceName: service.serviceName,
    status: service.status,
    lifecycle: service.lifecycle,
    reuseKey: service.reuseKey,
    command: service.command,
    cwd: service.cwd,
    port: service.port,
    url: service.url,
    provider: service.provider,
    providerRef: service.providerRef,
    ownerAgentId: service.ownerAgentId,
    startedByRunId: service.startedByRunId,
    lastUsedAt: service.lastUsedAt,
    startedAt: service.startedAt,
    stoppedAt: service.stoppedAt,
    healthStatus: service.healthStatus,
    exposure: service.exposure ?? null,
    configIndex: service.configIndex ?? null,
  };
}

export function compactIssueExecutionWorkspace(
  workspace: ExecutionWorkspace | null,
) {
  if (!workspace) return null;
  return {
    id: workspace.id,
    companyId: workspace.companyId,
    projectId: workspace.projectId,
    projectWorkspaceId: workspace.projectWorkspaceId,
    sourceIssueId: workspace.sourceIssueId,
    mode: workspace.mode,
    strategyType: workspace.strategyType,
    name: workspace.name,
    status: workspace.status,
    deliveryState: workspace.deliveryState,
    cwd: workspace.cwd,
    repoUrl: workspace.repoUrl,
    baseRef: workspace.baseRef,
    branchName: workspace.branchName,
    providerType: workspace.providerType,
    providerRef: workspace.providerRef,
    derivedFromExecutionWorkspaceId:
      workspace.derivedFromExecutionWorkspaceId,
    lastUsedAt: workspace.lastUsedAt,
    openedAt: workspace.openedAt,
    closedAt: workspace.closedAt,
    cleanupEligibleAt: workspace.cleanupEligibleAt,
    cleanupReason: workspace.cleanupReason,
    config: workspace.config
      ? {
          environmentId: workspace.config.environmentId,
          provisionCommand: workspace.config.provisionCommand,
          runtimeProvisionCommand: workspace.config.runtimeProvisionCommand,
          teardownCommand: workspace.config.teardownCommand,
          cleanupCommand: workspace.config.cleanupCommand,
          workspaceRuntime: workspace.config.workspaceRuntime,
          desiredState: workspace.config.desiredState,
          serviceStates: workspace.config.serviceStates,
        }
      : null,
    metadata: null,
    runtimeServices: (workspace.runtimeServices ?? [])
      .filter(
        (service) =>
          service.status === "provisioning" ||
          service.status === "starting" ||
          service.status === "running",
      )
      .map(compactIssueRuntimeService),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}
