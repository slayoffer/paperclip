import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { issues, issueThreadInteractions, activityLog, agentWakeupRequests } from "@paperclipai/db";
import { documentService } from "../services/documents.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("atomic issue create admission", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const savedEnv = { ...process.env };
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterEach(() => {
    for (const key of ["PAPERCLIP_AGENT_ISSUES_PER_DAY", "PAPERCLIP_AGENT_CHILDREN_PER_PARENT", "PAPERCLIP_AGENT_WIP_LIMIT"]) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });
  afterAll(async () => {
    await server?.close();
    if (savedEnv.PAPERCLIP_AGENT_JWT_SECRET === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = savedEnv.PAPERCLIP_AGENT_JWT_SECRET;
  });

  async function race(input: { children?: boolean; status?: string }) {
    const f = await server.fixture({ disableWakeOnDemand: true });
    await server.db.update(issues).set({ status: "done", createdByAgentId: null })
      .where(eq(issues.companyId, f.companyId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    let unlock!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const lockKey = `issue-privacy-tree:${f.companyId}`;
    const lock = server.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      acquired();
      await gate;
    });
    await ready;
    const requests = [0, 1].map(async index => {
      const endpoint = input.children && index === 1
        ? `/api/issues/${f.issueId}/children` : `/api/companies/${f.companyId}/issues`;
      const response = await fetch(`${server.apiUrl}${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Concurrent ${index}`, parentId: input.children ? f.issueId : null,
          assigneeAgentId: f.agentId, status: input.status ?? "backlog", allowDuplicate: true }),
      });
      return { status: response.status, body: await response.json() };
    });
    try {
      // Both requests must finish their route checks before insertion can proceed.
      await expect.poll(async () => {
        const rows = await server.db.execute(sql`select count(*)::int as n from pg_locks
          where locktype = 'advisory' and not granted`);
        return Number(rows[0]?.n ?? 0);
      }, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    } finally {
      unlock();
      await lock;
    }
    const responses = await Promise.all(requests);
    const created = await server.db.select({ status: issues.status }).from(issues)
      .where(and(eq(issues.companyId, f.companyId), eq(issues.createdByAgentId, f.agentId)));
    return { responses, created };
  }

  it("admits only one concurrent create at the daily quota", async () => {
    process.env.PAPERCLIP_AGENT_ISSUES_PER_DAY = "1";
    const result = await race({});
    expect(result.responses.map(r => r.status).sort()).toEqual([201, 409]);
    expect(result.responses.find(r => r.status === 409)?.body.details.code).toBe("agent_issue_create_limit");
    expect(result.created).toHaveLength(1);
  });

  it("shares the child quota between company and child create routes", async () => {
    process.env.PAPERCLIP_AGENT_CHILDREN_PER_PARENT = "1";
    const result = await race({ children: true });
    expect(result.responses.map(r => r.status).sort()).toEqual([201, 409]);
    expect(result.created).toHaveLength(1);
  });

  it("defers the second concurrent assignment when one WIP slot is free", async () => {
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "1";
    const result = await race({ children: true, status: "todo" });
    expect(result.responses.map(r => r.status)).toEqual([201, 201]);
    expect(result.created.map(r => r.status).sort()).toEqual(["backlog", "todo"]);
  });
  it("rolls back a quota-rejected batch and delivers all effects after retry", async () => {
    process.env.PAPERCLIP_AGENT_CHILDREN_PER_PARENT = "2";
    const f = await server.fixture({ disableWakeOnDemand: true });
    const plan = await documentService(server.db).upsertIssueDocument({
      issueId: f.issueId, key: "plan", title: "Plan", format: "markdown", body: "Two independent children",
      createdByAgentId: f.agentId, createdByRunId: f.runId,
    });
    await server.db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "accepted",
      continuationPolicy: "wake_assignee", resolvedAt: new Date(),
      createdByUserId: f.responsibleUserId, resolvedByUserId: f.responsibleUserId,
      payload: { version: 1, prompt: "Approve plan?", target: { type: "issue_document", key: "plan",
        issueId: f.issueId, documentId: plan.document.id, revisionId: plan.document.latestRevisionId } },
      result: { version: 1, outcome: "accepted" },
    });
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const post = async (endpoint: string, body: object) => {
      const response = await fetch(`${server.apiUrl}${endpoint}`, { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const endpoint = `/api/issues/${f.issueId}/accepted-plan-decompositions`;
    const batchBody = { acceptedPlanRevisionId: plan.document.latestRevisionId,
      children: ["Batch first", "Batch second"].map(title => ({ title, status: "todo", assigneeAgentId: f.agentId })) };
    let unlock!: () => void, acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const lock = server.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${f.companyId}`}, 0))`);
      acquired(); await gate;
    });
    await ready;
    const single = post(`/api/issues/${f.issueId}/children`, { title: "Concurrent single", status: "backlog", assigneeAgentId: f.agentId });
    const waiting = async () => {
      const rows = await server.db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`);
      return Number(rows[0]?.n ?? 0);
    };
    let batch!: ReturnType<typeof post>;
    try {
      await expect.poll(waiting).toBe(1);
      batch = post(endpoint, batchBody);
      await expect.poll(waiting).toBe(2);
    } finally { unlock(); await lock; }
    expect((await single).status).toBe(201);
    expect((await batch).status).toBe(409);
    const children = await server.db.select({ title: issues.title }).from(issues).where(eq(issues.parentId, f.issueId));
    expect(children).toEqual([{ title: "Concurrent single" }]);

    process.env.PAPERCLIP_AGENT_CHILDREN_PER_PARENT = "3";
    const retry = await post(endpoint, batchBody);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.newlyCreatedChildIssueIds).toHaveLength(2);
    const ids = retry.body.newlyCreatedChildIssueIds as string[];
    const activity = await server.db.select({ id: activityLog.entityId }).from(activityLog)
      .where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "issue.child_created")));
    expect(ids.every(id => activity.some(row => row.id === id))).toBe(true);
    await expect.poll(async () => {
      const wakes = await server.db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, f.companyId));
      return ids.every(id => wakes.some(row => row.payload?.issueId === id));
    }).toBe(true);
    const replay = await post(endpoint, batchBody);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.newlyCreatedChildIssueIds).toEqual([]);
  }, 15_000);

});
