import type { Db, issues } from "@paperclipai/db";
import { hasNonDependencyBlockedWait } from "./blocked-state-integrity.js";
import type { IssueDependencyReadiness } from "./issue-dependency-readiness.js";

type RestoredIssue = Pick<typeof issues.$inferSelect,
  "id" | "status" | "assigneeAgentId" | "blockedTransitionAt">;

export async function getRestoredBlockedDependencyWake(
  db: Pick<Db, "select">,
  input: {
    existing: Pick<RestoredIssue, "status" | "assigneeAgentId">;
    issue: RestoredIssue;
    blockersSupplied: boolean;
    getDependencyReadiness?: (issueId: string) => Promise<IssueDependencyReadiness>;
  },
) {
  const { existing, issue, getDependencyReadiness } = input;
  if (issue.status !== "blocked" || !issue.assigneeAgentId ||
      (existing.status === "blocked" && !input.blockersSupplied &&
        existing.assigneeAgentId === issue.assigneeAgentId) ||
      typeof getDependencyReadiness !== "function") return null;
  if (await hasNonDependencyBlockedWait(db, issue.id)) return null;

  const readiness = await getDependencyReadiness(issue.id);
  const resolvedBlockerIssueId = readiness.blockerIssueIds[0];
  if (!resolvedBlockerIssueId || !readiness.isDependencyReady) return null;
  return {
    agentId: issue.assigneeAgentId,
    dependentIssueId: issue.id,
    resolvedBlockerIssueId,
    blockerIssueIds: readiness.blockerIssueIds,
    blockedTransitionAt: issue.blockedTransitionAt,
    source: "issue.blockers_restored",
    mutation: "blocked_dependency_restored",
  };
}
