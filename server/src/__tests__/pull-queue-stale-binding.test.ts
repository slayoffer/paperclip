import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, agentWakeupRequests } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createHeartbeatPullQueue } from "../services/pull-queue.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)('closed issue deferred receipt canonical binding', () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-binding-regression-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  async function fixture(status = "in_progress") {
    const companyId = randomUUID(), agentId = randomUUID();
    const issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Binding fixture", issuePrefix: `B${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "idle", adapterType: "process" });
    await db.insert(issues).values([issueId, otherIssueId].map((id) => ({
      id, companyId, title: "Binding task", status, assigneeAgentId: agentId,
    })));
    return { companyId, agentId, issueId, otherIssueId };
  }

  it.each(["first-class", "native", "conflict", "recent-close"])("retains a closed issue receipt for live work or a recent close: %s", async kind => {
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    const f = await fixture("done");
    if (kind !== "recent-close") await db.update(issues).set({ updatedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(issues.id, f.issueId));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", status: "deferred_issue_execution", payload: { issueId: f.issueId },
      updatedAt: new Date(Date.now() - 3_600_000) }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      nativeIssueId: kind === "native" ? f.issueId : null,
      issueId: kind === "native" ? null : ["conflict", "recent-close"].includes(kind) ? f.otherIssueId : f.issueId,
      contextSnapshot: ["conflict", "recent-close"].includes(kind) ? { issueId: f.issueId } : {},
    });
    const queue = createHeartbeatPullQueue(db, { wakeup: vi.fn(), isSuppressed: async () => ({ suppressed: false }) });
    try { await queue.reconcile(); } finally { await queue.stop(); }
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0]?.status)
      .toBe(kind === "conflict" ? "cancelled" : "deferred_issue_execution");
  });

});
