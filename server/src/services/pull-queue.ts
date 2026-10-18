import { and, asc, eq, inArray, isNull, isNotNull, lt, sql } from "drizzle-orm";
import {
  agents, companies, heartbeatRuns, agentWakeupRequests, issues,
  issueComments, issueThreadInteractions, type Db,
} from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import type { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { countsTowardPullQueueWip, isPullQueueEnabled, issueHasExecution } from "./pull-queue-policy.js";
import { agentWipLimit } from "./agent-wip-limit.js";

type WakeupOptions = NonNullable<Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1]>;

const liveStatuses = ["queued", "running", "scheduled_retry"];
const pendingWakeStatuses = ["queued", "deferred_issue_execution"];
const terminalStatuses = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

export function isPullQueueSignal(event: LiveEvent) {
  return (event.type === "heartbeat.run.status" && terminalStatuses.includes(String(event.payload.status)))
    || (event.type === "activity.logged" && event.payload.entityType === "issue"
      && ["issue.updated", "issue.created", "issue.blockers_updated", "issue.thread_interaction_answered",
        "issue.thread_interaction_accepted", "issue.thread_interaction_rejected", "issue.thread_interaction_expired",
        "issue.thread_interaction_item_verdicts_submitted", "issue.thread_interaction_withdrawn",
        "issue.thread_interaction_cancelled", "issue.thread_interaction_skipped"].includes(String(event.payload.action)));
}

