/** Only controller-defined labels and generated identities enter the local evidence stream. */
export function projectLocalEvidence(value: unknown): Record<string, unknown> & { kind: string } {
  const invalid = { kind: "invalid_evidence" };
  try {
    if (!value || typeof value !== "object") return invalid;
    const event = value as Record<string, unknown>;
    const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const timestamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
    if (event.kind === "ssh_phase") {
      if (!uuid(event.attemptId) || !timestamp(event.at) || !["prepare", "restore"].includes(String(event.phase)) ||
          !["queued", "started", "ended"].includes(String(event.boundary))) return invalid;
      if (event.boundary === "ended" && !["succeeded", "failed"].includes(String(event.outcome))) return invalid;
      return { kind: "ssh_phase", attemptId: event.attemptId, phase: event.phase, boundary: event.boundary, at: event.at,
        ...(event.boundary === "ended" ? { outcome: event.outcome } : {}) };
    }
    if (event.kind === "stop_request") {
      const initiator = event.initiator as Record<string, unknown> | undefined;
      if (!uuid(event.requestId) || !timestamp(event.requestedAt) || event.source !== "control_plane" ||
          !["timeout", "terminal_cleanup", "checkpoint_failure"].includes(String(event.reason)) || initiator?.type !== "system") return invalid;
      return { kind: "stop_request", requestId: event.requestId, requestedAt: event.requestedAt,
        source: "control_plane", reason: event.reason, initiator: { type: "system" } };
    }
    if (event.kind === "stop_result" && uuid(event.requestId) && timestamp(event.at) &&
        ["returned", "failed"].includes(String(event.outcome))) {
      return { kind: "stop_result", requestId: event.requestId, at: event.at, outcome: event.outcome };
    }
    return invalid;
  } catch { return invalid; }
}
