import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { issueRelations, issues, type Db } from "@paperclipai/db";
import { issueWipReason, isRunnableWipReason, RUNNABLE_WIP_REASONS, type WipReason } from "./agent-wip-policy.js";
import { conflict } from "../errors.js";
import { tryLockPullQueueOwner } from "./pull-queue-owner-lock.js";

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
    tryAcquireAdmissionLock?: (agentId: string) => Promise<boolean>;
  },
): Promise<boolean> {
  const limit = agentWipLimit();
  if (limit === null || !input.agentId || !isWipActiveStatus(input.status) || !wipLimitAppliesToActor(actor)) return false;
  // Anton, 2026-10-17: a critical assignment bypasses WIP for any actor (the escape for urgent board-key work).
  if (input.priority === "critical") return false;
  if (input.tryAcquireAdmissionLock && !await input.tryAcquireAdmissionLock(input.agentId)) return true;
  const active = await countAgentActiveIssues(db, { companyId: input.companyId, agentId: input.agentId, excludeIssueId: input.excludeIssueId });
  return active + (input.pending ?? 0) >= limit;
}

export function wipPullRefusal(limit: number): string {
  return `WIP limit reached: this agent already has ${limit} or more runnable issues. ` +
    "Finish or hand off one of them first; the next backlog issue is promoted when a slot frees.";
}

/** The reassignment fallback needs a status before the issue write. */
export async function applyIssueReassignmentWipFallback(
  db: Pick<Db, "select">,
  actor: { type?: string; source?: string },
  existing: { id: string; companyId: string; assigneeAgentId: string | null; status: string; priority: string },
  patch: { status?: string; priority?: string },
  requestedAssignee: string | null | undefined,
  tryAcquireAdmissionLock?: (agentId: string) => Promise<boolean>,
) {
  const status = patch.status ?? existing.status;
  // Blocked work retains its stop condition even when the new owner is full.
  if (!requestedAssignee || requestedAssignee === existing.assigneeAgentId || status === "blocked") return;
  if (await agentWipFull(db, actor, {
    companyId: existing.companyId,
    agentId: requestedAssignee,
    status,
    priority: patch.priority ?? existing.priority,
    excludeIssueId: existing.id,
    tryAcquireAdmissionLock,
  })) patch.status = "backlog";
}

/** Read this snapshot while the issue row is locked and before mutating it. */
export async function readIssueWipReason(
  db: Pick<Db, "select">,
  companyId: string,
  issueId: string,
): Promise<WipReason | null> {
  const [issue] = await db.select({ reason: issueWipReason() }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  return issue?.reason ?? null;
}

/** Lock blocked dependents before the mutation that may release their external wait. */
export async function readDependentIssueWipReasons(
  tx: Pick<Db, "select">,
  companyId: string,
  issueId: string,
): Promise<Array<{ issueId: string; before: WipReason }>> {
  const dependents = await tx.select({ id: issues.id }).from(issues)
    .innerJoin(issueRelations, and(
      eq(issueRelations.companyId, issues.companyId),
      eq(issueRelations.relatedIssueId, issues.id),
    ))
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.status, "blocked"),
      isNotNull(issues.assigneeAgentId),
      eq(issueRelations.issueId, issueId),
      eq(issueRelations.type, "blocks"),
    ))
    .orderBy(asc(issues.id))
    .for("update", { of: issues });
  if (!dependents.length) return [];

  const snapshots = await tx.select({ issueId: issues.id, before: issueWipReason() }).from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, dependents.map(({ id }) => id))))
    .orderBy(asc(issues.id));
  return snapshots.filter(({ before }) => !isRunnableWipReason(before));
}

/** Reject new runnable work before committing the mutation that produced it. */
export async function assertIssueResultWipAdmission(
  tx: Pick<Db, "select" | "execute">,
  input: {
    actor: { type?: string; source?: string };
    companyId: string;
    issueId: string;
    before: WipReason | null;
  },
): Promise<void> {
  const { actor, companyId, issueId, before } = input;
  const limit = agentWipLimit();
  if (limit === null || !wipLimitAppliesToActor(actor) || before === null || isRunnableWipReason(before)) return;
  const [result] = await tx.select({
    reason: issueWipReason(),
    agentId: issues.assigneeAgentId,
    priority: issues.priority,
    status: issues.status,
  }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (!result || !isRunnableWipReason(result.reason)) return;
  if (await agentWipFull(tx, actor, {
    companyId,
    agentId: result.agentId,
    status: result.status,
    priority: result.priority,
    excludeIssueId: issueId,
    tryAcquireAdmissionLock: (agentId) => tryLockPullQueueOwner(tx, companyId, agentId),
  })) {
    throw conflict(wipPullRefusal(limit), { code: "agent_wip_limit" });
  }
}
