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
const BUDGET_ENV = ["PAPERCLIP_ISSUE_TOKEN_BUDGET", "PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE", "PAPERCLIP_ISSUE_TOKEN_BUDGET_CARD_AGENT_ID"];

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

    expect(await wake(heartbeat, agentId, issueId, "system")).toBeNull();
    expect(await wake(heartbeat, agentId, issueId, "system")).toBeNull();

    const skipped = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue.token_budget_exceeded")));
    expect(skipped).toHaveLength(2);
    expect(skipped.every((row) => row.status === "skipped")).toBe(true);
    const cards = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: "pending", addresseeAgentId: cardAgentId });
  });

  it("does not gate a wake while the switch is off", async () => {
    const { companyId, agentId, issueId } = await seed();
    delete process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET;
    await wake(heartbeatService(db), agentId, issueId, "system");
    const skipped = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue.token_budget_exceeded")));
    expect(skipped).toHaveLength(0);
  });

  it("does not gate a wake requested by a person", async () => {
    const { companyId, agentId, issueId } = await seed();
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET = "5000000";
    await wake(heartbeatService(db), agentId, issueId, "user");
    const skipped = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue.token_budget_exceeded")));
    expect(skipped).toHaveLength(0);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId))).toHaveLength(0);
  });
});
