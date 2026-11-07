import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";

/**
 * A stranded escalation gives the next decision to the board. With no open
 * blocker, the blocked-state integrity guard accepts `blocked` only with a
 * typed outside wait, so the escalation records that decision as a human wait.
 * The action must not name an issue identifier: the guard requires a blocker
 * link for each issue that the action names.
 */
export function boardEscalationWait(
  blockerIds: readonly string[],
  recoveryActionId: string,
): { unblockDescriptor?: IssueUnblockDescriptor } {
  if (blockerIds.length > 0) return {};
  return {
    unblockDescriptor: {
      owner: "board",
      kind: "human",
      action: `The board chooses the next action for stranded-work recovery action ${recoveryActionId}.`,
    },
  };
}

/** A refused write is tried again after this time even when the issue row did not change. */
export const REFUSED_RECONCILE_RETRY_MS = 60 * 60 * 1000;

type ReconciledIssue = { id: string; companyId: string; updatedAt: Date };

// In-process memory of reconcile writes that the server refused (HTTP 422).
// The same write on an unchanged issue gets the same refusal, so the sweep
// skips the issue until its row changes or the retry time passes.
const refusals = new Map<string, { updatedAt: number; at: number }>();

export function skipRefusedReconcile(issue: ReconciledIssue, now = Date.now()): boolean {
  const refusal = refusals.get(issue.id);
  return Boolean(
    refusal &&
      refusal.updatedAt === issue.updatedAt.getTime() &&
      now - refusal.at < REFUSED_RECONCILE_RETRY_MS,
  );
}

/**
 * Log a reconcile failure. The sweep catches every per-issue error: at startup
 * an escaped error exits the server, and the same issue fails again on every
 * restart. A refusal logs one warning for each issue state, not one for each tick.
 */
export function reportReconcileFailure(err: unknown, issue: ReconciledIssue, now = Date.now()) {
  const context = { err, companyId: issue.companyId, issueId: issue.id };
  // Compare the status, not the class: a second copy of the errors module fails `instanceof`.
  if ((err as { status?: unknown } | null)?.status !== 422) {
    logger.error(context, "stranded assigned issue reconcile failed; continuing with the next issue");
    return;
  }
  const updatedAt = issue.updatedAt.getTime();
  const previous = refusals.get(issue.id);
  refusals.set(issue.id, { updatedAt, at: now });
  if (previous?.updatedAt === updatedAt) return;
  logger.warn(context, "stranded assigned issue reconcile was refused; skipping the issue until it changes");
}
