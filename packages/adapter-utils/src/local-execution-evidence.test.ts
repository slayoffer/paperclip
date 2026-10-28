import { expect, it } from "vitest";
import { withLocalExecutionEvidence, type LocalExecutionEvidence } from "./local-execution-evidence.js";
import { scheduleSshWorkspaceOperation } from "./workspace-operation-schedule.js";
import { runChildProcess } from "./server-utils.js";

it("retains nested prepare and restore attempts with separate boundaries", async () => {
  const records: LocalExecutionEvidence[] = [];
  await withLocalExecutionEvidence(async event => { records.push(event); }, () =>
    scheduleSshWorkspaceOperation(undefined, "prepare", async () => {
      await scheduleSshWorkspaceOperation(undefined, "restore", async () => undefined);
    }));
  expect(records.map(r => r.kind === "ssh_phase" ? `${r.phase}:${r.boundary}` : r.kind)).toEqual([
    "prepare:queued", "prepare:started", "restore:queued", "restore:started", "restore:ended", "prepare:ended",
  ]);
  const attempts = records.filter(r => r.kind === "ssh_phase");
  expect(new Set(attempts.map(r => r.attemptId)).size).toBe(2);
  expect(attempts.filter(r => r.boundary === "ended").map(r => r.outcome)).toEqual(["succeeded", "succeeded"]);
});

it("preserves the original failure and records a failed end boundary", async () => {
  const records: LocalExecutionEvidence[] = [];
  const failure = new Error("private fixture text");
  await expect(withLocalExecutionEvidence(async event => { records.push(event); }, () =>
    scheduleSshWorkspaceOperation(undefined, "restore", async () => { throw failure; }))).rejects.toBe(failure);
  expect(records.at(-1)).toMatchObject({ boundary: "ended", outcome: "failed" });
  expect(JSON.stringify(records)).not.toContain(failure.message);
});

it("isolates concurrent runs and preserves synchronization after evidence failure", async () => {
  const records: LocalExecutionEvidence[] = [];
  await Promise.all([
    withLocalExecutionEvidence(async event => { records.push(event); }, () =>
      scheduleSshWorkspaceOperation(undefined, "prepare", async () => undefined)),
    withLocalExecutionEvidence(async () => { throw new Error("storage unavailable"); }, () =>
      scheduleSshWorkspaceOperation(undefined, "restore", async () => undefined)),
  ]);
  expect(records).toHaveLength(3);
  expect(records.every(r => r.kind === "ssh_phase" && r.phase === "prepare")).toBe(true);
});

it("retains a process timeout request before its later process close", async () => {
  const records: LocalExecutionEvidence[] = [];
  const result = await withLocalExecutionEvidence(async event => { records.push(event); }, () =>
    runChildProcess("timeout-fixture", process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(), env: {}, timeoutSec: 0.05, graceSec: 1, onLog: async () => undefined,
    }));
  expect(result.timedOut).toBe(true);
  const request = records.find(r => r.kind === "stop_request");
  const ended = records.find(r => r.kind === "stop_result");
  expect(request).toMatchObject({ source: "control_plane", reason: "timeout", initiator: { type: "system" } });
  expect(ended).toMatchObject({ requestId: request?.kind === "stop_request" ? request.requestId : null, outcome: "returned" });
});
