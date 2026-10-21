import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRelations, issues } from "@paperclipai/db";
import { visibleIssueCondition } from "../issue-visibility.js";

export function listBlockedDependencyWakeCandidates(
  db: Db, opts: { companyId?: string | null; blockerIssueId?: string | null } | undefined, afterIssueId: string | null, limit: number,
) {
  const filters = [
    eq(issues.status, "blocked"),
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
        totalCount: sql<number>`count(*) over()::int`,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
      .where(and(...filters))
      .orderBy(asc(issues.id))
      .limit(limit);
  }

  return db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      assigneeAgentId: issues.assigneeAgentId,
      blockedTransitionAt: issues.blockedTransitionAt,
      totalCount: sql<number>`count(*) over()::int`,
    })
    .from(issues)
    .where(and(...filters))
    .orderBy(asc(issues.id))
    .limit(limit);
}
