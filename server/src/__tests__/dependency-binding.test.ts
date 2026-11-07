import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, issueRelations, issueRecoveryActions, heartbeatRunEvents, projects, executionWorkspaces, workspaceOperations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { releaseReadyDependencyWait } from "../services/issue-dependency-release.js";
import { resolveSuppressedDependencyRecoveries } from "../services/dependency-recovery-resolution.js";
import { listIssueDependencyReadinessMap } from "../services/issue-dependency-readiness.js";
import { withWorkspaceFinalizationActivity } from "../services/workspace-finalization-activity.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)('dependency canonical run bindings', () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-binding-regression-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  async function fixture(status = "in_progress") {
    const companyId = randomUUID(), agentId = randomUUID();
    const issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Binding fixture", issuePrefix: `B${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "idle", adapterType: "process" });
    await db.insert(issues).values([issueId, otherIssueId].map((id) => ({
      id, companyId, title: "Binding task", status, assigneeAgentId: agentId,
    })));
    return { companyId, agentId, issueId, otherIssueId };
  }

  async function dependent() {
    const f = await fixture("blocked");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.otherIssueId));
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.otherIssueId,
      relatedIssueId: f.issueId, type: "blocks" });
    return f;
  }
  it.each(["first-class", "native", "snapshot-conflict"])("checks the canonical live run before release: %s", async kind => {
    const f = await dependent();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      nativeIssueId: kind === "native" ? f.issueId : null,
      issueId: kind === "snapshot-conflict" ? f.otherIssueId : kind === "first-class" ? f.issueId : null,
      contextSnapshot: kind === "snapshot-conflict" ? { issueId: f.issueId } : {},
    });
    expect(await releaseReadyDependencyWait(db, f.companyId, f.issueId)).toBe(kind === "snapshot-conflict");
    expect(await releaseReadyDependencyWait(db, randomUUID(), f.issueId)).toBe(false);
  });
  it.each(["first-class", "conflict", "provider-work", "restore-failure"])("retains dispatch proof when settling %s", async kind => {
    const f = await dependent();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "cancelled", runtimeMode: "legacy", errorCode: "issue_dependencies_blocked",
      scheduledRetryAt: new Date(), scheduledRetryAttempt: 1, finishedAt: new Date(),
      issueId: kind === "conflict" ? f.otherIssueId : f.issueId,
      contextSnapshot: kind === "conflict" ? { issueId: f.issueId } : {},
    }).returning();
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", ownerType: "board",
      nextAction: "Reconcile source execution.",
      fingerprint: run.id, evidence: { runId: run.id,
        ...(kind === "restore-failure" ? { workspaceRestoreFailure: "restore_failed" } : {}) },
    });
    if (kind === "provider-work") await db.insert(heartbeatRunEvents).values({
      companyId: f.companyId, agentId: f.agentId, runId: run.id, seq: 1, eventType: "adapter.invoke",
    });
    expect(await resolveSuppressedDependencyRecoveries(db, f.companyId, f.issueId)).toBe(kind === "first-class" ? 1 : 0);
  });
  it.each([false, true])("preserves active finalization for first-class failed owners (conflict=%s)", async conflict => {
    const f = await dependent();
    const projectId = randomUUID(), workspaceId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Workspace" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: f.companyId, projectId,
      name: "Workspace", mode: "isolated", strategyType: "git_worktree" });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, f.otherIssueId));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "failed", issueId: conflict ? f.issueId : f.otherIssueId,
      contextSnapshot: conflict ? { issueId: f.otherIssueId } : {}, finishedAt: new Date() }).returning();
    const [operation] = await db.insert(workspaceOperations).values({ companyId: f.companyId,
      executionWorkspaceId: workspaceId, issueId: f.otherIssueId, heartbeatRunId: run.id,
      phase: "workspace_finalize", status: "failed" }).returning();
    const ready = async () => (await listIssueDependencyReadinessMap(db, f.companyId, [f.issueId])).get(f.issueId)?.isDependencyReady;
    let finish!: () => void;
    const active = withWorkspaceFinalizationActivity({ operationId: operation.id, companyId: f.companyId,
      runId: run.id, issueId: f.otherIssueId, phase: "workspace_finalize" }, () => new Promise<void>(resolve => { finish = resolve; }));
    try { expect(await ready()).toBe(false); } finally { finish(); await active; }
    expect(await ready()).toBe(!conflict);
  });

});
