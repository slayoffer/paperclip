import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { issueComments, issueRelations, issues, type Db } from "@paperclipai/db";
import { blockedStateIntegrityEnabled, hasNonDependencyBlockedWait } from "./blocked-state-integrity.js";
import { isReviewBridgeWait } from "./review-bridge-contract.js";

const MAX_CHILD_COMPLETION_SUMMARIES = 20;
const CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS = 500;

export type ChildIssueCompletionSummary = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: Date;
  summary: string | null;
};

function truncateInlineSummary(
  value: string | null | undefined,
  maxChars = CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS,
) {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]`
    : normalized;
}

export async function getWakeableParentAfterChildCompletion(
  db: Db,
  parentIssueId: string,
  completedChildResult?: { issueId: string; summary: string | null } | null,
  dependencyNotification = false,
) {
  const parent = await db
    .select({
      id: issues.id,
      conversationAgentId: issues.conversationAgentId,
      originKind: issues.originKind,
      assigneeAgentId: issues.assigneeAgentId,
      status: issues.status,
      companyId: issues.companyId,
      unblockDescriptor: issues.unblockDescriptor,
    })
    .from(issues)
    .where(eq(issues.id, parentIssueId))
    .then((rows) => rows[0] ?? null);
  if (!parent || parent.conversationAgentId || !parent.assigneeAgentId || ["backlog", "cancelled"].includes(parent.status) ||
      (parent.status === "done" && parent.originKind !== "onboarding_first_task")) {
    return null;
  }
  if (parent.status === "blocked" && isReviewBridgeWait(parent.unblockDescriptor)
      && Date.parse(parent.unblockDescriptor.until) > Date.now()) {
    return null;
  }

  if (blockedStateIntegrityEnabled()) {
    if (await hasNonDependencyBlockedWait(db, parent.id)) return null;
    if (completedChildResult && !dependencyNotification && parent.status !== "done") {
      // The dependency path owns this completion, including deferred dispatch.
      // A separate parent wake must not bypass finalization or create another run.
      const [dependency] = await db.select({ id: issueRelations.issueId }).from(issueRelations).where(and(
        eq(issueRelations.companyId, parent.companyId), eq(issueRelations.type, "blocks"),
        eq(issueRelations.issueId, completedChildResult.issueId), eq(issueRelations.relatedIssueId, parent.id),
      )).limit(1);
      if (dependency) return null;
    }
  }

  const children = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, parent.companyId),
        eq(issues.parentId, parentIssueId),
      ),
    )
    .orderBy(asc(issues.issueNumber), asc(issues.createdAt));
  if (children.length === 0) return null;
  if (
    !children.every(
      (child) => child.status === "done" || child.status === "cancelled",
    )
  ) {
    return null;
  }

  const childIdsForSummaries = children
    .slice(0, MAX_CHILD_COMPLETION_SUMMARIES)
    .map((child) => child.id);
  const commentRows =
    childIdsForSummaries.length > 0
      ? await db
          .select({
            issueId: issueComments.issueId,
            body: issueComments.body,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.companyId, parent.companyId),
              inArray(issueComments.issueId, childIdsForSummaries),
              isNull(issueComments.deletedAt),
            ),
          )
          .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
      : [];
  const latestCommentByIssueId = new Map<string, string>();
  for (const comment of commentRows) {
    if (!latestCommentByIssueId.has(comment.issueId)) {
      latestCommentByIssueId.set(comment.issueId, comment.body);
    }
  }
  const childIssueSummaries: ChildIssueCompletionSummary[] = children
    .slice(0, MAX_CHILD_COMPLETION_SUMMARIES)
    .map((child) => ({
      ...child,
      summary: truncateInlineSummary(
        child.id === completedChildResult?.issueId
          ? (completedChildResult.summary ??
              latestCommentByIssueId.get(child.id))
          : latestCommentByIssueId.get(child.id),
      ),
    }));

  return {
    onboardingCompletion: parent.originKind === "onboarding_first_task",
    id: parent.id,
    assigneeAgentId: parent.assigneeAgentId,
    childIssueIds: children.map((child) => child.id),
    childIssueSummaries,
    childIssueSummaryTruncated:
      children.length > childIssueSummaries.length,
  };
}
