import { and, eq, gt, inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

export function listNewerAgentRunActivity(db: Db, companyId: string, agentIds: string[], since: Date) {
  if (!agentIds.length) return Promise.resolve([]);
  return db.select({
    agentId: heartbeatRuns.agentId, createdAt: heartbeatRuns.createdAt,
    runIssueId: heartbeatRuns.contextIssueId, runTaskId: heartbeatRuns.contextTaskId,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.agentId, agentIds),
    gt(heartbeatRuns.createdAt, since),
  ));
}
