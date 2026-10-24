import fs from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { resolveExecutionWorkspaceReuseRequestForIssue, resolveNativeRecoveryExecutionWorkspaceBinding } from "./execution-workspace-reuse.js";
import { parseObject } from "../adapters/utils.js";
import { assertWorkspaceReuseIsSafe } from "./workspace-reuse-safety.js";

type ReuseWorkspace = {
  id: string;
  companyId?: string;
  cwd: string | null;
  providerRef: string | null;
  sourceIssueId: string | null;
};

/** Select a new workspace before inherited configuration or restore can run. */
export async function resolveUnsafeWorkspaceReuseFallback(input: {
  db?: Db | null;
  companyId: string;
  issueId?: string | null;
  workspace: ReuseWorkspace | null;
  recoveryExecutionWorkspaceId?: string | null;
  requestedExistingBranch?: string | null;
  operatorBranch?: boolean;
}) {
  if (!input.issueId || !input.workspace || input.recoveryExecutionWorkspaceId || input.requestedExistingBranch || input.operatorBranch) return null;
  if (input.workspace.companyId && input.workspace.companyId !== input.companyId) {
    throw new Error("The execution workspace belongs to another company.");
  }
  const cwd = input.workspace.cwd ?? input.workspace.providerRef;
  if (!cwd) return null;
  // Missing directories must retain the existing restore path.
  if (!await fs.stat(cwd).then((stat) => stat.isDirectory()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) return null;
  try {
    await assertWorkspaceReuseIsSafe({
      db: input.db,
      companyId: input.companyId,
      issueId: input.issueId,
      executionWorkspaceId: input.workspace.id,
      sourceIssueId: input.workspace.sourceIssueId,
      cwd,
    });
    return null;
  } catch (error) {
    const failure = parseObject(error);
    const validation = parseObject(parseObject(failure.resultJson).workspaceValidation);
    if (failure.code !== "workspace_validation_failed" || validation.reason !== "cross_issue_workspace_not_clean") throw error;
    return {
      reason: "cross_issue_workspace_not_clean",
      executionWorkspaceId: input.workspace.id,
      sourceIssueId: validation.sourceIssueId,
      cleanliness: validation.cleanliness,
      warning: `Workspace ${input.workspace.id} belongs to another issue and is not clean. This run uses a separate issue workspace.`,
    };
  }
}

/** Never inherit the foreign workspace's branch or a shared branch template. */
export function isolatedWorkspaceReuseConfig(input: {
  config: Record<string, unknown>;
  issueId: string;
  issueIdentifier?: string | null;
}) {
  const { existingBranch: _existingBranch, ...strategy } = parseObject(input.config.workspaceStrategy);
  return {
    workspaceStrategy: {
      ...strategy,
      type: "git_worktree",
      branchTemplate: `${input.issueIdentifier ?? "issue"}-isolated-${input.issueId}`,
    },
  };
}

/** All supported strategy sources can carry an exact branch request. */
export function requestedWorkspaceReuseBranch(strategies: unknown[]): string | null {
  for (const strategy of strategies) {
    const branch = parseObject(strategy).existingBranch;
    if (typeof branch === "string" && branch.trim()) return branch.trim();
  }
  return null;
}

/** Keep the selected strategy stable on subsequent wakes of the new binding. */
export function shouldKeepWorkspaceReuseIsolation(input: {
  issueId?: string | null;
  workspace: { sourceIssueId: string | null; metadata?: Record<string, unknown> | null } | null;
  requestedExistingBranch?: string | null;
  operatorBranch?: boolean;
}) {
  return !input.requestedExistingBranch && !input.operatorBranch && Boolean(input.issueId
    && input.workspace?.sourceIssueId === input.issueId
    && parseObject(input.workspace.metadata?.workspaceReuseFallback).reason === "cross_issue_workspace_not_clean");
}

/** Resolve the reuse guard before inherited configuration can reach dispatch. */
export async function resolveWorkspaceReuseSelection(input: {
  db: Db;
  companyId: string;
  issueId?: string | null;
  requestedExecutionWorkspaceId: string | null;
  persistedRecoveryExecutionWorkspaceId: string | null;
  existingExecutionWorkspace: ExecutionWorkspace | null;
  preference?: string | null;
  operatorBranch: boolean;
  strategies: unknown[];
}) {
  const recoveryExecutionWorkspaceId = resolveNativeRecoveryExecutionWorkspaceBinding({
    bindingId: input.persistedRecoveryExecutionWorkspaceId,
    persistedWorkspaceFound: input.existingExecutionWorkspace !== null,
  });
  const requestedReuseBranch = requestedWorkspaceReuseBranch(input.strategies);
  const workspaceReuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({
    issueExecutionWorkspaceId: input.requestedExecutionWorkspaceId,
    issueExecutionWorkspacePreference: recoveryExecutionWorkspaceId ? "reuse_existing" : input.preference,
    existingExecutionWorkspaceStatus: input.existingExecutionWorkspace?.status,
    requestedExistingBranch: recoveryExecutionWorkspaceId ? null : requestedReuseBranch,
    existingExecutionWorkspaceBranchName: input.existingExecutionWorkspace?.branchName,
  });
  const workspaceReuseFallback = await resolveUnsafeWorkspaceReuseFallback({
    db: input.db, companyId: input.companyId, issueId: input.issueId,
    workspace: workspaceReuseRequest.existingExecutionWorkspaceAvailable ? input.existingExecutionWorkspace : null,
    recoveryExecutionWorkspaceId, requestedExistingBranch: requestedReuseBranch, operatorBranch: input.operatorBranch,
  });
  const requestedShouldReuseExisting = workspaceReuseRequest.requestedShouldReuseExisting && !workspaceReuseFallback;
  return { recoveryExecutionWorkspaceId, requestedReuseBranch, workspaceReuseRequest,
    workspaceReuseFallback, requestedShouldReuseExisting,
    reusableExistingExecutionWorkspace: requestedShouldReuseExisting && workspaceReuseRequest.existingExecutionWorkspaceAvailable
      ? input.existingExecutionWorkspace : null,
  };
}
