import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  issues, issueThreadInteractions, statusCards } from "@paperclipai/db";
import { defaultStatusCardRefreshPolicy } from "@paperclipai/shared";
import { statusCardRoutes } from "../routes/status-cards.js";
import { errorHandler } from "../middleware/index.js";
import { withBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { statusCardService } from "../services/status-cards.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("status-card cancellation attribution", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-status-card-resolution-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Status attribution", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ companyId, name: "Summarizer", role: "general", status: "idle",
      adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" },
      metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }) });
    const keyId = randomUUID();
    const actor = { agentId: null, userId: "status-user",
      via: { resolvedVia: "board_api_key" as const, resolvedViaKeyId: keyId } };
    const service = statusCardService(db);
    const card = await service.create(companyId, { interestPrompt: "Launch tasks", titlePinned: false,
      refreshPolicy: defaultStatusCardRefreshPolicy }, actor);
    await db.update(statusCards).set({ state: "active", queries: [
      { scope: "issues", status: ["blocked"], updatedWithin: "7d", sort: "updated", limit: 20, offset: 0 },
    ] }).where(eq(statusCards.id, card.id));
    async function pending(issueId: string) {
      const [row] = await db.insert(issueThreadInteractions).values({ companyId, issueId,
        kind: "request_confirmation", continuationPolicy: "none", payload: { version: 1, prompt: "Continue?" } }).returning();
      return row;
    }
    async function read(id: string) {
      return db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)).then((rows) => rows[0]);
    }
    return { companyId, actor, card, service, pending, read };
  }

  it("keeps the board resolver ID when archive cancels its generation", async () => {
    const f = await fixture();
    const generation = await f.service.requestCompile(f.card.id, f.actor);
    const pending = await f.pending(generation.generatingIssue.id);
    await f.service.update(generation.card, { archived: true }, f.actor);
    expect(await f.read(pending.id)).toMatchObject({ status: "expired", ...f.actor.via,
      resolvedByUserId: f.actor.userId, resolvedByAgentId: null });
  });

  it.each(["compile", "refresh"] as const)("keeps the route actor after %s wake failure", async (mode) => {
    const f = await fixture();
    let pendingId: string | undefined;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "board_key", userId: f.actor.userId,
        keyId: f.actor.via.resolvedViaKeyId, companyIds: [f.companyId], isInstanceAdmin: true };
      next();
    });
    app.use("/api", statusCardRoutes(db, { heartbeat: { wakeup: async () => {
      const [generation] = await db.select().from(issues).where(eq(issues.companyId, f.companyId));
      pendingId = (await f.pending(generation.id)).id;
      throw new Error("Test wake failure");
    } } }));
    app.use(errorHandler);
    const response = mode === "compile"
      ? await request(app).post(`/api/companies/${f.companyId}/status-cards`).send({ interestPrompt: "Compile tasks" })
      : await request(app).post(`/api/status-cards/${f.card.id}/refresh`).send({ full: true });
    expect(response.status).toBe(500);
    expect(pendingId).toBeDefined();
    expect(await f.read(pendingId!)).toMatchObject({ status: "expired", ...f.actor.via,
      resolvedByUserId: f.actor.userId, resolvedByAgentId: null });
  });

  it.each(["manual", "automatic", "unidentified"] as const)("attributes %s refresh claim cleanup", async (mode) => {
    const f = await fixture();
    const realIssues = issueService(db);
    let pendingId: string | undefined;
    const racingIssues = { ...realIssues, update: async (...args: Parameters<typeof realIssues.update>) => {
      const row = await realIssues.update(...args);
      if (args[1].description) {
        pendingId = (await f.pending(args[0])).id;
        await db.update(statusCards).set({ archivedAt: new Date(), generatingIssueId: null }).where(eq(statusCards.id, f.card.id));
      }
      return row;
    } };
    const actor = mode === "automatic" ? undefined : mode === "manual" ? f.actor : { ...f.actor, userId: null };
    await expect(statusCardService(db, { issuesSvc: racingIssues }).requestRefresh(f.card.id, {
      full: true, actor,
    })).rejects.toMatchObject({ status: 409 });
    expect(pendingId).toBeDefined();
    expect(await f.read(pendingId!)).toMatchObject({ status: "expired",
      resolvedVia: mode === "manual" ? "board_api_key" : mode === "automatic" ? "system" : null,
      resolvedViaKeyId: mode === "manual" ? f.actor.via.resolvedViaKeyId : null,
      resolvedByUserId: mode === "manual" ? f.actor.userId : null, resolvedByAgentId: null });
  });
});
