import { sql } from "drizzle-orm";
import { agents, companyMemberships, issues, issueRelations, issueThreadInteractions } from "@paperclipai/db";
import { isPullQueueEnabled, issueHasExecution } from "./pull-queue-policy.js";

export type WipReason = "todo" | "in_progress" | "active_execution" | "untyped_blocked"
  | "external_blocker" | "human_card" | "named_external_wait" | "outside_wip";

export function isRunnableWipReason(reason: WipReason): boolean {
  return ["todo", "in_progress", "active_execution", "untyped_blocked"].includes(reason);
}

export function isWaitingWipReason(reason: WipReason): boolean {
  return ["external_blocker", "human_card", "named_external_wait"].includes(reason);
}

/** Use the same company-scoped evidence for admission, selection, and reports. */
export function issueWipReason(pullQueue = isPullQueueEnabled()) {
  return sql<WipReason>`case
    when ${pullQueue} and ${issues.conversationAgentId} is not null then 'outside_wip'
    when ${issues.status} = 'todo' then 'todo'
    when ${issues.status} = 'in_progress' then
      case when not ${pullQueue} then 'in_progress'
        when ${issueHasExecution()} then 'active_execution' else 'outside_wip' end
    when ${issues.status} <> 'blocked' then 'outside_wip'
    when exists (
      select 1 from ${issueRelations} edge
      join ${issues} blocker on blocker.id = edge.issue_id and blocker.company_id = edge.company_id
      where edge.company_id = "issues"."company_id" and edge.related_issue_id = "issues"."id"
        and edge.type = 'blocks' and blocker.status not in ('done', 'cancelled')
        and (blocker.assignee_user_id is not null or
          (blocker.assignee_agent_id is not null and blocker.assignee_agent_id <> "issues"."assignee_agent_id"))
    ) then 'external_blocker'
    when exists (
      select 1 from ${issueThreadInteractions} card
      where card.company_id = "issues"."company_id" and card.issue_id = "issues"."id"
        and card.status = 'pending' and card.addressee_agent_id is null
        and (card.effective_resolver_policy = 'human_only' or card.addressee_user_id is not null)
    ) then 'human_card'
    when jsonb_typeof(${issues.unblockDescriptor}->'action') = 'string'
      and btrim(${issues.unblockDescriptor}->>'action') <> ''
      and (${issues.unblockDescriptor}->>'owner' = 'board'
        or (jsonb_typeof(${issues.unblockDescriptor}->'owner'->'userId') = 'string'
          and exists (select 1 from ${companyMemberships} member
            where member.company_id = "issues"."company_id" and member.principal_type = 'user'
              and member.principal_id = ${issues.unblockDescriptor}->'owner'->>'userId'
              and member.status = 'active'))
        or (jsonb_typeof(${issues.unblockDescriptor}->'owner'->'agentId') = 'string'
          and ${issues.unblockDescriptor}->'owner'->>'agentId' <> ${issues.assigneeAgentId}::text
          and exists (select 1 from ${agents} owner_agent
            where owner_agent.company_id = "issues"."company_id"
              and owner_agent.id::text = ${issues.unblockDescriptor}->'owner'->>'agentId')))
      then 'named_external_wait'
    else 'untyped_blocked' end`;
}
