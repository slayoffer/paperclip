import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

export const SSH_IN_PLACE_TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

export async function isSshInPlaceOwnerRunTerminal(db: Db, companyId: string, runId: string | null): Promise<boolean> {
  if (!runId) return false;
  const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId),
  )).limit(1);
  return Boolean(rows[0] && SSH_IN_PLACE_TERMINAL_RUN_STATUSES.includes(rows[0].status));
}
