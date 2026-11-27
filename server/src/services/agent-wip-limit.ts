import { and, eq, inArray, ne } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { isPullQueueEnabled, issueHasExecution } from "./pull-queue-policy.js";
import { classifyIssueWip, issueWipEvidence } from "./issue-wip-policy.js";
import { logger } from "../middleware/logger.js";

/**
 * Agent WIP limit (synthiq fork, Guild model v2 rule 2, 2026-10-17). With PAPERCLIP_AGENT_WIP_LIMIT=N, a NEW assignment
 * that would give an agent more than N runnable issues is stored in `backlog`, which skips the
 * assignment wake. An agent that moves its own backlog issue to an active status over the limit gets 409. Existing load
 * is untouched. A person in the board UI (browser session) is not limited, and a `critical` issue is never deferred. The promote step that moves the next backlog
 * issue to `todo` when a slot frees lives outside the server (the homelab watchdog).
 * Typed outside waits do not use a slot. Untyped blocked work still uses a slot.
 * PAPERCLIP_PULL_QUEUE_ENABLED also checks execution state for in_progress work.
 */
export const WIP_ACTIVE_STATUSES = ["todo", "in_progress", "blocked"] as const;

export function isWipActiveStatus(status: unknown): boolean {
  return typeof status === "string" && (WIP_ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function agentWipLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.PAPERCLIP_AGENT_WIP_LIMIT?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

export function wipLimitAppliesToActor(actor: { type?: string; source?: string } | undefined | null): boolean {
  if (!actor) return false;
  return !(actor.type === "board" && (actor.source === "session" || actor.source === "local_implicit"));
}

export async function countAgentActiveIssues(
  db: Db,
  input: { companyId: string; agentId: string; excludeIssueId?: string | null },
): Promise<number> {
  return (await getAgentWipCounts(db, input)).runnable;
}

export async function getAgentWipCounts(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; excludeIssueId?: string | null },
) {
  const pullQueue = isPullQueueEnabled();
  const rows = await db
    .select({
      id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
      unblockDescriptor: issues.unblockDescriptor, conversationAgentId: issues.conversationAgentId,
      hasExecution: pullQueue ? issueHasExecution() : issues.executionRunId,
      ...issueWipEvidence(),
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.assigneeAgentId, input.agentId),
      inArray(issues.status, [...WIP_ACTIVE_STATUSES]),
      input.excludeIssueId ? ne(issues.id, input.excludeIssueId) : undefined,
    ));
  const now = Date.now();
  const decisions = rows.map(row => ({ issueId: row.id,
    ...classifyIssueWip(row, { ...row, hasExecution: Boolean(row.hasExecution) }, pullQueue, now) }));
  const counts = {
    runnable: decisions.filter(row => row.countsTowardWip).length,
    waiting: decisions.filter(row => ["external_blocker", "pending_human_card", "named_wait"].includes(row.reason)).length,
    untypedBlocked: decisions.filter(row => row.reason === "untyped_blocked").length,
  };
  logger.info({ event: "agent_wip_count", ...input, ...counts, decisions }, "Counted owner work for WIP admission");
  return counts;
}

/** True when one more active issue for this agent would exceed the limit. */
export async function agentWipFull(
  db: Db,
  actor: { type?: string; source?: string } | undefined | null,
  input: {
    companyId: string; agentId: string | null | undefined; status: unknown; excludeIssueId?: string | null; pending?: number;
    priority?: unknown;
  },
): Promise<boolean> {
  const limit = agentWipLimit();
  const bypassReason = limit === null ? "limit_disabled" : !input.agentId ? "no_agent"
    : !isWipActiveStatus(input.status) ? "inactive_status" : !wipLimitAppliesToActor(actor) ? "board_exempt"
      : input.priority === "critical" ? "critical_priority" : null;
  // Anton, 2026-10-17: a critical assignment bypasses WIP for any actor (the escape for urgent board-key work).
  if (bypassReason) {
    logger.info({ event: "agent_wip_decision", ...input, limit, full: false, reason: bypassReason }, "Allowed work at the WIP gate");
    return false;
  }
  const active = await countAgentActiveIssues(db, { companyId: input.companyId, agentId: input.agentId!, excludeIssueId: input.excludeIssueId });
  const full = active + (input.pending ?? 0) >= limit!;
  logger.info({ event: "agent_wip_decision", ...input, limit, runnable: active, full,
    reason: full ? "owner_at_wip_limit" : "owner_has_slot" }, "Checked owner WIP capacity");
  return full;
}

export function wipPullRefusal(limit: number): string {
  return `WIP limit reached: this agent already has ${limit} or more runnable issues, including untyped blocked work. ` +
    "Finish or hand off one of them first; the next backlog issue is promoted when a slot frees.";
}
