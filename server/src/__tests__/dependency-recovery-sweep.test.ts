import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, createDb, heartbeatRunEvents, heartbeatRuns,
  issueRecoveryActions, issueRelations, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { recoveryService } from "../services/recovery/service.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("historical dependency recovery sweep", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("dependency-recovery-sweep-");
    db = createDb(temp.connectionString);
  }, 90000);
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture(actionStatus = "resolved") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Historical holds", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Ready issue", status: "todo", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled",
      invocationSource: "automation", runtimeMode: "legacy", errorCode: "issue_dependencies_blocked",
      scheduledRetryAt: new Date(), scheduledRetryAttempt: 1, contextSnapshot: { issueId }, finishedAt: new Date() });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", status: actionStatus,
      fingerprint: `legacy-execution:${runId}`, ownerType: "board", nextAction: "Reconcile the run.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }).returning();
    return { companyId, agentId, issueId, runId, action };
  }

  async function actions(issueId: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  it("settles 140 relation-free todo holds without a release receipt or duplicate wakes", async () => {
    const f = await fixture();
    for (let n = 1; n < 140; n++) {
      await db.insert(issueRecoveryActions).values({ ...f.action, id: randomUUID(), fingerprint: randomUUID() });
    }
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    const enqueueWakeup = vi.fn();
    const sweep = recoveryService(db, { enqueueWakeup });
    const first = await sweep.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId });
    expect(first.checked).toBe(1);
    const retained = await actions(f.issueId);
    expect(retained).toHaveLength(140);
    expect(retained.every(action => action.status === "resolved" && action.outcome === "cancelled" &&
      action.evidence.runId === f.runId &&
      (action.evidence.automaticRecovery as { replay?: string })?.replay === "not_required")).toBe(true);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await sweep.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId })).checked).toBe(0);
    expect((await recoveryService(db, { enqueueWakeup }).reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId })).checked).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    const audits = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
      eq(activityLog.action, "issue.execution_recovery_settled")));
    expect(audits).toHaveLength(140);
  });

  it("preserves execution-backed holds across repeated standard sweeps", async () => {
    const f = await fixture();
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.runId, agentId: f.agentId,
      seq: 1, eventType: "adapter.invoke", payload: {} });
    const enqueueWakeup = vi.fn();
    const sweep = recoveryService(db, { enqueueWakeup });
    expect((await sweep.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId })).checked).toBe(1);
    await sweep.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId });
    expect(await actions(f.issueId)).toEqual([f.action]);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("preserves cancelled recovery records", async () => {
    const f = await fixture("cancelled");
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Cancelled blocker", status: "cancelled" });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    const enqueueWakeup = vi.fn();
    await recoveryService(db, { enqueueWakeup }).reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId });
    expect(await actions(f.issueId)).toEqual([f.action]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("settles only the requested company's holds", async () => {
    const f = await fixture(), other = await fixture();
    const enqueueWakeup = vi.fn();
    await recoveryService(db, { enqueueWakeup }).reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect(await actions(other.issueId)).toEqual([other.action]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("retains the real dependency after it settles a false hold", async () => {
    const f = await fixture(), blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Real blocker", status: "in_progress" });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
    const enqueueWakeup = vi.fn();
    await recoveryService(db, { enqueueWakeup }).reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).toBe("todo");
    expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, f.issueId))).toHaveLength(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["active", "escalated"])("settles a verified %s hold without creating a wake", async status => {
    const f = await fixture(status);
    const enqueueWakeup = vi.fn();
    const sweep = recoveryService(db, { enqueueWakeup });
    await sweep.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await actions(f.issueId))[0].status).toBe("resolved");
    await sweep.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});
