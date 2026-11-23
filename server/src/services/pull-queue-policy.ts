import { sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { boundRunIssueIdSql } from "./run-task-binding.js";

/** The guarded queue remains opt-in through the fork's existing switch. */
export function isPullQueueEnabled() {
  return process.env.PAPERCLIP_PULL_QUEUE_ENABLED === "true";
}

export function issueHasLiveRun() {
  return sql<boolean>`exists (select 1 from ${heartbeatRuns}
    where ${heartbeatRuns.companyId} = ${issues.companyId}
      and ${boundRunIssueIdSql()} = ${issues.id}::text
      and ${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry'))`;
}

export function issueHasUnsettledNativeRun() {
  return sql<boolean>`exists (select 1 from ${nativeRunFinalizations}
    where ${nativeRunFinalizations.companyId} = ${issues.companyId}
      and ${nativeRunFinalizations.issueId} = ${issues.id}
      and (${nativeRunFinalizations.leaseOwner} is not null
        or ${nativeRunFinalizations.phase} not in ('committed', 'applied', 'terminal_failure')))`;
}

export function issueHasExecution() {
  return sql<boolean>`(${issueHasLiveRun()} or exists (select 1 from ${agentWakeupRequests}
    where ${agentWakeupRequests.companyId} = ${issues.companyId}
      and ${agentWakeupRequests.payload}->>'issueId' = ${issues.id}::text
      and (${agentWakeupRequests.status} = 'queued'
        or (${agentWakeupRequests.status} = 'deferred_issue_execution'
          and ${agentWakeupRequests.agentId} = ${issues.assigneeAgentId}))))`;
}
