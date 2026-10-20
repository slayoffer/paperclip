import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, executionWorkspaces, heartbeatRunEvents, heartbeatRuns,
  issueRecoveryActions, issueRelations, issues, issueThreadInteractions, projects, workspaceOperations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { releaseReadyDependencyWait } from "../services/issue-dependency-release.js";
import { resolveSuppressedDependencyRecoveries } from "../services/dependency-recovery-resolution.js";
import { legacyExecutionNeedsReconciliationWithEvidence, terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { recoveryService } from "../services/recovery/service.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";
import { withWorkspaceFinalizationActivity } from "../services/workspace-finalization-activity.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("dependency release", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("dependency-release-");
    db = createDb(temp.connectionString);
  }, 90000);
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture(status = "done") {
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID();
    const blockerId = randomUUID(), dependentId = randomUUID(), workspaceId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Dependency test", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(projects).values({ id: projectId, companyId, name: "Test", status: "in_progress" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, mode: "isolated_workspace",
      strategyType: "git_worktree", name: "Test", status: "active", providerType: "git_worktree" });
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status, assigneeAgentId: agentId, executionWorkspaceId: workspaceId },
      { id: dependentId, companyId, title: "Dependent", status: "blocked", assigneeAgentId: agentId },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: dependentId, type: "blocks" });
    return { companyId, agentId, blockerId, dependentId, workspaceId, runId };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function stoppedRun(f: Fixture, status: string) {
    const [run] = await db.insert(heartbeatRuns).values({ id: f.runId, companyId: f.companyId, agentId: f.agentId,
      status, invocationSource: "assignment", runtimeMode: "legacy",
      contextSnapshot: { issueId: f.blockerId, executionWorkspaceId: f.workspaceId }, startedAt: new Date(), finishedAt: status === "running" ? null : new Date(),
    }).returning();
    await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.blockerId,
      executionWorkspaceId: f.workspaceId, heartbeatRunId: f.runId, phase: "workspace_prepare", status: "succeeded" });
    return run;
  }

  it.each(["cancelled", "failed", "timed_out"])("releases a done blocker after its %s run, without finalization", async status => {
    const f = await fixture();
    await stoppedRun(f, status);
    const svc = issueService(db);
    expect((await svc.getDependencyReadiness(f.dependentId)).isDependencyReady).toBe(true);
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(true);
    expect((await svc.getById(f.dependentId))?.status).toBe("todo");
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(true);
    const records = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.dependentId),
      eq(activityLog.action, "issue.updated")));
    expect(records).toHaveLength(1);
  });

  it("releases a cancelled blocker without the pull queue feature", async () => {
    const f = await fixture("cancelled");
    await stoppedRun(f, "cancelled");
    expect((await issueService(db).getDependencyReadiness(f.dependentId)).unresolvedBlockerIssueIds).toEqual([]);
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(true);
  });

  it("settles an old workspace operation when the last retry never prepares the workspace", async () => {
    const f = await fixture();
    await stoppedRun(f, "failed");
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "cancelled",
      invocationSource: "automation", runtimeMode: "legacy", contextSnapshot: { issueId: f.blockerId },
      createdAt: new Date(Date.now() + 1000), finishedAt: new Date() });
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(true);
  });

  it("keeps a live workspace gated, then releases it after late finalization", async () => {
    const f = await fixture();
    await stoppedRun(f, "running");
    const svc = issueService(db);
    expect((await svc.getDependencyReadiness(f.dependentId)).isDependencyReady).toBe(false);
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(false);
    await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.blockerId,
      executionWorkspaceId: f.workspaceId, heartbeatRunId: f.runId, phase: "workspace_finalize", status: "succeeded" });
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(true);
  });

  it("keeps an unresolved blocker and exposes its readiness on issue reads", async () => {
    const f = await fixture("in_progress");
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(false);
    const issue = await issueService(db).getById(f.dependentId);
    expect(issue?.dependencyReadiness).toMatchObject({ isDependencyReady: false,
      unresolvedBlockerIds: [f.blockerId], unresolvedBlockerIssueIds: [f.blockerId] });
    expect(await releaseReadyDependencyWait(db, randomUUID(), f.dependentId)).toBe(false);
  });

  it("keeps a live export gated after its run stops, including a recorder timeout", async () => {
    const f = await fixture();
    await stoppedRun(f, "failed");
    const [operation] = await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.blockerId,
      executionWorkspaceId: f.workspaceId, heartbeatRunId: f.runId, phase: "workspace_finalize", status: "failed" }).returning();
    let finish!: () => void;
    const callback = new Promise<void>(resolve => { finish = resolve; });
    const active = withWorkspaceFinalizationActivity({ operationId: operation.id, companyId: f.companyId,
      runId: f.runId, issueId: f.blockerId, phase: "workspace_finalize" }, () => callback);
    try {
      expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(false);
    } finally {
      finish();
      await active;
    }
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(true);
  });

  it("preserves an independent declared wait", async () => {
    const f = await fixture("cancelled");
    await db.update(issues).set({ unblockDescriptor: { owner: "board", action: "Accept the merge card." } })
      .where(eq(issues.id, f.dependentId));
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(false);
    expect((await issueService(db).getById(f.dependentId))?.status).toBe("blocked");
  });

  it("preserves a pending interaction", async () => {
    const f = await fixture("cancelled");
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.dependentId,
      kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Accept?" } });
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(false);
  });

  it("preserves a declared external monitor wait", async () => {
    const f = await fixture("cancelled");
    await db.update(issues).set({ monitorNextCheckAt: new Date(Date.now() + 7200000) })
      .where(eq(issues.id, f.dependentId));
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(false);
  });

  it.each([false, true])("releases and wakes once after a completion event, with an old wake: %s", async oldWake => {
    const f = await fixture("cancelled");
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });
    if (oldWake) await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      status: "completed", source: "automation", reason: "issue_blockers_resolved", payload: { issueId: f.dependentId },
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: f.dependentId, blockerIssueIds: [f.blockerId] }) });
    const first = await recovery.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, blockerIssueId: f.blockerId });
    expect(first.healed).toBe(1);
    expect((await issueService(db).getById(f.dependentId))?.status).toBe("todo");
    await recovery.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, blockerIssueId: f.blockerId });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(f.agentId, expect.objectContaining({ reason: "issue_blockers_resolved" }));
  });

  async function suppressedRun(f: Fixture) {
    const [run] = await db.insert(heartbeatRuns).values({ id: f.runId, companyId: f.companyId,
      agentId: f.agentId, status: "cancelled", invocationSource: "automation", runtimeMode: "legacy",
      errorCode: "issue_dependencies_blocked", scheduledRetryAt: new Date(), scheduledRetryAttempt: 1,
      contextSnapshot: { issueId: f.dependentId }, finishedAt: new Date(),
    }).returning();
    return run;
  }
  async function falseHold(f: Fixture) {
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.dependentId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", status: "resolved",
      fingerprint: `legacy-execution:${f.runId}:${randomUUID()}`, ownerType: "board", nextAction: "Reconcile the run.",
      evidence: { runId: f.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
  }

  it("creates no recovery action for a suppressed scheduled retry", async () => {
    const f = await fixture("in_progress");
    const run = await suppressedRun(f);
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, run)).toBe(false);
    await terminalizeLegacyExecution({ db, run, status: "cancelled" });
    await terminalizeLegacyExecution({ db, run, status: "cancelled" });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.dependentId))).toEqual([]);
  });

  it("settles all 139 false holds, then releases the dependent without another hold", async () => {
    const f = await fixture("cancelled");
    await suppressedRun(f);
    for (let i = 0; i < 139; i++) await falseHold(f);
    expect(await getExecutionBlocker(db, f.companyId, f.dependentId)).not.toBeNull();
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(true);
    expect(await getExecutionBlocker(db, f.companyId, f.dependentId)).toBeNull();
    expect(await resolveSuppressedDependencyRecoveries(db, f.companyId, f.dependentId)).toBe(0);
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.dependentId));
    expect(actions).toHaveLength(139);
    expect(actions.every(a => (a.evidence.automaticRecovery as Record<string, unknown>)?.replay !== "blocked")).toBe(true);
  });

  it("keeps uncertain dispatch evidence and deduplicates the source run", async () => {
    const f = await fixture("cancelled");
    const run = await suppressedRun(f);
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: run.id, agentId: f.agentId,
      seq: 1, eventType: "adapter.invoke", payload: {} });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, run)).toBe(true);
    await terminalizeLegacyExecution({ db, run, status: "cancelled" });
    await db.update(issueRecoveryActions).set({ status: "resolved", evidence: { runId: run.id,
      automaticRecovery: { replay: "blocked" } } }).where(eq(issueRecoveryActions.sourceIssueId, f.dependentId));
    await terminalizeLegacyExecution({ db, run, status: "cancelled" });
    expect(await resolveSuppressedDependencyRecoveries(db, f.companyId, f.dependentId)).toBe(0);
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(false);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.dependentId))).toHaveLength(1);
  });
  it("retries dependency wake after enqueue failure and service restart", async () => {
    const f = await fixture("cancelled");
    const enqueueWakeup = vi.fn().mockRejectedValueOnce(new Error("queue temporarily unavailable"))
      .mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db, { enqueueWakeup });
    const first = await recovery.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, blockerIssueId: f.blockerId });
    const status = (await issueService(db).getById(f.dependentId))?.status;
    expect(first.enqueueFailed).toBe(1);
    expect(status).toBe("todo");
    const restarted = recoveryService(db, { enqueueWakeup });
    const second = await restarted.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId });
    expect(second.healed).toBe(1);
    await restarted.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId });
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup.mock.calls[0][1].idempotencyKey).toBe(enqueueWakeup.mock.calls[1][1].idempotencyKey);
  });
  it.each(["queued", "running", "scheduled_retry"])("preserves an older %s workspace after a cancelled retry", async status => {
    const f = await fixture();
    await stoppedRun(f, status);
    await db.insert(heartbeatRuns).values({ companyId:f.companyId, agentId:f.agentId, status:"cancelled",
      invocationSource:"automation",runtimeMode:"legacy", contextSnapshot:{issueId:f.blockerId},
      createdAt:new Date(Date.now()+1000),finishedAt:new Date() });
    const readiness=await issueService(db).getDependencyReadiness(f.dependentId);
    expect(readiness.isDependencyReady).toBe(false);
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(false);
  });
  it("preserves an older live workspace after a newer failed preparation", async () => {
    const f = await fixture();
    await stoppedRun(f, "running");
    const retry = { ...f, runId: randomUUID() };
    await stoppedRun(retry, "failed");
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(false);
  });

  it("retries a deferred enqueue without repeating a delivered wake", async () => {
    const f = await fixture("cancelled");
    const enqueueWakeup = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db, { enqueueWakeup });
    expect((await recovery.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId })).deferredOrFailed).toBe(1);
    const restarted = recoveryService(db, { enqueueWakeup });
    expect((await restarted.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId })).healed).toBe(1);
    await restarted.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId });
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
  });

  it("deduplicates a persisted wake when its delivery audit fails", async () => {
    const f = await fixture("cancelled");
    await releaseReadyDependencyWait(db, f.companyId, f.dependentId);
    const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: f.dependentId,
      blockerIssueIds: [f.blockerId] }) + ":release";
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      status: "completed", source: "automation", reason: "issue_blockers_resolved", payload: { issueId: f.dependentId }, idempotencyKey });
    const enqueueWakeup = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup });
    expect((await recovery.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId })).existingWakeSkipped).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not select an ordinary todo issue as a pending release", async () => {
    const f = await fixture("cancelled");
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.dependentId));
    const enqueueWakeup = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup });
    expect((await recovery.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId })).checked).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("expires a release receipt after another status cycle", async () => {
    const f = await fixture("cancelled");
    await releaseReadyDependencyWait(db, f.companyId, f.dependentId);
    await db.update(issues).set({ status: "in_progress", statusVersion: sql`${issues.statusVersion} + 1` })
      .where(eq(issues.id, f.dependentId));
    await db.update(issues).set({ status: "todo", statusVersion: sql`${issues.statusVersion} + 1` })
      .where(eq(issues.id, f.dependentId));
    const enqueueWakeup = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup });
    expect((await recovery.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId })).checked).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

});
