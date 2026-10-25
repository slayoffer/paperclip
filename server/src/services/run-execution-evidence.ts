import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { and, asc, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { withLocalExecutionEvidence, type LocalExecutionEvidence } from "@paperclipai/adapter-utils/local-execution-evidence";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { logger } from "../middleware/logger.js";
import { requestedRunCancellation } from "./run-cancellation.js";
import { projectLocalEvidence } from "./local-evidence-projection.js";

export const EXECUTION_EVIDENCE_EVENT = "execution.evidence";
export const EXECUTION_EVIDENCE_SCHEMA = "paperclip.execution-evidence/v1";
export const EXECUTION_EVIDENCE_SOURCE_ID = randomUUID();
export const EVIDENCE_WRITE_TIMEOUT_MS = 5_000;
type Binding = { id: string; companyId: string; agentId: string };
type RunIdentity = Binding | { id: string };
export type EvidenceRecord = Record<string, unknown> & {
  schema: typeof EXECUTION_EVIDENCE_SCHEMA; scopeId: string; index: number; kind: string;
};
const stopScope = new AsyncLocalStorage<string>();
const executionAdmission = new AsyncLocalStorage<() => void>();
const storageFailures = new Set<string>();
let sourceStorageUnverified = false;
const pendingStops = new Map<string, number>();
function markStorageFailure(runId: string) {
  if (sourceStorageUnverified) return;
  storageFailures.add(runId);
  if (storageFailures.size >= 10_000) { sourceStorageUnverified = true; storageFailures.clear(); }
}
const hasStorageFailure = (runId: string) => sourceStorageUnverified || storageFailures.has(runId);

/** One ordered manifest per owner. A lost write leaves a gap or an unclosed scope. */
export function createExecutionEvidenceRecorder(write: (event: EvidenceRecord) => Promise<void>, scope: "execution" | "stop",
  onFailure: () => void = () => {}, ready: Promise<void> = Promise.resolve(), initiallyAdmitted = true) {
  const scopeId = randomUUID();
  let index = 0;
  let failedWrites = 0;
  let writeMs = 0;
  const failureKinds = new Set<string>();
  let pending = ready;
  let executionAdmitted = initiallyAdmitted;
  const append = (data: Record<string, unknown> & { kind: string }) => {
    const record: EvidenceRecord = { ...data, schema: EXECUTION_EVIDENCE_SCHEMA, scopeId, index: index++ };
    pending = pending.then(async () => {
      // After one storage failure, preserve the operation and try only its final gap receipt.
      if (failedWrites && record.kind !== "scope_finished") { failedWrites++; return; }
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([write(record), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("execution_evidence_storage_timeout")), EVIDENCE_WRITE_TIMEOUT_MS);
        })]);
      } catch (error) {
        failedWrites++;
        failureKinds.add(error instanceof Error && error.message === "execution_evidence_storage_timeout" ? "timeout" : "storage_error");
        onFailure();
      }
      finally { clearTimeout(timer); writeMs += performance.now() - started; }
    });
    return pending;
  };
  void append({ kind: "scope_started", scope, sourceId: EXECUTION_EVIDENCE_SOURCE_ID, at: new Date().toISOString() });
  return {
    append,
    admit: () => { executionAdmitted = true; },
    sink: (data: LocalExecutionEvidence) => append(projectLocalEvidence(data)),
    async finish() {
      await pending;
      await append({ kind: "scope_finished", scope, sourceId: EXECUTION_EVIDENCE_SOURCE_ID, at: new Date().toISOString(),
        expectedRecords: index + 1, failedWrites, failureKinds: [...failureKinds], writeMs,
        sourceStorageFailed: false, executionAdmitted: scope === "execution" && executionAdmitted });
      return { failedWrites, failureKinds: [...failureKinds], writeMs };
    },
  };
}

