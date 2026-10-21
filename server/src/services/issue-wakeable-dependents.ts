import { and, eq, isNull } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { issueRelations, issues, type Db } from "@paperclipai/db";
import { blockedStateIntegrityEnabled, hasNonDependencyBlockedWait } from "./blocked-state-integrity.js";
import { releaseResolvedBlockedDependents } from "./blocked-dependency-release.js";
import { createIssueDependencyReadiness } from "./issue-blocker-details.js";
import { listIssueDependencyReadinessMap } from "./issue-dependency-readiness.js";
import { executeIssuePostCommitActions, type IssuePostCommitAction } from "./issue-post-commit-actions.js";
import { publishActivity, type ActivityPublication } from "./activity-log.js";
import { isPullQueueEnabled } from "./pull-queue-policy.js";

export async function listWakeableBlockedDependents(
  db: Db,
  blockerIssueId: string,
  dbOrTx: Db = db,
  postCommitActivityPublications?: ActivityPublication[],
  postCommitActions?: IssuePostCommitAction[],
) {
  // A nested savepoint does not commit the outer status transaction.
  // Transaction-bound callers without queues leave durable intents for recovery.
  const ownsCommit = dbOrTx === db && !(db instanceof PgTransaction);
  const blockerIssue = await dbOrTx
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(eq(issues.id, blockerIssueId))
    .then((rows) => rows[0] ?? null);
  if (!blockerIssue) return [];
  if (blockedStateIntegrityEnabled()) {
    const publications = postCommitActivityPublications ?? [];
    const actions = postCommitActions ?? [];
    const release = async (tx: Db) => releaseResolvedBlockedDependents(tx, blockerIssue,
      async (issueId) => (await listIssueDependencyReadinessMap(tx, blockerIssue.companyId, [issueId])).get(issueId)?.isDependencyReady ?? false, publications);
    const intents = ownsCommit
      ? await db.transaction(tx => release(tx as unknown as Db))
      : await release(dbOrTx);
    actions.push(...intents.map(intentId => ({
      type: "dispatch_dependency_wake" as const, companyId: blockerIssue.companyId, intentId,
    })));
    if (ownsCommit && !postCommitActivityPublications) {
      for (const publication of publications) publishActivity(publication);
    }
    if (ownsCommit && !postCommitActions) await executeIssuePostCommitActions(db, actions);
  }

  const candidates = await dbOrTx
    .select({
      id: issues.id,
      assigneeAgentId: issues.assigneeAgentId,
      status: issues.status,
      blockedTransitionAt: issues.blockedTransitionAt,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, blockerIssue.companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.issueId, blockerIssueId),
        isNull(issues.conversationAgentId),
      ),
    );
  if (candidates.length === 0) return [];

  const wakeableCandidates = candidates.filter(
    (candidate) =>
      candidate.assigneeAgentId &&
      !(isPullQueueEnabled() ? ["done", "cancelled"] : ["backlog", "done", "cancelled"]).includes(candidate.status),
  );
  if (wakeableCandidates.length === 0) return [];

  // Defer to the unified readiness check so that a dependent only fires when
  // (a) every blocker is resolved AND (b) each workspace passes finalization.
  // The finalize hook also calls
  // this function on completion, so a wake initially gated by an in-flight
  // sync-back will re-fire once the restore lands locally.
  const readinessMap = await listIssueDependencyReadinessMap(
    dbOrTx,
    blockerIssue.companyId,
    wakeableCandidates.map((candidate) => candidate.id),
  );

  const waitStates = await Promise.all(wakeableCandidates.map(candidate => hasNonDependencyBlockedWait(dbOrTx, candidate.id)));
  return wakeableCandidates.filter((_, index) => !waitStates[index])
    .map((candidate) => {
      const readiness =
        readinessMap.get(candidate.id) ??
        createIssueDependencyReadiness(candidate.id);
      return { candidate, readiness };
    })
    .filter(
      ({ readiness }) =>
        readiness.isDependencyReady && readiness.blockerIssueIds.length > 0,
    )
    .map(({ candidate, readiness }) => ({
      id: candidate.id,
      assigneeAgentId: candidate.assigneeAgentId!,
      blockerIssueIds: readiness.blockerIssueIds,
      blockedTransitionAt: candidate.blockedTransitionAt,
    }));
}
