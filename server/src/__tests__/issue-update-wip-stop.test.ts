import { randomUUID } from "node:crypto";
import { agents, authUsers, companyMemberships, heartbeatRuns, issueComments, issueRelations, issues, nativeRunFinalizations, withDedicatedDbConnection } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { boardAuthService } from "../services/board-auth.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("WIP refusal preserves run ownership", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_WIP_LIMIT", "1");
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    server = await startRunnerApiTestServer({ deploymentMode: "local_trusted" });
  }, 60_000);

  afterAll(async () => {
    try {
      await server?.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  async function fixture() {
    const ids = await server.fixture({ disableWakeOnDemand: true });
    const userId = randomUUID();
    await server.db.insert(authUsers).values({
      id: userId, name: "Board key user", email: `${userId}@fixture.invalid`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await server.db.insert(companyMemberships).values({
      companyId: ids.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner",
    });
    const { token } = await boardAuthService(server.db).createNamedBoardApiKey({ userId, name: "WIP refusal test" });
    return {
      ...ids,
      userId,
      async request(method: "PATCH" | "POST", body: object) {
        const response = await fetch(`${server.apiUrl}/api/issues/${ids.issueId}${method === "POST" ? "/comments" : ""}`, {
          method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8_000),
        });
        return { status: response.status, body: await response.json() };
      },
      async readState(runId = ids.runId) {
        const [issue] = await server.db.select()
          .from(issues).where(eq(issues.id, ids.issueId));
        const [run] = await server.db.select({ status: heartbeatRuns.status, writesRevoked: heartbeatRuns.writesRevoked,
          scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
          resultJson: heartbeatRuns.resultJson, contextSnapshot: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const comments = await server.db.select({ id: issueComments.id }).from(issueComments)
          .where(eq(issueComments.issueId, ids.issueId));
        return { issue, run, comments };
      },
    };
  }

  async function addRetry(f: Awaited<ReturnType<typeof fixture>>, durableIssueId: string) {
    await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    const retryId = randomUUID();
    await server.db.insert(heartbeatRuns).values({
      id: retryId, companyId: f.companyId, agentId: f.agentId,
      status: "scheduled_retry", runtimeMode: "legacy", nativeIssueId: null,
      issueId: durableIssueId, contextSnapshot: { issueId: f.issueId },
      scheduledRetryAt: new Date(Date.now() + 600_000), scheduledRetryReason: "infrastructure_retry",
      invocationSource: "assignment", triggerDetail: "system",
    });
    return retryId;
  }

  it.each(["PATCH", "POST"] as const)("keeps a parked retry alive when %s comment cannot acquire a WIP slot", async method => {
    const f = await fixture();
    // Legacy retry attribution still discovers the context task; the durable
    // binding points at the other task, so this task needs a new runnable slot.
    const retryId = await addRetry(f, f.blockerId);
    const before = await f.readState(retryId);
    const { status, body } = await f.request(method, method === "PATCH" ? { comment: "Please continue" } : { body: "Please continue" });
    expect(status, JSON.stringify(body)).toBe(409);
    expect(body.details.code).toBe("agent_wip_limit");
    expect(await f.readState(retryId)).toEqual(before);
  });

  it.each(["PATCH", "POST"] as const)("%s resumes a comment when an agent has a free slot", async method => {
    const f = await fixture();
    const retryId = await addRetry(f, f.blockerId);
    await server.db.update(issues).set({ status: "backlog" }).where(eq(issues.id, f.blockerId));
    const { status, body } = await f.request(method, method === "PATCH" ? { comment: "Please continue" } : { body: "Please continue" });
    expect(status, JSON.stringify(body)).toBe(method === "PATCH" ? 200 : 201);
    const state = await f.readState(retryId);
    expect(state.issue?.status).toBe("todo");
    expect(state.run?.status).toBe("cancelled");
    expect(state.comments).toHaveLength(1);
  });

  it.each(["PATCH", "POST"] as const)("%s keeps in-progress status when the retry was promoted before the claim", async method => {
    const f = await fixture();
    const retryId = await addRetry(f, f.issueId);
    let request: ReturnType<typeof f.request> | undefined;
    await withDedicatedDbConnection(server.db, dedicated => dedicated.transaction(async holder => {
      await holder.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${f.companyId}`}, 0))`);
      request = f.request(method, method === "PATCH" ? { comment: "Please continue" } : { body: "Please continue" });
      await expect.poll(async () => {
        const [row] = await holder.execute<{ waiting: boolean }>(sql`select exists(
          select 1 from pg_locks where locktype = 'advisory' and not granted
        ) as waiting`);
        return row?.waiting;
      }, { timeout: 3_000 }).toBe(true);
      await holder.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, retryId));
    }));
    const { status, body } = await request!;
    expect(status, JSON.stringify(body)).toBe(method === "PATCH" ? 200 : 201);
    const state = await f.readState(retryId);
    expect(state.issue?.status).toBe("in_progress");
    expect(state.run?.status).toBe("queued");
    expect(state.comments).toHaveLength(1);
  });

  it.each(["terminalization", "reassignment"] as const)("leaves the native execution untouched when %s would release a full dependent owner's slot", async kind => {
    const f = await fixture();
    const ownerId = randomUUID();
    await server.db.insert(agents).values({ id: ownerId, companyId: f.companyId, name: "Dependent owner", adapterType: "process", status: "idle" });
    await server.db.update(issues).set({ assigneeAgentId: ownerId }).where(eq(issues.id, f.blockerId));
    const dependentId = randomUUID();
    await server.db.insert(issues).values({
      id: dependentId, companyId: f.companyId, title: "Wait for source", status: "blocked", assigneeAgentId: ownerId,
    });
    await server.db.insert(issueRelations).values({
      companyId: f.companyId, issueId: f.issueId, relatedIssueId: dependentId, type: "blocks",
    });
    await server.db.insert(nativeRunFinalizations).values({
      companyId: f.companyId, issueId: f.issueId, runId: f.runId, phase: "running",
    });
    const before = await f.readState();
    const { status, body } = await f.request("PATCH", kind === "terminalization" ? { status: "done" } : { assigneeAgentId: ownerId });
    expect(status, JSON.stringify(body)).toBe(409);
    expect(body.details.code).toBe("agent_wip_limit");
    expect(await f.readState()).toEqual(before);
  });

  it("commits a metered terminal update and settles the fenced native Stop", async () => {
    const f = await fixture();
    await server.db.insert(nativeRunFinalizations).values({
      companyId: f.companyId, issueId: f.issueId, runId: f.runId, phase: "running",
    });
    const { status, body } = await f.request("PATCH", { status: "done" });
    expect(status, JSON.stringify(body)).toBe(200);
    const state = await f.readState();
    expect(state.issue).toMatchObject({ status: "done", executionRunId: null });
    expect(state.run).toMatchObject({
      status: "cancelled", writesRevoked: true,
      resultJson: {
        cancelledByUserId: f.userId,
        terminalizationStopConfirmed: true,
        issueMutationStop: { issueId: f.issueId, runId: f.runId, status: "done" },
        nativeCancellation: { dispatchState: "acknowledged", issueId: f.issueId, runId: f.runId },
      },
    });
  });
});
