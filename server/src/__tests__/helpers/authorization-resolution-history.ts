import { expect } from "vitest";
import { eq } from "drizzle-orm";
import { type Db, issueThreadInteractions } from "@paperclipai/db";

export async function assertAuthorizationResolutionHistory(
  db: Db,
  card: typeof issueThreadInteractions.$inferSelect,
  requestAgain: () => Promise<unknown>,
) {
  await db.update(issueThreadInteractions).set({
    status: "rejected", resolvedAt: new Date(), resolvedByUserId: "original-user",
    resolvedVia: "board_api_key", resolvedViaKeyId: "ea6557da-2200-4cf4-bb67-24c5c8cafcbb",
  }).where(eq(issueThreadInteractions.id, card.id));
  await requestAgain();
  const rows = await db.select().from(issueThreadInteractions)
    .where(eq(issueThreadInteractions.issueId, card.issueId));
  expect(rows.find((row) => row.id === card.id)).toMatchObject({
    status: "pending", resolvedByUserId: "original-user", resolvedVia: null, resolvedViaKeyId: null,
  });
  const pending = rows.filter((row) => row.status === "pending");
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
    resolvedVia: null, resolvedAt: null, resolvedByUserId: "original-user", resolvedByAgentId: null,
  });
  expect(pending[0].id).toBe(card.id);
  await requestAgain();
  expect(await db.select().from(issueThreadInteractions)
    .where(eq(issueThreadInteractions.issueId, card.issueId))).toHaveLength(rows.length);
}
