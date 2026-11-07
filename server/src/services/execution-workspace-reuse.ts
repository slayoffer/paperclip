// The shared reuse helpers remain in heartbeat/workspaces.ts.
// This module keeps the fork's import path for workspace-reuse-fallback.ts.
export {
  provisionExecutionWorkspaceForFreshnessDecision,
  resolveNativeRecoveryExecutionWorkspaceBinding,
  resolveExecutionWorkspaceReuseRequestForIssue,
  resolveExecutionWorkspaceReuseProvisioningPolicy,
} from "./heartbeat/workspaces.js";
export type { ExecutionWorkspaceReuseRequestForIssue } from "./heartbeat/workspaces.js";
