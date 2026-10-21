import type { Issue } from "./issue.js";

/** `view=light` returns the persisted issue and labels. Derived detail fields are absent. */
export type LightIssue = Omit<Issue,
  "ancestors" | "project" | "goal" | "mentionedProjects" | "planDocument" | "legacyPlanDocument" | "documentSummaries" |
  "relatedWork" | "referencedIssueIdentifiers" | "blockedBy" | "blocks" | "blockerAttention" |
  "reviewAttention" | "successfulRunHandoff" | "executionBlocker" | "scheduledRetry" |
  "activeRecoveryAction" | "linkedCases" | "workProducts" | "externalChannelBinding" |
  "currentExecutionWorkspace"
>;
