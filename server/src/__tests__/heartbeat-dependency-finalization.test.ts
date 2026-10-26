import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, createDb, executionWorkspaces, issueRelations, issues,
  projects, projectWorkspaces, workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";

const adapterExecute = vi.hoisted(() => vi.fn());
const reconcileCalls = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));
vi.mock("../services/recovery/service.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/recovery/service.js")>();
  return { ...actual, recoveryService: (...args: Parameters<typeof actual.recoveryService>) => {
    const service = actual.recoveryService(...args);
    return { ...service, reconcileResolvedDependencyWakeBackstop:
      (...params: Parameters<typeof service.reconcileResolvedDependencyWakeBackstop>) => {
        reconcileCalls(...params);
        return service.reconcileResolvedDependencyWakeBackstop(...params);
      } };
  } };
});

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("heartbeat dependency finalization callback", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-dependency-callback-");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
  }, 30_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    adapterExecute.mockReset();
    reconcileCalls.mockClear();
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await database?.cleanup(); });

  it.each([
    { status: "done", integrity: true, finalization: "succeeded", rechecks: 1 },
    { status: "cancelled", integrity: true, finalization: "succeeded", rechecks: 1 },
    { status: "done", integrity: false, finalization: "succeeded", rechecks: 1 },
    { status: "cancelled", integrity: false, finalization: "succeeded", rechecks: 0 },
    { status: "done", integrity: true, finalization: "failed", rechecks: 1 },
    { status: "cancelled", integrity: true, finalization: "failed", rechecks: 1 },
  ])("rechecks $status with integrity=$integrity and finalization=$finalization", async ({ status, integrity, finalization, rechecks }) => {
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", String(integrity));
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "false");
    const companyId = randomUUID();
    const agentId = randomUUID();
    const dependentAgentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const dependentId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Dependency callback",
      issuePrefix: `C${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Callback project" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId,
      name: "Primary", cwd: fileURLToPath(new URL("../../../", import.meta.url)), isPrimary: true });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Blocker owner", adapterType: "codex_local", status: "idle",
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } },
      { id: dependentAgentId, companyId, name: "Dependent owner", status: "paused" },
    ]);
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId,
      name: "Blocker workspace", mode: "shared_workspace", strategyType: "project_primary" });
    await db.insert(issues).values([
      { id: issueId, companyId, projectId, projectWorkspaceId, title: "Blocker",
        status: "in_progress", workMode: "standard", assigneeAgentId: agentId },
      { id: dependentId, companyId, title: "Dependent", status: "blocked",
        assigneeAgentId: dependentAgentId, blockedTransitionAt: new Date() },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId, relatedIssueId: dependentId, type: "blocks" });
    adapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status, executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
      const [operation] = await db.insert(workspaceOperations).values({ companyId, issueId,
        executionWorkspaceId: workspaceId, phase: "workspace_finalize", status: "running" }).returning();
      if (integrity) {
        expect(await issueService(db).getDependencyReadiness(dependentId)).toMatchObject({
          isDependencyReady: false, pendingFinalizeBlockerIssueIds: [issueId],
        });
      }
      expect((await issueService(db).getById(dependentId))?.status).toBe("blocked");
      await db.update(workspaceOperations).set({ status: finalization })
        .where(eq(workspaceOperations.id, operation!.id));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Finalization completed.",
        provider: "test", model: "test-model" };
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_commented", payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, skipIssueComment: true } });
    expect(run).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(adapterExecute).toHaveBeenCalledOnce();
    expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "succeeded" });
    const callbacks = reconcileCalls.mock.calls.filter(([opts]) => opts?.source === "workspace.finalize");
    process.stdout.write(`${status}: rechecks = ${callbacks.length}, expected ${rechecks} (integrity=${integrity}, finalization=${finalization})\n`);
    expect(callbacks).toHaveLength(rechecks);
    if (rechecks) expect(callbacks[0]?.[0]).toMatchObject({
      runId: run!.id, companyId, blockerIssueId: issueId, source: "workspace.finalize",
    });
    if (integrity) expect((await issueService(db).getById(dependentId))?.status)
      .toBe(finalization === "succeeded" ? "todo" : "blocked");
  }, 30_000);
});
