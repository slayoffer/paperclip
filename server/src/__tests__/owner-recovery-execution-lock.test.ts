import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentWakeupRequests, authUsers, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService, shouldAutoCheckoutIssueForWake } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

it("requires a verified owner continuation before a source recovery can check out work", () => {
  const input = { agentId: "owner", issueAssigneeAgentId: "owner", issueStatus: "todo", isDependencyReady: true,
    contextSnapshot: { wakeReason: "source_scoped_recovery_action" } };
  expect(shouldAutoCheckoutIssueForWake(input)).toBe(false);
  expect(shouldAutoCheckoutIssueForWake({ ...input, ownerRecoveryResume: true })).toBe(true);
  expect(shouldAutoCheckoutIssueForWake({ ...input, ownerRecoveryResume: true, isDependencyReady: false })).toBe(false);
});

describeDb("source-scoped owner execution lock", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-recovery-lock-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterAll(async () => { await tempDb?.cleanup(); });
  beforeEach(() => vi.stubEnv("PAPERCLIP_OWNER_RECOVERY_RESUME_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("defers source work until the prior execution releases the issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const previousRunId = randomUUID();
    const recoveryRunId = randomUUID();
    const responsibleUserId = randomUUID();
    const adapterType = "owner_recovery_execution_lock_test";
    await db.insert(authUsers).values({ id: responsibleUserId, name: "Test operator", email: "recovery-lock@example.test",
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Recovery lock fixture", issuePrefix: `L${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: responsibleUserId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle", adapterType,
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } } });
    await db.insert(heartbeatRuns).values([
      { id: previousRunId, companyId, agentId, status: "running", contextSnapshot: { issueId, wakeReason: "issue_assigned" } },
      { id: recoveryRunId, companyId, agentId, status: "queued", invocationSource: "automation", triggerDetail: "system",
        contextSnapshot: { issueId, wakeReason: "source_scoped_recovery_action", recoveryCause: "process_lost" } },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue owner work", status: "in_progress",
      assigneeAgentId: agentId, executionRunId: previousRunId, checkoutRunId: previousRunId, responsibleUserId });
    const actionId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "stranded_assigned_issue", cause: "process_lost", ownerType: "agent", ownerAgentId: agentId,
      returnOwnerAgentId: agentId, fingerprint: previousRunId, evidence: {}, nextAction: "Continue owner work." });
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "automation",
      triggerDetail: "system", reason: "source_scoped_recovery_action", status: "queued", runId: recoveryRunId,
      payload: { issueId, recoveryActionId: actionId } });
    await db.update(heartbeatRuns).set({ wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "source_scoped_recovery_action", recoveryActionId: actionId },
    }).where(eq(heartbeatRuns.id, recoveryRunId));
    let calls = 0;
    registerServerAdapter({
      type: adapterType,
      execute: async ctx => {
        calls++;
        const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
        expect(task.executionRunId).toBe(ctx.runId);
        expect(task.checkoutRunId).toBe(ctx.runId);
        expect(ctx.context.paperclipWake).toMatchObject({ recovery: { executionMode: "owner_resume" } });
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
        return { exitCode: 0, summary: "Owner work completed with the issue lock.", provider: "test", model: "test" };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect(calls).toBe(0);
      expect((await heartbeat.getRun(recoveryRunId))?.status).toBe("queued");
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBe(previousRunId);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, previousRunId));
      await db.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, issueId));
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const [recovery] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error }).from(heartbeatRuns).where(eq(heartbeatRuns.id, recoveryRunId));
      expect(calls, JSON.stringify(recovery)).toBe(1);
      expect((await heartbeat.getRun(recoveryRunId))?.status).toBe("succeeded");
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("done");
    } finally {
      await heartbeat.drainActiveRunExecutions();
      unregisterServerAdapter(adapterType);
    }
  }, 30_000);
});
