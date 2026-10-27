import { and, eq } from "drizzle-orm";
import { issueQuestionResponseDeliveries as deliveries, type Db } from "@paperclipai/db";
import { outboxBackoff } from "./outbox-backoff.js";

export async function releaseQuestionResponseForRetry(
  db: Db,
  delivery: typeof deliveries.$inferSelect,
  errorCode: string,
  options: { bounded: boolean },
  at: Date,
  maxErrors: number,
) {
  const errorCount = delivery.errorCount + (options.bounded ? 1 : 0);
  const exhausted = options.bounded && errorCount >= maxErrors;
  await db.update(deliveries).set({
    // Keep an exhausted claim owned until its terminal outcome commits.
    status: exhausted ? "delivering" : "pending",
    ...(options.bounded ? { errorCount } : outboxBackoff(delivery.holdCount, at)),
    lastErrorCode: errorCode,
    updatedAt: at,
  }).where(and(eq(deliveries.id, delivery.id), eq(deliveries.status, "delivering"),
    eq(deliveries.attemptCount, delivery.attemptCount)));
  return exhausted;
}
