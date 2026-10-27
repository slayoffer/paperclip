import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { issueLabels, labels, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export const OWNER_PARKING_LABELS = ["owner:stopped", "owner:local-session"] as const;
export const OWNER_PARKING_SKIP_REASON = "issue.owner_parked";

/** Read current company-scoped labels. Saved wake payloads cannot grant execution authority. */
export async function issueOwnerParkingReason(
  db: Db,
  issue: { companyId: string; id: string },
  source: string,
): Promise<string | null> {
  const [park] = await db.select({ name: labels.name }).from(issueLabels)
    .innerJoin(labels, and(eq(labels.id, issueLabels.labelId), eq(labels.companyId, issueLabels.companyId)))
    .where(and(eq(issueLabels.companyId, issue.companyId), eq(issueLabels.issueId, issue.id),
      inArray(sql`lower(${labels.name})`, [...OWNER_PARKING_LABELS])))
    .orderBy(asc(labels.name)).limit(1);
  if (!park) return null;
  logger.info({ companyId: issue.companyId, issueId: issue.id, source,
    reason: OWNER_PARKING_SKIP_REASON, ownerLabel: park.name }, "Issue owner is parked. Execution skipped.");
  return OWNER_PARKING_SKIP_REASON;
}
