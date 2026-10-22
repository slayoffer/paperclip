import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, like, sql } from "drizzle-orm";
import { agentWakeupRequests, documentRevisions, issueComments, issueDocuments, issues, type Db } from "@paperclipai/db";
import { bridgeEventMatches, bridgeWaitKey, isReviewBridgeWait, type BridgeWait } from "./review-bridge-contract.js";
import { resetBridgeDispositionRecovery } from "./review-bridge-recovery.js";
import { persistActivity } from "./activity-log.js";

export const BRIDGE_DISPATCH_PENDING = "pending_bridge_dispatch";
export const BRIDGE_DISPATCH_ACTOR = "review-bridge-wait";

/** Prevent disposition recovery from racing a committed, undelivered wake. */
export function pendingBridgeWakeCondition(issueId: typeof issues.id, companyId: typeof issues.companyId) {
  return sql`exists (select 1 from agent_wakeup_requests bridge_wait
    where bridge_wait.company_id = ${companyId} and bridge_wait.payload->>'issueId' = ${issueId}::text
      and bridge_wait.requested_by_actor_id = ${BRIDGE_DISPATCH_ACTOR}
      and bridge_wait.status in ('pending_bridge_dispatch', 'dispatching_bridge'))`;
}

async function matchingEvent(db: Db, issue: typeof issues.$inferSelect, wait: BridgeWait) {
  const pattern = `%${wait.bridge.waitId}%`;
  const comments = await db.select({ id: issueComments.id, body: issueComments.body }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    isNull(issueComments.authorAgentId), isNotNull(issueComments.authorUserId), isNull(issueComments.deletedAt),
    like(issueComments.body, pattern),
  ));
  const comment = comments.find(row => bridgeEventMatches(wait, row.body));
  if (comment) return { commentId: comment.id };
  const revisions = await db.select({ id: documentRevisions.id, body: documentRevisions.body })
    .from(issueDocuments).innerJoin(documentRevisions, and(
      eq(documentRevisions.documentId, issueDocuments.documentId),
      eq(documentRevisions.companyId, issueDocuments.companyId),
    )).where(and(eq(issueDocuments.companyId, issue.companyId), eq(issueDocuments.issueId, issue.id),
      isNull(documentRevisions.createdByAgentId), isNotNull(documentRevisions.createdByUserId),
      like(documentRevisions.body, pattern)));
  const revision = revisions.find(row => bridgeEventMatches(wait, row.body));
  return revision ? { documentRevisionId: revision.id } : null;
}

/** Serialize timeout, event, and board resume against the same issue row. */
export async function releaseBridgeWait(db: Db, companyId: string, issueId: string, resume = false) {
  return db.transaction(async tx => {
    const store = tx as unknown as Db;
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .for("update");
    if (!issue) return null;
    if (resume) await resetBridgeDispositionRecovery(store, companyId, issueId, "The board requested continuation.");
    const wait = issue.unblockDescriptor;
    if (issue.status !== "blocked" || issue.hiddenAt || issue.conversationAgentId || !issue.assigneeAgentId
      || !isReviewBridgeWait(wait)) return null;
    const event = await matchingEvent(store, issue, wait);
    const expired = Date.parse(wait.until) <= Date.now();
    if (!event && !expired && !resume) return null;
    const reason = event ? "review_bridge_event" : resume ? "review_bridge_resumed" : "review_bridge_timeout";
    const statusVersion = issue.statusVersion + 1;
    await tx.update(issues).set({ status: "todo", unblockDescriptor: null, blockedOwnerNotifiedAt: null,
      statusVersion, updatedAt: new Date() }).where(eq(issues.id, issueId));
    await resetBridgeDispositionRecovery(store, companyId, issueId, reason);
    const [intent] = await tx.insert(agentWakeupRequests).values({
      companyId, agentId: issue.assigneeAgentId, source: "automation", triggerDetail: "system", reason,
      requestedByActorType: "system", requestedByActorId: BRIDGE_DISPATCH_ACTOR,
      status: BRIDGE_DISPATCH_PENDING, idempotencyKey: bridgeWaitKey(issueId, wait.bridge.waitId),
      payload: { issueId, statusVersion, bridge: wait.bridge, until: wait.until, ...event, receiptId: randomUUID() },
    }).returning({ id: agentWakeupRequests.id });
    await persistActivity(store, { companyId, actorType: "system", actorId: BRIDGE_DISPATCH_ACTOR,
      action: "issue.bridge_wait_released", entityType: "issue", entityId: issueId,
      details: { reason, bridge: wait.bridge, until: wait.until, ...event } });
    return intent!.id;
  });
}

/** Both startup recovery and the periodic backstop call this reconciliation. */
export async function reconcileBridgeWaits(db: Db, opts?: { companyId?: string | null; issueId?: string }) {
  const candidates = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(and(
    eq(issues.status, "blocked"), sql`${issues.unblockDescriptor}->>'kind' = 'review_bridge'`,
    isNull(issues.hiddenAt),
    opts?.companyId ? eq(issues.companyId, opts.companyId) : undefined,
    opts?.issueId ? eq(issues.id, opts.issueId) : undefined,
  ));
  for (const candidate of candidates) await releaseBridgeWait(db, candidate.companyId, candidate.id);
}
