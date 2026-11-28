import { randomUUID } from "node:crypto";
import { issues, withDedicatedDbConnection } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { pullQueueOwnerLockKey } from "../services/pull-queue-owner-lock.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("issue update WIP admission", () => {
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

  async function setupIssue(status: "backlog" | "blocked" | "done" | "in_progress", atCapacity: boolean) {
    const { agentId, companyId, issueId, blockerId, runId, responsibleUserId } =
      await server.fixture({ disableWakeOnDemand: true });
    await server.db.update(issues).set({
      status,
      executionRunId: null,
      ...(status === "blocked" ? { unblockDescriptor: { owner: "board", action: "Confirm access" } } : {}),
    }).where(eq(issues.id, issueId));
    await server.db.update(issues)
      .set({ status: atCapacity ? "todo" : "backlog" })
      .where(eq(issues.id, blockerId));
    const token = createLocalAgentJwt(agentId, companyId, "paperclip_runner", runId, responsibleUserId);
    expect(token).toBeTruthy();

    return {
      agentId,
      companyId,
      async moveToTodo() {
        const response = await fetch(`${server.apiUrl}/api/issues/${issueId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ status: "todo" }),
          signal: AbortSignal.timeout(5_000),
        });
        return { status: response.status, body: await response.json() };
      },
      async readStatus() {
        const [stored] = await server.db.select().from(issues).where(eq(issues.id, issueId));
        return stored?.status;
      },
    };
  }

  async function withOwnerLock(fixture: { companyId: string; agentId: string }, run: () => Promise<void>) {
    const ownerKey = pullQueueOwnerLockKey(fixture.companyId, fixture.agentId);
    expect(ownerKey).toBe(`pull-queue:${fixture.companyId}:${fixture.agentId}`);

    await withDedicatedDbConnection(server.db, dedicated => dedicated.transaction(async holder => {
      await holder.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ownerKey}, 0))`);
      await run();
    }));
  }

  it.each(["backlog", "done"] as const)("refuses to move %s work to todo while pull selection holds the owner lock", async (originalStatus) => {
    const fixture = await setupIssue(originalStatus, false);
    await withOwnerLock(fixture, async () => {
      const { status, body } = await fixture.moveToTodo();
      expect(status, JSON.stringify(body)).toBe(409);
      expect(body.details.code).toBe("agent_wip_limit");
      expect(await fixture.readStatus()).toBe(originalStatus);
    });
  });

  it.each(["blocked", "done"] as const)("refuses to move a %s issue to todo when the owner is at capacity", async (originalStatus) => {
    const fixture = await setupIssue(originalStatus, true);
    const { status, body } = await fixture.moveToTodo();
    expect(status, JSON.stringify(body)).toBe(409);
    expect(body.details.code).toBe("agent_wip_limit");
    expect(await fixture.readStatus()).toBe(originalStatus);
  });

  it("moves an externally blocked issue to todo when the owner has capacity", async () => {
    const fixture = await setupIssue("blocked", false);
    const { status, body } = await fixture.moveToTodo();
    expect(status, JSON.stringify(body)).toBe(200);
    expect(await fixture.readStatus()).toBe("todo");
  });

  it("does not take another slot when an issue with live execution moves to todo", async () => {
    const fixture = await setupIssue("in_progress", true);
    await withOwnerLock(fixture, async () => {
      const { status, body } = await fixture.moveToTodo();
      expect(status, JSON.stringify(body)).toBe(200);
      expect(await fixture.readStatus()).toBe("todo");
    });
  });
});
