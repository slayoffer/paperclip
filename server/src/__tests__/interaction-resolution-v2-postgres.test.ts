import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, issueThreadInteractions,
  chatActions, chatConversations, chatEndpoints, chatExternalPrincipals, chatPublications,
  toolApplications, toolConnections } from "@paperclipai/db";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { createTelegramConfirmationActions } from "../services/chat-channels/telegram/confirmation-actions.js";
import { projectSafeChatPublication } from "../services/chat-publication-projection.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolutionFixture } from "./helpers/resolution-v2.js";

describe("resolution channel and board key identity", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-resolution-v2-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  it.each([
    ["session", "user_session"], ["board_key", "board_api_key"],
    ["agent_key", "agent_key"], ["agent_jwt", "agent_key"], ["cloud_tenant", null],
  ] as const)("records authenticated %s provenance and ignores forged fields", async (source, expected) => {
    const f = await resolutionFixture(db, source);
    try {
      const card = await f.card();
      const endpoint = `/api/issues/${f.issue.id}/interactions/${card.id}`;
      const body = { resolvedVia: "user_session", resolvedViaKeyId: randomUUID(),
        expectedRevision: card.revision, idempotencyKey: "first-resolution" };
      const response = await request(f.server).post(`${endpoint}/accept`).send(body);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const attribution = { resolvedVia: expected,
        resolvedViaKeyId: source === "board_key" ? f.keyId : null,
        resolvedByUserId: f.actor.type === "agent" ? null : "same-user",
        resolvedByAgentId: f.actor.type === "agent" ? f.agent.id : null };
      expect(response.body).toMatchObject(attribution);
      const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(saved).toMatchObject(attribution);
      const single = await request(f.server).get(endpoint);
      expect(single.status).toBe(200);
      expect(single.body).toMatchObject(attribution);
      const listed = await request(f.server).get(`/api/issues/${f.issue.id}/interactions`);
      expect(listed.status).toBe(200);
      expect(listed.body.find((item: { id: string }) => item.id === card.id)).toMatchObject(attribution);
      const companyPage = await request(f.server).get(`/api/companies/${f.issue.companyId}/interactions`);
      expect(companyPage.status, JSON.stringify(companyPage.body)).toBe(200);
      expect(companyPage.body.items.find((item: { id: string }) => item.id === card.id)).toMatchObject(attribution);
      if (f.actor.type === "board") { f.actor.source = "session"; f.actor.keyId = randomUUID(); }
      const replay = await request(f.server).post(`${endpoint}/accept`).send(body);
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body).toMatchObject(attribution);
    } finally { await f.close(); }
  });

  it("records a native Telegram confirmation as chat_channel", async () => {
    const f = await resolutionFixture(db);
    try {
      const card = await f.card();
      const companyId = f.issue.companyId;
      const [application] = await db.insert(toolApplications).values({ companyId, name: "Chat", type: "chat" }).returning();
      const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id,
        name: "Telegram", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
      const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection.id,
        provider: "telegram", publicId: randomUUID(), assignedAgentId: f.agent.id }).returning();
      const [conversation] = await db.insert(chatConversations).values({ companyId, endpointId: endpoint.id,
        issueId: f.issue.id, externalConversationId: randomUUID(), externalLabel: "Telegram" }).returning();
      const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "telegram",
        providerAccountId: "account", externalId: "person" }).returning();
      const [publication] = await db.insert(chatPublications).values({ companyId, endpointId: endpoint.id,
        conversationId: conversation.id, issueId: f.issue.id, idempotencyKey: randomUUID(),
        payload: projectSafeChatPublication({ classification: "external", source: "issue_interaction", text: "Continue?",
          interaction: { id: card.id, card: { kind: "confirmation", title: "Continue?", body: "Continue?", actions: [] } } }),
      }).returning();
      const actionId = randomUUID();
      await db.insert(chatActions).values({ companyId, endpointId: endpoint.id, conversationId: conversation.id,
        kind: "confirmation_response", providerActionId: actionId, status: "issued",
        payload: { version: 1, publicationId: publication.id, interactionId: card.id, decision: "accept",
          expiresAt: new Date(Date.now() + 60_000).toISOString() } });
      const handler = createTelegramConfirmationActions(db, {
        requireCurrentExternalActionAuthorization: async () => {},
        isExternalActionAuthorizationChange: () => false,
        scheduleMessageProcessing: () => {}, processPendingPublications: async () => {},
      });
      const [interaction] = await issueThreadInteractionService(db).listForIssue(f.issue.id);
      type Input = Parameters<typeof handler.handleTelegramConfirmation>[0];
      await handler.handleTelegramConfirmation({
        record: { endpoint, assignedAgentName: f.agent.name, connectionName: connection.name,
          applicationId: application.id, credentialSecretRefs: [] },
        event: { endpointId: endpoint.id, provider: "telegram",
          event: { actionId, messageId: "message" } } as Input["event"],
        runtimeContext: { credentialFingerprint: "fixture", generation: 1, localEpoch: 1, version: "fixture" },
        conversation, principal: { principal, userId: "same-user" }, issued: { publication }, interaction,
        deny: async () => { throw new Error("Unexpected Telegram denial"); },
        safelyKnown: { conversationId: conversation.id, principalId: principal.id },
      });
      const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(saved).toMatchObject({ status: "accepted", resolvedVia: "chat_channel", resolvedViaKeyId: null,
        resolvedByUserId: "same-user", resolvedByAgentId: null });
    } finally { await f.close(); }
  });

  it("records automatic addressee cleanup as system", async () => {
    const f = await resolutionFixture(db);
    try {
      const card = await f.card();
      await db.update(issueThreadInteractions).set({ addresseeAgentId: f.agent.id }).where(eq(issueThreadInteractions.id, card.id));
      await issueThreadInteractionService(db).cancelPendingForDeletedAddressee(f.issue.companyId, f.agent.id);
      const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(saved).toMatchObject({ status: "cancelled", resolvedVia: "system", resolvedViaKeyId: null,
        resolvedByUserId: null, resolvedByAgentId: null });
    } finally { await f.close(); }
  });

  it("freezes both fields, including historical NULL, and clears both on reopen", async () => {
    const f = await resolutionFixture(db, "board_key");
    try {
      const card = await f.card();
      await db.$client.unsafe(`UPDATE issue_thread_interactions SET resolved_at = now(), status = 'accepted',
        resolved_via = 'board_api_key', resolved_via_key_id = $1 WHERE id = $2`, [f.keyId, card.id]);
      await expect(db.$client.unsafe(`UPDATE issue_thread_interactions SET resolved_via_key_id = $1 WHERE id = $2`,
        [randomUUID(), card.id])).rejects.toMatchObject({ code: "P0001" });
      await expect(db.$client.unsafe(`UPDATE issue_thread_interactions SET resolved_via = 'user_session',
        resolved_via_key_id = NULL WHERE id = $1`, [card.id])).rejects.toMatchObject({ code: "P0001" });
      await db.update(issueThreadInteractions).set({ resolvedAt: null, status: "pending" })
        .where(eq(issueThreadInteractions.id, card.id));
      const [reopened] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(reopened).toMatchObject({ resolvedVia: null, resolvedViaKeyId: null });
      f.actor.source = "session";
      const response = await request(f.server).post(`/api/issues/${f.issue.id}/interactions/${card.id}/accept`).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ resolvedVia: "user_session", resolvedViaKeyId: null });
      const legacy = await f.card();
      await db.update(issueThreadInteractions).set({ resolvedAt: new Date(), status: "accepted" })
        .where(eq(issueThreadInteractions.id, legacy.id));
      const read = await request(f.server).get(`/api/issues/${f.issue.id}/interactions/${legacy.id}`);
      expect(read.body).toMatchObject({ resolvedVia: null, resolvedViaKeyId: null });
      await expect(db.$client.unsafe(`UPDATE issue_thread_interactions SET resolved_via = 'board_api_key',
        resolved_via_key_id = $1 WHERE id = $2`, [f.keyId, legacy.id])).rejects.toMatchObject({ code: "P0001" });
    } finally { await f.close(); }
  });

  it.each([
    ["board_api_key", null, true], ["user_session", "key", true], [null, "key", true],
    ["invalid_channel", null, true], ["user_session", null, false], ["board_api_key", "key", false],
  ] as const)("rejects invalid stored combination via=%s key=%s resolved=%s", async (via, key, resolved) => {
    const f = await resolutionFixture(db);
    try {
      await expect(db.$client.unsafe(`INSERT INTO issue_thread_interactions
        (company_id, issue_id, kind, payload, resolved_via, resolved_via_key_id, resolved_at)
        VALUES ($1, $2, 'request_confirmation', '{"version":1,"prompt":"Continue?"}'::jsonb,
        $3, $4, $5)`, [f.issue.companyId, f.issue.id, via, key ? f.keyId : null,
        resolved ? new Date().toISOString() : null])).rejects.toMatchObject({ code: "23514" });
    } finally { await f.close(); }
  });
});
