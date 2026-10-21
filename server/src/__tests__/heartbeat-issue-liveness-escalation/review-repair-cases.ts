import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../../services/heartbeat.js";
import { attentionService } from "../../services/attention.js";
import { issueService } from "../../services/issues.js";
import { escalateExhaustedIssueReviewPathRecovery } from "../../services/recovery/review-path-recovery-escalation.js";
import type { LivenessContext } from "../heartbeat-issue-liveness-escalation.test.js";

// Upstream review-path repair cases (v2026.1023.0), split out for the fork file-size rule.
export function registerReviewRepairCases(getContext: () => LivenessContext) {
  it.each(["pathless", "monitor"] as const)("runs exactly one bounded review-path recovery with %s disposition", async (disposition) => {
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
      title: "External build follow-up",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    if (disposition === "monitor") {
      const execute = getContext().mockAdapterExecute.getMockImplementation()!;
      getContext().mockAdapterExecute.mockImplementationOnce(execute).mockImplementationOnce(async () => {
        await issueService(getContext().db).update(issueId, {
          monitorNextCheckAt: new Date(Date.now() + 60_000), monitorNotes: "Check external build",
        });
        return execute();
      });
    }

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

    const issue = await getContext().db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    if (disposition === "monitor") {
      expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: agentId, monitorNextCheckAt: expect.any(Date) });
      expect(await getContext().db.select().from(issueRecoveryActions)).toHaveLength(0);
      expect(await getContext().db.select().from(issueComments)).toHaveLength(0);
      const attention = await issueService(getContext().db).listReviewAttention(companyId, [issue]);
      expect(attention.get(issueId)).toMatchObject({ state: "covered", paths: expect.arrayContaining([expect.objectContaining({ kind: "monitor" })]) });
      return;
    }
    expect(issue).toMatchObject({ status: "blocked", assigneeAgentId: agentId });
    const actions = await getContext().db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      ownerType: "board", ownerAgentId: null, ownerUserId: null,
      returnOwnerAgentId: agentId, cause: "issue_review_path_lost", attemptCount: 1, maxAttempts: 1,
    });
    const notices = await getContext().db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ authorType: "system", presentation: expect.objectContaining({ title: "No follow-up scheduled" }) });

    const recoveryRun = await getContext().db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, recoveryWakes[0].runId!)).then((rows) => rows[0]);
    // Replayed finalization must not duplicate the notice, action, or wake.
    expect(await escalateExhaustedIssueReviewPathRecovery(getContext().db, { run: recoveryRun, issueId })).toBeNull();
    expect(await getContext().db.select().from(issueRecoveryActions)).toHaveLength(1);
    expect(await getContext().db.select().from(issueComments)).toHaveLength(1);
    expect(await getContext().db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "issue_review_path_lost"))).toHaveLength(1);

    const feed = await attentionService(getContext().db).list(companyId, { userId: "responsible-user" });
    expect(feed.items.find((item) => item.subject.id === actions[0].id)).toMatchObject({
      sourceKind: "recovery_action",
      relatedIssue: expect.objectContaining({ id: issueId }),
      decisionVerbs: expect.arrayContaining([
        expect.objectContaining({ id: "resolve", label: "Resolve" }),
      ]),
    });
  });

  it.each(["monitor", "completed", "reassigned", "newer_run", "other_company"] as const)(
    "does not escalate a stale review recovery after %s",
    async (change) => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      await getContext().db.insert(companies).values({ id: companyId, name: "Review Co", issuePrefix: `R${companyId.slice(0, 6)}` });
      await getContext().db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", adapterType: "codex_local" });
      await getContext().db.insert(issues).values({ id: issueId, companyId, title: "Async review", status: "in_review", assigneeAgentId: agentId });
      const [run] = await getContext().db.insert(heartbeatRuns).values({
        companyId, agentId, status: "succeeded", issueId,
        createdAt: new Date(Date.now() - 60_000),
        contextSnapshot: { issueId, wakeReason: "issue_review_path_lost", reviewPathRecoveryAttempt: 1 },
      }).returning();
      if (change === "monitor") {
        await issueService(getContext().db).update(issueId, { monitorNextCheckAt: new Date(Date.now() + 60_000), monitorNotes: "Check build" });
      } else if (change === "completed") {
        await issueService(getContext().db).update(issueId, { status: "done" });
      } else if (change === "reassigned") {
        const nextAgentId = randomUUID();
        await getContext().db.insert(agents).values({ id: nextAgentId, companyId, name: "New reviewer", role: "engineer", adapterType: "codex_local" });
        await issueService(getContext().db).update(issueId, { assigneeAgentId: nextAgentId });
      } else if (change === "newer_run") {
        await getContext().db.insert(heartbeatRuns).values({ companyId, agentId, issueId, status: "succeeded", contextSnapshot: { issueId } });
      }
      expect(await escalateExhaustedIssueReviewPathRecovery(getContext().db, {
        run: change === "other_company" ? { ...run, companyId: randomUUID() } : run,
        issueId,
      })).toBeNull();
      expect(await getContext().db.select().from(issueRecoveryActions)).toHaveLength(0);
      expect(await getContext().db.select().from(issueComments)).toHaveLength(0);
      const current = await getContext().db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
      expect(current.status).toBe(change === "completed" ? "done" : "in_review");
      if (change === "monitor") expect(current.monitorNextCheckAt).not.toBeNull();
    },
  );

  it("serializes concurrent finalization of a failed review repair", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await getContext().db.insert(companies).values({ id: companyId, name: "Review Co", issuePrefix: `R${companyId.slice(0, 6)}` });
    await getContext().db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", adapterType: "codex_local" });
    await getContext().db.insert(issues).values({ id: issueId, companyId, title: "Failed review repair", status: "in_review", assigneeAgentId: agentId });
    const [run] = await getContext().db.insert(heartbeatRuns).values({
      companyId, agentId, issueId, status: "failed",
      contextSnapshot: { issueId, wakeReason: "issue_review_path_lost", reviewPathRecoveryAttempt: 1 },
    }).returning();
    const results = await Promise.all([
      escalateExhaustedIssueReviewPathRecovery(getContext().db, { run, issueId }),
      escalateExhaustedIssueReviewPathRecovery(getContext().db, { run, issueId }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await getContext().db.select().from(issueRecoveryActions)).toHaveLength(1);
    expect(await getContext().db.select().from(issueComments)).toHaveLength(1);
    expect(await getContext().db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await getContext().db.select().from(activityLog).where(eq(activityLog.action, "issue.review_path_recovery_exhausted"))).toHaveLength(1);
  });

  it.each(["restart", "transaction_failure", "due_monitor", "claimed_monitor", "expired_monitor", "exhausted_monitor", "disabled_monitor"] as const)("reconciles a committed review repair after %s with a one-connection pool", async (gap) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const wakeId = randomUUID();
    await getContext().db.insert(companies).values({ id: companyId, name: "Review Co", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await getContext().db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await getContext().db.insert(issues).values({ id: issueId, companyId, title: "Repair finalized before restart", status: "in_review", assigneeAgentId: agentId, responsibleUserId: "responsible-user" });
    await getContext().db.insert(agentWakeupRequests).values({
      id: wakeId, companyId, agentId, source: "automation", status: "completed",
      reason: "issue_review_path_lost", payload: { issueId, reviewPathRecoveryAttempt: 1 },
    });
    const [repairRun] = await getContext().db.insert(heartbeatRuns).values({
      companyId, agentId, issueId, status: "succeeded", wakeupRequestId: wakeId, finishedAt: new Date(),
      contextSnapshot: { issueId, wakeReason: "issue_review_path_lost", reviewPathRecoveryAttempt: 1 },
    }).returning();
    const dueAt = new Date(Date.now() - 60_000);
    if (gap.endsWith("monitor")) {
      const monitored = await issueService(getContext().db).update(issueId, {
        monitorNextCheckAt: dueAt, monitorNotes: "Check external build",
        executionPolicy: { monitor: {
          nextCheckAt: dueAt.toISOString(), notes: "Check external build", scheduledBy: "assignee",
          kind: "external_service", serviceName: "github_checks",
          ...(gap === "disabled_monitor" ? {} : { timeoutAt: new Date(Date.now() + 60_000).toISOString(), maxAttempts: 3 }),
        } },
      });
      if (gap === "disabled_monitor") {
        // A policy change after saving an unbounded check must not hide the
        // spent repair forever: dispatch cannot accept its on-demand wake.
        await getContext().db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, agentId));
      } else if (gap === "claimed_monitor") {
        await getContext().db.update(issues).set({ monitorWakeRequestedAt: new Date() }).where(eq(issues.id, issueId));
      } else if (gap === "expired_monitor" || gap === "exhausted_monitor") {
        const policy = monitored!.executionPolicy as { monitor: Record<string, unknown> };
        await getContext().db.update(issues).set({
          executionPolicy: { ...policy, monitor: { ...policy.monitor, ...(gap === "expired_monitor" ? { timeoutAt: new Date(Date.now() - 1_000).toISOString() } : { maxAttempts: 1 }) } },
          ...(gap === "exhausted_monitor" ? { monitorAttemptCount: 1 } : {}),
        }).where(eq(issues.id, issueId));
      }
    }
    // Only the terminal run and completed wake were persisted before the crash.
    // A new service must restore the missing action without invoking the agent.
    const singleConnectionDb = createDb(getContext().connectionString, { maxConnections: 1 });
    try {
      if (gap === "transaction_failure") {
        await getContext().db.execute(sql`alter table issue_comments add constraint review_repair_notice_test check (false) not valid`);
        try {
          await expect(escalateExhaustedIssueReviewPathRecovery(singleConnectionDb, { run: repairRun, issueId })).rejects.toThrow();
        } finally {
          await getContext().db.execute(sql`alter table issue_comments drop constraint review_repair_notice_test`);
        }
        expect(await getContext().db.select().from(issueRecoveryActions)).toHaveLength(0);
        expect((await getContext().db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("in_review");
      }
      const recovery = heartbeatService(singleConnectionDb);
      const result = await recovery.reconcileStrandedAssignedIssues();
      if (gap === "due_monitor" || gap === "claimed_monitor") {
        expect(result.escalated).toBe(0);
        expect(await getContext().db.select().from(issueRecoveryActions)).toHaveLength(0);
        expect(await getContext().db.select().from(issueComments)).toHaveLength(0);
        const current = (await getContext().db.select().from(issues).where(eq(issues.id, issueId)))[0];
        expect(current).toMatchObject({ status: "in_review", monitorNextCheckAt: dueAt });
        // A claim left by a crashed dispatcher can be reclaimed after its lease.
        if (gap === "claimed_monitor") {
          await getContext().db.update(issues).set({ monitorWakeRequestedAt: new Date(Date.now() - 6 * 60_000) }).where(eq(issues.id, issueId));
        }
        const execute = getContext().mockAdapterExecute.getMockImplementation()!;
        getContext().mockAdapterExecute.mockImplementationOnce(async () => {
          await issueService(getContext().db).update(issueId, { status: "done" });
          return execute();
        });
        const dispatcher = heartbeatService(getContext().db, { runtimeEnv: {} });
        await dispatcher.tickTimers();
        await dispatcher.drainActiveRunExecutions();
        const wakes = await getContext().db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "issue_monitor_due"));
        expect(wakes).toHaveLength(1);
        expect(getContext().mockAdapterExecute).toHaveBeenCalledOnce();
        expect((await getContext().db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "done", monitorNextCheckAt: null });
        return;
      }
      expect(result).toMatchObject({ escalated: 1, issueIds: [issueId] });
      expect(await getContext().db.select().from(issueRecoveryActions)).toHaveLength(1);
      expect(await getContext().db.select().from(issueComments)).toHaveLength(1);
      const second = await recovery.reconcileStrandedAssignedIssues();
      expect(second.escalated).toBe(0);
      expect(await getContext().db.select().from(agentWakeupRequests)).toHaveLength(1);
      expect(getContext().mockAdapterExecute).not.toHaveBeenCalled();
      expect((await getContext().db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "blocked", assigneeAgentId: agentId });
    } finally {
      await singleConnectionDb.$client.end({ timeout: 1 });
    }
  });
}
