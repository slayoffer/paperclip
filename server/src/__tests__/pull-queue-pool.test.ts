import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, companyMemberships, createDb,
  heartbeatRuns, issues, issueThreadInteractions,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createHeartbeatPullQueue } from "../services/pull-queue.js";
import { taskDrainService } from "../services/task-drain.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseTests = support.supported ? describe : describe.skip;

databaseTests("pull queue with one ordinary database connection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const schedulers: ReturnType<typeof createHeartbeatPullQueue>[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pull-pool-");
  }, 60_000);
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", "1");
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "5000000");
    db = createDb(database.connectionString, { maxConnections: 1 });
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pull pool", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: `owner-${companyId}`,
      status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {} });
    const occupiedAgentId = randomUUID();
    await db.insert(agents).values({ id: occupiedAgentId, companyId, name: "Occupied", role: "engineer",
      status: "running", adapterType: "process" });
    // Normal admission persists the run, but the occupied instance slot prevents adapter startup.
    await db.insert(heartbeatRuns).values({ companyId, agentId: occupiedAgentId, status: "running" });
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation((callback, config) => transaction(async (tx) => {
      // Bound the pre-fix pool deadlock without replacing any query or admission logic.
      await tx.execute(sql`set local idle_in_transaction_session_timeout = '5s'`);
      return callback(tx);
    }, config));
    vi.spyOn(logger, "error");
  });
  afterEach(async () => {
    for (const scheduler of schedulers.splice(0)) await scheduler.stop();
    vi.restoreAllMocks();
    await db.$client.end({ timeout: 1 });
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await database?.cleanup(); });

  async function task(priority: string = "medium") {
    const [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agentId,
      title: "Ready work", status: "todo", priority }).returning();
    return issue;
  }
  function scheduler() {
    const wakeup = vi.fn(heartbeat.wakeup);
    const isSuppressed = vi.fn(() => heartbeat.resolveSchedulingSuppression());
    const queue = createHeartbeatPullQueue(db, { wakeup, isSuppressed });
    schedulers.push(queue);
    return { queue, wakeup, isSuppressed };
  }
  async function expectQueued(issueId: string) {
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.filter((run) => run.status === "queued")).toEqual([
      expect.objectContaining({ contextSnapshot: expect.objectContaining({ issueId }) }),
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  }

  it("keeps real suppression and admission responsive while two schedulers select one task", async () => {
    const issue = await task();
    const first = scheduler();
    const second = scheduler();
    await Promise.all([first.queue.notify(companyId), second.queue.notify(companyId)]);
    expect(first.wakeup.mock.calls.length + second.wakeup.mock.calls.length).toBe(1);
    expect(first.isSuppressed.mock.calls.length + second.isSuppressed.mock.calls.length).toBeGreaterThan(2);
    await expectQueued(issue.id);
  });

  it("honors the durable drain and admits after its exact lease is released", async () => {
    const issue = await task();
    const drain = taskDrainService(db);
    const audit = async () => {};
    const lease = await drain.acquire("pull-pool-test", {}, audit);
    const { queue, wakeup } = scheduler();
    try {
      await queue.notify(companyId);
      expect(wakeup).not.toHaveBeenCalled();
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
    } finally {
      await drain.release("pull-pool-test", lease.leaseId, audit);
    }
    await queue.notify(companyId);
    expect(wakeup).toHaveBeenCalledOnce();
    await expectQueued(issue.id);
  });

  it("continues to a ready candidate after the budget gate holds the first candidate", async () => {
    const held = await task("critical");
    const ready = await task();
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", nativeIssueId: held.id,
      finishedAt: new Date(), usageJson: { inputTokens: 6_000_000 }, contextSnapshot: { issueId: held.id } });
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    expect(wakeup.mock.calls.map(([, options]) => options?.payload?.issueId)).toEqual([ready.id]);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, held.id))).toHaveLength(1);
    await expectQueued(ready.id);
  });

  it("continues after real admission skips a candidate changed after selection", async () => {
    const changed = await task("critical");
    const ready = await task();
    const { queue, wakeup } = scheduler();
    wakeup.mockImplementationOnce(async (owner, options) => {
      await db.update(issues).set({ statusVersion: sql`${issues.statusVersion} + 1` })
        .where(eq(issues.id, changed.id));
      return heartbeat.wakeup(owner, options);
    });
    await queue.notify(companyId);
    expect(wakeup.mock.calls.map(([, options]) => options?.payload?.issueId)).toEqual([changed.id, ready.id]);
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(receipts).toContainEqual(expect.objectContaining({ status: "skipped", reason: "issue_state_guard_mismatch",
      payload: expect.objectContaining({ issueId: changed.id }) }));
    await expectQueued(ready.id);
  });
});
