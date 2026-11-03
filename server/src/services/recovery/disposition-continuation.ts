import { and, eq } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { resolveTimerDriverIssueId } from "../heartbeat/timer-driver-issue.js";
import { createHeartbeatTimerPolicy } from "../heartbeat/timer-policy.js";
import { supportsUnscopedTimerHeartbeat } from "../heartbeat-policy.js";
import type { issueService } from "../issues.js";

export async function hasStandingTimerContinuation(
  db: Db,
  issuesSvc: Pick<ReturnType<typeof issueService>, "listDependencyReadiness">,
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "status" | "assigneeAgentId">,
): Promise<boolean> {
  if (issue.status !== "in_progress" || !issue.assigneeAgentId) return false;
  const [agent] = await db.select().from(agents).where(and(
    eq(agents.companyId, issue.companyId), eq(agents.id, issue.assigneeAgentId),
  )).limit(1);
  if (!agent || !supportsUnscopedTimerHeartbeat(agent) ||
      !(await evaluateAgentInvokabilityFromDb(db, agent)).invokable) return false;
  if (await createHeartbeatTimerPolicy(db).nextTimerHeartbeatAt(agent) === null) return false;
  return await resolveTimerDriverIssueId(db, issuesSvc, agent) === issue.id;
}
