import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, agentWakeupRequests, issueThreadInteractions, issueRelations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createHeartbeatPullQueue } from "../services/pull-queue.js";
import { issueService } from "../services/issues.js";
import type { heartbeatService } from "../services/heartbeat.js";

type WakeupOptions = NonNullable<Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1]>;
const support = await getEmbeddedPostgresTestSupport();
const databaseTests = support.supported ? describe : describe.skip;

databaseTests("pull queue skip and parking regressions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  const queues: ReturnType<typeof createHeartbeatPullQueue>[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pull-queue-gap-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "");
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Queue gaps", issuePrefix: `Q${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  });
  afterEach(async () => {
    for (const queue of queues.splice(0)) await queue.stop();
    vi.unstubAllEnvs();
  });
  async function task(values: Partial<typeof issues.$inferInsert> = {}) {
    const [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agentId,
      title: "Ready work", status: "backlog", ...values }).returning();
    return issue;
  }
  async function finishRuns() {
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.companyId, companyId));
  }
  function scheduler() {
    const wakeup = vi.fn(async (_owner: string, options: WakeupOptions): Promise<unknown> => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId,
        nativeIssueId: String(options.payload?.issueId), invocationSource: "assignment", status: "queued",
        contextSnapshot: options.contextSnapshot }).returning();
      return run;
    });
    const queue = createHeartbeatPullQueue(db, { wakeup, isSuppressed: async () => ({ suppressed: false }) });
    queues.push(queue);
    return { queue, wakeup };
  }

  it("starts eligible work behind a budget-exhausted head without repeated skipped wakes", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "100");
    const exhausted = await task({ status: "todo", priority: "critical" });
    const ready = await task({ status: "todo" });
    await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: exhausted.id,
      contextSnapshot: { issueId: exhausted.id }, invocationSource: "assignment", status: "succeeded",
      finishedAt: new Date(), usageJson: { inputTokens: 101 } });
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    expect(wakeup.mock.calls.map(([, opts]) => opts.payload?.issueId)).toEqual([ready.id]);
    await finishRuns();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, ready.id));
    await queue.notify(companyId);
    const restarted = scheduler();
    await restarted.queue.notify(companyId);
    expect(wakeup).toHaveBeenCalledOnce();
    expect(restarted.wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, exhausted.id))).toHaveLength(1);
    // A grant starts a new window. The saved stop must not suppress it.
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date(Date.now() + 1) })
      .where(eq(issueThreadInteractions.issueId, exhausted.id));
    await restarted.queue.notify(companyId);
    expect(restarted.wakeup.mock.calls[0][1].payload?.issueId).toBe(exhausted.id);
  });

  it("continues after an admission skip and suppresses its unchanged receipt across restarts", async () => {
    const head = await task({ priority: "critical" });
    const ready = await task();
    const { queue, wakeup } = scheduler();
    wakeup.mockImplementationOnce(async (_owner, options) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
        status: "skipped", reason: "workspace_worktree_requires_project", payload: options.payload });
      return null;
    });
    await queue.notify(companyId);
    expect(wakeup.mock.calls.map(([, opts]) => opts.payload?.issueId)).toEqual([head.id, ready.id]);
    await finishRuns();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, ready.id));
    const restarted = scheduler();
    await restarted.queue.notify(companyId);
    expect(restarted.wakeup).not.toHaveBeenCalled();
    await db.update(issues).set({ executionWorkspaceSettings: { mode: "shared_workspace" } }).where(eq(issues.id, head.id));
    await restarted.queue.notify(companyId);
    expect(restarted.wakeup.mock.calls[0][1].payload?.issueId).toBe(head.id);
  });

  it("stops selection when a null wake leaves durable queued work", async () => {
    await task({ priority: "critical" });
    await task();
    const { queue, wakeup } = scheduler();
    wakeup.mockImplementationOnce(async (_owner, options) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
        status: "deferred_issue_execution", payload: options.payload });
      return null;
    });
    await queue.notify(companyId);
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it("continues when admission records an issue-specific skip and then throws", async () => {
    const head = await task({ priority: "critical" });
    const ready = await task();
    const { queue, wakeup } = scheduler();
    wakeup.mockImplementationOnce(async (_owner, options) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
        status: "skipped", reason: "budget.blocked", payload: options.payload });
      throw new Error("The issue budget blocked admission");
    });
    await queue.notify(companyId);
    expect(wakeup.mock.calls.map(([, opts]) => opts.payload?.issueId)).toEqual([head.id, ready.id]);
  });

  it("rechecks a skipped candidate when its interaction resolves", async () => {
    const issue = await task({ status: "todo" });
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
      kind: "request_confirmation", status: "rejected", payload: { version: 1, prompt: "Continue?" } }).returning();
    const { queue, wakeup } = scheduler();
    wakeup.mockImplementationOnce(async (_owner, options) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
        status: "skipped", reason: "execution_confirmation_required", payload: options.payload });
      return null;
    });
    await queue.notify(companyId);
    await queue.notify(companyId);
    expect(wakeup).toHaveBeenCalledOnce();
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date() })
      .where(eq(issueThreadInteractions.id, card.id));
    await queue.notify(companyId);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("rechecks dependencies after a racing blocker completes", async () => {
    const issue = await task({ status: "todo" });
    const blocker = await task({ status: "in_progress", assigneeAgentId: null });
    const { queue, wakeup } = scheduler();
    wakeup.mockImplementationOnce(async (_owner, options) => {
      await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: issue.id, type: "blocks" });
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
        status: "skipped", reason: "issue_dependencies_blocked", payload: options.payload });
      return null;
    });
    await queue.notify(companyId);
    await queue.notify(companyId);
    expect(wakeup).toHaveBeenCalledOnce();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blocker.id));
    await queue.notify(companyId);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("rechecks an old wake-policy skip without a fingerprint when policy changes", async () => {
    const issue = await task({ status: "todo" });
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, agentId));
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
      status: "skipped", reason: "heartbeat.wakeOnDemand.disabled", payload: { issueId: issue.id } });
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    expect(wakeup).not.toHaveBeenCalled();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, agentId));
    await queue.notify(companyId);
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it("keeps a backlog disposition parked until its wait changes, including after restart", async () => {
    const parked = await task({ status: "in_progress", priority: "critical" });
    const wait = { owner: "board" as const, action: "Wait for the vendor response" };
    await issueService(db).update(parked.id, { status: "backlog", unblockDescriptor: wait });
    const ready = await task();
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    expect(wakeup.mock.calls.map(([, opts]) => opts.payload?.issueId)).toEqual([ready.id]);
    await finishRuns();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, ready.id));
    // Ordinary metadata and comment activity cannot turn the same wait into work.
    await issueService(db).update(parked.id, { title: "Updated title" });
    const restarted = scheduler();
    await restarted.queue.notify(companyId);
    expect(restarted.wakeup).not.toHaveBeenCalled();
    await issueService(db).update(parked.id, { unblockDescriptor: { ...wait, action: "Vendor replied; validate the result" } });
    await restarted.queue.notify(companyId);
    expect(restarted.wakeup.mock.calls[0][1].payload?.issueId).toBe(parked.id);
  });

  it("honors a same-status backlog park and an explicit todo resume", async () => {
    const parked = await task();
    await issueService(db).update(parked.id, { status: "backlog" });
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    expect(wakeup).not.toHaveBeenCalled();
    await issueService(db).update(parked.id, { status: "todo" });
    await queue.notify(companyId);
    expect(wakeup.mock.calls[0][1].payload?.issueId).toBe(parked.id);
  });

  it("rolls back the parking receipt with its status transaction", async () => {
    const issue = await task({ status: "todo" });
    await expect(db.transaction(async (tx) => {
      await issueService(db).update(issue.id, { status: "backlog" }, tx);
      throw new Error("Abort the disposition");
    })).rejects.toThrow("Abort the disposition");
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    expect(wakeup).toHaveBeenCalledOnce();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
  });

  it("protects legacy backlog work after a completed run without blocking a new owner", async () => {
    const parked = await task({ priority: "critical" });
    await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: parked.id,
      invocationSource: "assignment", status: "succeeded", finishedAt: new Date() });
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    await queue.notify(companyId);
    expect(wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "pull_queue.parked"),
    ))).toHaveLength(1);
    const newOwner = randomUUID();
    await db.insert(agents).values({ id: newOwner, companyId, name: "New owner", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await issueService(db).update(parked.id, { assigneeAgentId: newOwner });
    await queue.notify(companyId);
    expect(wakeup.mock.calls[0][0]).toBe(newOwner);
  });

  it("does not suppress a timed skip after its deadline", async () => {
    const head = await task({ status: "todo" });
    const { queue, wakeup } = scheduler();
    wakeup.mockImplementationOnce(async (_owner, options) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
        status: "skipped", reason: "issue_rewake_throttled", payload: { ...options.payload,
          heartbeatSkip: { nextAllowedAt: new Date(Date.now() + 60_000).toISOString() } } });
      return null;
    });
    await queue.notify(companyId);
    await queue.notify(companyId);
    expect(wakeup).toHaveBeenCalledOnce();
    await db.update(agentWakeupRequests).set({ payload: { ...wakeup.mock.calls[0][1].payload,
      heartbeatSkip: { nextAllowedAt: new Date(Date.now() - 1).toISOString() } } })
      .where(eq(agentWakeupRequests.companyId, companyId));
    await queue.notify(companyId);
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(wakeup.mock.calls[1][1].payload?.issueId).toBe(head.id);
  });
});
