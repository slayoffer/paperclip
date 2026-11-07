import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agents, heartbeatRuns, issues, workspaceOperations } from "@paperclipai/db";
import { heartbeatService } from "../../services/heartbeat.js";
import type { LivenessContext } from "../heartbeat-issue-liveness-escalation.test.js";

export function registerSelfBlockCases(getContext: () => LivenessContext) {
  it("does not re-wake an assignee agent that opened the current blocked cycle itself", async () => {
    const { companyId, agentId, blockedIssueId } =
      await getContext().seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await getContext().db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await getContext().db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: blockedIssueId,
      details: { status: "blocked", changes: { status: { from: "in_progress", to: "blocked" } } },
      createdAt: blockedTransitionAt,
    });

    const result = await heartbeatService(getContext().db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.selfBlockedSkipped).toBe(1);
  });

  it("heals a self-blocked issue after a later board edit in the same blocked cycle", async () => {
    const { companyId, agentId, blockedIssueId } =
      await getContext().seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await getContext().db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await getContext().db.insert(activityLog).values([
      {
        companyId, actorType: "agent", actorId: agentId, agentId, action: "issue.updated",
        entityType: "issue", entityId: blockedIssueId, details: { status: "blocked" }, createdAt: blockedTransitionAt,
      },
      {
        companyId, actorType: "user", actorId: "board-user", action: "issue.updated",
        entityType: "issue", entityId: blockedIssueId, details: { blockedByIssueIds: [] },
        createdAt: new Date("2026-08-01T12:05:00.000Z"),
      },
    ]);

    const result = await heartbeatService(getContext().db).reconcileResolvedDependencyWakes();

    expect(result.selfBlockedSkipped).toBe(0);
    expect(result.healed).toBe(1);
  });

  it.each(["title", "monitorNotes"])("preserves an assignee block after an unrelated %s edit", async (field) => {
    const { companyId, agentId, blockedIssueId } =
      await getContext().seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await getContext().db.update(issues).set({ blockedTransitionAt }).where(eq(issues.id, blockedIssueId));
    await getContext().db.insert(activityLog).values([
      { companyId, actorType: "agent", actorId: agentId, agentId, action: "issue.updated",
        entityType: "issue", entityId: blockedIssueId, details: { status: "blocked" }, createdAt: blockedTransitionAt },
      { companyId, actorType: "user", actorId: "board-user", action: "issue.updated",
        entityType: "issue", entityId: blockedIssueId, details: { changes: { [field]: { from: "old", to: "new" } } },
        createdAt: new Date("2026-08-01T12:05:00.000Z") },
    ]);
    const result = await heartbeatService(getContext().db).reconcileResolvedDependencyWakes();
    expect(result.healed).toBe(0);
    expect(result.selfBlockedSkipped).toBe(1);
  });

  it.each([true, false])("checks the native blocked decision run owner (assignee: %s)", async (sameOwner) => {
    const { companyId, agentId, blockedIssueId } =
      await getContext().seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await getContext().db.update(issues).set({ blockedTransitionAt }).where(eq(issues.id, blockedIssueId));
    const otherAgentId = randomUUID();
    if (!sameOwner) await getContext().db.insert(agents).values({ id: otherAgentId, companyId, name: "Other agent", role: "engineer", status: "idle", adapterType: "process" });
    const [run] = await getContext().db.insert(heartbeatRuns).values({ companyId, agentId: sameOwner ? agentId : otherAgentId,
      issueId: blockedIssueId, status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: blockedIssueId } }).returning();
    await getContext().db.insert(activityLog).values({ companyId, actorType: "system", actorId: "native-status-committer",
      runId: run.id, action: "issue.updated", entityType: "issue", entityId: blockedIssueId,
      details: { source: "native_status_decision", fromStatus: "in_progress", toStatus: "blocked" }, createdAt: blockedTransitionAt });
    const result = await heartbeatService(getContext().db).reconcileResolvedDependencyWakes();
    expect(result.healed).toBe(sameOwner ? 0 : 1);
    expect(result.selfBlockedSkipped).toBe(sameOwner ? 1 : 0);
  });

  it.each(["completion", "finalize"] as const)("heals a self-block after later blocker %s", async (event) => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId } =
      await getContext().seedResolvedDependencyBackstopFixture({ workspaceState: event === "finalize" ? "not_finalized" : "none" });
    const blockedTransitionAt = new Date(Date.now() - 120_000);
    const completedAt = new Date();
    await getContext().db.update(issues).set({ blockedTransitionAt }).where(eq(issues.id, blockedIssueId));
    await getContext().db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentId, agentId,
      action: "issue.updated", entityType: "issue", entityId: blockedIssueId, details: { status: "blocked" }, createdAt: blockedTransitionAt });
    if (event === "completion") await getContext().db.update(issues).set({ completedAt }).where(eq(issues.id, blockerIssueId));
    else await getContext().db.insert(workspaceOperations).values({ companyId, executionWorkspaceId, issueId: blockerIssueId,
      phase: "workspace_finalize", status: "succeeded", startedAt: completedAt, finishedAt: completedAt });
    const result = await heartbeatService(getContext().db).reconcileResolvedDependencyWakes();
    expect(result.healed).toBe(1);
    expect(result.selfBlockedSkipped).toBe(0);
  });

  it.each(["dependent", "blocker", "unattributed"] as const)("attributes shared-workspace export to its %s issue", async (exporter) => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId } =
      await getContext().seedResolvedDependencyBackstopFixture({ workspaceState: "finalized" });
    const blockedTransitionAt = new Date(Date.now() - 30_000);
    await getContext().db.update(issues).set({ blockedTransitionAt, executionWorkspaceId }).where(eq(issues.id, blockedIssueId));
    await getContext().db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentId, agentId,
      action: "issue.updated", entityType: "issue", entityId: blockedIssueId, details: { status: "blocked" }, createdAt: blockedTransitionAt });
    await getContext().db.insert(workspaceOperations).values({ companyId, executionWorkspaceId,
      issueId: exporter === "dependent" ? blockedIssueId : exporter === "blocker" ? blockerIssueId : null, phase: "workspace_finalize",
      status: "succeeded", startedAt: new Date(), finishedAt: new Date() });
    const result = await heartbeatService(getContext().db).reconcileResolvedDependencyWakes();
    expect(result.healed).toBe(exporter === "blocker" ? 1 : 0);
    expect(result.selfBlockedSkipped).toBe(exporter === "blocker" ? 0 : 1);
  });

  it("still heals when someone other than the assignee opened the blocked cycle", async () => {
    const { companyId, agentId, blockedIssueId } =
      await getContext().seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await getContext().db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await getContext().db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: blockedIssueId,
      details: { status: "blocked" },
      createdAt: blockedTransitionAt,
    });

    const result = await heartbeatService(getContext().db).reconcileResolvedDependencyWakes();

    expect(result.selfBlockedSkipped).toBe(0);
    expect(result.healed).toBe(1);
    void agentId;
  });

}
