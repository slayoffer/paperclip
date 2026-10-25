import { beforeEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
const store = vi.hoisted(() => ({ records: [] as Record<string, unknown>[], fail: false }));
vi.mock("./heartbeat-run-events.js", () => ({ appendHeartbeatRunEvent: async (_db: unknown, input: { payload: Record<string, unknown> }) => {
  if (store.fail) throw new Error("private storage error");
  store.records.push(input.payload);
} }));
import { observeRunAbort, withRunExecutionEvidence, withStopRequestEvidence } from "./run-execution-evidence.js";
import { scheduleSshWorkspaceOperation } from "@paperclipai/adapter-utils/workspace-operation-schedule";
import { reconcileExecutionEvidence } from "./reconcile-execution-evidence.js";

const db = {} as Db;
const run = { id: "run", companyId: "company", agentId: "agent" };
const stop = (reason: string, operation: () => Promise<unknown> = async () => undefined) =>
  withStopRequestEvidence({ db, run, reason, requestedAt: new Date().toISOString(),
    metadata: { cancelledByActorType: "user", cancelledByUserId: "operator" } }, operation);
beforeEach(() => { store.records = []; store.fail = false; run.id = randomUUID(); });

it("retains repeated requests while one process cancellation is pending", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let signalled = false;
  const first = stop("Stop private message", async () => { signalled = true; await pending; });
  expect(signalled).toBe(true);
  const second = stop("Repeated Stop", () => pending);
  release();
  await Promise.all([first, second]);
  const requests = store.records.filter(r => r.kind === "stop_request");
  expect(requests).toHaveLength(2);
  expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
  expect(JSON.stringify(store.records)).not.toContain("private message");
});

it("retains one request across the heartbeat and native cancellation helpers", async () => {
  await stop("Stop", () => stop("native helper"));
  expect(store.records.filter(r => r.kind === "stop_request")).toHaveLength(1);
  expect(store.records.filter(r => r.kind === "stop_result")).toHaveLength(1);
});

it("preserves cancellation failure when evidence storage also fails", async () => {
  store.fail = true;
  const failure = new Error("termination failed");
  await expect(stop("Stop", async () => { throw failure; })).rejects.toBe(failure);
});

it("retains shutdown source and excludes arbitrary reason text", async () => {
  await withStopRequestEvidence({ db, run, requestedAt: new Date().toISOString(),
    reason: "Interrupted by graceful server shutdown (SIGTERM)", source: "shutdown" }, async () => undefined);
  expect(store.records.find(r => r.kind === "stop_request")).toMatchObject({ source: "shutdown", reason: "shutdown", initiator: { type: "system" } });
});

it("retains an internal controller abort and avoids a second request for public Stop", async () => {
  const internal = new AbortController();
  const finish = observeRunAbort(db, run, internal.signal);
  internal.abort(new Error("Legacy controller lease lost"));
  await finish();
  expect(store.records.find(r => r.kind === "stop_request")).toMatchObject({ reason: "lease_lost" });
  store.records = [];
  const external = new AbortController();
  const finishExternal = observeRunAbort(db, run, external.signal);
  await stop("Stop", async () => { external.abort(); });
  await finishExternal();
  expect(store.records.filter(r => r.kind === "stop_request")).toHaveLength(1);
});

it("reconciles a Stop inside a restore attempt with the later terminal outcome", async () => {
  await withRunExecutionEvidence(db, run, () => scheduleSshWorkspaceOperation(undefined, "restore", () => stop("Stop")));
  const report = reconcileExecutionEvidence({ run: { ...run, status: "cancelled", finishedAt: new Date() }, records: store.records });
  expect(report.complete).toBe(true);
  expect(report.phaseStopObserved).toBe(true);
  expect(report.stops[0]?.terminalOutcome).toBe("cancelled");
});
