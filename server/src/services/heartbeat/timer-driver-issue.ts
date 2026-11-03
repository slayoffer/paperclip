import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import type { issueService } from "../issues.js";

/**
 * runtimeConfig.heartbeat.driverIssueId (an id or identifier) gives an agent's timer runs a source issue. A timer run
 * without one cannot write any issue: the cross-issue influence limit needs a source issue (PM·Codex, 2026-11-01: every
 * status change and its own driver renewal got 403 cross_issue_influence_run_context_required). The driver applies only
 * while it is assigned to the agent, open, and free of unresolved blockers (a blocked issue would cancel the timer run).
 * Writes to other issues still count against the per-run cross-issue cap.
 */
export async function resolveTimerDriverIssueId(
  db: Db,
  issuesSvc: Pick<ReturnType<typeof issueService>, "listDependencyReadiness">,
  agent: typeof agents.$inferSelect,
): Promise<string | null> {
  const raw = parseObject(parseObject(agent.runtimeConfig).heartbeat).driverIssueId;
  const ref = typeof raw === "string" ? raw.trim() : "";
  if (!ref) return null;
  const driver = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, agent.companyId),
      eq(issues.assigneeAgentId, agent.id),
      notInArray(issues.status, ["done", "cancelled"]),
      isUuidLike(ref) ? eq(issues.id, ref) : sql`upper(${issues.identifier}) = ${ref.toUpperCase()}`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!driver) return null;
  const readiness = (await issuesSvc.listDependencyReadiness(agent.companyId, [driver.id])).get(driver.id);
  return (readiness?.unresolvedBlockerCount ?? 0) > 0 ? null : driver.id;
}
