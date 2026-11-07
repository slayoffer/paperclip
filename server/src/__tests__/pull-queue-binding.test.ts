import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { alias } from "drizzle-orm/pg-core";
import { boundRunIssueId, boundRunIssueIdSql } from "../services/run-task-binding.js";
import { issueHasExecution } from "../services/pull-queue-policy.js";
import { createHeartbeatPullQueue } from "../services/pull-queue.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)('pull queue canonical SQL binding', () => {
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

  it.each(["native", "first-class", "snapshot", "task", "first-class-conflict", "native-conflict", "blank", "invalid"])(
    "keeps aliased SQL and loaded bindings equal for %s", async (kind) => {
      const f = await fixture();
      const native = kind === "native" || kind === "native-conflict";
      const firstClass = kind === "first-class" || kind === "first-class-conflict";
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
        nativeIssueId: native ? f.issueId : null,
        issueId: firstClass ? f.issueId : kind === "native-conflict" ? f.otherIssueId : null,
        contextSnapshot: kind === "snapshot" ? { issueId: ` ${f.issueId} ` }
          : kind === "task" ? { taskId: f.issueId }
          : kind === "blank" ? { issueId: " ", taskId: f.issueId }
          : kind === "invalid" ? { issueId: 42, taskId: f.issueId }
          : kind.endsWith("conflict") ? { issueId: f.otherIssueId, taskId: f.otherIssueId } : {},
      }).returning();
      const r = alias(heartbeatRuns, "binding_run");
      const [row] = await db.select({ issueId: boundRunIssueIdSql(r) }).from(r).where(eq(r.id, run.id));
      expect(row.issueId).toBe(boundRunIssueId(run));
      expect(row.issueId).toBe(f.issueId);
      const rows = await db.select({ id: issues.id, executing: issueHasExecution() }).from(issues)
        .where(eq(issues.companyId, f.companyId));
      expect(rows.find((item) => item.id === f.issueId)?.executing).toBe(true);
      expect(rows.find((item) => item.id === f.otherIssueId)?.executing).toBe(false);
    },
  );

  it("keeps recent first-class work out of ghost release", async () => {
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    const f = await fixture();
    const now = new Date();
    await db.update(issues).set({ updatedAt: new Date(now.getTime() - 3_600_000) }).where(eq(issues.companyId, f.companyId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      issueId: f.issueId, contextSnapshot: { issueId: f.otherIssueId }, finishedAt: now, updatedAt: now });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const queue = createHeartbeatPullQueue(db, { wakeup: vi.fn(), isSuppressed: async () => ({ suppressed: false }) });
    try { await queue.reconcile(now); } finally { await queue.stop(); }
    const rows = await db.select().from(issues).where(eq(issues.companyId, f.companyId));
    expect(rows.find((row) => row.id === f.issueId)?.status).toBe("in_progress");
    expect(rows.find((row) => row.id === f.otherIssueId)?.status).toBe("todo");
  });

});
