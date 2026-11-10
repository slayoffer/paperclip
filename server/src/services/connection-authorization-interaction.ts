import { and, eq } from "drizzle-orm";
import { type Db, issues, issueThreadInteractions } from "@paperclipai/db";

type InteractionInsert = typeof issueThreadInteractions.$inferInsert;

/** Reopen the same authorization card; the database clears resolution provenance. */
export async function saveConnectionAuthorizationInteraction(
  db: Db,
  values: InteractionInsert & { idempotencyKey: string },
  refresh: Partial<InteractionInsert>,
) {
  return db.transaction(async (tx) => {
    // Serialize authorization producers with callbacks before refreshing the row.
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, values.issueId), eq(issues.companyId, values.companyId)))
      .for("update");
    const [existing] = await tx.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, values.companyId),
      eq(issueThreadInteractions.issueId, values.issueId),
      eq(issueThreadInteractions.idempotencyKey, values.idempotencyKey),
    )).for("update");
    if (existing) {
      const [updated] = await tx.update(issueThreadInteractions).set(refresh)
        .where(eq(issueThreadInteractions.id, existing.id)).returning();
      return updated;
    }
    const [created] = await tx.insert(issueThreadInteractions).values(values).returning();
    return created;
  });
}
