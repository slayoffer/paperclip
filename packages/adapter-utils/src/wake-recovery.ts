/** Recovery mode comes from the server after owner and issue checks. */
export type PaperclipWakeRecovery = {
  executionMode?: "owner_resume";
  cause: string | null;
  failureSummary: string | null;
  originalAssignee: { id: string | null; name: string | null } | null;
  attemptCount: number | null;
  maxAttempts: number | null;
  nextAction: string | null;
  routingFallbackReason: string | null;
};

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function normalizePaperclipWakeRecovery(
  value: unknown,
): PaperclipWakeRecovery | null {
  const recovery = parseObject(value);
  const cause = asString(recovery.cause, "").trim() || null;
  if (!cause) return null;
  const originalAssignee = parseObject(recovery.originalAssignee);
  const originalAssigneeId = asString(originalAssignee.id, "").trim() || null;
  const originalAssigneeName =
    asString(originalAssignee.name, "").trim() || null;
  return {
    cause,
    ...(recovery.executionMode === "owner_resume" ? { executionMode: "owner_resume" as const } : {}),
    failureSummary: asString(recovery.failureSummary, "").trim() || null,
    originalAssignee:
      originalAssigneeId || originalAssigneeName
        ? { id: originalAssigneeId, name: originalAssigneeName }
        : null,
    attemptCount:
      typeof recovery.attemptCount === "number" ? recovery.attemptCount : null,
    maxAttempts:
      typeof recovery.maxAttempts === "number" ? recovery.maxAttempts : null,
    nextAction: asString(recovery.nextAction, "").trim() || null,
    routingFallbackReason:
      asString(recovery.routingFallbackReason, "").trim() || null,
  };
}
