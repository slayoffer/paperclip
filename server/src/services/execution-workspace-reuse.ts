import { parseObject } from "../adapters/utils.js";
import type { ExecutionWorkspaceConfigFreshnessDecision } from "./heartbeat.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

type ExecutionWorkspaceReuseProvisioningPolicy = {
  shouldRestoreExistingWorkspace: boolean;
  shouldRefreshWorkspaceConfigSnapshot: boolean;
  shouldPersistLatestWorkspaceConfigMetadata: boolean;
};

type WorkspaceReuseIssueRef =
  | {
      id?: string | null;
      identifier?: string | null;
    }
  | null
  | undefined;

export type ExecutionWorkspaceReuseRequestForIssue = {
  requestedExecutionWorkspaceId: string | null;
  requestedShouldReuseExisting: boolean;
  existingExecutionWorkspaceAvailable: boolean;
};

/**
 * Projectless native runs bind their immutable envelope to the run id even
 * though no project-scoped execution-workspace row exists. Treat that value
 * as a reuse request only when it resolves to a persisted workspace row.
 */
export function resolveNativeRecoveryExecutionWorkspaceBinding(input: {
  bindingId: string | null | undefined;
  persistedWorkspaceFound: boolean;
}): string | null {
  const bindingId = readNonEmptyString(input.bindingId);
  return bindingId && input.persistedWorkspaceFound ? bindingId : null;
}

export function resolveExecutionWorkspaceReuseRequestForIssue(input: {
  issueExecutionWorkspaceId?: string | null;
  issueExecutionWorkspacePreference?: string | null;
  existingExecutionWorkspaceStatus?: string | null;
  requestedExistingBranch?: string | null;
  existingExecutionWorkspaceBranchName?: string | null;
}): ExecutionWorkspaceReuseRequestForIssue {
  const requestedExecutionWorkspaceId = readNonEmptyString(
    input.issueExecutionWorkspaceId,
  );
  // An explicitly pinned existing branch outranks an inherited reuse_existing
  // binding: a persisted workspace on any other branch (or with no recorded
  // branch) is stale for this issue, so dispatch realizes the pinned branch.
  const requestedExistingBranch = readNonEmptyString(
    input.requestedExistingBranch,
  );
  const existingWorkspaceMatchesRequestedBranch =
    requestedExistingBranch === null ||
    readNonEmptyString(input.existingExecutionWorkspaceBranchName) ===
      requestedExistingBranch;
  const requestedShouldReuseExisting =
    input.issueExecutionWorkspacePreference === "reuse_existing" &&
    requestedExecutionWorkspaceId !== null &&
    existingWorkspaceMatchesRequestedBranch;

  return {
    requestedExecutionWorkspaceId,
    requestedShouldReuseExisting,
    existingExecutionWorkspaceAvailable:
      requestedShouldReuseExisting &&
      input.existingExecutionWorkspaceStatus !== null &&
      input.existingExecutionWorkspaceStatus !== undefined &&
      input.existingExecutionWorkspaceStatus !== "archived",
  };
}

export function resolveExecutionWorkspaceReuseProvisioningPolicy(input: {
  requestedShouldReuseExisting: boolean;
  workspaceConfigFreshness: ExecutionWorkspaceConfigFreshnessDecision;
}): ExecutionWorkspaceReuseProvisioningPolicy {
  const shouldRestoreExistingWorkspace = input.requestedShouldReuseExisting;
  const replacementClassDrift =
    input.requestedShouldReuseExisting &&
    input.workspaceConfigFreshness.action === "replace";

  return {
    shouldRestoreExistingWorkspace,
    shouldRefreshWorkspaceConfigSnapshot:
      shouldRestoreExistingWorkspace &&
      !replacementClassDrift &&
      input.workspaceConfigFreshness.shouldRefreshConfigSnapshot,
    shouldPersistLatestWorkspaceConfigMetadata: !replacementClassDrift,
  };
}

