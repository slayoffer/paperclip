import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";
import { recoveryService } from "../services/recovery/service.js";

const execute = vi.hoisted(() => vi.fn<(input: AdapterExecutionContext) => Promise<{
  exitCode: number; signal: string | null; timedOut: boolean; sessionId?: string;
}>>());
vi.mock("../adapters/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute }),
}));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("restart with live legacy runs", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let cwd: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("restart-live-runs-");
    db = createDb(database.connectionString);
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "restart-live-runs-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(cwd, "paperclip"));
    await db.insert(authUsers).values({ id: "restart-live-user", name: "Test",
      email: "restart-live@example.test", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);
  afterAll(async () => {
    await database?.cleanup();
    if (cwd) await fs.rm(cwd, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each(["checkpoint", "controller"] as const)(
    "retains locks when a %s arrives after the sweep snapshot", async evidence => {
      const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Snapshot",
        issuePrefix: `S${companyId.slice(0, 7)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "general", adapterType: "codex_local" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Work", status: "in_progress", assigneeAgentId: agentId });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running",
        processPid: 999_999_999, contextSnapshot: { issueId } });
      await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
      const beforeWrite = vi.fn(async (id: string) => {
        expect(id).toBe(runId);
        await db.update(heartbeatRuns).set(evidence === "checkpoint"
          ? { resultJson: { restartCheckpoint: { version: 1, adapterType: "codex_local",
            companyId, agentId, issueId, taskKey: issueId, executionWorkspaceId: null,
            workspaceCwd: cwd, sessionParams: { cwd, sessionId: randomUUID() } } } }
          : { controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() - 1_000) })
          .where(eq(heartbeatRuns.id, runId));
      });
      expect(await recoveryService(db, { enqueueWakeup: vi.fn(),
        beforeOrphanedRunTerminalWrite: beforeWrite }).sweepStaleIssueLocks())
        .toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
      expect(beforeWrite).toHaveBeenCalledOnce();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status).toBe("running");
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
        .toMatchObject({ executionRunId: runId, checkoutRunId: runId });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
      await heartbeatService(db).sweepStaleIssueLocks();
    },
  );

  it.each(["sweep_first", "overlap"] as const)(
    "resumes six stopped runs once when recovery order is %s", async order => {
      execute.mockReset();
      const companyId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Restart",
        issuePrefix: `R${companyId.slice(0, 7)}`, defaultResponsibleUserId: "restart-live-user" });
      const runIds: string[] = [];
      const sessionByRun = new Map<string, string>();
      const readyByRun = new Map<string, () => void>();
      const ready: Promise<void>[] = [];
      for (let index = 0; index < 6; index++) {
        const agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
        const adapterType = index % 2 ? "claude_local" : "codex_local";
        await db.insert(agents).values({ id: agentId, companyId, name: `Agent ${index}`,
          role: "general", adapterType, adapterConfig: { cwd, engine: "cli" } });
        await db.insert(issues).values({ id: issueId, companyId, title: `Work ${index}`,
          status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "restart-live-user" });
        await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
          status: "queued", contextSnapshot: { issueId } });
        await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId })
          .where(eq(issues.id, issueId));
        runIds.push(runId);
        sessionByRun.set(runId, randomUUID());
        ready.push(new Promise(resolve => readyByRun.set(runId, resolve)));
      }
      const children: ReturnType<typeof spawn>[] = [];
      execute.mockImplementation(async input => {
        const sessionId = sessionByRun.get(input.runId)!;
        if (input.context.paperclipRestartResume) {
          expect(input.runtime.sessionId).toBe(sessionId);
          const [issue] = await db.select().from(issues).where(eq(issues.id, String(input.context.issueId)));
          expect(issue?.executionRunId).toBe(input.runId);
          expect(issue?.checkoutRunId).toBe(input.runId);
          await db.update(issues).set({ status: "done" }).where(eq(issues.id, issue!.id));
          return { exitCode: 0, signal: null, timedOut: false, sessionId };
        }
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        children.push(child);
        const stopped = once(child, "exit");
        runningProcesses.set(input.runId, { child, processGroupId: null, graceSec: 1 });
        try {
          await input.onSpawn?.({ pid: child.pid!, processGroupId: null, startedAt: new Date().toISOString() });
          await input.onEvent?.({ eventType: "session.checkpoint", payload: { sessionParams: { cwd, sessionId } } });
          readyByRun.get(input.runId)!();
          await stopped;
          await input.onProviderStopped?.();
          return { exitCode: 0, signal: null, timedOut: false };
        } finally {
          child.kill();
          runningProcesses.delete(input.runId);
        }
      });
      const previous = heartbeatService(db);
      const replacement = heartbeatService(db);
      try {
        await previous.resumeQueuedRuns();
        await Promise.all(ready);
        const drained = await previous.drainRunningRunsForShutdown("SIGTERM", new Date(), runIds);
        await previous.drainActiveRunExecutions();
        expect(drained.restartSuspendedRunIds.sort()).toEqual([...runIds].sort());
        expect(drained.interruptedRunIds).toEqual([]);
        // Drain expires the old leases. Do not manufacture expiry in the test.
        const suspended = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, runIds));
        expect(suspended.every(run => run.status === "running" && run.processPid !== null)).toBe(true);
        if (order === "sweep_first") {
          expect(await replacement.sweepStaleIssueLocks()).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
        }
        await Promise.all([
          replacement.reapOrphanedRuns(),
          order === "overlap" ? heartbeatService(db).sweepStaleIssueLocks() : Promise.resolve(),
        ]);
        await replacement.drainActiveRunExecutions();
        const completed = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
        expect(completed).toHaveLength(6);
        for (const run of completed) {
          expect(run).toMatchObject({ status: "succeeded", sessionIdAfter: sessionByRun.get(run.id),
            resultJson: { restartRecovery: { outcome: "resumed" } } });
          expect(execute.mock.calls.filter(([input]) => input.runId === run.id)).toHaveLength(2);
        }
      } finally {
        for (const child of children) child.kill("SIGKILL");
        await previous.drainActiveRunExecutions();
        await replacement.drainActiveRunExecutions();
      }
    }, 120_000,
  );
});
