import { randomUUID } from "node:crypto";
import { agents, authUsers, companyMemberships, heartbeatRuns, issueRelations, issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { boardAuthService } from "../services/board-auth.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("WIP admission for dependent work released by PATCH", () => {
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

  it.each([
    { atCapacity: true, status: "done" },
    { atCapacity: true, status: "cancelled" },
    { atCapacity: false, status: "done" },
    { atCapacity: true, status: "delete" },
    { atCapacity: false, status: "delete" },
  ] as const)("checks the dependent owner's WIP when moving the blocker to $status (at capacity: $atCapacity)", async ({ atCapacity, status }) => {
    const { agentId, companyId, issueId, blockerId, runId } = await server.fixture({ disableWakeOnDemand: true });
    const deleting = status === "delete";
    const sourceId = deleting ? randomUUID() : issueId;
    if (deleting) {
      await server.db.insert(issues).values({
        id: sourceId, companyId, title: "Source blocker", assigneeAgentId: agentId, status: "in_progress",
      });
    }
    const boardUserId = randomUUID();
    await server.db.insert(authUsers).values({
      id: boardUserId, name: "Test board operator", email: `${boardUserId}@fixture.invalid`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await server.db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: boardUserId, status: "active", membershipRole: "owner",
    });
    await server.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
    await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    const [owner] = await server.db.insert(agents).values({
      companyId, name: "Dependent owner", adapterType: "process",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    }).returning({ id: agents.id });
    const [dependent] = await server.db.insert(issues).values({
      companyId, title: "Wait for the source", assigneeAgentId: owner!.id, status: "blocked",
    }).returning({ id: issues.id });
    await server.db.update(issues)
      .set({ status: atCapacity ? "todo" : "backlog", assigneeAgentId: owner!.id })
      .where(eq(issues.id, blockerId));
    await server.db.insert(issueRelations).values({
      companyId, issueId: sourceId, relatedIssueId: dependent!.id, type: "blocks",
    });

    const { token } = await boardAuthService(server.db).createNamedBoardApiKey({ userId: boardUserId, name: "WIP fixture" });
    const response = await fetch(`${server.apiUrl}/api/issues/${sourceId}`, {
      method: deleting ? "DELETE" : "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: deleting ? undefined : JSON.stringify({ status }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(atCapacity ? 409 : 200);
    if (atCapacity) expect(body.details.code).toBe("agent_wip_limit");
    const [storedBlocker] = await server.db.select({ status: issues.status }).from(issues).where(eq(issues.id, sourceId));
    expect(storedBlocker?.status).toBe(atCapacity ? "in_progress" : deleting ? undefined : status);
    const relation = await server.db.select().from(issueRelations)
      .where(and(eq(issueRelations.issueId, sourceId), eq(issueRelations.relatedIssueId, dependent!.id)));
    expect(relation).toHaveLength(deleting && !atCapacity ? 0 : 1);
  });

  it("rolls back a direct agent dependency update when the owner has no slot", async () => {
    const { agentId, companyId, issueId, blockerId } = await server.fixture({ disableWakeOnDemand: true });
    const externalOwnerId = randomUUID();
    await server.db.insert(agents).values({ id: externalOwnerId, companyId, name: "External owner", adapterType: "process" });
    const externalBlockerId = randomUUID();
    await server.db.insert(issues).values({
      id: externalBlockerId, companyId, title: "External blocker", status: "todo", assigneeAgentId: externalOwnerId,
    });
    await server.db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, issueId));
    await server.db.insert(issueRelations).values({
      companyId, issueId: externalBlockerId, relatedIssueId: issueId, type: "blocks",
    });
    await expect(issueService(server.db).update(issueId, { actorAgentId: agentId, blockedByIssueIds: [] }))
      .rejects.toMatchObject({ status: 409, details: { code: "agent_wip_limit" } });
    const relation = await server.db.select({ id: issueRelations.issueId }).from(issueRelations)
      .where(and(eq(issueRelations.issueId, externalBlockerId), eq(issueRelations.relatedIssueId, issueId)));
    expect(relation).toEqual([{ id: externalBlockerId }]);
    const [slot] = await server.db.select({ status: issues.status }).from(issues).where(eq(issues.id, blockerId));
    expect(slot?.status).toBe("todo");
  });
});
