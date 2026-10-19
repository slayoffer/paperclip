import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRelations, issues,
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { issueService, executeIssuePostCommitActions, type IssuePostCommitAction } from "../services/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { dispatchPendingDependencyReleaseWakes } from "../services/dependency-release-wakes.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";

const heartbeat = vi.hoisted(() => ({ wakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
    ...actual.heartbeatService(...args), wakeup: heartbeat.wakeup,
  }) };
});
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("durable dependency release wakes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof issueService>;
  let companyId: string;
  let agentId: string;
  let blocker: typeof issues.$inferSelect;
  let dependent: typeof issues.$inferSelect;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-release-wakes-");
    db = createDb(database.connectionString);
    svc = issueService(db);
  }, 30_000);
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", "true");
    heartbeat.wakeup.mockReset().mockResolvedValue(null);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Release", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle" });
    [blocker] = await db.insert(issues).values({ companyId, title: "Blocker", status: "todo" }).returning() as [typeof blocker];
    [dependent] = await db.insert(issues).values({ companyId, title: "Dependent", status: "blocked",
      assigneeAgentId: agentId, blockedTransitionAt: new Date("2026-08-01T00:00:00Z") }).returning() as [typeof dependent];
    await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: dependent.id, type: "blocks" });
  });
  afterEach(async () => {
    for (const table of [activityLog, issueComments, issueRelations, heartbeatRuns, agentWakeupRequests, issues, agents, companies]) {
      await db.delete(table);
    }
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await database?.cleanup(); });
  const intents = () => db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.requestedByActorId, "blocked-dependency-release"));
  const recover = () => recoveryService(db, { enqueueWakeup: heartbeat.wakeup })
    .reconcileResolvedDependencyWakeBackstop({ companyId });
  const delivered = async () => (await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded" }).returning())[0]!;

  it.each(["done", "cancelled"])("dispatches after direct service completion to %s commits", async status => {
    heartbeat.wakeup.mockImplementation(async (owner, opts) => {
      expect(owner).toBe(agentId);
      expect((await svc.getById(blocker.id))?.status).toBe(status);
      expect((await svc.getById(dependent.id))?.status).toBe("todo");
      expect(await intents()).toHaveLength(1);
      expect(opts).toMatchObject({ reason: "issue_blockers_resolved", payload: { issueId: dependent.id },
        issueStateGuard: { statuses: ["todo"], assigneeAgentId: agentId, statusVersion: dependent.statusVersion + 1 },
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: dependent.id,
          blockerIssueIds: [blocker.id], blockedTransitionAt: dependent.blockedTransitionAt }) });
      return delivered();
    });
    await svc.update(blocker.id, { status });
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect((await intents())[0]?.status).toBe("completed_dependency_dispatch");
    await recover();
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
  });

  it.each(["deferred", "failed"])("recovers a %s dispatch after the dependent becomes todo", async outcome => {
    if (outcome === "failed") heartbeat.wakeup.mockRejectedValueOnce(new Error("admission unavailable"));
    await svc.update(blocker.id, { status: "done" });
    expect((await svc.getById(dependent.id))?.status).toBe("todo");
    expect((await intents())[0]?.status).toBe("pending_dependency_dispatch");
    heartbeat.wakeup.mockResolvedValueOnce(await delivered());
    expect(await recover()).toMatchObject({ checked: 1, healed: 1, issueIds: [dependent.id] });
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(2);
    expect((await intents())[0]?.status).toBe("completed_dependency_dispatch");
  });

  it("rolls back the pending wake with the status transition", async () => {
    const actions: IssuePostCommitAction[] = [];
    await expect(db.transaction(async tx => {
      await svc.update(blocker.id, { status: "done" }, tx, [], actions);
      expect(heartbeat.wakeup).not.toHaveBeenCalled();
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await intents()).toEqual([]);
    expect((await svc.getById(dependent.id))?.status).toBe("blocked");
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("recovers a committed intent when the process misses its post-commit actions", async () => {
    const actions: IssuePostCommitAction[] = [];
    await db.transaction(tx => svc.update(blocker.id, { status: "done" }, tx, [], actions));
    expect(actions).toHaveLength(1);
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    heartbeat.wakeup.mockResolvedValueOnce(await delivered());
    expect(await recover()).toMatchObject({ healed: 1 });
    await executeIssuePostCommitActions(db, actions);
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
  });

  it("recovers a stale dispatch claim without duplicating a completed wake", async () => {
    await svc.update(blocker.id, { status: "done" });
    const [intent] = await intents();
    await db.update(agentWakeupRequests).set({ status: "dispatching_dependency",
      updatedAt: new Date(Date.now() - 120_000) }).where(eq(agentWakeupRequests.id, intent!.id));
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "completed",
      reason: "issue_blockers_resolved", idempotencyKey: buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: dependent.id,
        blockerIssueIds: [blocker.id], blockedTransitionAt: dependent.blockedTransitionAt }) });
    await recover();
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect((await intents())[0]?.status).toBe("completed_dependency_dispatch");
  });

  it("does not consume a fresh claim or a different company's intent", async () => {
    await svc.update(blocker.id, { status: "done" });
    heartbeat.wakeup.mockClear();
    await dispatchPendingDependencyReleaseWakes(db, heartbeat.wakeup, { companyId: randomUUID() });
    expect((await intents())[0]?.status).toBe("pending_dependency_dispatch");
    const [intent] = await intents();
    await db.update(agentWakeupRequests).set({ status: "dispatching_dependency", updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, intent!.id));
    await recover();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("cancels an obsolete intent after a new blocked cycle starts", async () => {
    await svc.update(blocker.id, { status: "done" });
    await svc.update(blocker.id, { status: "todo" });
    await svc.update(dependent.id, { status: "blocked", blockedByIssueIds: [blocker.id] });
    heartbeat.wakeup.mockClear();
    await recover();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    expect((await intents())[0]?.status).toBe("cancelled");
  });

  it("keeps legacy recovery when the switch is disabled", async () => {
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", "false");
    await svc.update(blocker.id, { status: "done" });
    expect(await intents()).toEqual([]);
    expect((await svc.getById(dependent.id))?.status).toBe("blocked");
    heartbeat.wakeup.mockResolvedValueOnce(await delivered());
    expect(await recover()).toMatchObject({ healed: 1 });
  });
});
