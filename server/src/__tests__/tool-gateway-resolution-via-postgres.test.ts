import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  issues, issueThreadInteractions, toolActionRequests, toolInvocations } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { toolGatewayRoutes } from "../routes/tool-gateway.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { canonicalToolArguments, signToolArguments, summarizeToolValue } from "../services/tool-content-guards.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("tool gateway HTTP resolution provenance", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-gateway-resolution-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  it.each([
    ["approve", "approved", "accepted"], ["decline", "rejected", "rejected"],
  ] as const)("records the authenticated board key for %s and preserves it on retry", async (operation, actionStatus, cardStatus) => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Gateway resolution", issuePrefix: `G${companyId.slice(0, 7)}` });
    const [issue] = await db.insert(issues).values({ companyId, title: "Review", status: "in_progress" }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({
      companyId, issueId: issue.id, kind: "request_confirmation", continuationPolicy: "none",
      payload: { version: 1, prompt: "Review tool action" },
    }).returning();
    const [invocation] = await db.insert(toolInvocations).values({
      companyId, issueId: issue.id, toolName: "fixture", status: "awaiting_approval",
    }).returning();
    const signingSecret = randomUUID();
    const argumentSummary = summarizeToolValue({});
    const [action] = await db.insert(toolActionRequests).values({
      companyId, issueId: issue.id, interactionId: card.id, invocationId: invocation.id,
      canonicalArgumentsHash: argumentSummary.sha256, canonicalArgumentsSummary: argumentSummary,
      signedArguments: signToolArguments({ invocationId: invocation.id, toolName: invocation.toolName,
        canonicalArguments: canonicalToolArguments({}), signingSecret }),
    }).returning();
    await db.update(issueThreadInteractions).set({ payload: {
      version: 1, prompt: "Review tool action", toolAction: {
        version: 1, actionRequestId: action.id, invocationId: invocation.id,
        toolName: "fixture", toolDisplayName: "Fixture", connectionId: null, applicationId: null,
        appDisplayName: null, risk: "read", previewMarkdown: "Fixture", argumentsSummaryJson: "{}",
        argumentsHash: argumentSummary.sha256, expiresAt: "2099-01-01T00:00:00.000Z",
      },
    } }).where(eq(issueThreadInteractions.id, card.id));
    const keyId = randomUUID();
    const actor: Express.Request["actor"] = { type: "board", source: "board_key",
      keyId, userId: "gateway-reviewer", companyIds: [companyId], isInstanceAdmin: true };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", toolGatewayRoutes(db, createToolGatewayService(db, { toolActionSigningSecret: signingSecret })));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const endpoint = `/api/tool-gateway/action-requests/${action.id}/${operation}`;
      const body = { companyId, resolvedVia: "user_session", resolvedViaKeyId: randomUUID(),
        via: { resolvedVia: "board_api_key", resolvedViaKeyId: randomUUID() },
        actor: { userId: "forged-user", via: { resolvedVia: "user_session", resolvedViaKeyId: null } } };
      const response = await request(server).post(endpoint).send(body);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ id: action.id, status: actionStatus });
      const expected = { status: cardStatus, resolvedVia: "board_api_key", resolvedViaKeyId: keyId,
        resolvedByUserId: "gateway-reviewer", resolvedByAgentId: null };
      const [stored] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(stored).toMatchObject(expected);
      const read = await request(server).get(`/api/issues/${issue.id}/interactions/${card.id}`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject(expected);
      actor.source = "session";
      actor.keyId = randomUUID();
      const retry = await request(server).post(endpoint).send(body);
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      const reread = await request(server).get(`/api/issues/${issue.id}/interactions/${card.id}`);
      expect(reread.status).toBe(200);
      expect(reread.body).toMatchObject(expected);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
