import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

import { boundRunIssueIdSql } from "./run-task-binding.js";

export function listNewerAgentRunActivity(db: Db, companyId: string, agentIds: string[], since: Date) {
  if (!agentIds.length) return Promise.resolve([]);
  return db.select({
    agentId: heartbeatRuns.agentId, createdAt: heartbeatRuns.createdAt,
    runIssueId: boundRunIssueIdSql(), runTaskId: sql<null>`null`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.agentId, agentIds),
    gt(heartbeatRuns.createdAt, since),
  ));
}
