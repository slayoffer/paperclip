import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { issueRelations, issues, type Db } from "@paperclipai/db";
import { dependencyReleaseRetryCondition } from "../issue-dependency-release.js";
import { visibleIssueCondition } from "../issue-visibility.js";

export const RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT = 500;

export function queryResolvedDependencyCandidates(db: Db,
  opts: { companyId?: string | null; blockerIssueId?: string | null } | undefined,
  afterIssueId: string | null,
) {
  const filters = [
    or(eq(issues.status, "blocked"), dependencyReleaseRetryCondition())!,
    isNull(issues.conversationAgentId),
    visibleIssueCondition(),
    sql`${issues.assigneeAgentId} is not null`,
  ];
  if (opts?.companyId) filters.push(eq(issues.companyId, opts.companyId));
  if (afterIssueId) filters.push(gt(issues.id, afterIssueId));

  if (opts?.blockerIssueId) {
    filters.push(
      eq(issueRelations.companyId, issues.companyId),
      eq(issueRelations.type, "blocks"),
      eq(issueRelations.issueId, opts.blockerIssueId),
      eq(issueRelations.relatedIssueId, issues.id),
    );
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        assigneeAgentId: issues.assigneeAgentId,
        blockedTransitionAt: issues.blockedTransitionAt,
        releaseStatusVersion: sql<number>`${issues.statusVersion} + case when ${issues.status} = 'blocked' then 1 else 0 end`,
        totalCount: sql<number>`count(*) over()::int`,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
      .where(and(...filters))
      .orderBy(asc(issues.id))
      .limit(RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT);
  }

  return db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      assigneeAgentId: issues.assigneeAgentId,
      blockedTransitionAt: issues.blockedTransitionAt,
      releaseStatusVersion: sql<number>`${issues.statusVersion} + case when ${issues.status} = 'blocked' then 1 else 0 end`,
      totalCount: sql<number>`count(*) over()::int`,
    })
    .from(issues)
    .where(and(...filters))
    .orderBy(asc(issues.id))
    .limit(RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT);
}
