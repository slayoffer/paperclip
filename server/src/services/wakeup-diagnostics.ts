import { and, eq, inArray } from "drizzle-orm";
import { agentWakeupRequests, issues, type Db } from "@paperclipai/db";
import { isUuidLike, type AgentWakeupSkipped } from "@paperclipai/shared";
import { redactSensitiveText } from "../redaction.js";

type Diagnostics = Pick<AgentWakeupSkipped, "wakeupRequestId" | "reason" | "error" | "message" | "details">;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

// Do not return arbitrary wake payloads, context snapshots, or wait conditions.
const DETAIL_KEYS = new Set([
  "reason", "message", "code", "remediation", "observed", "limit", "cutoff",
  "issueId", "recoveryActionId", "holdId", "scopeType", "scopeId", "status",
  "enabled", "wakeOnDemand", "noProgressStreak", "cooldownMs", "lastRunFinishedAt",
  "nextAllowedAt", "actualStatus", "expectedAssigneeAgentId", "actualAssigneeAgentId",
  "executionRunId", "executionAgentId", "coalescedIntoWakeupRequestId",
]);

function safeDetails(value: unknown) {
  const result: Record<string, string | number | boolean | null | string[]> = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (DETAIL_KEYS.has(key)) {
      if (typeof item === "string") result[key] = redactSensitiveText(item);
      else if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
        result[key] = item;
      }
    }
  }
  return result;
}

/** Read only this invocation's receipt. A latest-row lookup can return another caller's skip. */
export async function readWakeupDiagnostics(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; requestId: string },
): Promise<Diagnostics | null> {
  const [receipt] = await db.select({
    id: agentWakeupRequests.id,
    status: agentWakeupRequests.status,
    reason: agentWakeupRequests.reason,
    error: agentWakeupRequests.error,
    payload: agentWakeupRequests.payload,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, input.requestId),
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, input.agentId),
    inArray(agentWakeupRequests.status, ["skipped", "deferred_issue_execution", "coalesced"]),
  )).limit(1);
  if (!receipt) return null;

  const payload = record(receipt.payload);
  const wait = record(payload.executionWait);
  const heartbeatSkip = safeDetails(payload.heartbeatSkip);
  const executionWait = safeDetails(wait);
  const details: NonNullable<AgentWakeupSkipped["details"]> = {};
  if (Object.keys(heartbeatSkip).length) details.heartbeatSkip = heartbeatSkip;
  if (Object.keys(executionWait).length) details.executionWait = executionWait;

  const rawIds = wait.unresolvedBlockerIssueIds ?? payload.unresolvedBlockerIssueIds;
  if (Array.isArray(rawIds)) {
    const ids = [...new Set(rawIds.filter((id): id is string => typeof id === "string" && isUuidLike(id)))];
    // Resolve identifiers and status in this company. Never expose foreign issue metadata.
    const blockers = ids.length ? await db.select({
      id: issues.id, identifier: issues.identifier, status: issues.status,
    }).from(issues).where(and(eq(issues.companyId, input.companyId), inArray(issues.id, ids))) : [];
    const byId = new Map(blockers.map((blocker) => [blocker.id, blocker]));
    details.unresolvedBlockerIssueIds = ids.filter((id) => byId.has(id));
    details.unresolvedBlockers = ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  }

  const budget = record(payload.issueTokenBudget);
  if (receipt.reason === "issue.token_budget_exceeded" && typeof budget.used === "number" && Number.isFinite(budget.used) &&
      typeof budget.limit === "number" && Number.isFinite(budget.limit) &&
      typeof budget.windowStart === "string") {
    details.budget = { used: budget.used, limit: budget.limit, windowStart: redactSensitiveText(budget.windowStart) };
  }
  const reason = redactSensitiveText(
    receipt.status === "deferred_issue_execution" && typeof wait.reason === "string"
      ? wait.reason
      : receipt.reason ?? "wakeup_skipped",
  );
  const error = receipt.error === null ? null : redactSensitiveText(receipt.error);
  const message = error ?? (typeof executionWait.message === "string" ? executionWait.message : null)
    ?? (typeof heartbeatSkip.reason === "string" ? heartbeatSkip.reason : null)
    ?? `Wakeup was skipped (${reason}).`;
  return { wakeupRequestId: receipt.id, reason, error, message, details };
}
