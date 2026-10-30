import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "../services/adapter-execution-control.js";
import { runningProcesses } from "../adapters/index.js";
import { readRunExecutionEvidence, withRunExecutionEvidence } from "../services/run-execution-evidence.js";
import { reconcileExecutionEvidence } from "../services/reconcile-execution-evidence.js";
import { scheduleSshWorkspaceOperation } from "@paperclipai/adapter-utils/workspace-operation-schedule";

describe("durable local execution evidence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const children: ChildProcess[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-evidence-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await database?.cleanup();
  });

  async function seed(runtimeMode: "legacy" | "native" = "legacy", companyId?: string) {
    const run = { id: randomUUID(), companyId: companyId ?? randomUUID(), agentId: randomUUID() };
    if (!companyId) await db.insert(companies).values({ id: run.companyId, name: "Evidence fixture", issuePrefix: `E${run.companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: run.agentId, companyId: run.companyId, name: "Fixture", role: "engineer",
      status: "paused", adapterType: runtimeMode === "native" ? "paperclip_runner" : "process", adapterConfig: {} });
    const issueId = runtimeMode === "native" ? randomUUID() : null;
    if (issueId) await db.insert(issues).values({ id: issueId, companyId: run.companyId, title: "Fixture", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ ...run, status: "running", runtimeMode, startedAt: new Date(),
      runtimeModeResolvedAt: new Date(), nativeIssueId: issueId, nativePhase: issueId ? "running" : null });
    if (issueId) await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId: run.companyId, issueId, phase: "executing" });
    return run;
  }

  it("retains the native cancellation request and its final run outcome", async () => {
    const run = await seed("native");
    await withRunExecutionEvidence(db, run, () => heartbeatService(db).cancelRun(run.id, "Stop fixture", {
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator" },
    }));
    const evidence = await readRunExecutionEvidence(db, run);
    const report = reconcileExecutionEvidence(evidence);
    expect(report.complete).toBe(true);
    expect(report.stops).toHaveLength(1);
    expect(report.stops[0]).toMatchObject({ source: "operator", terminalOutcome: "cancelled" });
    expect(evidence.run.resultJson?.nativeCancellation).toMatchObject({ dispatchState: "acknowledged" });
  });

  it("retains each process request and does not confuse terminal time with request time", async () => {
    const run = await seed();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    runningProcesses.set(run.id, { child, processGroupId: null, graceSec: 1 });
    try {
      const service = heartbeatService(db);
      await withRunExecutionEvidence(db, run, async () => {
        await service.cancelRun(run.id, "First stop");
        await service.cancelRun(run.id, "Repeated stop");
      });
      const report = reconcileExecutionEvidence(await readRunExecutionEvidence(db, run));
      expect(report.complete).toBe(true);
      expect(report.stops).toHaveLength(2);
      expect(new Set(report.stops.map(s => s.requestId)).size).toBe(2);
      expect(report.stops.every(s => s.terminalOutcome === "cancelled")).toBe(true);
      const [scope] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.runId, run.id), sql`${heartbeatRunEvents.payload}->>'scope' = 'stop'`,
      )).limit(1);
      await db.delete(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, run.id),
        sql`${heartbeatRunEvents.payload}->>'scopeId' = ${String(scope!.payload!.scopeId)}`));
      const missingScope = reconcileExecutionEvidence(await readRunExecutionEvidence(db, run));
      expect(missingScope.complete).toBe(false);
      expect(missingScope.gaps).toContain("run_event_stream_gap");
    } finally { runningProcesses.delete(run.id); }
  });

  it("retains an adapter-control stop during an SSH restore", async () => {
    const run = await seed();
    const control = createAdapterExecutionControl();
    adapterExecutionControls.set(run.id, control);
    let acknowledge!: () => void;
    const stopped = new Promise<void>(resolve => { acknowledge = resolve; });
    control.controller.signal.addEventListener("abort", () => { acknowledge(); }, { once: true });
    try {
      await withRunExecutionEvidence(db, run, async () => {
        const restoring = scheduleSshWorkspaceOperation(undefined, "restore", async () => {
          await stopped;
          await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
            resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, run.id));
          control.finish();
        });
        // Wait for a real durable start boundary before requesting Stop.
        for (;;) {
          const evidence = await readRunExecutionEvidence(db, run);
          if (evidence.records.some(r => r?.kind === "ssh_phase" && r.boundary === "started")) break;
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        await heartbeatService(db).cancelRun(run.id);
        await restoring;
      });
      const report = reconcileExecutionEvidence(await readRunExecutionEvidence(db, run));
      expect(report.complete).toBe(true);
      expect(report.phaseStopObserved).toBe(true);
    } finally { adapterExecutionControls.delete(run.id); control.finish(); }
  });

  it("retains shutdown request time before terminal reconciliation", async () => {
    const run = await seed();
    const requestedAt = new Date();
    await withRunExecutionEvidence(db, run, () => heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", requestedAt, [run.id]));
    const report = reconcileExecutionEvidence(await readRunExecutionEvidence(db, run));
    expect(report.complete).toBe(true);
    expect(report.stops[0]).toMatchObject({ source: "shutdown", requestedAt: requestedAt.toISOString(), terminalOutcome: "interrupted" });
  });

  it.each(["pause", "terminate"])("retains one operator request time for every run in a bulk %s", async action => {
    const first = await seed();
    let second: typeof first;
    if (action === "pause") {
      second = { ...first, id: randomUUID() };
      await db.insert(heartbeatRuns).values({ ...second, status: "running", startedAt: new Date(), runtimeModeResolvedAt: new Date() });
    } else second = await seed("legacy", first.companyId);
    const requestedAt = new Date(Date.now() - 1_000).toISOString();
    const context = { requestedAt, resultJson: { cancelledByActorType: "user", cancelledByUserId: "board-fixture" } };
    const service = heartbeatService(db);
    await withRunExecutionEvidence(db, first, () => withRunExecutionEvidence(db, second, async () => {
      if (action === "pause") await service.cancelActiveForAgent(first.agentId, undefined, context);
      else await service.cancelInvocationsForAgents([first.agentId, second.agentId], "Agent terminated", context);
    }));
    for (const run of [first, second]) {
      const report = reconcileExecutionEvidence(await readRunExecutionEvidence(db, run));
      expect(report.complete).toBe(true);
      expect(report.stops).toHaveLength(1);
      expect(report.stops[0]).toMatchObject({ source: "operator", requestedAt, initiator: { type: "user", id: "board-fixture" } });
    }
  });

  it("reads more than 200 records, measures overhead, and rejects a foreign company binding", async () => {
    const run = await seed();
    const started = performance.now();
    await withRunExecutionEvidence(db, run, async () => {
      for (let i = 0; i < 72; i++) await scheduleSshWorkspaceOperation(undefined, "prepare", async () => undefined);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    });
    const evidence = await readRunExecutionEvidence(db, run);
    const report = reconcileExecutionEvidence(evidence);
    expect(evidence.records).toHaveLength(218);
    expect(report.complete).toBe(true);
    expect(report.phases).toHaveLength(72);
    process.stdout.write(JSON.stringify({ fixture: "72_noop_ssh_attempts", elapsedMs: Math.round(performance.now() - started),
      writeMs: evidence.records.filter(r => r?.kind === "scope_finished").map(r => r?.writeMs), records: evidence.records.length }) + "\n");
    await expect(readRunExecutionEvidence(db, { ...run, companyId: randomUUID() })).rejects.toThrow("execution_evidence_binding_mismatch");
  }, 90_000);
});
