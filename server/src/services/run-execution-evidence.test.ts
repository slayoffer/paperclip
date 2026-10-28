import { describe, expect, it, vi } from "vitest";
import { createExecutionEvidenceRecorder, EVIDENCE_WRITE_TIMEOUT_MS, type EvidenceRecord } from "./run-execution-evidence.js";
import { reconcileExecutionEvidence } from "./reconcile-execution-evidence.js";

const at = (ms: number) => new Date(ms).toISOString();
const run = { id: "run", status: "cancelled", finishedAt: new Date(100) };
async function fixture(options: { drop?: number; fail?: number; requestAt?: unknown } = {}) {
  const records: EvidenceRecord[] = [];
  const recorder = createExecutionEvidenceRecorder(async record => {
    if (record.index === options.fail) throw new Error("storage failed");
    if (record.index !== options.drop) records.push(record);
  }, "execution");
  await recorder.append({ kind: "ssh_phase", attemptId: "attempt", phase: "prepare", boundary: "queued", at: at(10) });
  await recorder.append({ kind: "ssh_phase", attemptId: "attempt", phase: "prepare", boundary: "started", at: at(20) });
  await recorder.append({ kind: "stop_request", requestId: "request", requestedAt: options.requestAt === undefined ? at(30) : options.requestAt,
    source: "operator", reason: "stop", initiator: { type: "user", id: "operator" } });
  await recorder.append({ kind: "ssh_phase", attemptId: "attempt", phase: "prepare", boundary: "ended", at: at(40), outcome: "succeeded" });
  await recorder.append({ kind: "stop_result", requestId: "request", at: at(50), outcome: "returned" });
  await recorder.finish();
  return records;
}

describe("execution evidence reconciliation", () => {
  it("uses the request boundary when terminal time falls outside preparation", async () => {
    const report = reconcileExecutionEvidence({ run, records: await fixture() });
    expect(report.complete).toBe(true);
    expect(report.phaseStopObserved).toBe(true);
    expect(report.stops[0]).toMatchObject({ requestedAt: at(30), terminalOutcome: "cancelled", intersectingAttempts: ["attempt"] });
    expect(report.terminationProof).toBe(false);
  });
  it.each([20, 40])("treats an exact phase boundary at %s ms conservatively", async requestedAt => {
    expect(reconcileExecutionEvidence({ run, records: await fixture({ requestAt: at(requestedAt) }) }).phaseStopObserved).toBe(true);
  });
  it.each([null, "invalid", ""])("rejects an unknown request boundary: %s", async requestAt => {
    expect(reconcileExecutionEvidence({ run, records: await fixture({ requestAt }) }).complete).toBe(false);
  });
  it.each([0, 1, 2, 3, 4, 5, 6])("rejects missing record %s, including a scope boundary", async drop => {
    expect(reconcileExecutionEvidence({ run, records: await fixture({ drop }) }).complete).toBe(false);
  });
  it("rejects failed storage even if the missing record later appears", async () => {
    const records = await fixture({ fail: 2 });
    records.push((await fixture())[2]!);
    const report = reconcileExecutionEvidence({ run, records });
    expect(report.complete).toBe(false);
    expect(report.gaps).toContain("storage_failed");
  });
  it("rejects repeated, reversed, or inconsistent boundaries", async () => {
    const records = await fixture();
    expect(reconcileExecutionEvidence({ run, records: [...records, records[2]] }).complete).toBe(false);
    records[4] = { ...records[4]!, at: at(19) };
    expect(reconcileExecutionEvidence({ run, records }).complete).toBe(false);
  });
  it("requires terminal reconciliation and refuses historical or provider-only coverage", async () => {
    expect(reconcileExecutionEvidence({ run: { ...run, status: "running", finishedAt: null }, records: await fixture() }).complete).toBe(false);
    expect(reconcileExecutionEvidence({ run, records: [] }).gaps).toContain("request_time_unknown");
    const records = await fixture();
    records[3] = { ...records[3]!, source: "provider", requestedAt: null };
    expect(reconcileExecutionEvidence({ run, records }).complete).toBe(false);
  });
  it("seals a normal run without requiring a stop request", async () => {
    const records: EvidenceRecord[] = [];
    const recorder = createExecutionEvidenceRecorder(async r => { records.push(r); }, "execution");
    await recorder.finish();
    expect(reconcileExecutionEvidence({ run: { ...run, status: "succeeded" }, records }).complete).toBe(true);
  });
  it("rejects an unknown provider request even when another local request exists", async () => {
    const report = reconcileExecutionEvidence({ run: { ...run, resultJson: { cancellation: { source: "provider", requestedAt: null } } }, records: await fixture() });
    expect(report.gaps).toContain("request_time_unknown");
  });
  it("rejects a gap in the full event stream", async () => {
    expect(reconcileExecutionEvidence({ run, records: await fixture(), runEventStreamComplete: false }).complete).toBe(false);
  });
  it("refuses to attest a previous controller's lost storage-failure state", async () => {
    const report = reconcileExecutionEvidence({ run, records: await fixture(), sourceInstanceId: "another-controller" });
    expect(report.gaps).toContain("source_epoch_unverified");
    expect(report.complete).toBe(false);
  });
  it("reports pending stop evidence before its storage receipt", async () => {
    expect(reconcileExecutionEvidence({ run, records: await fixture(), pendingStopRequests: 1 }).gaps).toContain("stop_source_pending");
  });
  it.each([
    { writeMs: undefined }, { writeMs: -1 }, { writeMs: Infinity },
    { failureKinds: undefined }, { failureKinds: ["timeout"] },
    { sourceStorageFailed: undefined }, { sourceStorageFailed: "false" },
    { executionAdmitted: undefined },
  ])("rejects a missing or inconsistent final receipt: %j", async patch => {
    const records = await fixture();
    records[records.length - 1] = { ...records.at(-1)!, ...patch };
    expect(reconcileExecutionEvidence({ run, records }).complete).toBe(false);
  });
  it("bounds a stuck evidence store and does not retry each omitted boundary", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(() => new Promise<void>(() => {}));
      const recorder = createExecutionEvidenceRecorder(write, "execution");
      void recorder.append({ kind: "stop_request" });
      const finished = recorder.finish();
      await vi.advanceTimersByTimeAsync(EVIDENCE_WRITE_TIMEOUT_MS * 2 + 1);
      expect(await finished).toMatchObject({ failedWrites: 3, failureKinds: ["timeout"] });
      expect(write).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
