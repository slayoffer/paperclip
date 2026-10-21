import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, issues } from "@paperclipai/db";
import { heartbeatService } from "../../services/heartbeat.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../../services/issue-dependency-wakeups.js";
import type { LivenessContext } from "../heartbeat-issue-liveness-escalation.test.js";

export function registerReconciliationCases(getContext: () => LivenessContext) {
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
