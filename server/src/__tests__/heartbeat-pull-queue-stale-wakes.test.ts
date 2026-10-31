import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, agentWakeupRequests } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createHeartbeatPullQueue } from "../services/pull-queue.js";
import type { heartbeatService } from "../services/heartbeat.js";

type WakeupOptions = NonNullable<Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1]>;
const support = await getEmbeddedPostgresTestSupport();
const databaseTests = support.supported ? describe : describe.skip;

// SYNA-1936: a deferred receipt for finished or reassigned work held 16 live
// owners out of selection for up to 32 days.
databaseTests("pull queue slot accounting for deferred wakes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let otherAgentId: string;
  const queues: ReturnType<typeof createHeartbeatPullQueue>[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pull-queue-stale-wakes-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "");
    companyId = randomUUID();
    agentId = randomUUID();
    otherAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stale wakes", issuePrefix: `S${companyId.slice(0, 6)}` });
    for (const [id, name] of [[agentId, "Owner"], [otherAgentId, "Other owner"]]) {
      await db.insert(agents).values({ id, companyId, name, role: "engineer", status: "idle",
        adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    }
  });
  afterEach(async () => {
    for (const queue of queues.splice(0)) await queue.stop();
    vi.unstubAllEnvs();
  });
  async function task(values: Partial<typeof issues.$inferInsert> = {}) {
    const [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agentId,
      title: "Work", status: "todo", ...values }).returning();
    return issue;
  }
  async function wake(issueId: string, status = "deferred_issue_execution", updatedAt = new Date()) {
    const [row] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
      reason: "issue_assigned", status, payload: { issueId }, updatedAt }).returning();
    return row;
  }
  async function wakeStatus(id: string) {
    const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id));
    return row.status;
  }
  function scheduler(admit: (options: WakeupOptions) => boolean = () => true) {
    const wakeup = vi.fn(async (owner: string, options: WakeupOptions): Promise<unknown> => {
      if (!admit(options)) return null;
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: owner,
        nativeIssueId: String(options.payload?.issueId), invocationSource: "assignment", status: "queued",
        contextSnapshot: options.contextSnapshot }).returning();
      return run;
    });
    const queue = createHeartbeatPullQueue(db, { wakeup, isSuppressed: async () => ({ suppressed: false }) });
    queues.push(queue);
    return { queue, wakeup };
  }

  it("starts ready work when deferred wakes belong to done, cancelled, or reassigned tasks", async () => {
    await wake((await task({ status: "done" })).id);
    await wake((await task({ status: "cancelled" })).id);
    await wake((await task({ status: "in_progress", assigneeAgentId: otherAgentId })).id);
    await wake(randomUUID());
    const ready = await task({ priority: "high" });
    const { queue, wakeup } = scheduler();

    await queue.notify(companyId);

    expect(wakeup).toHaveBeenCalledOnce();
    expect(wakeup.mock.calls[0][0]).toBe(agentId);
    expect(wakeup.mock.calls[0][1].payload?.issueId).toBe(ready.id);
  });

  it("keeps the slot for a deferred wake on an open owned task and for any queued wake", async () => {
    const waiting = await task({ status: "in_progress" });
    await wake(waiting.id);
    await task();
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    expect(wakeup).not.toHaveBeenCalled();

    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    await wake((await task({ status: "done" })).id, "queued");
    await queue.notify(companyId);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("tries the next candidate after a null admission when only stale deferred wakes remain", async () => {
    await wake((await task({ status: "done" })).id);
    const first = await task({ priority: "critical" });
    const second = await task({ priority: "low" });
    const { queue, wakeup } = scheduler((options) => options.payload?.issueId !== first.id);

    await queue.notify(companyId);

    expect(wakeup.mock.calls.map(([, options]) => options.payload?.issueId)).toEqual([first.id, second.id]);
  });

  // SYNA-3586: nothing drains a deferred wake once its closed issue has no execution left.
  it("reconcile cancels a stale deferred wake only on a closed issue with no execution left", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 60 * 60_000);
    const done = await wake((await task({ status: "done" })).id, "deferred_issue_execution", old);
    const cancelled = await wake((await task({ status: "cancelled" })).id, "deferred_issue_execution", old);
    const fresh = await wake((await task({ status: "done" })).id);
    const open = await wake((await task({ status: "in_progress" })).id, "deferred_issue_execution", old);
    const lockedIssue = await task({ status: "done" });
    const [lockRun] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: lockedIssue.id,
      invocationSource: "assignment", status: "running" }).returning();
    await db.update(issues).set({ executionRunId: lockRun.id }).where(eq(issues.id, lockedIssue.id));
    const locked = await wake(lockedIssue.id, "deferred_issue_execution", old);
    const queued = await wake((await task({ status: "done" })).id, "queued", old);
    const { queue } = scheduler();

    await queue.reconcile(now);

    expect(await wakeStatus(done.id)).toBe("cancelled");
    expect(await wakeStatus(cancelled.id)).toBe("cancelled");
    for (const kept of [fresh, open, locked]) expect(await wakeStatus(kept.id)).toBe("deferred_issue_execution");
    expect(await wakeStatus(queued.id)).toBe("queued");
  });
});

