import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, companyMemberships, createDb, executionWorkspaces, heartbeatRuns, issueThreadInteractions,
  issues, principalPermissionGrants, projects, workspaceOperations,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported && process.env.CI) {
  throw new Error(`Company interaction tests require PostgreSQL: ${support.reason}`);
}
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping company interaction route tests: ${support.reason}`);

suite("company interaction reads", () => {
  let db!: ReturnType<typeof createDb>;
  const servers: Server[] = [];
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-interactions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    await db.delete(issueThreadInteractions);
    await db.delete(workspaceOperations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Interaction test", issuePrefix: `P${companyId.slice(0, 6).toUpperCase()}`,
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "test-user", status: "active", membershipRole: "owner",
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId, principalId: "test-user", membershipRole: "owner", grantedByUserId: null,
    });
    return companyId;
  }
  async function seedIssue(companyId: string, status = "in_progress") {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: "Read test", status, identifier: `TEST-${id}` });
    return id;
  }
  async function seedInteraction(companyId: string, issueId: string, status = "pending", id = randomUUID()) {
    await db.insert(issueThreadInteractions).values({
      id, companyId, issueId, kind: "request_confirmation", status,
      payload: { version: 1, prompt: "Accept this test change?" },
      result: status === "accepted" ? { version: 1, outcome: "accepted" } : null,
    });
    return id;
  }
  async function appFor(companyId: string, actor?: object) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor ?? {
        type: "board", userId: "test-user", companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant", isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    // Bind the test server to IPv4 on hosts without IPv6 loopback support.
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return server;
  }

  it("filters status in the database and preserves per-issue response fields", async () => {
    const company = await seedCompany();
    const issue = await seedIssue(company);
    const pending = await seedInteraction(company, issue);
    const accepted = await seedInteraction(company, issue, "accepted");
    const app = await appFor(company);
    const response = await request(app).get(`/api/companies/${company}/interactions`).query({ status: "pending" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const perIssue = await request(app).get(`/api/issues/${issue}/interactions`);
    expect(perIssue.status).toBe(200);
    const saved = await request(app).get(`/api/issues/${issue}/interactions/${pending}`);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual(perIssue.body.find((row: { id: string }) => row.id === pending));
    const location = await request(app).get(`/api/companies/${company}/interaction-locations/${pending}`);
    expect(location.status).toBe(200);
    expect(location.body).toEqual({ version: 1, companyId: company, interactionId: pending, issueId: issue });
    expect(response.body).toEqual({
      items: [{ ...perIssue.body.find((row: { id: string }) => row.id === pending), issueIdentifier: `TEST-${issue}` }],
      nextCursor: null,
    });
    const resolved = await request(app).get(`/api/companies/${company}/interactions`).query({ status: "accepted" });
    expect(resolved.body.items.map((row: { id: string }) => row.id)).toEqual([accepted]);
  });

  it("isolates companies, including inconsistent interaction company IDs", async () => {
    const company = await seedCompany();
    const otherCompany = await seedCompany();
    const issue = await seedIssue(company);
    const otherIssue = await seedIssue(otherCompany);
    const own = await seedInteraction(company, issue);
    await seedInteraction(otherCompany, otherIssue);
    await seedInteraction(company, otherIssue);
    await seedInteraction(otherCompany, issue);
    const app = await appFor(company);
    const response = await request(app).get(`/api/companies/${company}/interactions`);
    expect(response.status).toBe(200);
    expect(response.body.items.map((row: { id: string }) => row.id)).toEqual([own]);
    expect((await request(app).get(`/api/companies/${otherCompany}/interactions`)).status).toBe(403);
  });

  it("paginates with UUID cursors without duplicates or missing rows", async () => {
    const company = await seedCompany();
    const issue = await seedIssue(company);
    const ids = await Promise.all(Array.from({ length: 5 }, () => seedInteraction(company, issue)));
    const app = await appFor(company);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await request(app).get(`/api/companies/${company}/interactions`)
        .query({ status: "pending", limit: "2", ...(cursor ? { cursor } : {}) });
      expect(response.status).toBe(200);
      seen.push(...response.body.items.map((row: { id: string }) => row.id));
      cursor = response.body.nextCursor;
      expect(++pages).toBeLessThanOrEqual(3);
    } while (cursor);
    expect(seen).toEqual(ids.sort());
    expect(pages).toBe(3);
  });

  it("scans past hidden issues and returns only authorized rows and cursors", async () => {
    const company = await seedCompany();
    const allowedIssue = await seedIssue(company);
    const hiddenIssue = await seedIssue(company);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: company, name: "Scoped reader", role: "engineer", adapterType: "process" });
    const first = await seedInteraction(company, allowedIssue, "pending", "00000000-0000-4000-8000-000000000002");
    const second = await seedInteraction(company, allowedIssue, "pending", "00000000-0000-4000-8000-000000000004");
    for (const suffix of ["1", "3", "5"]) {
      await seedInteraction(company, hiddenIssue, "pending", `00000000-0000-4000-8000-00000000000${suffix}`);
    }
    const app = await appFor(company, {
      type: "agent", agentId, companyId: company, source: "agent_jwt",
      keyScope: { kind: "skill_test", issueId: allowedIssue },
    });
    const route = `/api/companies/${company}/interactions`;
    const page1 = await request(app).get(route).query({ limit: "1" });
    expect(page1.status, JSON.stringify(page1.body)).toBe(200);
    expect(page1.body.items.map((row: { id: string }) => row.id)).toEqual([first]);
    expect(page1.body.nextCursor).toBe(first);
    const page2 = await request(app).get(route).query({ limit: "1", cursor: first });
    expect(page2.body.items.map((row: { id: string }) => row.id)).toEqual([second]);
    expect(page2.body.nextCursor).toBeNull();
    expect((await request(app).get(`/api/issues/${hiddenIssue}/interactions`)).status).toBe(403);
  });

  it.each(["done", "cancelled"])("uses virtual expiry on %s issues without writing rows", async (status) => {
    const company = await seedCompany();
    const terminalIssue = await seedIssue(company, status);
    const id = await seedInteraction(company, terminalIssue);
    const app = await appFor(company);
    const pending = await request(app).get(`/api/companies/${company}/interactions`).query({ status: "pending" });
    expect(pending.body).toEqual({ items: [], nextCursor: null });
    const expired = await request(app).get(`/api/companies/${company}/interactions`).query({ status: "expired" });
    const perIssue = await request(app).get(`/api/issues/${terminalIssue}/interactions`);
    expect(expired.body.items).toEqual([{ ...perIssue.body[0], issueIdentifier: `TEST-${terminalIssue}` }]);
    expect(expired.body.items[0].result.outcome).toBe("issue_closed");
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)))[0].status).toBe("pending");
  });

  it("preserves each issue's workspace acceptance blocker", async () => {
    const company = await seedCompany();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: company, name: "Test project" });
    await db.insert(agents).values({ id: agentId, companyId: company, name: "Source agent", role: "engineer", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: company, agentId, status: "running" });
    const expected: Record<string, string | undefined> = {};
    for (const blocked of [false, true]) {
      const workspaceId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: workspaceId, companyId: company, projectId, mode: "isolated_workspace",
        strategyType: "git_worktree", name: "Read test workspace",
      });
      const issueId = await seedIssue(company);
      await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
      const interactionId = await seedInteraction(company, issueId);
      await db.update(issueThreadInteractions).set({ sourceRunId: runId }).where(eq(issueThreadInteractions.id, interactionId));
      if (blocked) await db.insert(workspaceOperations).values({
        companyId: company, executionWorkspaceId: workspaceId, heartbeatRunId: runId,
        phase: "worktree_prepare", status: "succeeded",
      });
      expected[interactionId] = blocked ? "workspace_sync_pending" : undefined;
    }
    const app = await appFor(company);
    const response = await request(app).get(`/api/companies/${company}/interactions`).query({ status: "pending" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(Object.fromEntries(response.body.items.map((row: { id: string; acceptanceBlocker?: string }) => [row.id, row.acceptanceBlocker]))).toEqual(expected);
  });

  it("supports issue and kind filters and rejects malformed query values", async () => {
    const company = await seedCompany();
    const issue = await seedIssue(company);
    const otherIssue = await seedIssue(company);
    const id = await seedInteraction(company, issue);
    await seedInteraction(company, otherIssue);
    const app = await appFor(company);
    const route = `/api/companies/${company}/interactions`;
    const filtered = await request(app).get(route).query({ issueId: issue, kind: "request_confirmation" });
    expect(filtered.body.items.map((row: { id: string }) => row.id)).toEqual([id]);
    expect((await request(app).get(route).query({ kind: "ask_user_questions" })).body.items).toEqual([]);
    for (const query of [{ limit: "0" }, { limit: "1001" }, { limit: "1.5" }, { cursor: "bad" }, { issueId: "bad" }, { status: "bad" }, { kind: "bad" }]) {
      expect((await request(app).get(route).query(query)).status, JSON.stringify(query)).toBe(400);
    }
  });
});
