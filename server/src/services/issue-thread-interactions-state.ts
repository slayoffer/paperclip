import { notFound } from "../errors.js";
import { issueThreadInteractionResolutionError } from "./issue-thread-interaction-resolution.js";

export function isTerminalIssueStatus(status: string) {
  return status === "done" || status === "cancelled";
}

export function interactionNotFoundError() {
  return notFound("Interaction not found", { code: "interaction_not_found" });
}

export function interactionIssueClosedError() {
  return issueThreadInteractionResolutionError(
    409,
    "interaction_issue_closed",
    "Interaction is no longer actionable because the issue is closed",
  );
}

export function interactionAlreadyResolvedError() {
  return issueThreadInteractionResolutionError(
    409,
    "interaction_already_resolved",
    "Interaction has already been resolved",
  );
}

export function interactionTerminalError(row: { status: string; result?: unknown }) {
  const result =
    row.result && typeof row.result === "object" && !Array.isArray(row.result)
      ? (row.result as unknown as Record<string, unknown>)
      : null;
  if (result?.outcome === "stale_target") {
    return issueThreadInteractionResolutionError(
      409,
      "interaction_stale_target",
      "Interaction target is stale",
    );
  }
  if (
    result?.outcome === "superseded_by_comment" ||
    result?.outcome === "superseded_by_newer_request"
  ) {
    return issueThreadInteractionResolutionError(
      409,
      "interaction_superseded",
      "Interaction has been superseded",
    );
  }
  if (result?.outcome === "issue_closed") return interactionIssueClosedError();
  return issueThreadInteractionResolutionError(
    409,
    "interaction_already_resolved",
    "Interaction has already been resolved",
  );
}
