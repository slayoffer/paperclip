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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, heartbeatRuns, heartbeatRunEvents, issueRecoveryActions, issues, projects, projectWorkspaces, executionWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { legacyControllerBootId, legacyControllerClaim } from "./legacy-controller-lease.js";
import { claimLegacyRestartRecovery, markLegacyRestartBoundary, readLegacyRestartCheckpoint, recordLegacyRestartFallback, saveLegacyRestartCheckpoint, suspendLegacyRunForRestart } from "./legacy-restart-recovery.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "./adapter-execution-control.js";
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
  afterEach(() => vi.unstubAllEnvs());
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
      ...legacyControllerClaim("legacy"), processPid: save ? 999_999_999 : null,
      contextSnapshot: { issueId, executionWorkspaceId } }).returning();
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
    [true, { remoteExecution: { transport: "ssh", host: "remote" } }, "restart_remote_stop_unverified"],
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

  it("rejects sandbox recovery even after stop and workspace receipts", async () => {
    const run = await seed(true, { remoteExecution: { transport: "sandbox", sandboxId: "sandbox-a" } });
    await markLegacyRestartBoundary(db, run, "providerStopped");
    await markLegacyRestartBoundary(db, run, "workspaceSettled");
    const expired = await expire(run.id);
    expect(await claimLegacyRestartRecovery(db, expired, "codex_local")).toBeNull();
    expect((await read(run.id)).resultJson?.restartRecovery).toMatchObject({ reason: "restart_sandbox_session_unsupported" });
  });

  it("preserves newer controller and terminal recovery evidence", async () => {
    const stale = await expire((await seed()).id);
    await claimLegacyRestartRecovery(db, stale, "codex_local");
    await recordLegacyRestartFallback(db, stale, "stale_controller");
    const owned = await read(stale.id);
    expect(owned.resultJson?.restartRecovery).toMatchObject({ outcome: "resuming", attempt: 1 });
    await recordLegacyRestartFallback(db, owned, "current_controller");
    expect((await read(stale.id)).resultJson?.restartRecovery).toMatchObject({ outcome: "reconciliation", attempt: 1 });
    await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { restartRecovery: { outcome: "resumed", attempt: 1 } } }).where(eq(heartbeatRuns.id, stale.id));
    await recordLegacyRestartFallback(db, owned, "late_controller");
    expect((await read(stale.id)).resultJson?.restartRecovery).toMatchObject({ outcome: "resumed", attempt: 1 });
  });

  it("requires both remote stop and workspace settlement for SSH recovery", async () => {
    const run = await seed(true, { cwd: "/remote/workspace", remoteExecution: { transport: "ssh", host: "host" } });
    await markLegacyRestartBoundary(db, run, "providerStopped");
    await markLegacyRestartBoundary(db, run, "workspaceSettled");
    const expired = await expire(run.id);
    expect(await claimLegacyRestartRecovery(db, expired, "codex_local")).not.toBeNull();
    expect(readLegacyRestartCheckpoint(await read(run.id))).toMatchObject({ providerStopped: false, workspaceSettled: false });
  });

  it.each(["control", "process", "missing", "owner", "scope_changed"] as const)("a graceful restart preserves the session through its %s owner", async ownership => {
    execute.mockClear();
    await db.update(heartbeatRuns).set({ status: "succeeded" });
    const seeded = await seed(false);
    if (ownership === "owner" || ownership === "scope_changed") {
      vi.stubEnv("PAPERCLIP_OWNER_SESSIONS_ENABLED", "true");
      vi.stubEnv("PAPERCLIP_OWNER_SESSION_AGENT_IDS", seeded.agentId);
    }
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
    const checkpoint = readLegacyRestartCheckpoint(await read(seeded.id));
    expect(checkpoint).not.toBeNull();
    if (ownership === "owner" || ownership === "scope_changed") {
      const [issue] = await db.select().from(issues).where(eq(issues.id, String(seeded.contextSnapshot?.issueId)));
      expect(checkpoint?.taskKey).toBe(`owner-project:${issue.projectId}`);
    }
    expect(await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date(), [seeded.id]))
      .toMatchObject({ restartSuspendedRunIds: [seeded.id], interruptedRunIds: [] });
    await oldController.drainActiveRunExecutions();
    const suspended = await read(seeded.id);
    expect(suspended.status).toBe("running");
    if (ownership === "scope_changed") vi.stubEnv("PAPERCLIP_OWNER_SESSIONS_ENABLED", "false");
    await expire(seeded.id);
    const newController = heartbeatService(db);
    await newController.reapOrphanedRuns({ staleThresholdMs: 0 });
    await newController.drainActiveRunExecutions();
    if (ownership === "missing" || ownership === "scope_changed") {
      expect(await read(seeded.id)).toMatchObject({ status: "failed", resultJson: {
        restartRecovery: { outcome: "reconciliation", reason: ownership === "missing"
          ? "restart_session_missing" : "restart_session_scope_changed" },
      } });
    } else {
      expect(await read(seeded.id)).toMatchObject({ status: "succeeded", sessionIdAfter: "01234567-89ab-4cde-8f01-23456789abcd", resultJson: { restartRecovery: { outcome: "resumed" } } });
    }
    const calls = execute.mock.calls.filter(([input]) => input.runId === seeded.id);
    expect(calls).toHaveLength(ownership === "scope_changed" ? 1 : 2);
    if (ownership !== "scope_changed") expect(calls[1]![0]).toMatchObject({ runId: seeded.id, runtime: { sessionId: "01234567-89ab-4cde-8f01-23456789abcd" }, context: { paperclipRestartResume: true } });
    const recoveryActions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, String(seeded.contextSnapshot?.issueId)));
    expect(recoveryActions.filter(action => action.cause === "legacy_execution_requires_reconciliation"))
      .toHaveLength(ownership === "missing" || ownership === "scope_changed" ? 1 : 0);
    if (ownership === "missing" || ownership === "scope_changed") {
      const obsolete = await db.select().from(issueRecoveryActions).where(conversationRecoveryActionPredicate());
      expect(obsolete.some(action => action.sourceIssueId === seeded.contextSnapshot?.issueId)).toBe(false);
    }
  }, 60_000);

  it.each([false, true])("requires local stop evidence without process identifiers: %s", async stopped => {
    const seeded = await seed();
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, seeded.id));
    if (stopped) await markLegacyRestartBoundary(db, seeded, "providerStopped");
    const run = await expire(seeded.id);
    const claimed = await claimLegacyRestartRecovery(db, run, "codex_local");
    if (stopped) expect(claimed).not.toBeNull();
    else {
      expect(claimed).toBeNull();
      expect((await read(run.id)).resultJson?.restartRecovery).toMatchObject({
        outcome: "reconciliation", reason: "restart_local_stop_unverified",
      });
    }
  });

  it("suspends a checkpoint saved after the shutdown snapshot", async () => {
    const snapshot = await seed(false);
    await saveLegacyRestartCheckpoint(db, snapshot, { adapterType: "codex_local", taskKey: null,
      workspaceCwd: cwd, sessionParams: { cwd, sessionId: "saved-session" } });
    const control = createAdapterExecutionControl();
    adapterExecutionControls.set(snapshot.id, control);
    const suspended = new Set<string>(), terminate = vi.fn(async () => {});
    const requestedAt = "2026-10-25T00:00:00.000Z";
    try {
      expect(await suspendLegacyRunForRestart(db, snapshot, suspended, terminate, requestedAt)).toBe(true);
      expect(suspended.has(snapshot.id)).toBe(true);
      expect(control.controller.signal.aborted).toBe(true);
      expect((control.controller.signal.reason as Error).message).toBe("server_restart");
      expect((await read(snapshot.id)).status).toBe("running");
      expect(terminate).not.toHaveBeenCalled();
      const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, snapshot.id));
      expect(rows.find(row => row.payload?.kind === "stop_request")?.payload).toMatchObject({ requestedAt, source: "shutdown" });
    } finally { adapterExecutionControls.delete(snapshot.id); control.finish(); }
  });

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

  it.each(["dispatch", "checkpoint", "attempt", "process", "group", "session", "started"])(
    "preserves execution evidence when bootstrap conflicts with %s", async scenario => {
      const seeded = await seed(scenario === "checkpoint");
      await db.update(heartbeatRuns).set({
        resultJson: { ...seeded.resultJson,
          executionRecovery: { kind: "bootstrap", providerWorkStarted: scenario === "started" },
          ...(scenario === "attempt" ? { restartRecovery: { outcome: "resuming", attempt: 1 } } : {}),
        },
        ...(scenario === "process" ? { processPid: 999_999_999 } : {}),
        ...(scenario === "group" ? { processGroupId: 999_999_999 } : {}),
        ...(scenario === "session" ? { sessionIdAfter: "saved-session" } : {}),
      }).where(eq(heartbeatRuns.id, seeded.id));
      if (scenario === "dispatch") await db.insert(heartbeatRunEvents).values({
        companyId: seeded.companyId, agentId: seeded.agentId, runId: seeded.id,
        seq: 1, eventType: "adapter.invoke", payload: { adapterType: "codex_local" },
      });
      const run = await expire(seeded.id);
      const claimed = await claimLegacyRestartRecovery(db, run, "codex_local");
      if (scenario === "checkpoint") {
        expect(claimed).toMatchObject({ sessionParams: { sessionId: seeded.sessionIdAfter } });
      } else {
        expect(claimed).toBeNull();
        expect((await read(run.id)).resultJson).toMatchObject({
          restartRecovery: { outcome: "reconciliation", reason: "restart_session_missing" },
        });
      }
    },
  );

  it("retains the attempt-limit fallback over stale resuming and conversation metadata", async () => {
    execute.mockClear();
    await db.update(heartbeatRuns).set({ status: "succeeded" });
    const run = await seed();
    await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson,
      restartRecovery: { outcome: "resuming", attempt: 3 }, conversationContinuation: "continue_conversation_v1",
    } }).where(eq(heartbeatRuns.id, run.id));
    await expire(run.id);
    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });
    expect(await read(run.id)).toMatchObject({ status: "failed", resultJson: {
      restartRecovery: { outcome: "reconciliation", reason: "restart_attempt_limit" },
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
