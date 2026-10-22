import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { agentWakeupRequests, issues, type Db } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";
import { createDurableBridgeWakeupRequest } from "./durable-bridge-wakeup.js";
import { BRIDGE_DISPATCH_ACTOR, BRIDGE_DISPATCH_PENDING, reconcileBridgeWaits } from "./review-bridge-waits.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./recovery/pause-hold-guard.js";
import { logger } from "../middleware/logger.js";

/** Only server-created receipts can enter bridge restart recovery. */
export function isDeferredBridgeReceipt() {
  return sql<boolean>`${agentWakeupRequests.requestedByActorType} = 'system' and exists (
    select 1 from agent_wakeup_requests bridge_intent
    where bridge_intent.company_id = ${agentWakeupRequests.companyId}
      and bridge_intent.agent_id = ${agentWakeupRequests.agentId}
      and bridge_intent.requested_by_actor_type = 'system'
      and bridge_intent.requested_by_actor_id = ${BRIDGE_DISPATCH_ACTOR}
      and bridge_intent.status in ('dispatching_bridge', 'completed_bridge_dispatch')
      and bridge_intent.payload->>'receiptId' = ${agentWakeupRequests.id}::text
      and bridge_intent.payload->>'issueId' = ${agentWakeupRequests.payload}->>'issueId'
      and ${agentWakeupRequests.requestedByActorId} = 'bridge-dispatch:' || bridge_intent.id::text
      and ${agentWakeupRequests.idempotencyKey} = bridge_intent.idempotency_key || ':receipt'
  )`;
}

/** Durable intent plus stable admission receipt prevents duplicate delivery after a crash. */
export async function dispatchBridgeWakes(db: Db, enqueue: ReturnType<typeof heartbeatService>["wakeup"],
  opts?: { companyId?: string | null; issueId?: string }) {
  await reconcileBridgeWaits(db, opts);
  const eligible = or(eq(agentWakeupRequests.status, BRIDGE_DISPATCH_PENDING), and(
    eq(agentWakeupRequests.status, "dispatching_bridge"), lte(agentWakeupRequests.updatedAt, new Date(Date.now() - 60_000)),
  ));
  const intents = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.requestedByActorId, BRIDGE_DISPATCH_ACTOR), eligible,
    opts?.companyId ? eq(agentWakeupRequests.companyId, opts.companyId) : undefined,
    opts?.issueId ? sql`${agentWakeupRequests.payload}->>'issueId' = ${opts.issueId}` : undefined,
  )).orderBy(asc(agentWakeupRequests.updatedAt), asc(agentWakeupRequests.id)).limit(500);
  let delivered = 0;
  for (const intent of intents) {
    const claimedAt = new Date();
    const [claimed] = await db.update(agentWakeupRequests).set({ status: "dispatching_bridge", updatedAt: claimedAt })
      .where(and(eq(agentWakeupRequests.id, intent.id), eligible)).returning();
    if (!claimed) continue;
    const claim = and(eq(agentWakeupRequests.id, intent.id), eq(agentWakeupRequests.status, "dispatching_bridge"),
      eq(agentWakeupRequests.updatedAt, claimedAt));
    try {
      const payload = intent.payload!;
      const issueId = String(payload.issueId);
      const receiptId = String(payload.receiptId);
      const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, intent.companyId), eq(issues.id, issueId)));
      if (!issue || issue.hiddenAt || issue.status !== "todo" || issue.assigneeAgentId !== intent.agentId
        || issue.statusVersion !== payload.statusVersion) {
        await db.update(agentWakeupRequests).set({ status: "cancelled", updatedAt: new Date() }).where(claim);
        continue;
      }
      if (await isAutomaticRecoverySuppressedByPauseHold(db, intent.companyId, issueId)) {
        await db.update(agentWakeupRequests).set({ status: BRIDGE_DISPATCH_PENDING, updatedAt: new Date() }).where(claim);
        continue;
      }
      const durableBridgeRequest = createDurableBridgeWakeupRequest({
        id: receiptId, issueId, companyId: intent.companyId, agentId: intent.agentId,
        requestedAt: intent.requestedAt, idempotencyKey: `${intent.idempotencyKey}:receipt`,
        requestedByActorType: "system", requestedByActorId: `bridge-dispatch:${intent.id}`,
        authorize: async tx => {
          // Admission holds this issue row lock. Check before execution-hold deferral.
          const [current] = await tx.select().from(issues).where(and(
            eq(issues.id, issueId), eq(issues.companyId, intent.companyId),
          ));
          if (!current || current.hiddenAt || current.status !== "todo"
            || current.assigneeAgentId !== intent.agentId || current.statusVersion !== payload.statusVersion) {
            throw new Error("bridge_issue_state_changed");
          }
          const [saved] = await tx.select().from(agentWakeupRequests).where(and(
            eq(agentWakeupRequests.id, intent.id), eq(agentWakeupRequests.companyId, intent.companyId),
          ));
          if (!saved || saved.payload?.receiptId !== receiptId || saved.agentId !== intent.agentId
            || saved.status !== "dispatching_bridge") throw new Error("bridge_intent_not_authorized");
        },
      });
      await enqueue(intent.agentId, {
        source: "automation", triggerDetail: "system", reason: intent.reason, payload, durableBridgeRequest,
        requestedByActorType: "system", requestedByActorId: durableBridgeRequest.requestedByActorId,
        issueStateGuard: { statuses: ["todo"], assigneeAgentId: intent.agentId, statusVersion: issue.statusVersion },
        contextSnapshot: { ...payload, taskId: issueId, wakeReason: intent.reason,
          source: "review_bridge", wakeCommentId: payload.commentId },
      });
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receiptId));
      const admitted = receipt && receipt.status !== "skipped";
      await db.update(agentWakeupRequests).set({
        status: admitted ? "completed_bridge_dispatch" : BRIDGE_DISPATCH_PENDING,
        updatedAt: new Date(), finishedAt: admitted ? new Date() : null,
        ...(receipt?.status === "skipped" ? { payload: { ...payload, receiptId: randomUUID() } } : {}),
      }).where(claim);
      if (admitted) delivered++;
    } catch (err) {
      await db.update(agentWakeupRequests).set({ status: BRIDGE_DISPATCH_PENDING, updatedAt: new Date() }).where(claim);
      logger.warn({ err, intentId: intent.id }, "bridge wake remains pending");
    }
  }
  return delivered;
}
