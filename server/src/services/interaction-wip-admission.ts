import { issues, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { agentWipLimit, assertIssueResultWipAdmission, readIssueWipReason, wipLimitAppliesToActor } from "./agent-wip-limit.js";
import type { InteractionActor } from "./interaction-resolution-input.js";

export type InteractionWipActor = { type?: string; source?: string };

export function interactionWipActor(actor: InteractionActor, explicitActor?: InteractionWipActor): InteractionWipActor {
  if (explicitActor) return explicitActor;
  if (actor.agentId || actor.runId) return { type: "agent" };
  if (actor.userId && !actor.systemId) return { type: "board", source: "session" };
  return { type: "system" };
}

/** Card decisions that also write issues must use the issue service's lock order. */
export async function lockInteractionIssuePrivacyForWip(
  tx: Pick<Db, "execute">,
  companyId: string,
  actor: InteractionWipActor,
) {
  if (agentWipLimit() === null || !wipLimitAppliesToActor(actor)) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${companyId}`}, 0))`);
}

/** Call before mutating any card. Complete the check after the final issue and card writes. */
export async function captureInteractionWipAdmission(
  tx: Pick<Db, "select" | "execute">,
  issue: { id: string; companyId: string },
  actor: InteractionWipActor,
) {
  if (agentWipLimit() === null || !wipLimitAppliesToActor(actor)) return null;
  const [locked] = await tx.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, issue.id))).for("update");
  if (!locked) return null;
  const before = await readIssueWipReason(tx, issue.companyId, issue.id);
  return () => assertIssueResultWipAdmission(tx, { actor, companyId: issue.companyId, issueId: issue.id, before });
}
