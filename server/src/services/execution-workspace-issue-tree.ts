import { and, eq, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";

type WorkspaceIssueSource = { companyId: string; sourceIssueId: string | null };
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

// Return the timestamp when an issue became terminal. A `done` issue uses
// `completedAt`. A `cancelled` issue uses `cancelledAt`. The reaper cooldown
// measures the age of the terminal transition from this timestamp. Fall back to
// `updatedAt` when the terminal timestamp is null, so an old issue that lacks a
// recorded transition time still gates the cooldown. Return null for a
// non-terminal issue.
function issueTerminalTimestamp(issue: {
  status: string;
  completedAt: Date | null;
  cancelledAt: Date | null;
  updatedAt: Date;
}): Date | null {
  if (issue.status === "done") return issue.completedAt ?? issue.updatedAt;
  if (issue.status === "cancelled") return issue.cancelledAt ?? issue.updatedAt;
  return null;
}

export function createWorkspaceIssueTreeAssessor(db: Db) {
  async function listWorkspaceIssueTree(workspace: WorkspaceIssueSource) {
    if (!workspace.sourceIssueId) return [];
    return db
      .select({
        id: issues.id,
        status: issues.status,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, workspace.companyId),
        sql<boolean>`
          ${issues.id} IN (
            WITH RECURSIVE issue_tree(id) AS (
              SELECT ${issues.id}
              FROM ${issues}
              WHERE ${issues.companyId} = ${workspace.companyId}
                AND ${issues.id} = ${workspace.sourceIssueId}
              UNION ALL
              SELECT child.id
              FROM ${issues} child
              JOIN issue_tree parent ON child.parent_id = parent.id
              WHERE child.company_id = ${workspace.companyId}
            )
            SELECT id FROM issue_tree
          )
        `,
      ));
  }

  return async function assessIssueTree(workspace: WorkspaceIssueSource) {
    const issueTree = await listWorkspaceIssueTree(workspace);
    const sourceIssue = issueTree.find((issue) => issue.id === workspace.sourceIssueId) ?? null;
    const sourceIssueTerminal = Boolean(sourceIssue && TERMINAL_ISSUE_STATUSES.has(sourceIssue.status));
    const subtreeTerminal = Boolean(sourceIssue && issueTree.every((issue) => TERMINAL_ISSUE_STATUSES.has(issue.status)));
    // The cooldown anchor is the most recent terminal timestamp across the whole
    // issue tree. The reaper compares it against the cooldown window. A null
    // anchor means no issue in the tree is terminal yet, so the cooldown never
    // applies (the terminal-tree gates above already block the archive).
    let cooldownAnchor: Date | null = null;
    for (const issue of issueTree) {
      const terminalAt = issueTerminalTimestamp(issue);
      if (terminalAt && (!cooldownAnchor || terminalAt.getTime() > cooldownAnchor.getTime())) {
        cooldownAnchor = terminalAt;
      }
    }
    return { sourceIssueTerminal, subtreeTerminal, cooldownAnchor };
  };
}
