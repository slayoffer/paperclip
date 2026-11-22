import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  interactionResolutionOutbox,
  issueThreadInteractions,
  type Db,
} from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import * as heartbeats from "../../services/heartbeat.js";

export async function assertAuthorizationResolutionHistory(
  db: Db,
  card: typeof issueThreadInteractions.$inferSelect,
  requestAgain: () => Promise<unknown>,
) {
  const { companyId, issueId, addresseeUserId } = card;
  if (!addresseeUserId) throw new Error("Expected a user-addressed authorization card");
  // An OAuth start can reuse a card that the gateway created with this policy.
  const [initial] = await db.update(issueThreadInteractions)
    .set({ continuationPolicy: "wake_assignee" })
    .where(eq(issueThreadInteractions.id, card.id))
    .returning();

  const admitWake = vi.spyOn(heartbeats, "heartbeatService").mockReturnValue({
    wakeup: async (agentId: string, options: { idempotencyKey: string }) => {
      await db.insert(agentWakeupRequests).values({
        companyId, agentId, source: "automation", status: "queued",
        idempotencyKey: options.idempotencyKey,
      }).onConflictDoNothing();
      return null;
    },
  } as never);
  try {
    const keyId = randomUUID();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board", source: "board_key", keyId, userId: addresseeUserId,
        companyIds: [companyId], isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never, {}));
    app.use(errorHandler);
    const reject = (row: typeof issueThreadInteractions.$inferSelect, idempotencyKey: string) =>
      request(app).post(`/api/issues/${issueId}/interactions/${row.id}/reject`)
        .send({ expectedRevision: row.revision, idempotencyKey, reason: idempotencyKey })
        .expect(200);

    await reject(initial, "first-answer");
    const readCards = () => db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issueId));
    const readOutbox = () => db.select().from(interactionResolutionOutbox)
      .where(eq(interactionResolutionOutbox.issueId, issueId));
    const completed = (await readCards()).find((row) => row.id === card.id);
    expect(completed).toMatchObject({
      status: "rejected", resolvedVia: "board_api_key", resolvedViaKeyId: keyId,
      resolutionRequest: { key: "first-answer" },
    });
    const firstOutbox = await readOutbox();
    expect(firstOutbox).toEqual([expect.objectContaining({
      interactionId: card.id, deliveredAt: expect.any(Date),
    })]);

    await Promise.all([requestAgain(), requestAgain()]);
    const rows = await readCards();
    expect(rows).toContainEqual(completed);
    const pending = rows.filter((row) => row.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      addresseeUserId, continuationPolicy: "wake_assignee",
      resolvedVia: null, resolvedViaKeyId: null, resolvedAt: null,
      resolvedByUserId: null, resolvedByAgentId: null, result: null, resolutionRequest: null,
    });
    expect(pending[0].id).not.toBe(card.id);
    await reject(pending[0], "second-answer");
    expect(await readCards()).toEqual(expect.arrayContaining([
      completed,
      expect.objectContaining({ id: pending[0].id, status: "rejected", resolutionRequest: { key: "second-answer", fingerprint: expect.any(String) } }),
    ]));
    const outbox = await readOutbox();
    expect(outbox).toHaveLength(2);
    expect(outbox).toEqual(expect.arrayContaining([
      firstOutbox[0],
      expect.objectContaining({ interactionId: pending[0].id, deliveredAt: expect.any(Date) }),
    ]));
  } finally {
    admitWake.mockRestore();
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
  }
}
