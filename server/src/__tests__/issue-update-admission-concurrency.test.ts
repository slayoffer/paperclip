import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issues } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("atomic issue update WIP admission", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const savedEnv = { ...process.env };
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer({ deploymentMode: "local_trusted" });
  }, 60_000);
  afterEach(() => {
    if (savedEnv.PAPERCLIP_AGENT_WIP_LIMIT === undefined) delete process.env.PAPERCLIP_AGENT_WIP_LIMIT;
    else process.env.PAPERCLIP_AGENT_WIP_LIMIT = savedEnv.PAPERCLIP_AGENT_WIP_LIMIT;
  });
  afterAll(async () => {
    await server?.close();
    if (savedEnv.PAPERCLIP_AGENT_JWT_SECRET === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = savedEnv.PAPERCLIP_AGENT_JWT_SECRET;
  });

  async function race(kind: "promotions" | "create" | "reassignments") {
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "1";
    const f = await server.fixture({ disableWakeOnDemand: true });
    await server.db.update(issues).set({ status: kind === "reassignments" ? "todo" : "backlog",
      assigneeAgentId: kind === "reassignments" ? null : f.agentId, executionRunId: null })
      .where(eq(issues.companyId, f.companyId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lock = server.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${f.companyId}`}, 0))`);
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId)).for("update");
      acquired();
      await gate;
    });
    await ready;
    const requests = [f.issueId, f.blockerId].map(async (id, index) => {
      const create = kind === "create" && index === 1;
      const response = await fetch(`${server.apiUrl}${create ? `/api/companies/${f.companyId}/issues` : `/api/issues/${id}`}`, {
        method: create ? "POST" : "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(create ? { title: "Concurrent new assignment", status: "todo", assigneeAgentId: f.agentId, allowDuplicate: true }
          : kind === "reassignments" ? { assigneeAgentId: f.agentId } : { status: "todo" }),
      });
      return { status: response.status, body: await response.json() };
    });
    try {
      // Hold both old row-lock and shared admission paths until both requests arrive.
      await expect.poll(async () => {
        const rows = await server.db.execute(sql`select count(*)::int as n from pg_locks
          where not granted and locktype in ('advisory', 'transactionid')`);
        return Number(rows[0]?.n ?? 0);
      }, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    } finally { release(); await lock; }
    const responses = await Promise.all(requests);
    const active = await server.db.select({ id: issues.id, status: issues.status }).from(issues)
      .where(and(eq(issues.companyId, f.companyId), eq(issues.assigneeAgentId, f.agentId),
        inArray(issues.status, ["todo", "in_progress", "blocked"])));
    return { responses, active };
  }

  it("admits only one concurrent own-backlog promotion into the last WIP slot", async () => {
    const result = await race("promotions");
    expect(result.responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect(result.responses.find(r => r.status === 409)?.body.details.code).toBe("agent_wip_limit");
    expect(result.active).toHaveLength(1);
  });

  it("shares the last WIP slot between backlog promotion and creation", async () => {
    const result = await race("create");
    expect([200, 409]).toContain(result.responses[0]!.status);
    expect(result.responses[1]!.status).toBe(201);
    expect(result.active).toHaveLength(1);
  });

  it("defers one of two concurrent reassignments into backlog", async () => {
    const result = await race("reassignments");
    expect(result.responses.map(r => r.status)).toEqual([200, 200]);
    expect(result.responses.map(r => r.body.status).sort()).toEqual(["backlog", "todo"]);
    expect(result.active).toHaveLength(1);
  });

  it.each(["critical", "blocked", "done", "in_review"] as const)("preserves the %s admission exemption", async kind => {
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "1";
    const f = await server.fixture({ disableWakeOnDemand: true });
    await server.db.update(issues).set({ status: kind === "critical" ? "backlog" : kind,
      priority: kind === "critical" ? "critical" : "medium", executionRunId: null })
      .where(eq(issues.id, f.issueId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "todo" }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("todo");
  });

  it.each(["in_progress", "blocked"])("keeps a deferred %s reassignment free of start side effects", async status => {
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "1";
    const f = await server.fixture({ disableWakeOnDemand: true });
    await server.db.update(issues).set({ status: "backlog", assigneeAgentId: null, executionRunId: null })
      .where(eq(issues.id, f.issueId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status, assigneeAgentId: f.agentId }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ status: "backlog", startedAt: null, checkoutRunId: null, executionRunId: null });
  });

  it("rolls back admission and publishes no issue activity when the attached comment fails", async () => {
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "1";
    const f = await server.fixture({ disableWakeOnDemand: true });
    await server.db.update(issues).set({ status: "backlog", executionRunId: null }).where(eq(issues.companyId, f.companyId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const published: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(f.companyId, event => {
      if (event.type === "activity.logged" && event.payload.entityId === f.issueId) published.push(String(event.payload.action));
    });
    try {
      const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}`, {
        method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "todo", comment: "Attach the missing upload", attachmentIds: [randomUUID()] }),
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(body.error).toBe("Comment attachments must belong to the same task and company");
      const [stored] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(stored?.status).toBe("backlog");
      expect(published).toEqual([]);
    } finally { unsubscribe(); }
  });

  it.each([false, true])("rejects an invalid board blocked reassignment without cancelling the current run (descriptor: %s)", async invalidDescriptor => {
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "1";
    const f = await server.fixture({ disableWakeOnDemand: true });
    const targetAgentId = randomUUID();
    await server.db.insert(agents).values({ id: targetAgentId, companyId: f.companyId, name: "Next owner",
      adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "blocked", assigneeAgentId: targetAgentId,
        ...(invalidDescriptor ? { unblockDescriptor: { owner: { agentId: randomUUID() }, action: "Unavailable owner" } } : {}) }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(422);
    const [task] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(task).toMatchObject({ status: "in_progress", assigneeAgentId: f.agentId, executionRunId: f.runId });
    expect(run).toMatchObject({ status: "running", errorCode: null });
  });

  it("retains a validated backlog fallback when capacity frees before the update lock", async () => {
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "1";
    const f = await server.fixture({ disableWakeOnDemand: true });
    await server.db.update(issues).set({ status: "backlog", assigneeAgentId: null, executionRunId: null })
      .where(eq(issues.id, f.issueId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lock = server.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${f.companyId}`}, 0))`);
      acquired(); await gate;
      await tx.update(issues).set({ status: "done" }).where(eq(issues.id, f.blockerId));
    });
    await ready;
    const request = fetch(`${server.apiUrl}/api/issues/${f.issueId}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "blocked", assigneeAgentId: f.agentId }),
    });
    try {
      await expect.poll(async () => {
        const rows = await server.db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`);
        return Number(rows[0]?.n ?? 0);
      }).toBe(1);
    } finally { release(); await lock; }
    const response = await request;
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("backlog");
  });

  it("clears a validated blocked descriptor when capacity fills after cancellation", async () => {
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "1";
    const f = await server.fixture({ disableWakeOnDemand: true });
    await server.db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null })
      .where(eq(heartbeatRuns.id, f.runId));
    const targetAgentId = randomUUID();
    await server.db.update(agents).set({ role: "ceo" }).where(eq(agents.id, f.agentId));
    await server.db.insert(agents).values({ id: targetAgentId, companyId: f.companyId, name: "Next owner",
      adapterType: "paperclip_runner", status: "idle", reportsTo: f.agentId,
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lock = server.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${f.companyId}`}, 0))`);
      acquired(); await gate;
      await tx.insert(issues).values({ companyId: f.companyId, title: "Concurrent assignment",
        status: "todo", assigneeAgentId: targetAgentId });
    });
    await ready;
    const request = fetch(`${server.apiUrl}/api/issues/${f.issueId}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "blocked", assigneeAgentId: targetAgentId, blockedByIssueIds: [f.blockerId],
        unblockDescriptor: { owner: { agentId: f.agentId }, action: "Finish the linked prerequisite" } }),
    });
    try {
      await expect.poll(async () => {
        const rows = await server.db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`);
        return Number(rows[0]?.n ?? 0);
      }).toBe(1);
      const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run?.status).toBe("cancelled");
    } finally { release(); await lock; }
    const response = await request;
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ status: "backlog", assigneeAgentId: targetAgentId,
      unblockDescriptor: null, blockedTransitionAt: null, blockedOwnerNotifiedAt: null });
    const active = await server.db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, f.companyId), eq(issues.assigneeAgentId, targetAgentId),
        inArray(issues.status, ["todo", "in_progress", "blocked"])));
    expect(active).toHaveLength(1);
    const wakes = await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wakes.some(wake => wake.reason === "issue_unblock_requested")).toBe(false);
  });

  it("orders privacy and review updates before row locks when a promotion competes", async () => {
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "1";
    const f = await server.fixture({ disableWakeOnDemand: true });
    await server.db.update(issues).set({ status: "backlog", executionRunId: null }).where(eq(issues.companyId, f.companyId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lock = server.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${f.companyId}`}, 0))`);
      acquired(); await gate;
    });
    await ready;
    const patch = async (body: object, authorization?: string) => {
      const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const privacy = patch({ reviewPolicy: "anyone", parentId: null });
    let promotion: ReturnType<typeof patch> | undefined;
    const waiting = async () => {
      const rows = await server.db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`);
      return Number(rows[0]?.n ?? 0);
    };
    try {
      await expect.poll(waiting).toBe(1);
      promotion = patch({ status: "todo" }, `Bearer ${token}`);
      await expect.poll(waiting).toBe(2);
      // Neither request may hold the issue row while waiting for the company lock.
      await expect(server.db.transaction(tx => tx.select({ id: issues.id }).from(issues)
        .where(eq(issues.id, f.issueId)).for("update", { noWait: true }))).resolves.toEqual([{ id: f.issueId }]);
    } finally {
      release(); await lock;
      await Promise.all([privacy, promotion]);
    }
    expect((await privacy).status).toBe(200);
    expect((await promotion!).status).toBe(200);
    const [stored] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(stored).toMatchObject({ status: "todo", reviewPolicy: "anyone", parentId: null });
  });

  it("admits an agent update through a one-connection pool and preserves board promotion", async () => {
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "1";
    const savedPoolMax = process.env.DATABASE_POOL_MAX;
    process.env.DATABASE_POOL_MAX = "1";
    let single: Awaited<ReturnType<typeof startRunnerApiTestServer>> | undefined;
    try {
      single = await startRunnerApiTestServer({ deploymentMode: "local_trusted" });
      expect(single.db.$client.options.max).toBe(1);
      const f = await single.fixture({ disableWakeOnDemand: true });
      await single.db.update(issues).set({ status: "backlog", executionRunId: null }).where(eq(issues.companyId, f.companyId));
      const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
      const agent = await fetch(`${single.apiUrl}/api/issues/${f.issueId}`, {
        method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "todo" }),
      });
      const agentBody = await agent.json();
      expect(agent.status, JSON.stringify(agentBody)).toBe(200);
      expect(agentBody.status).toBe("todo");
      const board = await fetch(`${single.apiUrl}/api/issues/${f.blockerId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "todo" }),
      });
      const boardBody = await board.json();
      expect(board.status, JSON.stringify(boardBody)).toBe(200);
      expect(boardBody.status).toBe("todo");
      const privacy = await fetch(`${single.apiUrl}/api/issues/${f.issueId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewPolicy: "anyone", parentId: null }),
      });
      const privacyBody = await privacy.json();
      expect(privacy.status, JSON.stringify(privacyBody)).toBe(200);
      expect(privacyBody).toMatchObject({ reviewPolicy: "anyone", parentId: null });
    } finally {
      await single?.close();
      if (savedPoolMax === undefined) delete process.env.DATABASE_POOL_MAX;
      else process.env.DATABASE_POOL_MAX = savedPoolMax;
    }
  }, 15_000);
});
