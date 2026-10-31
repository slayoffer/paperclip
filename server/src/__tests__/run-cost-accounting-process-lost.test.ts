import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import { reconcileRunCosts } from "../services/run-cost-accounting.js";
import { policyBlocks } from "../services/budgets.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// The usage a Codex subscription run had when a restart killed it (2026-10-31):
// its receipt never closed, so the finished run kept the agent's budget hard stop.
const openReceipt = {
  model: "gpt-6.1-sol", biller: "chatgpt", costUsd: null, provider: "openai", costStatus: "unpriced",
  billingType: "subscription_included", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
  usageSource: "per_run", accountingReceiptReady: false, accountingReceiptSequence: 1,
  ledgerScope: { issueId: null, projectId: null, billingCode: null },
};

describe("accounting of runs whose process was lost", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-process-lost-accounting-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(errorCode: string) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Accounting", issuePrefix: `A${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", adapterType: "codex_local" });
    const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agentId,
      metric: "billed_cents", windowKind: "lifetime", amount: 1000, warnPercent: 80, hardStopEnabled: true,
      notifyEnabled: false, isActive: true }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", errorCode,
      invocationSource: "on_demand", runtimeMode: "legacy", costAccountingPending: true,
      startedAt: new Date(), finishedAt: new Date(), usageJson: openReceipt }).returning();
    return { agentId, policy, run };
  }
  const read = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  it("closes the open receipt of a process_lost run and releases the budget hard stop", async () => {
    const { agentId, policy, run } = await fixture("process_lost");
    expect(await policyBlocks(db, policy)).toBe(true);
    await reconcileRunCosts(db);
    expect(await read(run.id)).toMatchObject({ costAccountingPending: false });
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, run.id));
    expect(events).toEqual([expect.objectContaining({ agentId, costCents: 0, billingType: "subscription_included" })]);
    expect(await policyBlocks(db, policy)).toBe(false);
  });

  it("keeps waiting for the receipt of a run that failed for another reason", async () => {
    const { policy, run } = await fixture("adapter_failed");
    await reconcileRunCosts(db);
    expect(await read(run.id)).toMatchObject({ costAccountingPending: true });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, run.id))).toEqual([]);
    expect(await policyBlocks(db, policy)).toBe(true);
  });
});
