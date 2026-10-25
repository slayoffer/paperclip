import type { agents } from "@paperclipai/db";
import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import type { LatestIssueRun } from "./run-types.js";
import type { StrandedRecoveryCause } from "./service.js";
import { SUCCESSFUL_RUN_MISSING_STATE_REASON } from "./successful-run-handoff.js";

export function compactRecoveryPresentation(title: string): IssueCommentPresentation {
  const normalizedTitle = title.trim();
  return {
    kind: "system_notice",
    tone: "warning",
    title:
      normalizedTitle.length > 160
        ? `${normalizedTitle.slice(0, 159)}…`
        : normalizedTitle,
    detailsDefaultOpen: false,
    density: "compact",
  };
}

export function recoveryCauseTitle(cause: StrandedRecoveryCause) {
  switch (cause) {
    case "process_lost":
      return "retries exhausted";
    case "codex_output_inactivity_monitor":
      return "output-inactivity retry exhausted";
    case "workspace_validation_failed":
      return "workspace validation failed";
    case "configuration_incomplete":
      return "configuration incomplete";
    case "execution_review_participant_recovery":
      return "reviewer recovery failed";
    case "provider_quota":
      return "provider quota unavailable";
    case SUCCESSFUL_RUN_MISSING_STATE_REASON:
      return "missing disposition recovery failed";
    default:
      return "execution path recovery failed";
  }
}

export function recoveryNoticeMetadata(input: {
  cause: string;
  latestRun: LatestIssueRun;
  recoveryActionId?: string | null;
  previousStatus: string;
  recoveryOwner?: Pick<typeof agents.$inferSelect, "id" | "name"> | null;
}): IssueCommentMetadata {
  const rows: IssueCommentMetadata["sections"][number]["rows"] = [
    ...(input.recoveryActionId
      ? [
          {
            type: "key_value" as const,
            label: "Recovery action",
            value: input.recoveryActionId,
          },
        ]
      : []),
    { type: "key_value", label: "Cause", value: input.cause },
    {
      type: "key_value",
      label: "Previous status",
      value: input.previousStatus,
    },
    ...(input.recoveryOwner
      ? [
          {
            type: "agent_link" as const,
            label: "Recovery owner",
            agentId: input.recoveryOwner.id,
            name: input.recoveryOwner.name.slice(0, 160),
          },
        ]
      : [
          {
            type: "key_value" as const,
            label: "Recovery owner",
            value: "board",
          },
        ]),
    ...(input.latestRun
      ? [
          {
            type: "run_link" as const,
            label: "Latest run",
            runId: input.latestRun.id,
            title: input.latestRun.status,
          },
        ]
      : []),
  ];

  return {
    version: 1,
    sourceRunId: input.latestRun?.id ?? null,
    sections: [{ title: "Recovery", rows }],
  };
}
