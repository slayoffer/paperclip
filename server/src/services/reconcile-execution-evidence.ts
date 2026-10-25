import { EXECUTION_EVIDENCE_SCHEMA, EXECUTION_EVIDENCE_SOURCE_ID } from "./run-execution-evidence.js";
import type { RunExecutionEvidenceReport } from "@paperclipai/shared";

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function time(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}
const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

/** Coverage is separate from trial acceptance and from provider termination proof. */
export function reconcileExecutionEvidence(input: {
  run: { id: string; status: string; finishedAt: Date | null; resultJson?: Record<string, unknown> | null };
  records: unknown[];
  storageFailed?: boolean;
  runEventStreamComplete?: boolean;
  sourceInstanceId?: string;
  pendingStopRequests?: number;
}): RunExecutionEvidenceReport {
  const gaps = new Set<string>();
  if (input.storageFailed) gaps.add("storage_failed");
  if (input.pendingStopRequests) gaps.add("stop_source_pending");
  if (input.runEventStreamComplete === false) gaps.add("run_event_stream_gap");
  const scopes = new Map<string, RecordValue[]>();
  const attempts = new Map<string, RecordValue[]>();
  const requests = new Map<string, RecordValue[]>();
  let executionScopes = 0;
  for (const value of input.records) {
    const record = object(value);
    if (record.schema !== EXECUTION_EVIDENCE_SCHEMA || typeof record.scopeId !== "string" ||
        !Number.isSafeInteger(record.index) || Number(record.index) < 0) {
      gaps.add("invalid_record"); continue;
    }
    const group = scopes.get(record.scopeId) ?? [];
    group.push(record);
    scopes.set(record.scopeId, group);
    if (record.kind === "ssh_phase" && typeof record.attemptId === "string") {
      const attempt = attempts.get(record.attemptId) ?? [];
      attempt.push(record);
      attempts.set(record.attemptId, attempt);
    } else if (["stop_request", "stop_result"].includes(String(record.kind)) && typeof record.requestId === "string") {
      const request = requests.get(record.requestId) ?? [];
      request.push(record);
      requests.set(record.requestId, request);
    } else if (!["scope_started", "scope_finished"].includes(String(record.kind))) gaps.add("invalid_record_kind");
  }
  for (const records of scopes.values()) {
    const ordered = [...records].sort((a, b) => Number(a.index) - Number(b.index));
    const first = ordered[0]!;
    const last = ordered.at(-1)!;
    if (first.sourceId !== (input.sourceInstanceId ?? EXECUTION_EVIDENCE_SOURCE_ID) || last.sourceId !== first.sourceId) gaps.add("source_epoch_unverified");
    if (first.kind !== "scope_started" || last.kind !== "scope_finished" || first.scope !== last.scope ||
        !["execution", "stop"].includes(String(first.scope)) ||
        last.expectedRecords !== ordered.length || ordered.some((r, i) => r.index !== i) ||
        ordered.slice(1, -1).some(r => ["scope_started", "scope_finished"].includes(String(r.kind)))) gaps.add("scope_gap");
    if (!Number.isFinite(time(first.at)) || !Number.isFinite(time(last.at)) || time(last.at) < time(first.at)) gaps.add("scope_time_invalid");
    if (last.failedWrites !== 0 || last.sourceStorageFailed !== false ||
        !Array.isArray(last.failureKinds) || last.failureKinds.length !== 0) gaps.add("storage_failed");
    if (typeof last.writeMs !== "number" || !Number.isFinite(last.writeMs) || last.writeMs < 0 ||
        typeof last.executionAdmitted !== "boolean") gaps.add("invalid_receipt");
    if (first.scope === "execution" && last.executionAdmitted === true) executionScopes++;
  }
  if (!executionScopes) gaps.add("execution_source_coverage_missing");
  const phases = [...attempts].map(([attemptId, records]) => {
    const queued = records.filter(r => r.boundary === "queued");
    const starts = records.filter(r => r.boundary === "started");
    const ends = records.filter(r => r.boundary === "ended");
    const phase = records[0]?.phase;
    const start = starts[0];
    const end = ends[0];
    const complete = records.length === 3 && queued.length === 1 && starts.length === 1 && ends.length === 1 &&
      ["prepare", "restore"].includes(String(phase)) && records.every(r => r.phase === phase) &&
      Number.isFinite(time(queued[0]?.at)) && Number.isFinite(time(start?.at)) && Number.isFinite(time(end?.at)) &&
      time(start?.at) >= time(queued[0]?.at) && time(end?.at) >= time(start?.at) &&
      ["succeeded", "failed"].includes(String(end?.outcome));
    if (!complete) gaps.add("phase_incomplete");
    return { attemptId, phase: text(phase) ?? "unknown", queuedAt: text(queued[0]?.at), startedAt: text(start?.at),
      endedAt: text(end?.at), outcome: complete ? String(end!.outcome) : "incomplete", complete };
  });
  const stops = [...requests].map(([requestId, records]) => {
    const starts = records.filter(r => r.kind === "stop_request");
    const ends = records.filter(r => r.kind === "stop_result");
    const request = starts[0];
    const result = ends[0];
    const initiator = object(request?.initiator);
    const complete = records.length === 2 && starts.length === 1 && ends.length === 1 &&
      Number.isFinite(time(request?.requestedAt)) && Number.isFinite(time(result?.at)) &&
      time(result?.at) >= time(request?.requestedAt) &&
      ["operator", "queued_message", "control_plane", "shutdown"].includes(String(request?.source)) &&
      ["user", "agent", "system"].includes(String(initiator.type)) &&
      ["shutdown", "lease_lost", "budget", "reassignment", "pause", "stop", "timeout", "terminal_cleanup", "checkpoint_failure"].includes(String(request?.reason)) &&
      ["returned", "failed"].includes(String(result?.outcome));
    if (!complete) gaps.add("stop_incomplete");
    const intersectingAttempts = phases.filter(p => p.complete &&
      time(request?.requestedAt) >= time(p.startedAt) && time(request?.requestedAt) <= time(p.endedAt))
      .map(p => p.attemptId);
    return { requestId, requestedAt: text(request?.requestedAt), source: text(request?.source) ?? "unknown",
      reason: text(request?.reason) ?? "unknown", initiator: text(initiator.type)
        ? { type: String(initiator.type), ...(text(initiator.id) ? { id: String(initiator.id) } : {}) } : null,
      result: text(result?.outcome) ?? "incomplete",
      intersectingAttempts, terminalOutcome: terminal.has(input.run.status) ? input.run.status : null, complete };
  });
  if (["cancelled", "interrupted", "timed_out"].includes(input.run.status) && !stops.length) gaps.add("request_time_unknown");
  const cancellation = object(input.run.resultJson?.cancellation);
  if (["provider", "transport", "unknown"].includes(String(cancellation.source)) &&
      !Number.isFinite(time(cancellation.requestedAt))) gaps.add("request_time_unknown");
  if (!terminal.has(input.run.status) || !input.run.finishedAt || !Number.isFinite(input.run.finishedAt.getTime())) gaps.add("terminal_outcome_missing");
  return { schema: EXECUTION_EVIDENCE_SCHEMA, runId: input.run.id, complete: gaps.size === 0,
    sourceInstanceId: input.sourceInstanceId ?? EXECUTION_EVIDENCE_SOURCE_ID,
    gaps: [...gaps], phases, stops, phaseStopObserved: stops.some(s => s.intersectingAttempts.length > 0),
    clock: { source: "controller_utc", precisionMs: 1, offsetMs: null },
    terminationProof: false as const };
}
