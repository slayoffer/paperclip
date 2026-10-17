import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueThreadInteractions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  ensureIssueTokenBudgetCard,
  issueTokenBudgetConfig,
  issueTokenBudgetWindowStart,
  loadIssueTokenBudgetState,
} from "./issue-token-budget.js";

describe("issue token budget config", () => {
  it("is off without a positive budget", () => {
    expect(issueTokenBudgetConfig({})).toBeNull();
    expect(issueTokenBudgetConfig({ PAPERCLIP_ISSUE_TOKEN_BUDGET: "0" })).toBeNull();
    expect(issueTokenBudgetConfig({ PAPERCLIP_ISSUE_TOKEN_BUDGET: "5M" })).toBeNull();
  });

  it("reads the budget, the go-live time and a valid card agent id", () => {
    const agent = randomUUID();
    expect(issueTokenBudgetConfig({
      PAPERCLIP_ISSUE_TOKEN_BUDGET: "5000000",
      PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE: "2026-10-17T06:00:00Z",
      PAPERCLIP_ISSUE_TOKEN_BUDGET_CARD_AGENT_ID: agent,
    })).toEqual({ budget: 5_000_000, since: new Date("2026-10-17T06:00:00Z"), cardAgentId: agent });
    expect(issueTokenBudgetConfig({ PAPERCLIP_ISSUE_TOKEN_BUDGET: "5", PAPERCLIP_ISSUE_TOKEN_BUDGET_CARD_AGENT_ID: "cto" })?.cardAgentId).toBeNull();
  });

  it("starts the window at go-live, a later grant, or 24 hours back", () => {
    const now = new Date("2026-10-18T00:00:00Z");
    const since = new Date("2026-10-17T06:00:00Z");
    expect(issueTokenBudgetWindowStart({ budget: 1, since, cardAgentId: null }, null, now)).toEqual(since);
    expect(issueTokenBudgetWindowStart({ budget: 1, since, cardAgentId: null }, new Date("2026-10-17T09:00:00Z"), now))
      .toEqual(new Date("2026-10-17T09:00:00Z"));
    expect(issueTokenBudgetWindowStart({ budget: 1, since: null, cardAgentId: null }, null, now))
      .toEqual(new Date("2026-10-17T00:00:00Z"));
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("issue token budget state and card", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
  const since = new Date("2026-10-17T06:00:00Z");
  const now = new Date("2026-10-17T12:00:00Z");
  const config = { budget: 5_000_000, since, cardAgentId: null as string | null };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-token-budget-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Budget", issuePrefix: "BUD" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Spender", role: "engineer", adapterType: "paperclip_runner" });
    config.cardAgentId = agentId;
    await db.insert(issues).values({ id: issueId, companyId, title: "Expensive", status: "todo", assigneeAgentId: agentId });
    const run = (hour: number, inputTokens: unknown) => ({
      companyId, agentId, status: "succeeded",
      contextSnapshot: { issueId }, usageJson: { inputTokens },
      createdAt: new Date(Date.UTC(2026, 9, 17, hour)),
    });
    await db.insert(heartbeatRuns).values([run(1, 9_000_000), run(7, 2_000_000), run(8, 2_500_000), run(9, "bad")]);
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup();
  });

  it("counts only runs since go-live and stays under the budget", async () => {
    const state = await loadIssueTokenBudgetState(db, { companyId, issueId, config, now });
    expect(state).toEqual({ spent: 4_500_000, windowStart: since, exceeded: false });
  });

  it("raises exactly one card per window once exceeded, and a granted card opens a new window", async () => {
    await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "succeeded", contextSnapshot: { issueId }, usageJson: { inputTokens: 600_000 },
      createdAt: new Date("2026-10-17T10:00:00Z"),
    });
    const state = await loadIssueTokenBudgetState(db, { companyId, issueId, config, now });
    expect(state.exceeded).toBe(true);
    expect(await ensureIssueTokenBudgetCard(db, { companyId, issueId, config, state })).toBe(true);
    expect(await ensureIssueTokenBudgetCard(db, { companyId, issueId, config, state })).toBe(false);
    const cards = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "request_confirmation", status: "pending", addresseeAgentId: agentId });

    await db.update(issueThreadInteractions)
      .set({ status: "accepted", resolvedAt: new Date("2026-10-17T11:00:00Z") })
      .where(eq(issueThreadInteractions.id, cards[0]!.id));
    const after = await loadIssueTokenBudgetState(db, { companyId, issueId, config, now });
    expect(after).toEqual({ spent: 0, windowStart: new Date("2026-10-17T11:00:00Z"), exceeded: false });
  });
});
