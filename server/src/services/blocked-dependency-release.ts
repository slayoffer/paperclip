import { persistDependencyReleaseWake } from "./dependency-release-wakes.js";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issueRelations, issues } from "@paperclipai/db";
import { blockedStateIntegrityEnabled, blockedWaitFacts, openBridgeHoldIds } from "./blocked-state-integrity.js";
import { logActivity, type ActivityPublication } from "./activity-log.js";

/** Keep the bridge's open hold when a reviewer completion replaces the blocker list. */
export async function preserveBridgeHolds(db: Pick<Db, "select">, companyId: string, issueId: string, blockerIds: string[]) {
  if (!blockedStateIntegrityEnabled()) return [...new Set(blockerIds)];
  const issue = await db.select({ id: issues.id, companyId: issues.companyId, identifier: issues.identifier })
    .from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).then(rows => rows[0]);
  return [...new Set([...blockerIds, ...(issue ? await openBridgeHoldIds(db, issue) : [])])];
}

/** Run inside the status transaction. Workspace finalization remains a dependency barrier. */
export async function releaseResolvedBlockedDependents(
  tx: Db,
  blocker: { id: string; companyId: string },
  isReady: (issueId: string) => Promise<boolean>,
  publications: ActivityPublication[],
) {
  const intents: string[] = [];
  if (!blockedStateIntegrityEnabled()) return intents;
  const relations = await tx.select({ id: issueRelations.relatedIssueId }).from(issueRelations).where(and(
    eq(issueRelations.companyId, blocker.companyId), eq(issueRelations.issueId, blocker.id), eq(issueRelations.type, "blocks"),
  ));
  if (!relations.length) return intents;
  const candidates = await tx.select().from(issues).where(and(
    eq(issues.companyId, blocker.companyId), inArray(issues.id, relations.map(row => row.id)),
    eq(issues.status, "blocked"), isNull(issues.hiddenAt), isNull(issues.conversationAgentId),
  )).orderBy(issues.id).for("update");
  for (const candidate of candidates) {
    const holds = await openBridgeHoldIds(tx, candidate);
    for (const hold of holds) {
      await tx.insert(issueRelations).values({
        companyId: candidate.companyId, issueId: hold, relatedIssueId: candidate.id, type: "blocks",
      }).onConflictDoNothing();
    }
    if (holds.length || !await isReady(candidate.id)) continue;
    const facts = await blockedWaitFacts(tx, candidate, candidate.unblockDescriptor);
    if (facts.hasTarget || facts.outside) continue;
    // Wake producers read this row after release. Retain the completed cycle timestamp.
    // The next transition into blocked replaces it with the new cycle timestamp.
    await tx.update(issues).set({
      status: "todo", unblockDescriptor: null, blockedOwnerNotifiedAt: null,
      updatedAt: new Date(), statusVersion: candidate.statusVersion + 1,
    }).where(and(eq(issues.companyId, candidate.companyId), eq(issues.id, candidate.id), eq(issues.status, "blocked")));
    const intentId = await persistDependencyReleaseWake(tx, candidate, blocker.id);
    if (intentId) intents.push(intentId);
    await tx.insert(issueComments).values({
      companyId: candidate.companyId, issueId: candidate.id,
      body: "All blocker issues are complete or cancelled. This issue is ready. The stale unblock action is cleared.",
    });
    await logActivity(tx, {
      companyId: candidate.companyId, actorType: "system", actorId: "blocked_state_integrity",
      action: "issue.blockers_resolved", entityType: "issue", entityId: candidate.id,
      details: { previousStatus: "blocked", status: "todo", resolvedBlockerIssueId: blocker.id },
    }, publications);
  }
  return intents;
}