function recorderForRun(db: Db, run: RunIdentity, scope: "execution" | "stop", ready?: Promise<void>, initiallyAdmitted = true) {
  let binding: Promise<Binding> | undefined;
  return createExecutionEvidenceRecorder(async payload => {
    binding ??= "companyId" in run ? Promise.resolve(run) : db.select({
      id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).limit(1).then(rows => {
      if (!rows[0]) throw new Error("execution_evidence_run_missing");
      return rows[0];
    });
    const identity = await binding;
    if (payload.kind === "scope_finished") payload = { ...payload, sourceStorageFailed: hasStorageFailure(run.id) };
    await appendHeartbeatRunEvent(db, {
      companyId: identity.companyId, agentId: identity.agentId, runId: identity.id,
      eventType: EXECUTION_EVIDENCE_EVENT, stream: "system", level: "info", payload,
    });
  }, scope, () => { markStorageFailure(run.id); }, ready, initiallyAdmitted);
}

export function admitRunExecutionEvidence() { executionAdmission.getStore()?.(); }

export async function withRunExecutionEvidence<T>(db: Db, run: RunIdentity, operation: () => Promise<T>, initiallyAdmitted = true): Promise<T> {
  const recorder = recorderForRun(db, run, "execution", undefined, initiallyAdmitted);
  try { return await executionAdmission.run(recorder.admit, () => withLocalExecutionEvidence(recorder.sink, operation)); }
  finally {
    const result = await recorder.finish();
    if (result.failedWrites) {
      markStorageFailure(run.id);
      logger.warn({ runId: run.id, failedWrites: result.failedWrites, failureKinds: result.failureKinds }, "Execution evidence is incomplete");
    }
  }
}

/** Internal lease loss and startup aborts can bypass the public Stop methods. */
export function observeRunAbort(db: Db, run: Binding, signal: AbortSignal) {
  let pending = Promise.resolve<unknown>(undefined);
  const onAbort = () => {
    pending = withStopRequestEvidence({ db, run, requestedAt: new Date().toISOString(),
      reason: signal.reason instanceof Error ? signal.reason.message : "stop" }, async () => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return async () => {
    signal.removeEventListener("abort", onAbort);
    await pending;
  };
}

/** Closed reasons exclude caller text, private messages, and provider error text. */
export function stopEvidenceReason(reason: string): string {
  if (/shutdown|server_restart/i.test(reason)) return "shutdown";
  if (/lease.*lost/i.test(reason)) return "lease_lost";
  if (/budget/i.test(reason)) return "budget";
  if (/reassign/i.test(reason)) return "reassignment";
  if (/pause/i.test(reason)) return "pause";
  return "stop";
}

export async function withStopRequestEvidence<T>(input: {
  db: Db; run: RunIdentity; requestedAt: string; reason: string;
  metadata?: Record<string, unknown>; source?: "shutdown";
}, operation: () => Promise<T>): Promise<T> {
  // A heartbeat stop can call the native helper. Retain one request for that call.
  if (stopScope.getStore() === input.run.id) return operation();
  let releaseWrites!: () => void;
  const ready = new Promise<void>(resolve => { releaseWrites = resolve; });
  const recorder = recorderForRun(input.db, input.run, "stop", ready);
  pendingStops.set(input.run.id, (pendingStops.get(input.run.id) ?? 0) + 1);
  const requestId = randomUUID();
  const cancellation = requestedRunCancellation(input.metadata ?? {}, input.reason, input.requestedAt);
  const actorId = cancellation.initiator.id;
  void recorder.append({ kind: "stop_request", requestId, requestedAt: input.requestedAt,
    source: input.source ?? cancellation.source, reason: stopEvidenceReason(input.reason),
    initiator: { type: input.source ? "system" : cancellation.initiator.type,
      ...(actorId && /^[a-zA-Z0-9:_-]{1,128}$/.test(actorId) ? { id: actorId } : {}) } });
  let outcome = "failed";
  try {
    // Do not await evidence storage before the existing cancellation fence or signal.
    const result = await stopScope.run(input.run.id, operation);
    outcome = "returned";
    return result;
  } finally {
    // Stop owns its original database and process ordering. Evidence cannot compete
    // for its pool connections or row locks before the cancellation settles.
    releaseWrites();
    await recorder.append({ kind: "stop_result", requestId, at: new Date().toISOString(), outcome });
    const result = await recorder.finish();
    const remaining = (pendingStops.get(input.run.id) ?? 1) - 1;
    if (remaining) pendingStops.set(input.run.id, remaining);
    else pendingStops.delete(input.run.id);
    if (result.failedWrites) {
      markStorageFailure(input.run.id);
      logger.warn({ runId: input.run.id, failedWrites: result.failedWrites, failureKinds: result.failureKinds }, "Stop evidence is incomplete");
    }
  }
}

/** Full run history, with company binding and no time-window or page truncation. */
export async function readRunExecutionEvidence(db: Db, run: Binding) {
  return db.transaction(async tx => {
    // The event allocator also locks this row. Keep the census and evidence consistent.
    const [current] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.agentId, run.agentId),
    )).for("share");
    if (!current) throw new Error("execution_evidence_binding_mismatch");
    const rows = await tx.select({ payload: heartbeatRunEvents.payload, seq: heartbeatRunEvents.seq })
      .from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
        eq(heartbeatRunEvents.eventType, EXECUTION_EVIDENCE_EVENT),
      )).orderBy(asc(heartbeatRunEvents.seq));
    // Check the complete stream too. Removing a whole stop scope must leave a visible gap.
    const [stream] = await tx.select({ count: sql<number>`count(*)`, first: sql<number>`min(${heartbeatRunEvents.seq})`, last: sql<number>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id)));
    const expected = Number(current.nextEventSeq) - 1;
    return { run: current, records: rows.map(row => row.payload), collectedAt: new Date().toISOString(),
      sourceInstanceId: EXECUTION_EVIDENCE_SOURCE_ID,
      storageFailed: hasStorageFailure(run.id),
      pendingStopRequests: pendingStops.get(run.id) ?? 0,
      runEventStreamComplete: Number(stream?.count) === expected && (expected === 0 || (Number(stream?.first) === 1 && Number(stream?.last) === expected)) };
  });
}
