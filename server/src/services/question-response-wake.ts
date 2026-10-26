import { and, desc, eq, inArray } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";

const DURABLE_WAKE_REQUEST_STATUSES = [
  "queued", "claimed", "running", "succeeded", "completed", "coalesced",
  "deferred_issue_execution", "retrying", "scheduled_retry",
] as const;

export async function findDurableQuestionResponseWake(
  db: Db,
  input: { companyId: string; idempotencyKey: string },
) {
  const [request] = await db.select({
    agentId: agentWakeupRequests.agentId, id: agentWakeupRequests.id,
    runId: agentWakeupRequests.runId, status: agentWakeupRequests.status,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
    inArray(agentWakeupRequests.status, [...DURABLE_WAKE_REQUEST_STATUSES]),
  )).orderBy(desc(agentWakeupRequests.createdAt)).limit(1);
  if (!request?.runId) return request ? { request, run: null } : null;
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, request.runId),
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, request.agentId),
  )).limit(1);
  return { request, run: run ?? null };
}
