import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issueRelations, issues } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";
import { blockedStateIntegrityEnabled, blockedWaitFacts } from "./blocked-state-integrity.js";
import { buildIssueBlockersResolvedWakeStateKey, findExistingIssueBlockersResolvedWakeForReadyState,
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON } from "./issue-dependency-wakeups.js";
import { logger } from "../middleware/logger.js";
import { getWakeableParentAfterChildCompletion } from "./issue-parent-completion.js";

type EnqueueWakeup = ReturnType<typeof heartbeatService>["wakeup"];
const pending = "pending_dependency_dispatch";
const dispatching = "dispatching_dependency";
const actor = "blocked-dependency-release";

/** The issue row lock serializes one durable intent per released blocked cycle. */
export async function persistDependencyReleaseWake(tx: Db, issue: typeof issues.$inferSelect, resolvedBlockerIssueId: string) {
  if (!issue.assigneeAgentId) return null;
  const relations = await tx.select({ id: issueRelations.issueId }).from(issueRelations).where(and(
    eq(issueRelations.companyId, issue.companyId), eq(issueRelations.relatedIssueId, issue.id),
    eq(issueRelations.type, "blocks"),
  ));
  const blockerIssueIds = relations.map(row => row.id);
  const key = buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: issue.id,
    blockerIssueIds, blockedTransitionAt: issue.blockedTransitionAt });
  const [intent] = await tx.insert(agentWakeupRequests).values({
    companyId: issue.companyId, agentId: issue.assigneeAgentId, source: "automation", triggerDetail: "system",
    reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON, status: pending,
    requestedByActorType: "system", requestedByActorId: actor, idempotencyKey: `dependency-release:${key}`,
    payload: { issueId: issue.id, blockerIssueIds, resolvedBlockerIssueId,
      blockedTransitionAt: issue.blockedTransitionAt?.toISOString() ?? null,
      releaseStatusVersion: issue.statusVersion + 1 },
  }).returning({ id: agentWakeupRequests.id });
  return intent!.id;
}

/** Dispatch only committed intents. A failed dispatch or expired lease remains recoverable. */
export async function dispatchPendingDependencyReleaseWakes(
  db: Db, enqueueWakeup: EnqueueWakeup,
  opts?: { companyId?: string | null; blockerIssueId?: string | null; intentId?: string },
) {
  const result = { checked: 0, healed: 0, deferredOrFailed: 0, enqueueFailed: 0, issueIds: [] as string[] };
  if (!blockedStateIntegrityEnabled()) return result;
  const staleAt = new Date(Date.now() - 60_000);
  const eligible = or(eq(agentWakeupRequests.status, pending), and(
    eq(agentWakeupRequests.status, dispatching), lte(agentWakeupRequests.updatedAt, staleAt),
  ));
  const candidates = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.requestedByActorType, "system"), eq(agentWakeupRequests.requestedByActorId, actor), eligible,
    opts?.companyId ? eq(agentWakeupRequests.companyId, opts.companyId) : undefined,
    opts?.intentId ? eq(agentWakeupRequests.id, opts.intentId) : undefined,
    opts?.blockerIssueId ? sql`${agentWakeupRequests.payload}->'blockerIssueIds' ? ${opts.blockerIssueId}` : undefined,
  )).orderBy(asc(agentWakeupRequests.updatedAt), asc(agentWakeupRequests.id)).limit(500);
  for (const intent of candidates) {
    const claimedAt = new Date();
    const [claimed] = await db.update(agentWakeupRequests).set({ status: dispatching, updatedAt: claimedAt })
      .where(and(eq(agentWakeupRequests.id, intent.id), eq(agentWakeupRequests.companyId, intent.companyId), eligible))
      .returning({ id: agentWakeupRequests.id });
    if (!claimed) continue;
    result.checked++;
    const claimedRow = and(eq(agentWakeupRequests.id, intent.id), eq(agentWakeupRequests.companyId, intent.companyId),
      eq(agentWakeupRequests.status, dispatching), eq(agentWakeupRequests.updatedAt, claimedAt));
    const settle = (status: string) => db.update(agentWakeupRequests).set({ status, updatedAt: new Date(),
      finishedAt: status === pending ? null : new Date() }).where(claimedRow);
    try {
      const payload = intent.payload ?? {};
      const issueId = String(payload.issueId);
      const [issue] = await db.select().from(issues).where(and(
        eq(issues.companyId, intent.companyId), eq(issues.id, issueId),
      ));
      if (!issue || issue.status !== "todo" || issue.hiddenAt || issue.conversationAgentId
        || issue.assigneeAgentId !== intent.agentId || issue.statusVersion !== payload.releaseStatusVersion) {
        await settle("cancelled");
        continue;
      }
      const { issueService } = await import("./issues.js");
      const readiness = (await issueService(db).listDependencyReadiness(intent.companyId, [issueId])).get(issueId);
      const wait = await blockedWaitFacts(db, issue, issue.unblockDescriptor);
      if (!readiness?.isDependencyReady || wait.hasTarget || wait.outside) {
        await settle(pending);
        result.deferredOrFailed++;
        continue;
      }
      const blockerIssueIds = readiness.blockerIssueIds;
      const state = { companyId: intent.companyId, dependentIssueId: issueId, blockerIssueIds,
        blockedTransitionAt: issue.blockedTransitionAt };
      if (await findExistingIssueBlockersResolvedWakeForReadyState(db, state)) {
        await settle("completed_dependency_dispatch");
        continue;
      }
      const resolvedBlockerIssueId = typeof payload.resolvedBlockerIssueId === "string"
        ? payload.resolvedBlockerIssueId : blockerIssueIds[0];
      const parent = resolvedBlockerIssueId ? await getWakeableParentAfterChildCompletion(db, issueId,
        { issueId: resolvedBlockerIssueId, summary: null }, true) : null;
      const childContext = parent?.childIssueIds.includes(resolvedBlockerIssueId!) ? {
        completedChildIssueId: resolvedBlockerIssueId,
        childIssueIds: parent.childIssueIds,
        childIssueSummaries: parent.childIssueSummaries,
        onboardingCompletion: parent.onboardingCompletion,
        childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
      } : {};
      const reason = parent?.childIssueIds.includes(resolvedBlockerIssueId!)
        ? "issue_children_completed" : ISSUE_BLOCKERS_RESOLVED_WAKE_REASON;
      const wake = await enqueueWakeup(intent.agentId, {
        source: "automation", triggerDetail: "system", reason,
        payload: { issueId, resolvedBlockerIssueId, blockerIssueIds, ...childContext },
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey(state),
        requestedByActorType: "system", requestedByActorId: `dependency-release-dispatch:${intent.id}`,
        issueStateGuard: { statuses: ["todo"], assigneeAgentId: intent.agentId, statusVersion: issue.statusVersion },
        contextSnapshot: { issueId, taskId: issueId, wakeReason: reason,
          source: "blocked_dependency_release", resolvedBlockerIssueId, blockerIssueIds, ...childContext },
      });
      if (wake || await findExistingIssueBlockersResolvedWakeForReadyState(db, state)) {
        await settle("completed_dependency_dispatch");
        if (wake) { result.healed++; result.issueIds.push(issueId); }
      } else {
        await settle(pending);
        result.deferredOrFailed++;
      }
    } catch (err) {
      await settle(pending);
      result.deferredOrFailed++;
      result.enqueueFailed++;
      logger.warn({ err, intentId: intent.id }, "dependency release wake deferred to recovery");
    }
  }
  return result;
}
