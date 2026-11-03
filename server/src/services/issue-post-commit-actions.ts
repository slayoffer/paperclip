import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { dispatchPendingDependencyReleaseWakes } from "./dependency-release-wakes.js";

export type IssuePostCommitAction = {
  type: "cancel_native_question_run";
  runId: string;
  issueId: string;
  issueStatus: string;
} | {
  type: "dispatch_dependency_wake";
  companyId: string;
  intentId: string;
} | {
  type: "close_terminal_workspaces";
  companyId: string;
  issueId: string;
};

/** Execute side effects that must never run before the issue transaction commits. */
export async function executeIssuePostCommitActions(
  db: Db,
  actions: readonly IssuePostCommitAction[],
): Promise<void> {
  if (actions.length === 0) return;
  const heartbeat = actions.some((action) => action.type !== "close_terminal_workspaces")
    ? (await import("./heartbeat.js")).heartbeatService(db)
    : null;
  const cancelledRunIds = new Set<string>();
  for (const action of actions) {
    if (action.type === "close_terminal_workspaces") {
      try {
        const { closeTerminalIssueWorkspaces } = await import("./issue-terminal-workspaces.js");
        await closeTerminalIssueWorkspaces(db, action);
      } catch (err) {
        logger.warn({ err, issueId: action.issueId }, "Could not close terminal issue workspaces");
      }
      continue;
    }
    if (action.type === "dispatch_dependency_wake") {
      try {
        await dispatchPendingDependencyReleaseWakes(db, heartbeat!.wakeup, action);
      } catch (err) {
        logger.warn({ err, intentId: action.intentId }, "dependency release wake deferred to recovery");
      }
      continue;
    }
    if (cancelledRunIds.has(action.runId)) continue;
    cancelledRunIds.add(action.runId);
    try {
      await heartbeat!.cancelRun(
        action.runId,
        "Task closed while waiting for operator input",
        {
          resultJson: {
            cancelledByIssueStatus: action.issueStatus,
            cancelledIssueId: action.issueId,
          },
        },
      );
    } catch (err) {
      // The durable marker written by the issue transaction remains available
      // to startup and periodic recovery. Do not report a post-commit failure
      // as though the already-committed issue transition had rolled back.
      logger.warn(
        { err, runId: action.runId, issueId: action.issueId },
        "native question cancellation deferred to recovery sweep",
      );
    }
  }
}
