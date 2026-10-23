import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { runningProcesses } from "../adapters/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, projects, projectWorkspaces, executionWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { legacyControllerBootId, legacyControllerClaim } from "./legacy-controller-lease.js";
import { claimLegacyRestartRecovery, markLegacyRestartBoundary, readLegacyRestartCheckpoint, saveLegacyRestartCheckpoint } from "./legacy-restart-recovery.js";
import { heartbeatService } from "./heartbeat.js";
import { conversationRecoveryActionPredicate } from "./conversation-continuation.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const execute = vi.hoisted(() => vi.fn(async (_input: AdapterExecutionContext) => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute }),
}));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("legacy restart checkpoints", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let cwd: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-restart-");
    db = createDb(database.connectionString);
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-restart-"));
    await promisify(execFile)("git", ["init", cwd]);
    await promisify(execFile)("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "Initial"]);
    await db.insert(authUsers).values({ id: "restart-user", name: "Test", email: "restart@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); if (cwd) await fs.rm(cwd, { recursive: true, force: true }); });
  async function seed(save = true, params: Record<string, unknown> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Restart", issuePrefix: `R${companyId.slice(0, 7)}`, defaultResponsibleUserId: "restart-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "general", adapterType: "codex_local", adapterConfig: { cwd, engine: "cli" } });
    const projectId = randomUUID(), projectWorkspaceId = randomUUID(), executionWorkspaceId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Checkout", cwd, isPrimary: true });
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, projectId, projectWorkspaceId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Checkout", cwd });
    await db.insert(issues).values({ projectId, projectWorkspaceId, executionWorkspaceId, id: issueId, companyId, title: "Continue work", assigneeAgentId: agentId, status: "in_progress", responsibleUserId: "restart-user" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running",
      ...legacyControllerClaim("legacy"), contextSnapshot: { issueId, executionWorkspaceId } }).returning();
    await db.update(issues).set({ executionRunId: run.id, checkoutRunId: run.id }).where(eq(issues.id, issueId));
    if (save) await saveLegacyRestartCheckpoint(db, run, { adapterType: "codex_local", taskKey: "owner-project:test",
      workspaceCwd: cwd, sessionParams: { sessionId: "01234567-89ab-4cde-8f01-23456789abcd", cwd, ...params } });
    return read(run.id);
  }
  async function read(id: string) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!; }
  async function expire(id: string) {
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(heartbeatRuns.id, id));
    return read(id);
  }
  it("reclaims the same run with the saved session and owner session key", async () => {
    const run = await expire((await seed()).id);
    expect(await claimLegacyRestartRecovery(db, run, "codex_local")).toMatchObject({
      taskKey: "owner-project:test", sessionParams: { sessionId: "01234567-89ab-4cde-8f01-23456789abcd", cwd },
    });
    const saved = await read(run.id);
    expect(saved).toMatchObject({ id: run.id, status: "running", controllerBootId: legacyControllerBootId,
      sessionIdAfter: "01234567-89ab-4cde-8f01-23456789abcd", resultJson: { restartRecovery: { outcome: "resuming", attempt: 1 } } });
    const [issue] = await db.select().from(issues).where(eq(issues.id, String(run.contextSnapshot?.issueId)));
    expect(issue).toMatchObject({ executionRunId: run.id, checkoutRunId: run.id });
  });
  it("does not claim an unexpired controller or permit two concurrent claims", async () => {
    const run = await seed();
    expect(await claimLegacyRestartRecovery(db, run, "codex_local")).toBeNull();
    const expired = await expire(run.id);
    const results = await Promise.all([claimLegacyRestartRecovery(db, expired, "codex_local"), claimLegacyRestartRecovery(db, expired, "codex_local")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it.each([
    [false, {}, "restart_session_missing"],
    [true, { cwd: "/missing/restart-workspace" }, "restart_workspace_missing"],
    [true, { remoteExecution: { host: "remote" } }, "restart_remote_stop_unverified"],
  ])("records a reconciliation reason when recovery lacks evidence", async (save, params, reason) => {
    const run = await expire((await seed(save as boolean, params as Record<string, unknown>)).id);
    expect(await claimLegacyRestartRecovery(db, run, "codex_local")).toBeNull();
    expect((await read(run.id)).resultJson).toMatchObject({ restartRecovery: { outcome: "reconciliation", reason } });
  });
  it("rejects a checkpoint from another company or workspace", async () => {
    const run = await seed();
    expect(readLegacyRestartCheckpoint({ ...run, companyId: randomUUID() })).toBeNull();
    expect(readLegacyRestartCheckpoint({ ...run, contextSnapshot: { ...run.contextSnapshot, executionWorkspaceId: randomUUID() } })).toBeNull();
  });

  it("requires both remote stop and workspace settlement for SSH recovery", async () => {
    const run = await seed(true, { cwd: "/remote/workspace", remoteExecution: { transport: "ssh", host: "host" } });
    await markLegacyRestartBoundary(db, run, "providerStopped");
    await markLegacyRestartBoundary(db, run, "workspaceSettled");
    const expired = await expire(run.id);
    expect(await claimLegacyRestartRecovery(db, expired, "codex_local")).not.toBeNull();
    expect(readLegacyRestartCheckpoint(await read(run.id))).toMatchObject({ providerStopped: false, workspaceSettled: false });
  });

  it.each(["control", "process", "missing"] as const)("a graceful restart resumes a live Codex run through its %s owner", async ownership => {
    execute.mockClear();
    await db.update(heartbeatRuns).set({ status: "succeeded" });
    const seeded = await seed(false);
    await db.update(heartbeatRuns).set({ status: "queued", controllerBootId: null, controllerLeaseExpiresAt: null })
      .where(eq(heartbeatRuns.id, seeded.id));
    execute.mockImplementation(async input => {
      if (ownership === "missing") throw new Error("restart_session_missing");
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
      return { exitCode: 0, signal: null, timedOut: false,
        sessionId: "01234567-89ab-4cde-8f01-23456789abcd" };
    });
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    execute.mockImplementationOnce(async input => {
      const child = ownership === "process" ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }) : null;
      const stopped = child ? once(child, "exit") : null;
      if (child) {
        runningProcesses.set(input.runId, { child, graceSec: 1, processGroupId: null });
        await input.onSpawn?.({ pid: child.pid!, processGroupId: null, startedAt: new Date().toISOString() });
      } else await input.onCancellationReady?.();
      await input.onEvent?.({ eventType: "session.checkpoint", payload: {
        sessionParams: { sessionId: "01234567-89ab-4cde-8f01-23456789abcd", cwd },
      } });
      markStarted();
      try {
        if (stopped) await stopped;
        else await new Promise<void>(resolve => {
          if (input.signal?.aborted) resolve();
          else input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await input.onProviderStopped?.();
      } finally { child?.kill(); runningProcesses.delete(input.runId); }
      return { exitCode: 0, signal: null, timedOut: false };
    });
    const oldController = heartbeatService(db);
    await oldController.resumeQueuedRuns();
    await started;
    expect(readLegacyRestartCheckpoint(await read(seeded.id))).not.toBeNull();
    expect(await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date(), [seeded.id]))
      .toMatchObject({ restartSuspendedRunIds: [seeded.id], interruptedRunIds: [] });
    await oldController.drainActiveRunExecutions();
    const suspended = await read(seeded.id);
    expect(suspended.status).toBe("running");
    await expire(seeded.id);
    const newController = heartbeatService(db);
    await newController.reapOrphanedRuns({ staleThresholdMs: 0 });
    await newController.drainActiveRunExecutions();
    if (ownership === "missing") {
      expect(await read(seeded.id)).toMatchObject({ status: "failed", resultJson: {
        restartRecovery: { outcome: "reconciliation", reason: "restart_session_missing" },
      } });
    } else {
      expect(await read(seeded.id)).toMatchObject({ status: "succeeded", sessionIdAfter: "01234567-89ab-4cde-8f01-23456789abcd", resultJson: { restartRecovery: { outcome: "resumed" } } });
    }
    const calls = execute.mock.calls.filter(([input]) => input.runId === seeded.id);
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toMatchObject({ runId: seeded.id, runtime: { sessionId: "01234567-89ab-4cde-8f01-23456789abcd" }, context: { paperclipRestartResume: true } });
    const recoveryActions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, String(seeded.contextSnapshot?.issueId)));
    expect(recoveryActions.filter(action => action.cause === "legacy_execution_requires_reconciliation"))
      .toHaveLength(ownership === "missing" ? 1 : 0);
    if (ownership === "missing") {
      const obsolete = await db.select().from(issueRecoveryActions).where(conversationRecoveryActionPredicate());
      expect(obsolete.some(action => action.sourceIssueId === seeded.contextSnapshot?.issueId)).toBe(false);
    }
  }, 60_000);

  it("a missing checkpoint retains reconciliation without dispatch", async () => {
    execute.mockClear();
    await db.update(heartbeatRuns).set({ status: "succeeded" });
    const run = await expire((await seed(false)).id);
    const heartbeat = heartbeatService(db);
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
    expect(await read(run.id)).toMatchObject({ status: "failed", resultJson: {
      restartRecovery: { outcome: "reconciliation", reason: "restart_session_missing" },
    } });
    expect(execute).not.toHaveBeenCalled();
    const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, String(run.contextSnapshot?.issueId)));
    expect(holds).toEqual([expect.objectContaining({ cause: "legacy_execution_requires_reconciliation" })]);
  });

  it("does nothing when no live runs exist", async () => {
    execute.mockClear();
    await db.update(heartbeatRuns).set({ status: "succeeded" });
    expect(await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 })).toEqual({ reaped: 0, runIds: [] });
    expect(execute).not.toHaveBeenCalled();
  });
});
