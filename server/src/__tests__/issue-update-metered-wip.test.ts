import { randomUUID } from "node:crypto";
import { authUsers, companyMemberships, issueRelations, issues, withDedicatedDbConnection } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { boardAuthService } from "../services/board-auth.js";
import { pullQueueOwnerLockKey } from "../services/pull-queue-owner-lock.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("WIP admission for blocked-task edits and board keys", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
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

  async function setupIssue(options: {
    atCapacity: boolean;
    externalWait: "relation" | "descriptor" | "none";
    unassignedTodo?: boolean;
  }) {
    const { agentId, companyId, issueId, blockerId, runId, responsibleUserId } =
      await server.fixture({ disableWakeOnDemand: true });
    const boardUserId = randomUUID();
    await server.db.insert(authUsers).values({
      id: boardUserId, name: "Test board operator", email: `${boardUserId}@fixture.invalid`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await server.db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: boardUserId, status: "active", membershipRole: "owner",
    });
    await server.db.update(issues).set({
      status: options.unassignedTodo ? "todo" : "blocked",
      assigneeAgentId: options.unassignedTodo ? null : agentId,
      executionRunId: null,
      unblockDescriptor: options.externalWait === "descriptor" ? { owner: "board", action: "Confirm access" } : null,
    }).where(eq(issues.id, issueId));
    await server.db.update(issues)
      .set({ status: options.atCapacity ? "todo" : "backlog" })
      .where(eq(issues.id, blockerId));
    if (options.externalWait === "relation") {
      const [external] = await server.db.insert(issues).values({
        companyId, title: "Operator decision", status: "todo", assigneeUserId: boardUserId,
      }).returning({ id: issues.id });
      await server.db.insert(issueRelations).values({
        companyId, issueId: external!.id, relatedIssueId: issueId, type: "blocks",
      });
    }
    const agentToken = createLocalAgentJwt(agentId, companyId, "paperclip_runner", runId, responsibleUserId);
    expect(agentToken).toBeTruthy();

    return {
      agentId,
      companyId,
      async patch(body: Record<string, unknown>, actor: "agent" | "board_key" | "local_implicit" = "agent") {
        const token = actor === "board_key"
          ? (await boardAuthService(server.db).createNamedBoardApiKey({ userId: boardUserId, name: "WIP fixture" })).token
          : agentToken;
        const response = await fetch(`${server.apiUrl}/api/issues/${issueId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(actor === "local_implicit" ? {} : { Authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5_000),
        });
        return { status: response.status, body: await response.json() };
      },
      async storedState() {
        const [issue] = await server.db.select({
          status: issues.status, assigneeAgentId: issues.assigneeAgentId, unblockDescriptor: issues.unblockDescriptor,
        }).from(issues).where(eq(issues.id, issueId));
        const blockers = await server.db.select({ id: issueRelations.issueId }).from(issueRelations)
          .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.relatedIssueId, issueId), eq(issueRelations.type, "blocks")));
        return { ...issue, blockerIds: blockers.map(({ id }) => id) };
      },
    };
  }

  async function withOwnerLock(fixture: { companyId: string; agentId: string }, run: () => Promise<void>) {
    const ownerKey = pullQueueOwnerLockKey(fixture.companyId, fixture.agentId);
    await withDedicatedDbConnection(server.db, dedicated => dedicated.transaction(async holder => {
      await holder.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ownerKey}, 0))`);
      await run();
    }));
  }

  it.each([true, false])("meters an echoed assignee when removing the last external blocker (at capacity: %s)", async (atCapacity) => {
    const fixture = await setupIssue({ atCapacity, externalWait: "relation" });
    const before = await fixture.storedState();
    expect(before.blockerIds).toHaveLength(1);
    const { status, body } = await fixture.patch({ assigneeAgentId: fixture.agentId, blockedByIssueIds: [] });
    expect(status, JSON.stringify(body)).toBe(atCapacity ? 409 : 200);
    if (atCapacity) expect(body.details.code).toBe("agent_wip_limit");
    expect(await fixture.storedState()).toEqual({ ...before, blockerIds: atCapacity ? before.blockerIds : [] });
  });

  it("meters a board key moving its assigned blocked task to todo at capacity", async () => {
    const fixture = await setupIssue({ atCapacity: true, externalWait: "descriptor" });
    const before = await fixture.storedState();
    const { status, body } = await fixture.patch({ status: "todo" }, "board_key");
    expect(status, JSON.stringify(body)).toBe(409);
    expect(body.details.code).toBe("agent_wip_limit");
    expect(await fixture.storedState()).toEqual(before);
  });

  it("meters a board key using the shared owner lock even with an open slot", async () => {
    const fixture = await setupIssue({ atCapacity: false, externalWait: "descriptor" });
    await withOwnerLock(fixture, async () => {
      const { status, body } = await fixture.patch({ status: "todo" }, "board_key");
      expect(status, JSON.stringify(body)).toBe(409);
      expect(body.details.code).toBe("agent_wip_limit");
      expect((await fixture.storedState()).status).toBe("blocked");
    });
  });

  it("preserves the wait descriptor when the owner has no slot", async () => {
    const fixture = await setupIssue({ atCapacity: true, externalWait: "descriptor" });
    const before = await fixture.storedState();
    const { status, body } = await fixture.patch({ assigneeAgentId: fixture.agentId, unblockDescriptor: null });
    expect(status, JSON.stringify(body)).toBe(409);
    expect(body.details.code).toBe("agent_wip_limit");
    expect(await fixture.storedState()).toEqual(before);
  });

  it("keeps local human board actions exempt", async () => {
    const fixture = await setupIssue({ atCapacity: true, externalWait: "descriptor" });
    const { status, body } = await fixture.patch({ status: "todo" }, "local_implicit");
    expect(status, JSON.stringify(body)).toBe(200);
    expect((await fixture.storedState()).status).toBe("todo");
  });

  it("retains an existing runnable slot when an untyped blocked issue moves to todo", async () => {
    const fixture = await setupIssue({ atCapacity: true, externalWait: "none" });
    await withOwnerLock(fixture, async () => {
      const { status, body } = await fixture.patch({ status: "todo" }, "board_key");
      expect(status, JSON.stringify(body)).toBe(200);
      expect((await fixture.storedState()).status).toBe("todo");
    });
  });

  it("puts newly assigned runnable work in backlog when the new owner has no slot", async () => {
    const fixture = await setupIssue({ atCapacity: true, externalWait: "none", unassignedTodo: true });
    const { status, body } = await fixture.patch({ assigneeAgentId: fixture.agentId }, "board_key");
    expect(status, JSON.stringify(body)).toBe(200);
    expect(await fixture.storedState()).toMatchObject({ assigneeAgentId: fixture.agentId, status: "backlog" });
  });
});
