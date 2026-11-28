import { inArray, sql } from "drizzle-orm";
import { agents, companyMemberships, issues, issueRelations, issueThreadInteractions } from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { isPullQueueEnabled, issueHasExecution } from "./pull-queue-policy.js";

export type WipReason = "todo" | "in_progress" | "active_execution" | "untyped_blocked"
  | "external_blocker" | "human_card" | "named_external_wait" | "outside_wip";

export const RUNNABLE_WIP_REASONS: readonly WipReason[] = ["todo", "in_progress", "active_execution", "untyped_blocked"];

export function isRunnableWipReason(reason: WipReason): boolean {
  return RUNNABLE_WIP_REASONS.includes(reason);
}

export function isWaitingWipReason(reason: WipReason): boolean {
  return ["external_blocker", "human_card", "named_external_wait"].includes(reason);
}

/** Classify work slots. Dependency admission still uses the upstream readiness policy. */
export function issueWipReason(pullQueue = isPullQueueEnabled(), patch?: {
  status?: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedByIssueIds?: string[];
}) {
  const status = patch?.status === undefined ? issues.status : sql`${patch.status}::text`;
  const descriptor = patch?.unblockDescriptor === undefined
    ? issues.unblockDescriptor
    : sql`(${JSON.stringify(patch.unblockDescriptor)}::jsonb)`;
  const blockerIds = patch?.blockedByIssueIds;
  const blockerSource = blockerIds === undefined
    ? sql`${issueRelations} edge join ${issues} blocker on blocker.id = edge.issue_id and blocker.company_id = edge.company_id`
    : sql`${issues} blocker`;
  const blockerMatch = blockerIds === undefined
    ? sql`edge.company_id = "issues"."company_id" and edge.related_issue_id = "issues"."id" and edge.type = 'blocks'`
    : sql`blocker.company_id = "issues"."company_id" and ${inArray(sql`blocker.id`, blockerIds)}`;

  return sql<WipReason>`case
    when ${pullQueue} and ${issues.conversationAgentId} is not null then 'outside_wip'
    when ${status} = 'todo' then 'todo'
    when ${status} = 'in_progress' then
      case when not ${pullQueue} then 'in_progress'
        when ${issueHasExecution()} then 'active_execution' else 'outside_wip' end
    when ${status} <> 'blocked' then 'outside_wip'
    when exists (
      select 1 from ${blockerSource}
      where ${blockerMatch} and blocker.status not in ('done', 'cancelled')
        and (blocker.assignee_user_id is not null or
          (blocker.assignee_agent_id is not null and blocker.assignee_agent_id <> "issues"."assignee_agent_id"))
    ) then 'external_blocker'
    when exists (
      select 1 from ${issueThreadInteractions} card
      where card.company_id = "issues"."company_id" and card.issue_id = "issues"."id"
        and card.status = 'pending' and card.addressee_agent_id is null
        and (card.effective_resolver_policy = 'human_only' or card.addressee_user_id is not null)
    ) then 'human_card'
    when jsonb_typeof(${descriptor}->'action') = 'string'
      and btrim(${descriptor}->>'action') <> ''
      and (${descriptor}->>'owner' = 'board'
        or (jsonb_typeof(${descriptor}->'owner'->'userId') = 'string'
          and exists (select 1 from ${companyMemberships} member
            where member.company_id = "issues"."company_id" and member.principal_type = 'user'
              and member.principal_id = ${descriptor}->'owner'->>'userId'
              and member.status = 'active'))
        or (jsonb_typeof(${descriptor}->'owner'->'agentId') = 'string'
          and ${descriptor}->'owner'->>'agentId' <> ${issues.assigneeAgentId}::text
          and exists (select 1 from ${agents} owner_agent
            where owner_agent.company_id = "issues"."company_id"
              and owner_agent.id::text = ${descriptor}->'owner'->>'agentId')))
      then 'named_external_wait'
    else 'untyped_blocked' end`;
}
