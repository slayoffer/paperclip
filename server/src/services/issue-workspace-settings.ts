import {
  parseIssueExecutionWorkspaceSettings,
  selectEnvironmentExecutionWorkspaceSettings,
} from "./execution-workspace-policy.js";

export function removeIsolatedWorkspaceControls(data: {
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: Record<string, unknown> | null;
}) {
  delete data.executionWorkspaceId;
  delete data.executionWorkspacePreference;
  if (data.executionWorkspaceSettings === undefined) return;
  const settings = selectEnvironmentExecutionWorkspaceSettings(
    parseIssueExecutionWorkspaceSettings(data.executionWorkspaceSettings, { includeEnvironmentId: true }),
    false,
  );
  data.executionWorkspaceSettings = settings ? { ...settings } : null;
}
