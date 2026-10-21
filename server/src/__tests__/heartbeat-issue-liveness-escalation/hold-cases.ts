import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { heartbeatService } from "../../services/heartbeat.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../../services/issue-dependency-wakeups.js";
import type { LivenessContext } from "../heartbeat-issue-liveness-escalation.test.js";

export function registerHoldCases(getContext: () => LivenessContext) {
  async function seedExecutionWait(status: "active" | "resolved" = "resolved") {
    const fixture = await getContext().seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const [action] = await getContext().db.insert(issueRecoveryActions).values({
      companyId: fixture.companyId, sourceIssueId: fixture.blockedIssueId,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: fixture.agentId,
      cause: "legacy_execution_requires_reconciliation", status,
      evidence: status === "resolved" ? { automaticRecovery: { replay: "blocked" } } : {},
      fingerprint: randomUUID(), nextAction: "Check the stopped execution before resuming.",
    }).returning();
    return { ...fixture, action: action! };
  }

  it.each(["active", "resolved"] as const)("keeps repeated wakes behind a %s execution hold run-free, then resumes once", async (status) => {
    const { companyId, agentId, blockedIssueId, action } = await seedExecutionWait(status);
    const heartbeat = heartbeatService(getContext().db);
    // Different producers and wake keys must not create new attempts or notices.
    await Promise.all(Array.from({ length: 6 }, (_, i) => heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      requestedByActorType: "system", requestedByActorId: "wait-regression",
      idempotencyKey: `producer-${i}`, payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId },
    })));
    for (let i = 0; i < 3; i++) {
      // Recreate the service to prove the wait is durable across scheduler restarts.
      expect(await heartbeatService(getContext().db).reconcileResolvedDependencyWakes()).toMatchObject({
        healed: 0, notReadySkipped: 1,
      });
    }
    const waits = await getContext().db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      status: "skipped", runId: null, reason: "execution_reconciliation_required", coalescedCount: 5,
      payload: { issueId: blockedIssueId, executionWait: { recoveryActionId: action.id } },
    });
    expect(await getContext().db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    expect(getContext().mockAdapterExecute).not.toHaveBeenCalled();
    expect(await getContext().db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted"),
    ))).toHaveLength(0);

    getContext().mockAdapterExecute.mockImplementationOnce(async () => {
      await getContext().db.update(issues).set({ status: "done" }).where(eq(issues.id, blockedIssueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Finished the dependency-ready task.", provider: "test", model: "test-model" };
    });
    await getContext().db.update(issueRecoveryActions).set({ status: "resolved", evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(1);
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(0);
    await heartbeat.drainActiveRunExecutions();
    expect(await getContext().db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(getContext().mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("rechecks every gate after an execution hold clears", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, action } = await seedExecutionWait();
    const wake = () => heartbeatService(getContext().db).wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      requestedByActorType: "system", requestedByActorId: "wait-regression",
      payload: { issueId: blockedIssueId }, contextSnapshot: { issueId: blockedIssueId },
    });
    await wake();
    await getContext().db.update(issues).set({ status: "todo" }).where(eq(issues.id, blockerIssueId));
    await getContext().db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    await wake();
    await wake();
    const waits = await getContext().db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(waits).toHaveLength(2);
    expect(waits.find((row) => row.reason === "issue_dependencies_blocked")?.coalescedCount).toBe(1);
    expect(await getContext().db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    await getContext().db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerIssueId));
    expect((await heartbeatService(getContext().db).reconcileResolvedDependencyWakes()).healed).toBe(1);
  });

  it("preserves distinct comments through a hold and adopts them on the next eligible wake", async () => {
    const { companyId, agentId, blockedIssueId, action } = await seedExecutionWait();
    const heartbeat = heartbeatService(getContext().db);
    const commentIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [comment] = await getContext().db.insert(issueComments).values({
        companyId, issueId: blockedIssueId, authorUserId: "board-user", body: `Follow-up ${i}`,
      }).returning();
      commentIds.push(comment!.id);
      expect(await heartbeat.wakeup(agentId, {
        source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "board-user",
        payload: { issueId: blockedIssueId, commentId: comment!.id },
        contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_commented", wakeCommentId: comment!.id },
      })).toBeNull();
    }
    const deferred = await getContext().db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(deferred).toHaveLength(2);
    expect(deferred.every((row) => row.status === "deferred_issue_execution" && row.runId === null)).toBe(true);
    expect(await getContext().db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    await getContext().db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    const resumed = await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_resumed",
      requestedByActorType: "user", requestedByActorId: "board-user",
      payload: { issueId: blockedIssueId }, contextSnapshot: { issueId: blockedIssueId },
    });
    expect(resumed?.contextSnapshot?.wakeCommentIds).toEqual(commentIds);
    const receipts = await getContext().db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(receipts.filter((row) => row.status === "coalesced")).toHaveLength(2);
  });

  it("retries a resolved dependency wake when the prior wake was skipped as stale", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await getContext().seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    // The route-time wake writes the level-triggered state key. A skip records a
    // `skipped` row with that key. `skipped` is not an in-flight status, so the
    // backstop must still re-emit for the same ready state.
    const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    await getContext().db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "skipped",
      finishedAt: new Date(),
      error: "Cancelled because issue assignee changed before the queued run could start",
      idempotencyKey,
    });

    const result = await heartbeatService(getContext().db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.existingWakeSkipped).toBe(0);

    const wakes = await getContext().db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")))
      .orderBy(agentWakeupRequests.requestedAt);

    expect(wakes).toHaveLength(2);
    expect(wakes.map((wake) => wake.status)).toContain("skipped");
    expect(wakes.map((wake) => wake.idempotencyKey)).toEqual([idempotencyKey, `${idempotencyKey}:release`]);
    expect(wakes.some((wake) => ["queued", "claimed", "completed"].includes(wake.status))).toBe(true);
  });

}
