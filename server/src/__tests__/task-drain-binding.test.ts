import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, agentWakeupRequests } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { releaseRunClaimedJustBeforeSuppression } from "../services/heartbeat-task-drain-admission.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)('drain canonical lock release', () => {
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

  it.each(["first-class", "native", "task", "changed-lock"])("releases only the canonical exact lock for %s", async kind => {
    const f = await fixture();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "assignment", status: "claimed", claimedAt: new Date() }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", wakeupRequestId: wake.id, startedAt: new Date(),
      nativeIssueId: kind === "native" ? f.issueId : null,
      issueId: kind === "native" ? f.otherIssueId : kind === "task" ? null : f.issueId,
      contextSnapshot: kind === "task" ? { taskId: f.issueId } : { issueId: f.otherIssueId },
    }).returning();
    const [replacement] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", issueId: f.issueId }).returning();
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.companyId, f.companyId));
    if (kind === "changed-lock") await db.update(issues).set({ executionRunId: replacement.id }).where(eq(issues.id, f.issueId));
    await releaseRunClaimedJustBeforeSuppression(db, run.id);
    const rows = await db.select().from(issues).where(eq(issues.companyId, f.companyId));
    expect(rows.find((row) => row.id === f.issueId)?.executionRunId).toBe(kind === "changed-lock" ? replacement.id : null);
    expect(rows.find((row) => row.id === f.otherIssueId)?.executionRunId).toBe(run.id);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0])
      .toMatchObject({ status: "queued", startedAt: null, responsibleUserId: null });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0])
      .toMatchObject({ status: "queued", claimedAt: null });
  });

});
