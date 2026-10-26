import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, issueComments, issueRelations,
  issueThreadInteractions, issues, agentWakeupRequests,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createHeartbeatPullQueue, isPullQueueSignal } from "../services/pull-queue.js";
import { countsTowardPullQueueWip } from "../services/pull-queue-policy.js";
import { countAgentActiveIssues } from "../services/agent-wip-limit.js";
import { issueService } from "../services/issues.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { heartbeatService } from "../services/heartbeat.js";
import type { LiveEvent } from "@paperclipai/shared";

type WakeupOptions = NonNullable<Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1]>;

const support = await getEmbeddedPostgresTestSupport();
const databaseTests = support.supported ? describe : describe.skip;

databaseTests("event-driven pull queue", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  const schedulers: ReturnType<typeof createHeartbeatPullQueue>[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pull-queue-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pull queue", issuePrefix: `Q${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  });
  afterEach(async () => {
    for (const scheduler of schedulers.splice(0)) await scheduler.stop();
    vi.unstubAllEnvs();
  });

  async function task(values: Partial<typeof issues.$inferInsert> = {}) {
    const [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agentId,
      title: "Ready work", status: "backlog", ...values }).returning();
    return issue;
  }
  async function run(issueId: string, values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issueId,
      invocationSource: "assignment", status: "running", contextSnapshot: { issueId }, ...values }).returning();
    return row;
  }
  function scheduler(suppressed = false) {
    const wakeup = vi.fn(async (owner: string, options: WakeupOptions) => {
      await db.insert(heartbeatRuns).values({ companyId, agentId: owner, nativeIssueId: String(options.payload?.issueId),
        invocationSource: "assignment", status: "queued",
        contextSnapshot: options.contextSnapshot });
      return { queued: true };
    });
    const queue = createHeartbeatPullQueue(db, { wakeup, isSuppressed: async () => ({ suppressed }) });
    schedulers.push(queue);
    return { queue, wakeup };
  }

  it("selects the highest priority and then the oldest ready task", async () => {
    await task({ priority: "low", createdAt: new Date("2026-01-01") });
    await task({ priority: "high", createdAt: new Date("2026-03-01") });
    const selected = await task({ priority: "high", createdAt: new Date("2026-02-01") });
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    expect(wakeup).toHaveBeenCalledOnce();
    expect(wakeup.mock.calls[0][1]).toMatchObject({ payload: { issueId: selected.id },
      issueStateGuard: { statuses: ["backlog"], statusVersion: selected.statusVersion, assigneeAgentId: agentId } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, selected.id))).toHaveLength(1);
  });

  it("starts ready work when the previous run ends", async () => {
    const previous = await task({ status: "in_progress" });
    const active = await run(previous.id);
    const next = await task();
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    expect(wakeup).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, active.id));
    await queue.notify(companyId);
    expect(wakeup.mock.calls[0][1].payload?.issueId).toBe(next.id);
  });

  it("skips open blockers and pending cards, and resolves cancelled blockers without the switch", async () => {
    const blocker = await task({ status: "in_progress", assigneeAgentId: null });
    const dependent = await task({ priority: "critical" });
    await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: dependent.id, type: "blocks" });
    const cardTask = await task({ priority: "high" });
    await db.insert(issueThreadInteractions).values({ companyId, issueId: cardTask.id, kind: "request_confirmation",
      payload: { version: 1, prompt: "Approve?" } });
    const next = await task();
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    expect(wakeup.mock.calls[0][1].payload?.issueId).toBe(next.id);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, next.id));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, next.id));
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, blocker.id));
    const svc = issueService(db);
    expect((await svc.listWakeableBlockedDependents(blocker.id)).map((row) => row.id)).toEqual([dependent.id]);
    await queue.notify(companyId);
    expect(wakeup.mock.calls[1][1].payload?.issueId).toBe(dependent.id);
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "false");
    expect((await svc.getDependencyReadiness(dependent.id)).isDependencyReady).toBe(true);
    expect(await svc.listWakeableBlockedDependents(blocker.id)).toEqual([]);
  });

  it("wakes backlog dependents when their final blocker completes", async () => {
    const blocker = await task({ status: "todo", assigneeAgentId: null });
    const dependent = await task();
    await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: dependent.id, type: "blocks" });
    const svc = issueService(db);
    expect(await svc.listWakeableBlockedDependents(blocker.id)).toEqual([]);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blocker.id));
    expect((await svc.listWakeableBlockedDependents(blocker.id)).map((row) => row.id)).toEqual([dependent.id]);
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "false");
    expect(await svc.listWakeableBlockedDependents(blocker.id)).toEqual([]);
  });

  it("does not count scheduled waits or inactive in_progress tasks toward the work limit", async () => {
    await task({ status: "blocked" });
    await task({ status: "blocked" });
    await task({ status: "in_progress", monitorNextCheckAt: new Date(Date.now() + 3_600_000) });
    await task({ status: "blocked", monitorNextCheckAt: new Date(Date.now() + 3_600_000) });
    await task({ status: "in_progress" });
    const next = await task();
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    expect(await countAgentActiveIssues(db, { companyId, agentId })).toBe(2);
    expect(wakeup.mock.calls[0][1].payload?.issueId).toBe(next.id);
  });

  it("keeps backlog work pending at the work limit but runs an admitted todo task", async () => {
    await task({ status: "blocked" });
    await task({ status: "blocked" });
    await task({ status: "blocked" });
    await task({ priority: "critical" });
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    expect(wakeup).not.toHaveBeenCalled();
    const todo = await task({ status: "todo" });
    await queue.notify(companyId);
    expect(wakeup.mock.calls[0][1].payload?.issueId).toBe(todo.id);
  });

  it("uses the configured work limit and company boundary", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_WIP_LIMIT", "1");
    await task({ status: "blocked" });
    await task();
    const { queue, wakeup } = scheduler();
    await queue.notify(randomUUID());
    await queue.notify(companyId);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("counts task execution consistently for assignment and selection", async () => {
    await task({ status: "todo" });
    await task({ status: "blocked" });
    await task({ status: "blocked", monitorNextCheckAt: new Date() });
    await task({ status: "in_progress" });
    const running = await task({ status: "in_progress" });
    await run(running.id, { status: "scheduled_retry" });
    const queued = await task({ status: "in_progress" });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
      status: "deferred_issue_execution", payload: { issueId: queued.id } });
    expect(await countAgentActiveIssues(db, { companyId, agentId })).toBe(4);
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "false");
    expect(await countAgentActiveIssues(db, { companyId, agentId })).toBe(6);
  });

  it("checks the issue token budget before heartbeat admission", async () => {
    const issue = await task({ status: "todo" });
    await run(issue.id, { status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 6_000_000 } });
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "5000000");
    const heartbeat = heartbeatService(db);
    const queue = createHeartbeatPullQueue(db, { wakeup: heartbeat.wakeup,
      isSuppressed: async () => ({ suppressed: false }) });
    schedulers.push(queue);
    await queue.notify(companyId);
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(receipts).toEqual([]);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issue.id))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
  });

  it("serializes competing schedulers with a database lock", async () => {
    await task();
    const first = scheduler();
    const second = scheduler();
    await Promise.all([first.queue.notify(companyId), second.queue.notify(companyId)]);
    expect(first.wakeup.mock.calls.length + second.wakeup.mock.calls.length).toBe(1);
  });

  it("continues with healthy owners after an admission error and retries the failed owner", async () => {
    const otherOwner = randomUUID();
    await db.insert(agents).values({ id: otherOwner, companyId, name: "Other owner", role: "engineer",
      status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await task();
    await task({ assigneeAgentId: otherOwner });
    const { queue, wakeup } = scheduler();
    wakeup.mockRejectedValueOnce(new Error("Admission failed"));

    await queue.notify(companyId);

    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(new Set(wakeup.mock.calls.map(([owner]) => owner))).toEqual(new Set([agentId, otherOwner]));
    const failedOwner = wakeup.mock.calls[0][0];
    const healthyOwner = wakeup.mock.calls[1][0];
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, failedOwner))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, healthyOwner))).toHaveLength(1);

    await queue.notify(companyId);

    expect(wakeup).toHaveBeenCalledTimes(3);
    expect(wakeup.mock.calls[2][0]).toBe(failedOwner);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, failedOwner))).toHaveLength(1);
  });

  it("keeps work pending when a wake exists or scheduling is suppressed", async () => {
    const issue = await task();
    const { queue, wakeup } = scheduler();
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
      status: "deferred_issue_execution", payload: { issueId: issue.id } });
    await queue.notify(companyId);
    expect(wakeup).not.toHaveBeenCalled();
    const suppressed = scheduler(true);
    await suppressed.queue.notify(companyId);
    expect(suppressed.wakeup).not.toHaveBeenCalled();
  });

  it("releases ghosts after 30 minutes and keeps runs, recent completions, wakes, monitors, and cards", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 31 * 60_000);
    const ghost = await task({ status: "in_progress", updatedAt: old });
    const recent = await task({ status: "in_progress", updatedAt: new Date(now.getTime() - 29 * 60_000) });
    const running = await task({ status: "in_progress", updatedAt: old });
    await run(running.id);
    const completed = await task({ status: "in_progress", updatedAt: old });
    await run(completed.id, { status: "succeeded", finishedAt: new Date(now.getTime() - 60_000) });
    const monitored = await task({ status: "in_progress", updatedAt: old, monitorNextCheckAt: new Date(now.getTime() + 60_000) });
    const queued = await task({ status: "in_progress", updatedAt: old });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment", payload: { issueId: queued.id } });
    const waiting = await task({ status: "in_progress", updatedAt: old });
    await db.insert(issueThreadInteractions).values({ companyId, issueId: waiting.id, kind: "ask_user_questions",
      payload: { version: 1, questions: [] } });
    const { queue } = scheduler();
    await queue.reconcile(now);
    const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(rows.find((row) => row.id === ghost.id)).toMatchObject({ status: "todo", statusVersion: 1 });
    for (const kept of [recent, running, completed, monitored, queued, waiting]) {
      expect(rows.find((row) => row.id === kept.id)?.status).toBe("in_progress");
    }
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ghost.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorType: "system" });
    await queue.reconcile(now);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, ghost.id))).toHaveLength(1);
  });

  it("leaves all scheduling and ghost behavior unchanged with the switch disabled", async () => {
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "false");
    const ghost = await task({ status: "in_progress", updatedAt: new Date(Date.now() - 3_600_000) });
    await task();
    const { queue, wakeup } = scheduler();
    await queue.notify(companyId);
    await queue.reconcile();
    expect(wakeup).not.toHaveBeenCalled();
    const [saved] = await db.select().from(issues).where(eq(issues.id, ghost.id));
    expect(saved.status).toBe("in_progress");
  });

  it("keeps a task when admission queues a run while ghost recovery waits for its row lock", async () => {
    const issue = await task({ status: "in_progress", updatedAt: new Date(Date.now() - 31 * 60_000) });
    const { queue } = scheduler();
    let admissionPid = 0;
    let unlock!: () => void;
    const unlocked = new Promise<void>((resolve) => { unlock = resolve; });
    let locked!: () => void;
    const rowLocked = new Promise<void>((resolve) => { locked = resolve; });
    const admission = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issue.id)).for("update");
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      admissionPid = backend.pid;
      locked();
      await unlocked;
      // Admission can insert a run without changing the locked issue row.
      await tx.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issue.id,
        invocationSource: "assignment", status: "queued", contextSnapshot: { issueId: issue.id } });
    });
    let recovery: Promise<void> | undefined;
    try {
      await rowLocked;
      recovery = queue.reconcile();
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity
          where ${admissionPid} = any(pg_blocking_pids(pid))`);
        expect(waiting).toHaveLength(1);
      }, { timeout: 5_000 });
    } finally {
      unlock();
      await admission;
      await recovery;
    }

    const [saved] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(saved).toMatchObject({ status: "in_progress", statusVersion: issue.statusVersion });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, issue.id))).toHaveLength(1);
  });
});

describe("pull queue monitor and event contracts", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("refuses a status change that would silently cancel a monitor", () => {
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    const owner = randomUUID();
    const nextCheckAt = new Date(Date.now() + 3_600_000);
    const policy = normalizeIssueExecutionPolicy({ stages: [], monitor: { nextCheckAt: nextCheckAt.toISOString(), scheduledBy: "board" } })!;
    const input = { issue: { status: "in_progress", assigneeAgentId: owner,
      executionPolicy: policy, monitorNextCheckAt: nextCheckAt },
      policy, previousPolicy: policy, requestedStatus: "backlog", requestedAssigneePatch: {}, actor: { agentId: owner } };
    expect(() => applyIssueExecutionPolicyTransition(input)).toThrow(expect.objectContaining({ status: 409 }));
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "false");
    expect(applyIssueExecutionPolicyTransition(input).patch.monitorNextCheckAt).toBeNull();
  });

  it("does not count a monitor alone as real work", () => {
    expect(countsTowardPullQueueWip({ status: "in_progress", monitorNextCheckAt: new Date() }, false)).toBe(false);
    expect(countsTowardPullQueueWip({ status: "in_progress", monitorNextCheckAt: new Date() }, true)).toBe(true);
    expect(countsTowardPullQueueWip({ status: "todo", monitorNextCheckAt: null }, false)).toBe(true);
  });

  it.each(["issue.updated", "issue.created", "issue.thread_interaction_answered", "issue.thread_interaction_accepted"])("selects work after %s", (action) => {
    expect(isPullQueueSignal({ type: "activity.logged", payload: { entityType: "issue", action } } as LiveEvent)).toBe(true);
  });
  it("selects work after a terminal run and ignores run output", () => {
    expect(isPullQueueSignal({ type: "heartbeat.run.status", payload: { status: "succeeded" } } as LiveEvent)).toBe(true);
    expect(isPullQueueSignal({ type: "heartbeat.run.status", payload: { status: "running" } } as LiveEvent)).toBe(false);
    expect(isPullQueueSignal({ type: "heartbeat.run.event", payload: {} } as LiveEvent)).toBe(false);
  });
});