/** Select work here. Normal heartbeat admission retains all execution authority. */
export function createHeartbeatPullQueue(db: Db, dependencies: {
  wakeup: (agentId: string, options: WakeupOptions) => Promise<unknown>;
  isSuppressed: () => Promise<{ suppressed: boolean }>;
}) {
  const svc = issueService(db);
  const pending = new Set<string>();
  let active: Promise<void> | null = null;
  let stopped = false;

  async function pullCompany(companyId: string) {
    const owners = await db.select({ agent: agents }).from(agents)
      .innerJoin(companies, eq(companies.id, agents.companyId))
      .where(and(eq(agents.companyId, companyId), eq(companies.status, "active"),
        inArray(agents.status, ["idle", "active", "running"])));
    for (const { agent } of owners) {
      if (stopped || (await dependencies.isSuppressed()).suppressed) return;
      // A transaction lock serializes competing schedulers. It holds no issue
      // row locks while normal admission uses its independent transaction.
      await db.transaction(async (tx) => {
        const lock = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(
          hashtextextended(${`pull-queue:${companyId}:${agent.id}`}, 0)) as acquired`);
        if (!lock[0]?.acquired) return;
        const executions = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agent.id),
            inArray(heartbeatRuns.status, liveStatuses))).limit(1);
        const wakes = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agent.id),
            inArray(agentWakeupRequests.status, pendingWakeStatuses))).limit(1);
        if (executions.length || wakes.length) return;
        const assigned = await tx.select({ issue: issues, hasExecution: issueHasExecution() }).from(issues)
          .where(and(eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agent.id),
            isNull(issues.conversationAgentId), inArray(issues.status, ["backlog", "todo", "in_progress", "blocked"])))
          .orderBy(sql`case ${issues.priority} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`,
            asc(issues.createdAt), asc(issues.id));
        const wip = assigned.filter(({ issue, hasExecution }) => countsTowardPullQueueWip(issue, hasExecution)).length;
        const candidates = assigned.filter(({ issue, hasExecution }) => !hasExecution && !issue.monitorNextCheckAt
          && (issue.status === "todo" || (issue.status === "backlog" && wip < (agentWipLimit() ?? 3))));
        if (!candidates.length) return;
        const ids = candidates.map(({ issue }) => issue.id);
        const cards = await tx.select({ issueId: issueThreadInteractions.issueId }).from(issueThreadInteractions)
          .where(and(eq(issueThreadInteractions.companyId, companyId), inArray(issueThreadInteractions.issueId, ids),
            eq(issueThreadInteractions.status, "pending")));
        const waiting = new Set(cards.map((card) => card.issueId));
        const readiness = await svc.listDependencyReadiness(companyId, ids, tx);
        const selected = candidates.find(({ issue }) => !waiting.has(issue.id) && readiness.get(issue.id)?.isDependencyReady);
        if (!selected) return;
        const { issue } = selected;
        await dependencies.wakeup(agent.id, {
          source: "assignment", reason: "issue_assigned", requestedByActorType: "system",
          payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id, source: "pull_queue" },
          issueStateGuard: { statuses: [issue.status], statusVersion: issue.statusVersion, assigneeAgentId: agent.id },
        });
      });
    }
  }

  async function drain() {
    while (!stopped && pending.size) {
      const companyId = pending.values().next().value!;
      pending.delete(companyId);
      if (!(await dependencies.isSuppressed()).suppressed) {
        await pullCompany(companyId).catch((err) => {
          logger.error({ err, companyId }, "Pull queue selection failed. The next reconciliation will retry.");
        });
      }
    }
  }

  function notify(companyId: string): Promise<void> {
    if (stopped || !isPullQueueEnabled()) return Promise.resolve();
    pending.add(companyId);
    if (!active) active = drain().catch((err) => {
      logger.error({ err }, "Pull queue selection failed. The next reconciliation will retry.");
    }).finally(() => {
      active = null;
      if (!stopped && pending.size) void notify(pending.values().next().value!);
    });
    return active;
  }

  async function reconcile(now = new Date()) {
    if (stopped || !isPullQueueEnabled() || (await dependencies.isSuppressed()).suppressed) return;
    // Recheck the execution predicates in the atomic UPDATE. Admission takes
    // the same issue row lock, so an admitted run prevents ghost release.
    const cutoff = new Date(now.getTime() - 30 * 60_000);
    const released = await db.transaction(async (tx) => {
      const rows = await tx.update(issues).set({ status: "todo", updatedAt: now,
        statusVersion: sql`${issues.statusVersion} + 1`, checkoutRunId: null,
        executionRunId: null, executionLockedAt: null, executionAgentNameKey: null,
      }).where(and(eq(issues.status, "in_progress"), isNull(issues.conversationAgentId),
        isNotNull(issues.assigneeAgentId), isNull(issues.assigneeUserId),
        isNull(issues.monitorNextCheckAt), lt(issues.updatedAt, cutoff),
        sql`not ${issueHasExecution()}`,
        sql`not exists (select 1 from ${heartbeatRuns} r where r.company_id = "issues"."company_id"
          and (r.native_issue_id = "issues"."id"
            or r.context_snapshot->>'issueId' = "issues"."id"::text)
          and coalesce(r.finished_at, r.updated_at) >= ${cutoff.toISOString()}::timestamptz)`,
        sql`not exists (select 1 from ${agentWakeupRequests} w where w.company_id = "issues"."company_id"
          and w.payload->>'issueId' = "issues"."id"::text and w.updated_at >= ${cutoff.toISOString()}::timestamptz)`,
        sql`not exists (select 1 from ${issueThreadInteractions} c
          where c.company_id = "issues"."company_id" and c.issue_id = "issues"."id" and c.status = 'pending')`,
        sql`exists (select 1 from ${companies} c where c.id = "issues"."company_id" and c.status = 'active')`,
      )).returning({ id: issues.id, companyId: issues.companyId });
      for (const row of rows) await tx.insert(issueComments).values({ companyId: row.companyId,
        issueId: row.id, authorType: "system", body: "The scheduler returned this task to todo. No run, queued wake, or monitor existed for 30 minutes." });
      return rows;
    });
    for (const row of released) await logActivity(db, { companyId: row.companyId, actorType: "system",
      actorId: "pull-queue", action: "issue.updated", entityType: "issue", entityId: row.id,
      details: { status: "todo", reason: "pull_queue_ghost_release" } });
    const activeCompanies = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
    for (const company of activeCompanies) await notify(company.id);
  }

  return { notify, reconcile, async stop() { stopped = true; pending.clear(); await active; } };
}
