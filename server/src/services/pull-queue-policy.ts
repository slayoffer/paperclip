import { sql } from "drizzle-orm";
import { heartbeatRuns, agentWakeupRequests } from "@paperclipai/db";

/** Leave the existing watchdog active until operators qualify this scheduler. */
export function isPullQueueEnabled() {
  return process.env.PAPERCLIP_PULL_QUEUE_ENABLED === "true";
}
export function issueHasExecution() {
  return sql<boolean>`(exists (select 1 from ${heartbeatRuns} r
    where r.company_id = "issues"."company_id"
      and (r.native_issue_id = "issues"."id"
        or r.context_snapshot->>'issueId' = "issues"."id"::text)
      and r.status in ('queued', 'running', 'scheduled_retry'))
    or exists (select 1 from ${agentWakeupRequests} w
      where w.company_id = "issues"."company_id"
        and w.payload->>'issueId' = "issues"."id"::text
        and w.status in ('queued', 'deferred_issue_execution')))`;
}
