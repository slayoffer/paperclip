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
import { isPullQueueEnabled, issueHasExecution } from "./pull-queue-policy.js";
import { issueOwnerParkingReason } from "./issue-owner-parking.js";
import { agentWipLimit } from "./agent-wip-limit.js";
import { issueWipReason, isRunnableWipReason, isWaitingWipReason } from "./agent-wip-policy.js";
import { pullQueueCandidateBlocked, pullQueueFingerprint, pullQueueWakeWasSkipped } from "./pull-queue-state.js";

type WakeupOptions = NonNullable<Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1]>;

const liveStatuses = ["queued", "running", "scheduled_retry"];
const terminalStatuses = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

export function isPullQueueSignal(event: LiveEvent) {
  return (event.type === "heartbeat.run.status" && terminalStatuses.includes(String(event.payload.status)))
    || (event.type === "activity.logged" && event.payload.entityType === "issue"
      && ["issue.updated", "issue.created", "issue.blockers_updated", "issue.thread_interaction_answered",
        "issue.thread_interaction_accepted", "issue.thread_interaction_rejected", "issue.thread_interaction_expired",
        "issue.thread_interaction_item_verdicts_submitted", "issue.thread_interaction_withdrawn",
        "issue.thread_interaction_cancelled", "issue.thread_interaction_skipped"].includes(String(event.payload.action)));
}

/**
 * A queued wake always holds the owner's slot. A deferred wake holds it only
 * while its task is open and still assigned to that owner. Receipts for done,
 * cancelled, or reassigned tasks can stay deferred for weeks (2026-10-29:
 * 179 such receipts, the oldest 32 days, held 16 owners), so they must not
 * stop selection.
 */
