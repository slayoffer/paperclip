import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, interactionResolutionOutbox, issueThreadInteractions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolutionFixture } from "./helpers/resolution-v2.js";
import * as heartbeats from "../services/heartbeat.js";
import { requestConnectionAuthorizationCard } from "../services/connection-authorization-card.js";

describe("authorization card resolution after reopen", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-reopen-review-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  afterEach(() => vi.restoreAllMocks());

  it("moves past a legacy pending card with a delivered answer and a conflicting successor key", async () => {
    // Match the outbox suite: only queue admission is stubbed.
    vi.spyOn(heartbeats, "heartbeatService").mockReturnValue({ wakeup: vi.fn(async () => null) } as never);
    const f = await resolutionFixture(db, "board_key");
    try {
      const input = {
        companyId: f.issue.companyId,
        issueId: f.issue.id,
        connectionId: "legacy-connection",
        addresseeUserId: "same-user",
        continuationPolicy: "wake_assignee" as const,
        payload: {
          version: 1 as const,
          prompt: "Connect?",
          target: { type: "custom" as const, key: "connection:legacy:user:same-user", revisionId: "1", label: "Connect" },
        },
      };
      const [card] = await db.insert(issueThreadInteractions).values({
        companyId: input.companyId,
        issueId: input.issueId,
        addresseeUserId: input.addresseeUserId,
        continuationPolicy: input.continuationPolicy,
        payload: input.payload,
        kind: "request_confirmation",
        idempotencyKey: "connection-authorization:legacy-connection:same-user",
      }).returning();
      const endpoint = `/api/issues/${f.issue.id}/interactions/${card.id}/reject`;
      const first = await request(f.server).post(endpoint).send({
        expectedRevision: card.revision, idempotencyKey: "first-answer",
      });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ resolvedVia: "board_api_key", resolvedViaKeyId: f.keyId });
      const delivered = await db.update(interactionResolutionOutbox).set({ deliveredAt: new Date() })
        .where(eq(interactionResolutionOutbox.interactionId, card.id)).returning();
      expect(delivered).toHaveLength(1);
      await db.update(issueThreadInteractions).set({
        status: "pending", result: null, resolvedAt: null,
      }).where(eq(issueThreadInteractions.id, card.id));
      const [unrelated] = await db.insert(issueThreadInteractions).values({
        companyId: input.companyId,
        issueId: input.issueId,
        kind: "request_confirmation",
        idempotencyKey: `connection-authorization-retry:${card.id}`,
        payload: { version: 1, prompt: "Unrelated decision" },
      }).returning();

      const successor = await db.transaction((tx) => requestConnectionAuthorizationCard(tx, input));
      expect(successor.id).not.toBe(card.id);
      expect(successor.id).not.toBe(unrelated.id);
      const readCard = async (id: string) => (await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, id)))[0];
      expect(await readCard(unrelated.id)).toEqual(unrelated);
      expect(await readCard(card.id)).toMatchObject({
        status: "expired", resolutionRequest: { key: "first-answer" },
      });
      const pending = await readCard(successor.id);
      expect(pending).toMatchObject({ status: "pending", resolutionRequest: null });
      await request(f.server).post(`/api/issues/${f.issue.id}/interactions/${pending.id}/reject`)
        .send({ expectedRevision: pending.revision, idempotencyKey: "second-answer" })
        .expect(200);
      const [unchangedDelivery] = await db.select().from(interactionResolutionOutbox)
        .where(eq(interactionResolutionOutbox.interactionId, card.id));
      expect(unchangedDelivery).toEqual(delivered[0]);
    } finally { await f.close(); }
  });
});
