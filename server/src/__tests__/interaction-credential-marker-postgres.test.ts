import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("confirmation credential marker persistence", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-credential-marker-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Credential marker fixture", issuePrefix: `C${companyId.slice(0, 7)}`,
    });
    const [agent] = await db.insert(agents).values({
      companyId, name: "Fixture agent", role: "engineer", adapterType: "process", status: "idle",
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId, title: "Credential marker fixture", status: "in_progress", assigneeAgentId: agent.id,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, status: "running", nativeIssueId: issue.id,
      contextSnapshot: { issueId: issue.id },
    }).returning();
    let actor: Record<string, unknown> = {
      type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true,
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
    app.use("/api", issueRoutes(db, {} as never, {}));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    return {
      issue, agent, server,
      useAgent() { actor = { type: "agent", agentId: agent.id, companyId, runId: run.id, source: "agent_key" }; },
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      }),
    };
  }

  it.each([true, false, undefined])("preserves marker %s through creation, storage, and reads", async (marker) => {
    const f = await fixture();
    try {
      const payload = {
        version: 1, prompt: "Approve the synthetic credential operation?",
        ...(marker === undefined ? {} : { credentialOperation: marker }),
      };
      const created = await request(f.server).post(`/api/issues/${f.issue.id}/interactions`).send({
        kind: "request_confirmation", resolverPolicy: "human_only", addresseeUserId: "local-board", payload,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
        addresseeUserId: "local-board", payload,
      });
      const [stored] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.body.id));
      expect(stored.payload).toMatchObject(payload);

      const listed = await request(f.server).get(`/api/issues/${f.issue.id}/interactions`);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0]).toMatchObject({ id: created.body.id, payload });
      if (marker === undefined) {
        for (const value of [created.body.payload, stored.payload, listed.body[0].payload]) {
          expect(value).not.toHaveProperty("credentialOperation");
        }
      }

      f.useAgent();
      const rejected = await request(f.server)
        .post(`/api/issues/${f.issue.id}/interactions/${created.body.id}/accept`).send({});
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(403);
      expect(rejected.body).toMatchObject({ code: "interaction_human_only" });
      const [pending] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.body.id));
      expect(pending.status).toBe("pending");
      expect(pending.payload).toMatchObject(payload);
    } finally { await f.close(); }
  });

  it("rejects an invalid marker before storage", async () => {
    const f = await fixture();
    try {
      const result = await request(f.server).post(`/api/issues/${f.issue.id}/interactions`).send({
        kind: "request_confirmation", resolverPolicy: "human_only",
        payload: { version: 1, prompt: "Proceed?", credentialOperation: "true" },
      });
      expect(result.status).toBe(400);
      expect(await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, f.issue.id))).toHaveLength(0);
    } finally { await f.close(); }
  });
});
