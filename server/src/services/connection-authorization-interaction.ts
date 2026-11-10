import { and, eq } from "drizzle-orm";
import { type Db, issues, issueThreadInteractions } from "@paperclipai/db";

type InteractionInsert = typeof issueThreadInteractions.$inferInsert;

/** Refresh a pending authorization card, but retain every completed resolution. */
export async function saveConnectionAuthorizationInteraction(
  db: Db,
  values: InteractionInsert & { idempotencyKey: string },
  refresh: Partial<InteractionInsert>,
) {
  return db.transaction(async (tx) => {
    // Serialize both authorization producers before transferring the stable lookup key.
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, values.issueId), eq(issues.companyId, values.companyId)))
      .for("update");
    const [existing] = await tx.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, values.companyId),
      eq(issueThreadInteractions.issueId, values.issueId),
      eq(issueThreadInteractions.idempotencyKey, values.idempotencyKey),
    )).for("update");
    if (existing?.status === "pending" && existing.resolvedAt === null && existing.resolvedVia === null) {
      const [updated] = await tx.update(issueThreadInteractions).set(refresh)
        .where(eq(issueThreadInteractions.id, existing.id)).returning();
      return updated;
    }
    if (existing) {
      await tx.update(issueThreadInteractions)
        .set({ idempotencyKey: `${values.idempotencyKey}:${existing.id}` })
        .where(eq(issueThreadInteractions.id, existing.id));
    }
    const [created] = await tx.insert(issueThreadInteractions).values(values).returning();
    return created;
  });
}
