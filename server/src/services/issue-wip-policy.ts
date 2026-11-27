import { sql } from "drizzle-orm";
import { issueRelations, issueThreadInteractions, issues } from "@paperclipai/db";
import { issueUnblockDescriptorSchema } from "@paperclipai/shared/validators/issue-unblock";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import type { IssueWipDecision } from "@paperclipai/shared/types/company-flow";
import { namesOnlyIssueReferences } from "./blocked-state-integrity.js";
import { externalWaitDeadline } from "./external-wait.js";
import { isReviewBridgeWait } from "./review-bridge-contract.js";

/** Project evidence in the same statement that reads the assigned issue. */
export function issueWipEvidence() {
  return {
    hasExternalBlocker: sql<boolean>`exists (select 1 from ${issueRelations} r
      join ${issues} b on b.id = r.issue_id and b.company_id = r.company_id
      where r.company_id = "issues"."company_id" and r.related_issue_id = "issues"."id"
        and r.type = 'blocks' and b.status not in ('done', 'cancelled')
        and ((b.assignee_agent_id is not null
          and b.assignee_agent_id is distinct from "issues"."assignee_agent_id")
          or b.assignee_user_id is not null))`,
    hasPendingHumanCard: sql<boolean>`exists (select 1 from ${issueThreadInteractions} c
      where c.company_id = "issues"."company_id" and c.issue_id = "issues"."id"
        and c.status = 'pending' and (c.effective_resolver_policy in ('human_only', 'board_only')
          or c.addressee_user_id is not null or c.addressee_agent_id is null))`,
  };
}

export interface WipIssue {
  status: string;
  assigneeAgentId?: string | null;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  conversationAgentId?: string | null;
}

function hasNamedWait(issue: WipIssue, now: number): boolean {
  const parsed = issueUnblockDescriptorSchema.safeParse(issue.unblockDescriptor);
  const descriptor = parsed.success ? parsed.data : null;
  if (!descriptor || !descriptor.action.trim()) return false;
  if (descriptor.until && Date.parse(descriptor.until) <= now) return false;
  if (isReviewBridgeWait(descriptor)) return true;
  // A note that only repeats issue IDs cannot turn a stale or self-owned link into an outside wait.
  if (namesOnlyIssueReferences(descriptor.action)) return false;
  if (descriptor.kind === "date") return Boolean(descriptor.until && Date.parse(descriptor.until) > now);
  const deadline = externalWaitDeadline(descriptor);
  if (deadline !== null && deadline <= now) return false;
  if (descriptor.kind === "external" || descriptor.kind === "human") return true;
  // Older descriptors use owner + action. An untyped self-owned note does not establish an outside wait.
  return descriptor.owner === "board" || "userId" in descriptor.owner
    || descriptor.owner.agentId !== issue.assigneeAgentId;
}

export function classifyIssueWip(issue: WipIssue, evidence: {
  hasExternalBlocker?: boolean;
  hasPendingHumanCard?: boolean;
  hasExecution?: boolean;
} = {}, pullQueue = false, now = Date.now()): IssueWipDecision {
  if (pullQueue && issue.conversationAgentId) return { countsTowardWip: false, reason: "conversation" };
  if (issue.status === "blocked") {
    if (evidence.hasExternalBlocker) return { countsTowardWip: false, reason: "external_blocker" };
    if (evidence.hasPendingHumanCard) return { countsTowardWip: false, reason: "pending_human_card" };
    if (hasNamedWait(issue, now)) return { countsTowardWip: false, reason: "named_wait" };
    return { countsTowardWip: true, reason: "untyped_blocked" };
  }
  if (issue.status === "todo") return { countsTowardWip: true, reason: "todo" };
  if (issue.status === "in_progress") {
    return !pullQueue || evidence.hasExecution
      ? { countsTowardWip: true, reason: "in_progress" }
      : { countsTowardWip: false, reason: "inactive_in_progress" };
  }
  return { countsTowardWip: false, reason: "inactive_status" };
}
