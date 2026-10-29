import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const support = await getEmbeddedPostgresTestSupport();
const BUDGET_ENV = ["PAPERCLIP_ISSUE_TOKEN_BUDGET", "PAPERCLIP_ISSUE_TOKEN_BUDGET_CACHED_WEIGHT",
  "PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE", "PAPERCLIP_ISSUE_TOKEN_BUDGET_CARD_AGENT_ID"];

(support.supported ? describe : describe.skip)("heartbeat issue token budget gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const saved = Object.fromEntries(BUDGET_ENV.map((k) => [k, process.env[k]]));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-token-budget-");
    db = createDb(tempDb.connectionString);
  }, 120_000);
  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), cardAgentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Budget", issuePrefix, requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process",
        adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: cardAgentId, companyId, name: "CTO", role: "cto", status: "idle", adapterType: "process",
        adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, title: "Expensive", status: "todo", priority: "medium", responsibleUserId: "responsible-user",
      assigneeAgentId: agentId, issueNumber: 1, identifier: `${issuePrefix}-1`,
    });
    await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "succeeded", invocationSource: "assignment",
      contextSnapshot: { issueId }, usageJson: { inputTokens: 6_000_000 },
      createdAt: new Date(Date.now() - 60_000),
    });
    return { companyId, agentId, cardAgentId, issueId };
  }

  const wake = (heartbeat: ReturnType<typeof heartbeatService>, agentId: string, issueId: string, actorType: "system" | "user") =>
    heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
      requestedByActorType: actorType,
      requestedByActorId: actorType === "user" ? "local-board" : null,
    });

  it("skips a system wake over the budget and raises one card for the configured agent", async () => {
    const { companyId, agentId, cardAgentId, issueId } = await seed();
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET = "5000000";
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE = new Date(Date.now() - 3_600_000).toISOString();
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET_CARD_AGENT_ID = cardAgentId;
    const heartbeat = heartbeatService(db);

    const outcome = await heartbeat.wakeupWithDiagnostics(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId },
      requestedByActorType: "system",
    });
    expect(outcome.run).toBeNull();
    expect(outcome.skipped).toMatchObject({
      reason: "issue.token_budget_exceeded",
      error: expect.stringContaining("6000000 weighted input tokens"),
      details: { budget: { used: 6_000_000, limit: 5_000_000 } },
    });
    expect(await wake(heartbeat, agentId, issueId, "system")).toBeNull();

    const skipped = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue.token_budget_exceeded")));
    expect(skipped).toHaveLength(2);
    expect(skipped.every((row) => row.status === "skipped")).toBe(true);
    const cards = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: "pending", addresseeAgentId: cardAgentId });
  });

  it("shows the weighted usage and cached weight in the stop card and skipped receipt", async () => {
    const { companyId, agentId, issueId } = await seed();
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET = "5000000";
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET_CACHED_WEIGHT = "0.1";
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE = new Date(Date.now() - 3_600_000).toISOString();
    await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 18_000_000, cachedInputTokens: 12_000_000 } })
      .where(eq(heartbeatRuns.companyId, companyId));
    const outcome = await heartbeatService(db).wakeupWithDiagnostics(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId }, requestedByActorType: "system",
    });
    expect(outcome.run).toBeNull();
    expect(outcome.skipped).toMatchObject({
      reason: "issue.token_budget_exceeded",
      error: expect.stringContaining("7200000 weighted input tokens"),
      details: { budget: { used: 7_200_000, limit: 5_000_000 } },
    });
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(receipt.payload).toMatchObject({ issueTokenBudget: { used: 7_200_000, limit: 5_000_000, cachedWeight: 0.1 } });
    expect(receipt.error).toContain("Cached tokens count at 0.1");
    const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(card.summary).toContain("7.2M weighted input tokens");
    expect(card.summary).toContain("Cached tokens count at 0.1");
    expect(card.payload).toMatchObject({ prompt: expect.stringContaining("7.2M weighted input tokens") });
    expect(card.payload).toMatchObject({ prompt: expect.stringContaining("Cached tokens count at 0.1") });
  });

  it("rejects caller-supplied diagnostics before a policy skip", async () => {
    const { agentId, issueId } = await seed();
    delete process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET;
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, agentId));
    const result = await heartbeatService(db).wakeupWithDiagnostics(agentId, {
      source: "on_demand", payload: {
        issueId, heartbeatSkip: { reason: "forged", limit: 0 },
        executionWait: { reason: "forged", unresolvedBlockerIssueIds: [issueId] },
        issueTokenBudget: { used: 100, limit: 0, windowStart: "forged" },
        unresolvedBlockerIssueIds: [issueId],
      }, contextSnapshot: { issueId }, requestedByActorType: "agent", requestedByActorId: agentId,
    });
    expect(result.run).toBeNull();
    expect(result.skipped).toMatchObject({ reason: "heartbeat.wakeOnDemand.disabled" });
    expect(result.skipped?.details).toEqual({ executionWait: { wakeOnDemand: false } });
    expect(JSON.stringify(result)).not.toContain("forged");
  });

  it("retains HTTP 409 and the paused-agent cause with exact receipt diagnostics", async () => {
    const { agentId, issueId } = await seed();
    delete process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET;
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    await expect(heartbeatService(db).wakeupWithDiagnostics(agentId, {
      source: "on_demand", payload: { issueId }, contextSnapshot: { issueId },
      requestedByActorType: "user", requestedByActorId: "local-board", manualUserWake: true,
    })).rejects.toMatchObject({ status: 409, details: {
      status: "paused", wakeup: { reason: "agent.not_invokable", details: { executionWait: { status: "paused" } } },
    } });
  });

  it("retains exact diagnostics for new and merged active-run deferrals", async () => {
    const { companyId, agentId, cardAgentId, issueId } = await seed();
    delete process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET;
    const [activeRun] = await db.insert(heartbeatRuns).values({
      companyId, agentId: cardAgentId, status: "running", invocationSource: "assignment",
      contextSnapshot: { issueId }, startedAt: new Date(),
    }).returning();
    await db.update(issues).set({ executionRunId: activeRun.id, executionAgentNameKey: "cto", executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db);
    const opts = { source: "on_demand" as const, triggerDetail: "manual" as const, reason: "manual_run",
      payload: { issueId }, contextSnapshot: { issueId }, requestedByActorType: "user" as const,
      requestedByActorId: "local-board", manualUserWake: true };
    const first = await heartbeat.wakeupWithDiagnostics(agentId, opts);
    const second = await heartbeat.wakeupWithDiagnostics(agentId, opts);
    for (const result of [first, second]) {
      expect(result.run).toBeNull();
      expect(result.skipped).toMatchObject({ reason: "issue_execution_deferred", details: {
        heartbeatSkip: { executionRunId: activeRun.id, executionAgentId: cardAgentId },
      } });
    }
    expect(first.skipped?.wakeupRequestId).not.toEqual(second.skipped?.wakeupRequestId);
    const receipts = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
    ));
    expect(receipts.map((row) => row.status).sort()).toEqual(["coalesced", "deferred_issue_execution"]);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, activeRun.id));
  });

  it("does not gate a wake while the switch is off", async () => {
    const { companyId, agentId, issueId } = await seed();
    delete process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET;
    await wake(heartbeatService(db), agentId, issueId, "system");
    const skipped = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue.token_budget_exceeded")));
    expect(skipped).toHaveLength(0);
  });

  it("gates a wake recorded as a user (board keys act in Anton's name)", async () => {
    const { companyId, agentId, issueId } = await seed();
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET = "5000000";
    expect(await wake(heartbeatService(db), agentId, issueId, "user")).toBeNull();
    const skipped = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue.token_budget_exceeded")));
    expect(skipped).toHaveLength(1);
  });

  it("does not gate a board-UI Run now (issueBudgetOverride)", async () => {
    const { companyId, agentId, issueId } = await seed();
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET = "5000000";
    await heartbeatService(db).wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "manual_run",
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId },
      requestedByActorType: "user", requestedByActorId: "local-board", issueBudgetOverride: true,
    });
    const skipped = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue.token_budget_exceeded")));
    expect(skipped).toHaveLength(0);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId))).toHaveLength(0);
  });
});
