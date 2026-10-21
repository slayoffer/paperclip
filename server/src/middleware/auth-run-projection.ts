import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

export async function readAgentAuthenticationRun(db: Db, claims: { run_id: string; company_id: string; sub: string }) {
  const [run] = await db.select({
    activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
    responsibleUserId: heartbeatRuns.responsibleUserId,
    status: heartbeatRuns.status,
    writesRevoked: heartbeatRuns.writesRevoked,
    conversationMode: heartbeatRuns.conversationMode,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, claims.run_id), eq(heartbeatRuns.companyId, claims.company_id), eq(heartbeatRuns.agentId, claims.sub),
  ));
  return run;
}
