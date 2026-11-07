import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, budgetReservations, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues, issueThreadInteractions, routines } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const adapterType = "issue_budget_retry_test";
(support.supported ? describe : describe.skip)("issue token budget at retry and dispatch", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let workspace: string;
  const executions: string[] = [];
  const heldAgents = new Map<string, Promise<void>>();
  const envKeys = ["PAPERCLIP_ISSUE_TOKEN_BUDGET", "PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE"];
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-budget-retry-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    heartbeat = heartbeatService(db);
    workspace = await mkdtemp(join(tmpdir(), "paperclip-budget-retry-"));
    registerServerAdapter({ type: adapterType, execute: async ctx => {
      executions.push(ctx.runId);
      await heldAgents.get(ctx.agent.id);
      return { exitCode: 0, signal: null, timedOut: false };
    }, testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
  }, 60_000);
  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  afterAll(async () => {
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    await rm(workspace, { recursive: true, force: true });
  });

  async function seed(binding: "issue" | "native" | "snapshot" = "issue") {
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET = "100";
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE = new Date(Date.now() - 3_600_000).toISOString();
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Budget owner", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Budget retry", issuePrefix: `B${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType,
      status: "idle", adapterConfig: { cwd: workspace }, runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Budget task", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, scopeKind: "issue", issueId,
      responsibleUserId: userId, invocationSource: "assignment", status: "failed", finishedAt: new Date(),
      errorCode: "transient_upstream", error: "Retryable provider error", usageJson: { inputTokens: 100 },
      contextSnapshot: { issueId, taskId: issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, errorFamily: "transient_upstream" },
    }).returning();
    if (binding !== "issue") await db.update(heartbeatRuns).set({ issueId: null,
      ...(binding === "native" ? { nativeIssueId: issueId, contextSnapshot: {} } : {}) })
      .where(eq(heartbeatRuns.id, source.id));
    return { companyId, agentId, issueId, userId, source };
  }

  it.each(["issue", "native", "snapshot"] as const)("does not schedule an automatic retry at the %s issue token limit", async binding => {
    const f = await seed(binding);
    const result = await heartbeat.scheduleBoundedRetry(f.source.id, { random: () => 0 });
    expect(result).toMatchObject({ outcome: "not_scheduled" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  });

  it.each(["issue", "native", "snapshot"] as const)("rechecks %s usage before dispatching work already in the queue", async binding => {
    const f = await seed(binding);
    await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 0 } }).where(eq(heartbeatRuns.id, f.source.id));
    const [queued] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      scopeKind: "issue", issueId: f.issueId, responsibleUserId: f.userId, invocationSource: "assignment",
      status: "queued", contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_assigned" },
    }).returning();
    await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 100 } }).where(eq(heartbeatRuns.id, f.source.id));
    await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
    await expect.poll(async () => (await heartbeat.getRun(queued.id))?.status, { timeout: 5_000 })
      .not.toMatch(/^(queued|running)$/);
    expect(executions).not.toContain(queued.id);
    const run = await heartbeat.getRun(queued.id);
    expect(run?.errorCode).toBe("issue.token_budget_exceeded");
    await heartbeat.waitForRunExecutionDrain(queued.id);
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task?.executionRunId).toBeNull();
    const reservations = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, queued.id));
    expect(reservations).toHaveLength(1);
    expect(reservations[0].state).toBe("released");
  });

  it.each(["Run now", "Retry"])("still executes a board-authorized %s above the issue limit", async action => {
    const f = await seed();
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual",
      reason: action === "Retry" ? "retry_failed_run" : "manual_run",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, taskId: f.issueId },
      requestedByActorType: "user", requestedByActorId: f.userId, issueBudgetOverride: true,
      ...(action === "Retry" ? { failedRunId: f.source.id } : { manualUserWake: true }) });
    expect(run).not.toBeNull();
    await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 5_000 })
      .not.toMatch(/^(queued|running)$/);
    expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "succeeded" });
    expect(executions).toContain(run!.id);
    expect(await heartbeat.scheduleBoundedRetry(run!.id)).toMatchObject({ outcome: "not_scheduled",
      errorCode: "issue.token_budget_exceeded" });
  });

  it("rejects forged payload and context overrides at admission", async () => {
    const f = await seed();
    const forged = { runId: f.source.id, issueId: f.issueId };
    const result = await heartbeat.wakeup(f.agentId, { source: "on_demand", reason: "manual_run",
      payload: { issueId: f.issueId, issueBudgetOverride: forged },
      contextSnapshot: { issueId: f.issueId, issueBudgetOverride: forged },
      requestedByActorType: "user", requestedByActorId: f.userId });
    expect(result).toBeNull();
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0].payload?.issueBudgetOverride).toBeUndefined();
  });

  it("uses an accepted budget card as a fresh window for retry and dispatch", async () => {
    const f = await seed();
    expect(await heartbeat.scheduleBoundedRetry(f.source.id)).toMatchObject({ outcome: "not_scheduled" });
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date() })
      .where(eq(issueThreadInteractions.issueId, f.issueId));
    const retry = await heartbeat.scheduleBoundedRetry(f.source.id, { random: () => 0 });
    expect(retry.outcome).toBe("scheduled");
    if (retry.outcome !== "scheduled") throw new Error("Expected scheduled retry");
    await heartbeat.promoteDueScheduledRetries(retry.run.scheduledRetryAt!);
    await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
    await expect.poll(async () => (await heartbeat.getRun(retry.run.id))?.status, { timeout: 5_000 })
      .toBe("succeeded");
    expect(executions).toContain(retry.run.id);
  });

  it.each(["plain", "routine", "comment"])("preserves a board override through deferred wake promotion with %s context", async contextKind => {
    const f = await seed();
    if (contextKind === "routine") {
      const [routine] = await db.insert(routines).values({ companyId: f.companyId, title: "Budget routine",
        responsibleUserId: f.userId }).returning();
      await db.update(issues).set({ originKind: "routine_execution", originId: routine.id }).where(eq(issues.id, f.issueId));
    }
    const [comment] = contextKind === "comment" ? await db.insert(issueComments).values({
      companyId: f.companyId, issueId: f.issueId, authorUserId: f.userId, authorType: "user", body: "Continue this task",
    }).returning() : [];
    let release!: () => void;
    heldAgents.set(f.agentId, new Promise<void>(resolve => { release = resolve; }));
    const options = { source: "on_demand" as const, triggerDetail: "manual" as const, reason: "manual_run",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId,
        ...(comment ? { wakeCommentId: comment.id, wakeCommentIds: [comment.id] } : {}) },
      requestedByActorType: "user" as const, requestedByActorId: f.userId,
      issueBudgetOverride: true, manualUserWake: true };
    const first = await heartbeat.wakeup(f.agentId, options);
    try {
      await expect.poll(() => executions.includes(first!.id), { timeout: 5_000 }).toBe(true);
      expect(await heartbeat.wakeup(f.agentId, options)).toBeNull();
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      const deferred = wakes.find(wake => wake.status === "deferred_issue_execution");
      expect(deferred?.payload?.issueBudgetOverride).toEqual({ issueId: f.issueId, actorId: f.userId });
      heldAgents.delete(f.agentId); release();
      await expect.poll(async () => {
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred!.id));
        return wake.runId ? (await heartbeat.getRun(wake.runId))?.status : null;
      }, { timeout: 5_000 }).toBe("succeeded");
    } finally { heldAgents.delete(f.agentId); release(); }
  });

  it.each(["system", "agent"] as const)("keeps board Retry authority separate from a deferred %s wake", async actorType => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 0 } }).where(eq(heartbeatRuns.id, f.source.id));
    let release!: () => void;
    heldAgents.set(f.agentId, new Promise<void>(resolve => { release = resolve; }));
    const first = await heartbeat.wakeup(f.agentId, { source: "on_demand", reason: "manual_run",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId },
      requestedByActorType: "user", requestedByActorId: f.userId, manualUserWake: true });
    try {
      await expect.poll(() => executions.includes(first!.id), { timeout: 5_000 }).toBe(true);
      expect(await heartbeat.wakeup(f.agentId, { source: "on_demand", reason: "retry_failed_run",
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, forceFreshSession: true },
        requestedByActorType: actorType, requestedByActorId: actorType === "agent" ? f.agentId : null })).toBeNull();
      const original = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
        .find(wake => wake.status === "deferred_issue_execution")!;
      expect(original).toBeDefined();
      await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 100 } }).where(eq(heartbeatRuns.id, f.source.id));
      await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run",
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, forceFreshSession: true },
        failedRunId: f.source.id, requestedByActorType: "user", requestedByActorId: f.userId,
        issueBudgetOverride: true });
      const admitted = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      expect(admitted.filter(wake => wake.status === "deferred_issue_execution")).toHaveLength(2);
      heldAgents.delete(f.agentId); release();
      await expect.poll(async () => {
        const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
        const retry = wakes.find(wake => wake.requestedByActorType === "user" &&
          wake.id !== first!.wakeupRequestId && wake.runId !== null);
        return retry?.runId ? (await heartbeat.getRun(retry.runId))?.status : null;
      }, { timeout: 5_000 }).toBe("succeeded");
      const [unchanged] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, original.id));
      expect(unchanged.requestedByActorType).toBe(actorType);
      expect(unchanged.requestedByActorId).toBe(original.requestedByActorId);
      expect(unchanged.payload?.issueBudgetOverride).toBeUndefined();
      const refused = await heartbeat.getRun(unchanged.runId!);
      expect(refused).toMatchObject({ status: "cancelled", errorCode: "issue.token_budget_exceeded",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
      expect(executions).not.toContain(refused!.id);
    } finally { heldAgents.delete(f.agentId); release(); }
  });

  it("binds a coalesced board Retry override to the existing queued run", async () => {
    const f = await seed();
    const [queued] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      scopeKind: "issue", issueId: f.issueId, responsibleUserId: f.userId, invocationSource: "assignment",
      status: "queued", contextSnapshot: { issueId: f.issueId, taskId: f.issueId } }).returning();
    await db.update(issues).set({ executionRunId: queued.id, executionAgentNameKey: "worker", executionLockedAt: new Date() })
      .where(eq(issues.id, f.issueId));
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId }, failedRunId: f.source.id,
      requestedByActorType: "user", requestedByActorId: f.userId, issueBudgetOverride: true });
    expect(run?.id).toBe(queued.id);
    await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
    await expect.poll(async () => (await heartbeat.getRun(queued.id))?.status, { timeout: 5_000 }).toBe("succeeded");
    expect(executions).toContain(queued.id);
    expect(await heartbeat.scheduleBoundedRetry(queued.id)).toMatchObject({ outcome: "not_scheduled" });
  });

  it("strips forged override intent before queued dispatch", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 0 } }).where(eq(heartbeatRuns.id, f.source.id));
    const [queued] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      scopeKind: "issue", issueId: f.issueId, responsibleUserId: f.userId, invocationSource: "assignment",
      status: "queued", contextSnapshot: { issueId: f.issueId, taskId: f.issueId } }).returning();
    await db.update(issues).set({ executionRunId: queued.id, executionAgentNameKey: "worker", executionLockedAt: new Date() })
      .where(eq(issues.id, f.issueId));
    const forged = { issueId: f.issueId, actorId: f.userId };
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual_run",
      payload: { issueId: f.issueId, issueBudgetOverride: forged },
      contextSnapshot: { issueId: f.issueId, issueBudgetOverride: forged },
      requestedByActorType: "user", requestedByActorId: f.userId });
    expect(run?.id).toBe(queued.id);
    await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 100 } }).where(eq(heartbeatRuns.id, f.source.id));
    await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
    await expect.poll(async () => (await heartbeat.getRun(queued.id))?.status, { timeout: 5_000 }).toBe("cancelled");
    expect((await heartbeat.getRun(queued.id))?.errorCode).toBe("issue.token_budget_exceeded");
    expect(executions).not.toContain(queued.id);
  });
});
