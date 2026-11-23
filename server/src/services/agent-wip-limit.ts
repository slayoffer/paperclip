import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { issueWipReason, RUNNABLE_WIP_REASONS } from "./agent-wip-policy.js";
import { conflict } from "../errors.js";

/**
 * Guild model v2, rule 2. A new assignment over PAPERCLIP_AGENT_WIP_LIMIT goes
 * to backlog. Typed external waits do not take a runnable slot. Human board
 * sessions and critical work are exempt.
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
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; excludeIssueId?: string | null },
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(issues)
    .where(and(
      inArray(issueWipReason(), RUNNABLE_WIP_REASONS),
      eq(issues.companyId, input.companyId),
      eq(issues.assigneeAgentId, input.agentId),
      inArray(issues.status, [...WIP_ACTIVE_STATUSES]),
      input.excludeIssueId ? ne(issues.id, input.excludeIssueId) : undefined,
    ));
  return Number(rows[0]?.n ?? 0);
}

/** True when one more active issue for this agent would exceed the limit. */
export async function agentWipFull(
  db: Pick<Db, "select">,
  actor: { type?: string; source?: string } | undefined | null,
  input: {
    companyId: string; agentId: string | null | undefined; status: unknown; excludeIssueId?: string | null; pending?: number;
    priority?: unknown;
  },
): Promise<boolean> {
  const limit = agentWipLimit();
  if (limit === null || !input.agentId || !isWipActiveStatus(input.status) || !wipLimitAppliesToActor(actor)) return false;
  // Anton, 2026-10-17: a critical assignment bypasses WIP for any actor (the escape for urgent board-key work).
  if (input.priority === "critical") return false;
  const active = await countAgentActiveIssues(db, { companyId: input.companyId, agentId: input.agentId, excludeIssueId: input.excludeIssueId });
  return active + (input.pending ?? 0) >= limit;
}

export function wipPullRefusal(limit: number): string {
  return `WIP limit reached: this agent already has ${limit} or more runnable issues. ` +
    "Finish or hand off one of them first; the next backlog issue is promoted when a slot frees.";
}

/** The same check runs on the preview and on the saved issue under the company admission lock. */
export async function applyIssueUpdateWipAdmission(
  db: Pick<Db, "select">,
  actor: { type?: string; source?: string },
  existing: { id: string; companyId: string; assigneeAgentId: string | null; status: string; priority: string },
  patch: { status?: string; priority?: string },
  requestedAssignee: string | null | undefined,
) {
  const status = patch.status ?? existing.status;
  const reassigned = requestedAssignee !== undefined && requestedAssignee !== existing.assigneeAgentId;
  const agentId = reassigned ? requestedAssignee : existing.assigneeAgentId;
  const input = { companyId: existing.companyId, agentId, status,
    priority: patch.priority ?? existing.priority, excludeIssueId: existing.id };
  if (reassigned) {
    // Blocked work retains its stop condition even when the new owner is full.
    if (status !== "blocked" && await agentWipFull(db, actor, input)) patch.status = "backlog";
  } else if (actor.type === "agent" && existing.status === "backlog" && await agentWipFull(db, actor, input)) {
    throw conflict(wipPullRefusal(agentWipLimit() ?? 0), { code: "agent_wip_limit" });
  }
}
