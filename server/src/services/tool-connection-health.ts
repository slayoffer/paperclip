import { eq } from "drizzle-orm";
import { toolConnections, type Db } from "@paperclipai/db";

export async function markToolConnectionHealth(
  db: Db,
  connection: typeof toolConnections.$inferSelect,
  status: "ok" | "error" | "missing_secret" | "degraded",
  message: string | null,
) {
  const now = new Date();
  await db
    .update(toolConnections)
    .set({
      healthStatus: status,
      healthMessage: message,
      healthCheckedAt: now,
      lastHealthAt: now,
      lastError: status === "ok" ? null : message,
      updatedAt: now,
    })
    .where(eq(toolConnections.id, connection.id));
}
