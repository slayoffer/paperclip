import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, issues } from "@paperclipai/db";
import { heartbeatService } from "../../services/heartbeat.js";
import { attentionService } from "../../services/attention.js";
import { issueService } from "../../services/issues.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../../services/issue-dependency-wakeups.js";
import type { LivenessContext } from "../heartbeat-issue-liveness-escalation.test.js";

export function registerReconciliationCases(getContext: () => LivenessContext) {
  it("runs exactly one bounded review-path recovery before surfacing a stalled decision", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await getContext().db.insert(companies).values({
      id: companyId,
      name: "Review Recovery Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await getContext().db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await getContext().db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PAP-14994 fingerprint",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(getContext().db);
    const followUpRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId,
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
    });
    expect(followUpRun).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const recoveryWakes = await getContext().db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.reason, "issue_review_path_lost"),
      ));
    expect(recoveryWakes).toHaveLength(1);
    expect(recoveryWakes[0]).toMatchObject({
      status: "completed",
      payload: expect.objectContaining({
        issueId,
        reviewPathConsumedRef: "superseded-confirmation",
        reviewPathRecoveryAttempt: 1,
        maxReviewPathRecoveryAttempts: 1,
      }),
    });

    const attention = await issueService(getContext().db)
      .listReviewAttention(companyId, [{ id: issueId, companyId, status: "in_review" }]);
    expect(attention.get(issueId)).toMatchObject({ state: "stalled", paths: [] });

    const feed = await attentionService(getContext().db).list(companyId, { userId: "responsible-user" });
    expect(feed.items.find((item) => item.subject.id === issueId)).toMatchObject({
      sourceKind: "review",
      decisionVerbs: expect.arrayContaining([
        expect.objectContaining({ id: "choose_review_path", label: "Choose review path" }),
      ]),
    });
  });

  it("keeps resolved dependency wake reconciliation active", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await getContext().seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(getContext().db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await getContext().db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }) + ":release",
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await getContext().db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityId: blockedIssueId,
      details: expect.objectContaining({ source: "issue_graph_liveness.backstop" }),
    });
  });

  it("heals a blocked dependent whose done blocker has no workspace finalize obligation", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await getContext().seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(getContext().db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await getContext().db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }) + ":release",
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await getContext().db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityId: blockedIssueId });
  });

  it("reconciles a resolved blocked dependency after the assignee-null window closes", async () => {
    const { agentId, blockedIssueId, blockerIssueId } =
      await getContext().seedResolvedDependencyBackstopFixture({ workspaceState: "none", assignee: null });
    const heartbeat = heartbeatService(getContext().db);

    const beforeAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeAssignment.healed).toBe(0);
    expect(beforeAssignment.checked).toBe(0);

    await getContext().db
      .update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, blockedIssueId));

    const afterAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterAssignment.healed).toBe(1);
    expect(afterAssignment.issueIds).toEqual([blockedIssueId]);

    const wake = await getContext().db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }) + ":release",
    });
  });

}
