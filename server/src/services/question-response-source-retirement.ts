import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issueQuestionResponseDeliveries, issueThreadInteractions } from "@paperclipai/db";
import { buildQuestionResponseDeliveryEnvelope, matchesQuestionResponseDeliveryDigest } from "./question-response-delivery-envelope.js";
import { hydrateQuestionInteraction, questionResponseDeliveryValues } from "./question-response-delivery-interaction.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * An intentional retired question source is not a failed execution incident.
 * This is only a stop classification: the dedicated answer wake still needs
 * its own fresh source/principal attestation before it can execute. Call while
 * holding the task lock; no provider operation or successor is started here.
 */
export async function isRetiredExternalChatQuestionSource(
  database: Db,
  scope: { companyId: string; issueId: string; agentId: string; runId: string },
): Promise<boolean> {
  const source = await database.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, scope.runId),
    eq(heartbeatRuns.companyId, scope.companyId),
    eq(heartbeatRuns.agentId, scope.agentId),
    eq(heartbeatRuns.nativeIssueId, scope.issueId),
    eq(heartbeatRuns.runtimeMode, "native"),
    eq(heartbeatRuns.status, "cancelled"),
    eq(heartbeatRuns.errorCode, "external_chat_continuation"),
  )).limit(1).then(rows => rows[0] ?? null);
  if (!source) return false;
  const result = record(source.resultJson);
  const cancellation = record(result.nativeCancellation);
  const interactionId = result.interactionId;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    result.externalChatContinuation !== true ||
    typeof interactionId !== "string" || !uuid.test(interactionId) ||
    cancellation.schema !== "paperclip.native-cancellation.v1" ||
    cancellation.companyId !== scope.companyId ||
    cancellation.runId !== scope.runId ||
    cancellation.issueId !== scope.issueId ||
    cancellation.scope !== "run" ||
    cancellation.dispatchState !== "acknowledged" ||
    typeof cancellation.intentId !== "string" ||
    typeof cancellation.intentAuditId !== "string" || !uuid.test(cancellation.intentAuditId) ||
    typeof cancellation.acknowledgementAuditId !== "string" || !uuid.test(cancellation.acknowledgementAuditId)
  ) return false;
  const interaction = await database.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId),
    eq(issueThreadInteractions.companyId, scope.companyId),
    eq(issueThreadInteractions.issueId, scope.issueId),
    eq(issueThreadInteractions.createdByAgentId, scope.agentId),
    eq(issueThreadInteractions.sourceRunId, scope.runId),
    eq(issueThreadInteractions.kind, "ask_user_questions"),
    eq(issueThreadInteractions.status, "answered"),
  )).limit(1).then(rows => rows[0] ?? null);
  if (!interaction) return false;
  const hydrated = hydrateQuestionInteraction(interaction);
  let expected: ReturnType<typeof questionResponseDeliveryValues>;
  try {
    expected = questionResponseDeliveryValues(hydrated);
  } catch {
    return false;
  }
  const delivery = await database.select({ payloadSha256: issueQuestionResponseDeliveries.payloadSha256 }).from(issueQuestionResponseDeliveries).where(and(
    eq(issueQuestionResponseDeliveries.companyId, scope.companyId),
    eq(issueQuestionResponseDeliveries.issueId, scope.issueId),
    eq(issueQuestionResponseDeliveries.interactionId, interactionId),
    eq(issueQuestionResponseDeliveries.sourceRunId, scope.runId),
    eq(issueQuestionResponseDeliveries.correlationId, expected.correlationId),
  )).limit(1);
  if (!delivery.length) return false;
  try {
    if (!matchesQuestionResponseDeliveryDigest(
      hydrated, buildQuestionResponseDeliveryEnvelope(hydrated), delivery[0]!.payloadSha256,
    )) return false;
  } catch {
    return false;
  }
  const audits = await database.select().from(activityLog).where(and(
    eq(activityLog.companyId, scope.companyId),
    eq(activityLog.agentId, scope.agentId),
    eq(activityLog.runId, scope.runId),
    eq(activityLog.entityType, "heartbeat_run"),
    eq(activityLog.entityId, scope.runId),
    eq(activityLog.actorType, "system"),
    eq(activityLog.actorId, "native-session-cancellation"),
    inArray(activityLog.id, [cancellation.intentAuditId, cancellation.acknowledgementAuditId]),
  ));
  return audits.some(audit => audit.id === cancellation.intentAuditId &&
    audit.action === "native.cancellation_intent_recorded" &&
    record(audit.details).intentId === cancellation.intentId &&
    record(audit.details).scope === "run") &&
    audits.some(audit => audit.id === cancellation.acknowledgementAuditId &&
      audit.action === "native.cancellation_dispatch_acknowledged" &&
      record(audit.details).intentId === cancellation.intentId &&
      record(audit.details).intentAuditId === cancellation.intentAuditId &&
      record(audit.details).scope === "run");
}