function formatInheritedExecutionWorkspaceReuseFailure(input: {
  reason:
    | "inherited_workspace_reuse_failed"
    | "inherited_workspace_reuse_unavailable";
  issueRef: WorkspaceReuseIssueRef;
  runId: string;
  executionWorkspaceId: string | null | undefined;
  workspaceConfigFreshness: ExecutionWorkspaceConfigFreshnessDecision;
  cause?: unknown;
}) {
  const issueLabel =
    input.issueRef?.identifier ?? input.issueRef?.id ?? input.runId;
  const workspaceLabel = input.executionWorkspaceId ?? "unknown workspace";
  const causeMessage =
    input.cause instanceof Error
      ? input.cause.message
      : input.cause != null
        ? String(input.cause)
        : null;
  const remediation =
    input.reason === "inherited_workspace_reuse_failed"
      ? "Inspect the referenced execution workspace restore/provision logs, repair or unarchive the workspace, or intentionally clear the issue's reuse_existing workspace binding before retrying."
      : "Repair or unarchive the referenced execution workspace, or intentionally clear the issue's reuse_existing workspace binding before retrying.";
  const message = causeMessage
    ? `Issue ${issueLabel} requested inherited execution workspace reuse for ${workspaceLabel}, but the workspace could not be restored because ${causeMessage}.`
    : `Issue ${issueLabel} requested inherited execution workspace reuse for ${workspaceLabel}, but the workspace could not be restored.`;

  return `${message} ${remediation}`;
}

export async function provisionExecutionWorkspaceForFreshnessDecision<
  T extends { warnings?: string[] },
>(input: {
  requestedShouldReuseExisting: boolean;
  existingExecutionWorkspaceId?: string | null;
  issueRef: WorkspaceReuseIssueRef;
  runId: string;
  workspaceConfigFreshness: ExecutionWorkspaceConfigFreshnessDecision;
  restoreExistingWorkspace?: (() => Promise<T | null>) | null;
  realizeWorkspace: () => Promise<T>;
}): Promise<{
  executionWorkspace: T;
  reusedExecutionWorkspace: T | null;
  policy: ExecutionWorkspaceReuseProvisioningPolicy;
}> {
  const policy = resolveExecutionWorkspaceReuseProvisioningPolicy({
    requestedShouldReuseExisting: input.requestedShouldReuseExisting,
    workspaceConfigFreshness: input.workspaceConfigFreshness,
  });

  if (!policy.shouldRestoreExistingWorkspace) {
    const executionWorkspace = await input.realizeWorkspace();
    return {
      executionWorkspace,
      reusedExecutionWorkspace: null,
      policy,
    };
  }

  let restored: T | null = null;
  let reuseFailure: string | null = null;
  try {
    restored = (await input.restoreExistingWorkspace?.()) ?? null;
  } catch (error) {
    if (parseObject(error).code === "workspace_validation_failed") {
      throw error;
    }
    reuseFailure = formatInheritedExecutionWorkspaceReuseFailure({
      reason: "inherited_workspace_reuse_failed",
      issueRef: input.issueRef,
      runId: input.runId,
      executionWorkspaceId: input.existingExecutionWorkspaceId,
      workspaceConfigFreshness: input.workspaceConfigFreshness,
      cause: error,
    });
  }

  if (!restored) {
    reuseFailure =
      reuseFailure ??
      formatInheritedExecutionWorkspaceReuseFailure({
        reason: "inherited_workspace_reuse_unavailable",
        issueRef: input.issueRef,
        runId: input.runId,
        executionWorkspaceId: input.existingExecutionWorkspaceId,
        workspaceConfigFreshness: input.workspaceConfigFreshness,
      });
  }

  if (reuseFailure) throw new Error(reuseFailure);
  if (!restored) {
    throw new Error(
      "Expected restored execution workspace after reuse fallback handling",
    );
  }

  return {
    executionWorkspace: restored,
    reusedExecutionWorkspace: restored,
    policy,
  };
}
