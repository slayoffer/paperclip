import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, heartbeatRuns, issues, projects, projectWorkspaces, executionWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { legacyControllerClaim } from "./legacy-controller-lease.js";
import { claimLegacyRestartRecovery, markLegacyRestartBoundary, readLegacyRestartCheckpoint, saveLegacyRestartCheckpoint, suspendLegacyRunForRestart } from "./legacy-restart-recovery.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "./adapter-execution-control.js";
import { restartSettleTimeoutMs } from "../shutdown.js";

// SYNA-2959: the 2026-10-29 18:02 VLAT deploy reaped SSH run 87699d0e with restart_remote_stop_unverified. Shutdown
// killed the local SSH client by signal, which is no stop proof, so providerStopped stayed null.
const remote = { cwd: "/remote/workspace", remoteExecution: { transport: "ssh", host: "home-pc" } };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("SSH restart stop proof", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let local: string;
  beforeAll(async () => {
    local = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-restart-ssh-"));
    database = await startEmbeddedPostgresTestDatabase("legacy-restart-ssh-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: "ssh-user", name: "Test", email: "ssh@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); if (local) await fs.rm(local, { recursive: true, force: true }); });

  async function read(id: string) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!; }
  async function seed(params: Record<string, unknown> = remote) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const projectId = randomUUID(), projectWorkspaceId = randomUUID(), executionWorkspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Restart", issuePrefix: `S${companyId.slice(0, 7)}`, defaultResponsibleUserId: "ssh-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "general", adapterType: "codex_local", adapterConfig: { engine: "cli" } });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Checkout", cwd: local, isPrimary: true });
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, projectId, projectWorkspaceId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Checkout", cwd: local });
    await db.insert(issues).values({ projectId, projectWorkspaceId, executionWorkspaceId, id: issueId, companyId, title: "Review", assigneeAgentId: agentId, status: "in_progress", responsibleUserId: "ssh-user" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", ...legacyControllerClaim("legacy"),
      contextSnapshot: { issueId, executionWorkspaceId } }).returning();
    await db.update(issues).set({ executionRunId: run.id, checkoutRunId: run.id }).where(eq(issues.id, issueId));
    await saveLegacyRestartCheckpoint(db, run, { adapterType: "codex_local", taskKey: "owner-project:test",
      workspaceCwd: local, sessionParams: { sessionId: "01234567-89ab-4cde-8f01-23456789abcd", ...params } });
    return read(run.id);
  }
  async function expire(id: string) {
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(heartbeatRuns.id, id));
    return read(id);
  }
  async function suspend(run: Awaited<ReturnType<typeof seed>>, stopRemote?: (r: typeof run) => Promise<boolean>) {
    const control = createAdapterExecutionControl();
    adapterExecutionControls.set(run.id, control);
    try {
      const suspended = new Set<string>();
      expect(await suspendLegacyRunForRestart(db, run, suspended, vi.fn(async () => {}), new Date().toISOString(), stopRemote)).toBe(true);
      expect(control.controller.signal.aborted).toBe(true);
    } finally { adapterExecutionControls.delete(run.id); control.finish(); }
  }

  it("records the remote stop before the abort, so the settled run resumes after restart", async () => {
    const run = await seed();
    const stopRemote = vi.fn(async () => {
      expect(adapterExecutionControls.get(run.id)?.controller.signal.aborted).toBe(false);
      return true;
    });
    await suspend(run, stopRemote);
    expect(stopRemote).toHaveBeenCalledOnce();
    const checkpoint = readLegacyRestartCheckpoint(await read(run.id));
    expect([checkpoint?.providerStopped, checkpoint?.workspaceSettled]).toEqual([true, undefined]);
    await markLegacyRestartBoundary(db, run, "workspaceSettled");
    expect(await claimLegacyRestartRecovery(db, await expire(run.id), "codex_local")).not.toBeNull();
    expect((await read(run.id)).resultJson).toMatchObject({ restartRecovery: { outcome: "resuming", attempt: 1 } });
  });

  it.each([
    ["an unconfirmed remote stop", async () => false],
    ["a remote stop that throws", async () => { throw new Error("ssh timeout"); }],
    ["no remote stopper (the 87699d0e shape)", undefined],
  ])("%s leaves providerStopped unset and recovery reconciles", async (_name, stopRemote) => {
    const run = await seed();
    await suspend(run, stopRemote);
    expect(readLegacyRestartCheckpoint(await read(run.id))?.providerStopped).toBeUndefined();
    expect(await claimLegacyRestartRecovery(db, await expire(run.id), "codex_local")).toBeNull();
    expect((await read(run.id)).resultJson).toMatchObject({ restartRecovery: { outcome: "reconciliation", reason: "restart_remote_stop_unverified" } });
  });

  it("does not call the remote stopper for a local run", async () => {
    const run = await seed({ cwd: "/remote/workspace" });
    const stopRemote = vi.fn(async () => true);
    await suspend(run, stopRemote);
    expect(stopRemote).not.toHaveBeenCalled();
  });
});

describe("restartSettleTimeoutMs", () => {
  it.each([
    [undefined, 60_000], ["120000", 120_000], ["4999", 60_000], ["600001", 60_000], ["abc", 60_000], ["5000.5", 60_000],
  ])("PAPERCLIP_RESTART_SETTLE_MS=%s gives %i", (value, expected) => {
    expect(restartSettleTimeoutMs(value === undefined ? {} : { PAPERCLIP_RESTART_SETTLE_MS: value })).toBe(expected);
  });
});
