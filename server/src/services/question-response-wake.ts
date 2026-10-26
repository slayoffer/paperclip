import { and, desc, eq, inArray } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";

export type QuestionResponseHeartbeat = Pick<ReturnType<typeof heartbeatService>, "wakeup" | "cancelRun"> &
  Partial<Pick<ReturnType<typeof heartbeatService>, "wakeupWithDiagnostics" | "wakeupForOutbox">>;

/** Use this invocation's diagnostics. Old skipped receipts cannot explain a new null result. */
export async function wakeQuestionResponse(
  heartbeat: Pick<QuestionResponseHeartbeat, "wakeup" | "wakeupWithDiagnostics" | "wakeupForOutbox">,
  agentId: string,
  options: Parameters<QuestionResponseHeartbeat["wakeup"]>[1],
) {
  const explained = (reason: unknown) => typeof reason === "string" && reason.length > 0 && reason !== "wakeup_skipped"
    ? reason : null;
  try {
    if (heartbeat.wakeupForOutbox) return await heartbeat.wakeupForOutbox(agentId, options ?? {});
    if (!heartbeat.wakeupWithDiagnostics) return { run: await heartbeat.wakeup(agentId, options), suppression: null };
    const result = await heartbeat.wakeupWithDiagnostics(agentId, options);
    return { run: result.run, suppression: explained(result.skipped?.reason) };
  } catch (error) {
    // The diagnostic API attaches the exact skipped receipt to policy conflicts.
    const details = (error as { details?: { wakeup?: { reason?: unknown } } } | null)?.details;
    const suppression = explained(details?.wakeup?.reason);
    if (suppression) return { run: null, suppression };
    throw error;
  }
}

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
