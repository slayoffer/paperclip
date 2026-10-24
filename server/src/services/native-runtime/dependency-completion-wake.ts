import { blockedStateIntegrityEnabled } from "../blocked-state-integrity.js";
import {
  buildIssueBlockersResolvedWakeIdempotencyKey,
  buildIssueBlockersResolvedWakeStateKey,
} from "../issue-dependency-wakeups.js";

/** Native completion and durable release must identify the same blocked cycle. */
export function dependencyCompletionWakeKey(
  dependent: { id: string; blockerIssueIds: string[]; blockedTransitionAt?: Date | string | null },
  completedIssueId: string,
  isCompletedChildParent: boolean,
  /** Upstream: a new child-completion decision revision gets a new parent wake. */
  childCompletionRevision = "",
) {
  if (blockedStateIntegrityEnabled()) {
    return buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: dependent.id,
      blockerIssueIds: dependent.blockerIssueIds,
      blockedTransitionAt: dependent.blockedTransitionAt,
    });
  }
  return isCompletedChildParent
    ? `issue_children_completed:${dependent.id}:${completedIssueId}${childCompletionRevision}`
    : buildIssueBlockersResolvedWakeIdempotencyKey({
        dependentIssueId: dependent.id, resolvedBlockerIssueId: completedIssueId,
      });
}
