import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, issues, type Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { queuedCommentIdsFromWakePayload, withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";
import { isDeferredBridgeReceipt } from "./review-bridge-wakes.js";

/** The caller holds the issue lock. Revalidate saved authority before admission. */
export async function readDeferredWakeForAdmission(db: Db, input: {
  companyId: string; issueId: string; agentId: string; requestId: string;
  actorId?: string | null; wakeCommentId?: string | null; bridgeReceiptRecovery: boolean;
  queuedCommentInterruptId?: string; queuedCommentRequestId?: string;
}, deps: {
  readQueuedInteractionResponse: (db: Db, companyId: string, issueId: string, payload: unknown) => Promise<unknown>;
  undeliveredLegacyUserCommentIds: (db: Db, companyId: string, issueId: string, agentId: string, ids: string[]) => Promise<string[]>;
}) {
  const { companyId, issueId, agentId, requestId, actorId, wakeCommentId, bridgeReceiptRecovery,
    queuedCommentInterruptId, queuedCommentRequestId } = input;
  const [pending] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, requestId), eq(agentWakeupRequests.companyId, companyId),
    eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    bridgeReceiptRecovery ? isDeferredBridgeReceipt()
      : (queuedCommentInterruptId ?? queuedCommentRequestId) === requestId
        ? undefined : eq(agentWakeupRequests.requestedByActorType, "user"),
    queuedCommentInterruptId === requestId
      ? sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt'->>'actorId' = ${actorId ?? ""}`
      : queuedCommentRequestId === requestId ? undefined : eq(agentWakeupRequests.requestedByActorId, actorId ?? ""),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
  ));
  if (!pending) return null;
  if (bridgeReceiptRecovery) {
    const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    if (!issue || issue.hiddenAt || issue.status !== "todo" || issue.assigneeAgentId !== agentId
      || issue.statusVersion !== pending.payload?.statusVersion) {
      await db.update(agentWakeupRequests).set({ status: "cancelled", updatedAt: new Date(), finishedAt: new Date() })
        .where(eq(agentWakeupRequests.id, pending.id));
      return null;
    }
    return pending;
  }
  if (!(wakeCommentId && queuedCommentIdsFromWakePayload(pending.payload).includes(wakeCommentId)) &&
      !(queuedCommentInterruptId && await deps.readQueuedInteractionResponse(db, companyId, issueId, pending.payload))) return null;
  if (queuedCommentRequestId) {
    const ids = await deps.undeliveredLegacyUserCommentIds(db, companyId, issueId, agentId,
      queuedCommentIdsFromWakePayload(pending.payload));
    if (!wakeCommentId || !ids.includes(wakeCommentId)) return null;
    pending.payload = withQueuedCommentIdsInWakePayload(parseObject(pending.payload), ids);
    await db.update(agentWakeupRequests).set({ payload: pending.payload }).where(and(
      eq(agentWakeupRequests.id, pending.id), eq(agentWakeupRequests.companyId, companyId),
    ));
  }
  return pending;
}

/** Reuse the locked receipt as the successor's receipt. Keep its dispatch identity. */
export async function queueDeferredBridgeReceipt(db: Db, requestId: string, payload: Record<string, unknown> | null) {
  const [receipt] = await db.update(agentWakeupRequests).set({ status: "queued", payload, updatedAt: new Date() })
    .where(and(eq(agentWakeupRequests.id, requestId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      isDeferredBridgeReceipt())).returning();
  if (!receipt) throw new Error("bridge_receipt_admission_lost");
  return receipt;
}
