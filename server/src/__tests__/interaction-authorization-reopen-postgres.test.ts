import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, interactionResolutionOutbox, issueThreadInteractions } from "@paperclipai/db";
import { saveConnectionAuthorizationInteraction } from "../services/connection-authorization-interaction.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolutionFixture } from "./helpers/resolution-v2.js";
import * as heartbeats from "../services/heartbeat.js";

describe("authorization card resolution after reopen", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-reopen-review-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  afterEach(() => vi.restoreAllMocks());

  it("clears provenance on reopen and preserves the existing resolver IDs", async () => {
    // Match the outbox suite: only queue admission is stubbed.
    vi.spyOn(heartbeats, "heartbeatService").mockReturnValue({ wakeup: vi.fn(async () => null) } as never);
    const f = await resolutionFixture(db, "board_key");
    try {
      const initial = await f.card();
      const [card] = await db.update(issueThreadInteractions).set({
        continuationPolicy: "wake_assignee", idempotencyKey: "authorization-retry",
      }).where(eq(issueThreadInteractions.id, initial.id)).returning();
      const endpoint = `/api/issues/${f.issue.id}/interactions/${card.id}/reject`;
      const first = await request(f.server).post(endpoint).send({
        expectedRevision: card.revision, idempotencyKey: "first-answer",
      });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ resolvedVia: "board_api_key", resolvedViaKeyId: f.keyId });
      const delivered = await db.update(interactionResolutionOutbox).set({ deliveredAt: new Date() })
        .where(eq(interactionResolutionOutbox.interactionId, card.id)).returning();
      expect(delivered).toHaveLength(1);
      const reopened = await saveConnectionAuthorizationInteraction(db, {
        companyId: f.issue.companyId, issueId: f.issue.id, kind: card.kind,
        payload: card.payload, idempotencyKey: "authorization-retry",
      }, { status: "pending", result: null, resolvedAt: null });
      expect(reopened.id).toBe(card.id);
      expect(reopened).toMatchObject({
        status: "pending", resolvedAt: null, resolvedVia: null, resolvedViaKeyId: null,
        resolvedByUserId: first.body.resolvedByUserId, resolvedByAgentId: first.body.resolvedByAgentId,
      });
    } finally { await f.close(); }
  });
});
