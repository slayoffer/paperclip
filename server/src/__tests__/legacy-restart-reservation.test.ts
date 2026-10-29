import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetReservations, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { reserveRunBudget } from "../services/budget-reservations.js";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";

// Synthiq fork: a legacy restart resume reuses the hold of its own run. It never reserves twice.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("legacy restart budget reservation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const sessionId = "01234567-89ab-4cde-8f01-23456789abcd";
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-restart-reservation-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    await db.transaction(async (tx) => {
      // Publication request history rejects TRUNCATE. Reset with triggers off.
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`TRUNCATE companies CASCADE`);
    });
  });
  afterAll(async () => { await database?.cleanup(); });

  async function dispatchedRun(restartRecovery: Record<string, unknown> | null, bootId = legacyControllerBootId) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Legacy restart", issuePrefix: `LR${companyId.slice(0, 4)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "running",
      runtimeMode: "legacy", controllerBootId: bootId, resultJson: restartRecovery ? { restartRecovery } : null });
    const first = await reserveRunBudget(db, companyId, runId, null);
    expect(first.reused).toBe(false);
    return { companyId, runId };
  }
  const holds = async (companyId: string, runId: string) => db.select().from(budgetReservations)
    .where(and(eq(budgetReservations.companyId, companyId), eq(budgetReservations.runId, runId)));

  it("reuses the original hold for the same run's current restart claim", async () => {
    const { companyId, runId } = await dispatchedRun({ outcome: "resuming", attempt: 1, sessionId });
    const second = await reserveRunBudget(db, companyId, runId, null, {}, undefined, sessionId);
    expect(second.reused).toBe(true);
    expect(await holds(companyId, runId)).toHaveLength(1);
  });

  it.each([
    ["no restart claim", null, sessionId, undefined],
    ["a claim for another session", { outcome: "resuming", attempt: 1, sessionId: randomUUID() }, sessionId, undefined],
    ["a finished claim", { outcome: "reconciliation", attempt: 1, sessionId }, sessionId, undefined],
    ["a claim held by another controller", { outcome: "resuming", attempt: 1, sessionId }, sessionId, randomUUID()],
    ["a dispatch without the restart session", { outcome: "resuming", attempt: 1, sessionId }, null, undefined],
  ] as const)("refuses a second dispatch with %s", async (_label, claim, requested, bootId) => {
    const { companyId, runId } = await dispatchedRun(claim, bootId);
    await expect(reserveRunBudget(db, companyId, runId, null, {}, undefined, requested))
      .rejects.toThrow("Provider dispatch has already reserved this run");
    expect(await holds(companyId, runId)).toHaveLength(1);
  });
});
