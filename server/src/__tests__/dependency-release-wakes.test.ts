import { nativeDependencyCompletionCases } from "./dependency-release-native.cases.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  issueWorkProducts, completionContracts, nativeRunFinalizations, nativeRunResults, statusDecisionEffects, statusDecisions, workAssessments, heartbeatRunEvents, issueRecoveryActions, activityLog, agents, agentWakeupRequests, approvals, companies, createDb, executionWorkspaces, heartbeatRuns, issueApprovals, issueComments, issueRelations, issueThreadInteractions, issues, projects, workspaceOperations,
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { issueService, executeIssuePostCommitActions, type IssuePostCommitAction } from "../services/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { dispatchPendingDependencyReleaseWakes } from "../services/dependency-release-wakes.js";
import { assertRealBlockedWait } from "../services/blocked-state-integrity.js";
import { assertBlockedIssueUpdate } from "../services/issue-blocked-validation.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";

const heartbeat = vi.hoisted(() => ({ wakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
    ...actual.heartbeatService(...args), wakeup: heartbeat.wakeup,
  }) };
});
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("durable dependency release wakes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof issueService>;
  let companyId: string;
  let hasRollbackTrigger = false;
  let agentId: string;
  let blocker: typeof issues.$inferSelect;
  let dependent: typeof issues.$inferSelect;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-release-wakes-");
    db = createDb(database.connectionString);
    svc = issueService(db);
  }, 30_000);
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", "true");
    heartbeat.wakeup.mockReset().mockResolvedValue(null);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Release", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle" });
    [blocker] = await db.insert(issues).values({ companyId, title: "Blocker", status: "todo" }).returning() as [typeof blocker];
    [dependent] = await db.insert(issues).values({ companyId, title: "Dependent", status: "blocked",
      assigneeAgentId: agentId, blockedTransitionAt: new Date("2026-08-01T00:00:00Z") }).returning() as [typeof dependent];
    await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: dependent.id, type: "blocks" });
  });
  afterEach(async () => {
    if (hasRollbackTrigger) {
      await db.execute(sql`DROP TRIGGER reject_dependency_commit ON status_decisions`);
      hasRollbackTrigger = false;
    }
    await db.update(issues).set({ lastStatusDecisionId: null });
    for (const table of [statusDecisionEffects, nativeRunFinalizations, statusDecisions, workAssessments, nativeRunResults, issueRecoveryActions, issueWorkProducts, heartbeatRunEvents, issueApprovals, approvals, workspaceOperations, issueThreadInteractions, activityLog, issueComments, issueRelations, heartbeatRuns, agentWakeupRequests, completionContracts, issues, executionWorkspaces, projects, agents, companies]) {
      await db.delete(table);
    }
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await database?.cleanup(); });
  const intents = () => db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.requestedByActorId, "blocked-dependency-release"));
  const recover = () => recoveryService(db, { enqueueWakeup: heartbeat.wakeup })
    .reconcileResolvedDependencyWakeBackstop({ companyId });
  const delivered = async () => (await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded" }).returning())[0]!;

  it.each([
    { integrity: false, pullQueue: false },
    { integrity: false, pullQueue: true },
    { integrity: true, pullQueue: false },
    { integrity: true, pullQueue: true },
  ])("preserves readiness with integrity=$integrity and pullQueue=$pullQueue", async ({ integrity, pullQueue }) => {
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", String(integrity));
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", String(pullQueue));
    for (const status of ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]) {
      await db.update(issues).set({ status }).where(eq(issues.id, blocker.id));
      const resolved = status === "done" || status === "cancelled";
      expect(await svc.getDependencyReadiness(dependent.id), status).toMatchObject({
        blockerIssueIds: [blocker.id],
        unresolvedBlockerIssueIds: resolved ? [] : [blocker.id],
        unresolvedBlockerCount: resolved ? 0 : 1,
        allBlockersDone: resolved,
        isDependencyReady: resolved,
      });
    }
  });

  it.each(["done", "cancelled"])("dispatches after direct service completion to %s commits", async status => {
    heartbeat.wakeup.mockImplementation(async (owner, opts) => {
      expect(owner).toBe(agentId);
      expect((await svc.getById(blocker.id))?.status).toBe(status);
      expect((await svc.getById(dependent.id))?.status).toBe("todo");
      expect(await intents()).toHaveLength(1);
      expect(opts).toMatchObject({ reason: "issue_blockers_resolved", payload: { issueId: dependent.id },
        issueStateGuard: { statuses: ["todo"], assigneeAgentId: agentId, statusVersion: dependent.statusVersion + 1 },
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: dependent.id,
          blockerIssueIds: [blocker.id], blockedTransitionAt: dependent.blockedTransitionAt }) });
      return delivered();
    });
    await svc.update(blocker.id, { status });
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect((await intents())[0]?.status).toBe("completed_dependency_dispatch");
    await recover();
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
  });

  it.each(["deferred", "failed"])("recovers a %s dispatch after the dependent becomes todo", async outcome => {
    if (outcome === "failed") heartbeat.wakeup.mockRejectedValueOnce(new Error("admission unavailable"));
    await svc.update(blocker.id, { status: "done" });
    expect((await svc.getById(dependent.id))?.status).toBe("todo");
    expect((await intents())[0]?.status).toBe("pending_dependency_dispatch");
    heartbeat.wakeup.mockResolvedValueOnce(await delivered());
    expect(await recover()).toMatchObject({ checked: 1, healed: 1, issueIds: [dependent.id] });
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(2);
    expect((await intents())[0]?.status).toBe("completed_dependency_dispatch");
  });

  it("preserves a card that appears before a deferred dispatch retries", async () => {
    await svc.update(blocker.id, { status: "done" });
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: dependent.id,
      kind: "request_confirmation", status: "pending", title: "Approve the operation", payload: {},
      continuationPolicy: "wake_assignee" }).returning();
    heartbeat.wakeup.mockClear();
    expect(await recover()).toMatchObject({ healed: 0, deferredOrFailed: 1 });
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    expect((await intents())[0]?.status).toBe("pending_dependency_dispatch");
    await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, card!.id));
    heartbeat.wakeup.mockResolvedValueOnce(await delivered());
    expect(await recover()).toMatchObject({ healed: 1 });
  });

  const deliverOnce = () => heartbeat.wakeup.mockImplementationOnce(async (_owner, opts) => {
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "completed",
      reason: "issue_blockers_resolved", idempotencyKey: opts.idempotencyKey });
    return delivered();
  });

  async function approvalWait(status: string) {
    const [approval] = await db.insert(approvals).values({ companyId, type: "approve_ceo_strategy", status, payload: {} }).returning();
    await db.insert(issueApprovals).values({ companyId, issueId: dependent.id, approvalId: approval!.id });
    return approval!;
  }

  it.each(["pending", "revision_requested"])("accepts a %s approval as the only blocked wait", async status => {
    await db.delete(issueRelations);
    await approvalWait(status);
    await expect(assertRealBlockedWait(db, dependent)).resolves.toBeUndefined();
    await expect(assertBlockedIssueUpdate({ db,
      actor: { type: "agent", companyId, agentId, source: "agent_jwt" }, existing: { ...dependent, status: "in_progress" },
      updateFields: { status: "blocked" }, getDependencyReadiness: svc.getDependencyReadiness,
    })).resolves.toBeUndefined();
  });

  it.each(["pending", "revision_requested"])("preserves a %s approval after the last blocker ends", async status => {
    const approval = await approvalWait(status);
    await svc.update(blocker.id, { status: "done" });
    expect((await svc.getById(dependent.id))?.status).toBe("blocked");
    expect(await intents()).toEqual([]);
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(approvals))[0]?.status).toBe(status);
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, approval.id));
    deliverOnce();
    const result = await recover();
    expect(result.healed + result.existingWakeSkipped).toBe(1);
    expect((await svc.getById(dependent.id))?.status).toBe("todo");
  });

  it.each(["pending", "revision_requested"])("defers dispatch while a %s approval remains open", async status => {
    await svc.update(blocker.id, { status: "done" });
    const approval = await approvalWait(status);
    heartbeat.wakeup.mockClear();
    expect(await recover()).toMatchObject({ healed: 0, deferredOrFailed: 1 });
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    expect((await intents())[0]?.status).toBe("pending_dependency_dispatch");
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, approval.id));
    deliverOnce();
    expect(await recover()).toMatchObject({ healed: 1 });
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect((await intents())[0]?.status).toBe("completed_dependency_dispatch");
  });

  it.each(["done", "cancelled"])("keeps a %s blocker unresolved until workspace finalization succeeds", async status => {
    const [project] = await db.insert(projects).values({ companyId, name: "Workspace barrier" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id,
      name: "Blocker workspace", mode: "isolated_workspace", strategyType: "git_worktree" }).returning();
    const blockerIdentifier = "DEP-1";
    await db.update(issues).set({ executionWorkspaceId: workspace!.id, identifier: blockerIdentifier })
      .where(eq(issues.id, blocker.id));
    const [operation] = await db.insert(workspaceOperations).values({ companyId, issueId: blocker.id,
      executionWorkspaceId: workspace!.id, phase: "workspace_finalize", status: "running" }).returning();
    await svc.update(blocker.id, { status });
    expect(await svc.getDependencyReadiness(dependent.id)).toMatchObject({ isDependencyReady: false,
      unresolvedBlockerIssueIds: [blocker.id], pendingFinalizeBlockerIssueIds: [blocker.id] });
    await expect(svc.update(dependent.id, { title: "Updated during finalization" }))
      .resolves.toMatchObject({ title: "Updated during finalization", status: "blocked" });
    const unblockDescriptor = { owner: { agentId }, action: `Wait for ${blockerIdentifier} workspace finalization` };
    await expect(svc.update(dependent.id, { unblockDescriptor })).resolves.toMatchObject({ unblockDescriptor });
    for (const requestedBlockerIds of [undefined, [blocker.id]]) {
      await expect(assertBlockedIssueUpdate({ db,
        actor: { type: "agent", companyId, agentId, source: "agent_jwt" }, existing: dependent,
        updateFields: { unblockDescriptor }, requestedBlockerIds, getDependencyReadiness: svc.getDependencyReadiness,
      })).resolves.toBeUndefined();
    }
    for (const blockedByIssueIds of [undefined, [blocker.id]]) {
      await expect(svc.update(dependent.id, { status: "in_progress", blockedByIssueIds }))
        .rejects.toMatchObject({ status: 422, details: {
          unresolvedBlockerIssueIds: [blocker.id],
          unresolvedBlockers: [{ issueId: blocker.id, reason: "pending_finalize" }],
        } });
    }
    expect((await svc.getById(dependent.id))?.status).toBe("blocked");
    expect(await intents()).toEqual([]);
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    expect(await recover()).toMatchObject({ healed: 0 });
    await db.update(workspaceOperations).set({ status: "succeeded" }).where(eq(workspaceOperations.id, operation!.id));
    deliverOnce();
    const result = await recover();
    expect(result.healed + result.existingWakeSkipped).toBe(1);
    expect((await svc.getById(dependent.id))?.status).toBe("todo");
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    await expect(svc.update(dependent.id, { status: "in_progress", blockedByIssueIds: [blocker.id] }))
      .resolves.toMatchObject({ status: "in_progress" });
  });

  it("rolls back the pending wake with the status transition", async () => {
    const actions: IssuePostCommitAction[] = [];
    await expect(db.transaction(async tx => {
      await svc.update(blocker.id, { status: "done" }, tx, [], actions);
      expect(heartbeat.wakeup).not.toHaveBeenCalled();
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await intents()).toEqual([]);
    expect((await svc.getById(dependent.id))?.status).toBe("blocked");
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("recovers a committed intent when the process misses its post-commit actions", async () => {
    const actions: IssuePostCommitAction[] = [];
    await db.transaction(tx => svc.update(blocker.id, { status: "done" }, tx, [], actions));
    expect(actions).toHaveLength(1);
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    heartbeat.wakeup.mockResolvedValueOnce(await delivered());
    expect(await recover()).toMatchObject({ healed: 1 });
    await executeIssuePostCommitActions(db, actions);
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
  });

  it("recovers a stale dispatch claim without duplicating a completed wake", async () => {
    await svc.update(blocker.id, { status: "done" });
    const [intent] = await intents();
    await db.update(agentWakeupRequests).set({ status: "dispatching_dependency",
      updatedAt: new Date(Date.now() - 120_000) }).where(eq(agentWakeupRequests.id, intent!.id));
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "completed",
      reason: "issue_blockers_resolved", idempotencyKey: buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: dependent.id,
        blockerIssueIds: [blocker.id], blockedTransitionAt: dependent.blockedTransitionAt }) });
    await recover();
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect((await intents())[0]?.status).toBe("completed_dependency_dispatch");
  });

  it("does not consume a fresh claim or a different company's intent", async () => {
    await svc.update(blocker.id, { status: "done" });
    heartbeat.wakeup.mockClear();
    await dispatchPendingDependencyReleaseWakes(db, heartbeat.wakeup, { companyId: randomUUID() });
    expect((await intents())[0]?.status).toBe("pending_dependency_dispatch");
    const [intent] = await intents();
    await db.update(agentWakeupRequests).set({ status: "dispatching_dependency", updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, intent!.id));
    await recover();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("cancels an obsolete intent after a new blocked cycle starts", async () => {
    await svc.update(blocker.id, { status: "done" });
    await svc.update(blocker.id, { status: "todo" });
    await svc.update(dependent.id, { status: "blocked", blockedByIssueIds: [blocker.id] });
    heartbeat.wakeup.mockClear();
    await recover();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    expect((await intents())[0]?.status).toBe("cancelled");
  });

  it("keeps legacy recovery when the switch is disabled", async () => {
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", "false");
    await svc.update(blocker.id, { status: "done" });
    expect(await intents()).toEqual([]);
    expect((await svc.getById(dependent.id))?.status).toBe("blocked");
    heartbeat.wakeup.mockResolvedValueOnce(await delivered());
    expect(await recover()).toMatchObject({ healed: 1 });
  });
  it("reviewer probe: transaction-bound update must not dispatch before outer commit", async () => {
    await expect(db.transaction(async tx => {
      await issueService(tx as unknown as typeof db).update(blocker.id, { status: "done" }, tx, []);
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    expect((await svc.getById(blocker.id))?.status).toBe("todo");
    expect((await svc.getById(dependent.id))?.status).toBe("blocked");
    expect(await intents()).toEqual([]);
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("reviewer probe: transaction-bound dependent listing must not dispatch before outer commit", async () => {
    await expect(db.transaction(async tx => {
      await tx.update(issues).set({ status: "done" }).where(eq(issues.id, blocker.id));
      await issueService(tx as unknown as typeof db).listWakeableBlockedDependents(blocker.id);
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    expect((await svc.getById(dependent.id))?.status).toBe("blocked");
    expect(await intents()).toEqual([]);
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  nativeDependencyCompletionCases(() => ({
    db, svc, companyId, agentId, blocker, dependent, heartbeat, intents, recover,
    markRollbackTrigger: () => { hasRollbackTrigger = true; },
  }));
  it("dispatches explicit outer transaction actions after commit", async () => {
    const actions: IssuePostCommitAction[] = [];
    await db.transaction(async tx => {
      await svc.update(blocker.id, { status: "done" }, tx, [], actions);
      expect(heartbeat.wakeup).not.toHaveBeenCalled();
    });
    heartbeat.wakeup.mockImplementation(async () => {
      expect((await svc.getById(blocker.id))?.status).toBe("done");
      expect((await svc.getById(dependent.id))?.status).toBe("todo");
      return await delivered();
    });
    await executeIssuePostCommitActions(db, actions);
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
  });
});
