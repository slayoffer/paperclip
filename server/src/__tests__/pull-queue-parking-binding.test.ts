import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, agentWakeupRequests, activityLog } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pullQueueCandidateBlocked } from "../services/pull-queue-state.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)('backlog parking canonical history', () => {
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

  it.each(["first-class", "native", "conflict", "no-decision"])("requires canonical prior work and explicit parking for %s", async kind => {
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "");
    const f = await fixture("backlog");
    const began = new Date(Date.now() - 60_000);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      nativeIssueId: kind === "native" ? f.issueId : null,
      issueId: kind === "native" ? null : kind === "conflict" ? f.otherIssueId : f.issueId,
      contextSnapshot: kind === "conflict" ? { issueId: f.issueId } : {},
      createdAt: began, startedAt: began, finishedAt: began,
    });
    if (kind !== "no-decision") await db.insert(activityLog).values({ companyId: f.companyId,
      actorType: "system", actorId: "fixture", action: "issue.updated", entityType: "issue", entityId: f.issueId,
      details: { status: "backlog" }, createdAt: new Date() });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(await pullQueueCandidateBlocked(db, issue, agent, "fixture-fingerprint"))
      .toBe(kind === "first-class" || kind === "native");
    const receipts = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.reason, "pull_queue.parked")));
    expect(receipts).toHaveLength(kind === "first-class" || kind === "native" ? 1 : 0);
  });

});
