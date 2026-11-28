import { randomUUID } from "node:crypto";
import { issues, withDedicatedDbConnection } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { pullQueueOwnerLockKey } from "../services/pull-queue-owner-lock.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => vi.unstubAllEnvs());

it.skipIf(!support.supported)("refuses agent backlog promotion while pull selection owns the admission lock", async () => {
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
  vi.stubEnv("PAPERCLIP_AGENT_WIP_LIMIT", "1");
  vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
  const server = await startRunnerApiTestServer({ deploymentMode: "local_trusted" });
  try {
    const fixture = await server.fixture({ disableWakeOnDemand: true });
    const { agentId, companyId, issueId, runId } = fixture;
    await server.db.update(issues)
      .set({ status: "backlog", executionRunId: null })
      .where(eq(issues.companyId, companyId));
    const token = createLocalAgentJwt(agentId, companyId, "paperclip_runner", runId, fixture.responsibleUserId);
    expect(token).toBeTruthy();
    const ownerKey = pullQueueOwnerLockKey(companyId, agentId);
    expect(ownerKey).toBe(`pull-queue:${companyId}:${agentId}`);

    await withDedicatedDbConnection(server.db, dedicated => dedicated.transaction(async holder => {
      await holder.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ownerKey}, 0))`);
      const response = await fetch(`${server.apiUrl}/api/issues/${issueId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "todo" }),
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(409);
      expect(body.details.code).toBe("agent_wip_limit");
      const [stored] = await server.db.select().from(issues).where(eq(issues.id, issueId));
      expect(stored?.status).toBe("backlog");
    }));
  } finally {
    await server.close();
  }
}, 60_000);