function ownerHasPendingWake(companyId: string, agentId: string) {
  return sql<boolean>`exists (select 1 from ${agentWakeupRequests} w
    where w.company_id = ${companyId} and w.agent_id = ${agentId}
      and (w.status = 'queued' or (w.status = 'deferred_issue_execution'
        and (w.payload->>'issueId' is null or exists (select 1 from ${issues} task
          where task.company_id = w.company_id and task.id::text = w.payload->>'issueId'
            and task.assignee_agent_id = w.agent_id and task.status not in ('done', 'cancelled'))))))`;
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
        const [wake] = await tx.execute<{ pending: boolean }>(
          sql`select ${ownerHasPendingWake(companyId, agent.id)} as pending`);
        if (executions.length || wake?.pending) return;
        const assigned = await tx.select({ issue: issues, hasExecution: issueHasExecution(), wipReason: issueWipReason() }).from(issues)
          .where(and(eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agent.id),
            isNull(issues.conversationAgentId), inArray(issues.status, ["backlog", "todo", "in_progress", "blocked"])))
          .orderBy(sql`case ${issues.priority} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`,
            asc(issues.createdAt), asc(issues.id));
        const wip = assigned.filter(({ wipReason }) => isRunnableWipReason(wipReason)).length;
        logger.info({ companyId, agentId: agent.id, runnable: wip,
          waiting: assigned.filter(({ wipReason }) => isWaitingWipReason(wipReason)).length,
          decisions: assigned.map(({ issue, wipReason }) => ({ issueId: issue.id, reason: wipReason })),
        }, "WIP queue decision.");
        const candidates = assigned.filter(({ issue, hasExecution }) => !hasExecution && !issue.monitorNextCheckAt
          && (issue.status === "todo" || (issue.status === "backlog" && wip < (agentWipLimit() ?? 3))));
        if (!candidates.length) return;
        const ids = candidates.map(({ issue }) => issue.id);
        const cards = await tx.select({ issueId: issueThreadInteractions.issueId }).from(issueThreadInteractions)
          .where(and(eq(issueThreadInteractions.companyId, companyId), inArray(issueThreadInteractions.issueId, ids),
            eq(issueThreadInteractions.status, "pending")));
        const waiting = new Set(cards.map((card) => card.issueId));
        const readiness = await svc.listDependencyReadiness(companyId, ids, tx);
        for (const { issue } of candidates) {
          if (stopped || (await dependencies.isSuppressed()).suppressed) return;
          if (waiting.has(issue.id) || !readiness.get(issue.id)?.isDependencyReady) continue;
          const client = tx as unknown as Db;
          if (await issueOwnerParkingReason(client, issue, "pull_queue")) continue;
          const fingerprint = await pullQueueFingerprint(client, issue, agent);
          if (await pullQueueCandidateBlocked(client, issue, agent, fingerprint)) continue;
          const admitted = await dependencies.wakeup(agent.id, {
            source: "assignment", reason: "issue_assigned", requestedByActorType: "system",
            payload: { issueId: issue.id, pullQueueFingerprint: fingerprint },
            contextSnapshot: { issueId: issue.id, source: "pull_queue" },
            issueStateGuard: { statuses: [issue.status], statusVersion: issue.statusVersion, assigneeAgentId: agent.id },
          }).catch(async (err) => {
            if (!await pullQueueWakeWasSkipped(client, issue, agent, fingerprint)) throw err;
            return null;
          });
          if (admitted) return;
          // A null result can also mean deferred or coalesced admission. Check
          // its durable work before attempting another issue for this owner.
          const [busy] = await tx.execute<{ busy: boolean }>(sql`select exists (select 1 from ${heartbeatRuns}
            where company_id = ${companyId} and agent_id = ${agent.id}
              and status in ('queued', 'running', 'scheduled_retry'))
            or ${ownerHasPendingWake(companyId, agent.id)} as busy`);
          if (busy?.busy) return;
        }
      }).catch((err) => {
        logger.error({ err, companyId, agentId: agent.id },
          "Pull queue selection failed for this owner. The next reconciliation will retry.");
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
    // Admission holds the same issue row lock. After the lock wait, a separate
    // statement must see executions that admission committed during the wait.
    const cutoff = new Date(now.getTime() - 30 * 60_000);
    const released = await db.transaction(async (tx) => {
      const eligible = and(eq(issues.status, "in_progress"), isNull(issues.conversationAgentId),
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
      );
      const candidates = await tx.select({ id: issues.id }).from(issues)
        .where(eligible).orderBy(asc(issues.id)).for("update");
      if (!candidates.length) return [];
      const rows = await tx.update(issues).set({ status: "todo", updatedAt: now,
        statusVersion: sql`${issues.statusVersion} + 1`, checkoutRunId: null,
        executionRunId: null, executionLockedAt: null, executionAgentNameKey: null,
      }).where(and(inArray(issues.id, candidates.map((row) => row.id)), eligible))
        .returning({ id: issues.id, companyId: issues.companyId });
      for (const row of rows) await tx.insert(issueComments).values({ companyId: row.companyId,
        issueId: row.id, authorType: "system", body: "The scheduler returned this task to todo. No run, queued wake, or monitor existed for 30 minutes." });
      return rows;
    }, { isolationLevel: "read committed" });
    for (const row of released) await logActivity(db, { companyId: row.companyId, actorType: "system",
      actorId: "pull-queue", action: "issue.updated", entityType: "issue", entityId: row.id,
      details: { status: "todo", reason: "pull_queue_ghost_release" } });
    await cancelOrphanedDeferredWakes(now, cutoff);
    const activeCompanies = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
    for (const company of activeCompanies) await notify(company.id);
  }

  /**
   * A deferred wake runs only when the wake queue drains its issue at execution release. Many writers clear the issue's
   * execution lock without that drain, so a wake on a done or cancelled issue can be left with nothing that will ever
   * drain it (2026-10-31: 170 such rows, the oldest from 2026-09-27; SYNA-3586). Cancel it once the issue is closed,
   * holds no execution lock, has no live run, and the wake has not changed for 30 minutes. A wake on a closed issue whose
   * run still holds the lock stays: that run's release drains it (a closing comment can reopen the issue).
   */
  async function cancelOrphanedDeferredWakes(now: Date, cutoff: Date) {
    const rows = await db.update(agentWakeupRequests)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now,
        error: "Issue closed with no execution left to drain this deferred wake" })
      .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"), lt(agentWakeupRequests.updatedAt, cutoff),
        sql`exists (select 1 from ${issues} task where task.company_id = ${agentWakeupRequests.companyId}
          and task.id::text = ${agentWakeupRequests.payload}->>'issueId'
          and task.status in ('done', 'cancelled') and task.execution_run_id is null
          and not exists (select 1 from ${heartbeatRuns} r where r.company_id = task.company_id
            and (r.native_issue_id = task.id or r.context_snapshot->>'issueId' = task.id::text)
            and r.status in ('queued', 'running', 'scheduled_retry')))`))
      .returning({ id: agentWakeupRequests.id });
    if (rows.length) logger.info({ count: rows.length }, "Pull queue cancelled deferred wakes of closed issues");
  }

  return { notify, reconcile, async stop() { stopped = true; pending.clear(); await active; } };
}
