import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";

/**
 * Agent WIP limit (synthiq fork, Guild model v2 rule 2, 2026-10-17). With PAPERCLIP_AGENT_WIP_LIMIT=N, a NEW assignment
 * that would give an agent more than N active issues (todo, in_progress, blocked) is stored in `backlog`, which skips the
 * assignment wake. An agent that moves its own backlog issue to an active status over the limit gets 409. Existing load
 * is untouched. A person in the board UI (browser session) is not limited, and a `critical` issue is never deferred. The promote step that moves the next backlog
 * issue to `todo` when a slot frees lives outside the server (the homelab watchdog).
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
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.assigneeAgentId, input.agentId),
      inArray(issues.status, [...WIP_ACTIVE_STATUSES]),
      input.excludeIssueId ? ne(issues.id, input.excludeIssueId) : undefined,
    ));
  return Number(rows[0]?.n ?? 0);
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
  if (limit === null || !input.agentId || !isWipActiveStatus(input.status) || !wipLimitAppliesToActor(actor)) return false;
  // Anton, 2026-10-17: a critical assignment bypasses WIP for any actor (the escape for urgent board-key work).
  if (input.priority === "critical") return false;
  const active = await countAgentActiveIssues(db, { companyId: input.companyId, agentId: input.agentId, excludeIssueId: input.excludeIssueId });
  return active + (input.pending ?? 0) >= limit;
}

export function wipPullRefusal(limit: number): string {
  return `WIP limit reached: this agent already has ${limit} or more active issues (todo, in_progress, blocked). ` +
    "Finish or hand off one of them first; the next backlog issue is promoted when a slot frees.";
}
