import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, authUsers, companies, createDb, heartbeatRuns, issueRecoveryActions, issueThreadInteractions, issues } from "@paperclipai/db";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { buildPaperclipWakePayload, heartbeatService } from "../services/heartbeat.js";
import { ownerRecoveryResumeEnabled } from "../services/recovery/owner-resume.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const restriction = "Recovery contract: your job is to RECOVER this task";

it("enables owner recovery resume by default and permits explicit rollback", () => {
  expect(ownerRecoveryResumeEnabled({})).toBe(true);
  for (const value of ["false", "FALSE", " false ", "0"]) {
    expect(ownerRecoveryResumeEnabled({ PAPERCLIP_OWNER_RECOVERY_RESUME_ENABLED: value })).toBe(false);
  }
  expect(ownerRecoveryResumeEnabled({ PAPERCLIP_OWNER_RECOVERY_RESUME_ENABLED: "true" })).toBe(true);
});

describeDb("owner recovery prompt contract", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const responsibleUserId = randomUUID();
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-recovery-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: responsibleUserId, name: "Test operator", email: "owner-recovery@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  afterAll(async () => { await tempDb?.cleanup(); });
  beforeEach(() => vi.stubEnv("PAPERCLIP_OWNER_RECOVERY_RESUME_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());

  async function fixture(cause = "process_lost", withExecution = true) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const ownerRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery fixture", defaultResponsibleUserId: responsibleUserId, issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finish the source change", description: "Implement the remaining task change.",
      assigneeAgentId: agentId, responsibleUserId, status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", errorCode: cause,
      contextSnapshot: { issueId }, resultJson: {} });
    const contextSnapshot: Record<string, unknown> = { issueId, retryOfRunId: runId, wakeReason: "source_scoped_recovery_action", recoveryCause: cause };
    if (withExecution) {
      await db.insert(heartbeatRuns).values({ id: ownerRunId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
      await db.update(issues).set({ executionRunId: ownerRunId }).where(eq(issues.id, issueId));
    }
    const input = { db, companyId, agentId, runId: withExecution ? ownerRunId : undefined, contextSnapshot };
    return { companyId, agentId, issueId, runId, ownerRunId, input };
  }

  async function expectNormal(input: Parameters<typeof buildPaperclipWakePayload>[0]) {
    const wake = await buildPaperclipWakePayload(input);
    expect(wake?.recovery).toMatchObject({ executionMode: "owner_resume" });
    for (const resumedSession of [false, true]) {
      const prompt = renderPaperclipWakePrompt(wake, { resumedSession, includeExecutionContract: true });
      expect(prompt).toContain("Owner continuation: resume normal task work from durable progress.");
      expect(prompt).toContain("Implement the remaining task change.");
      expect(prompt).not.toContain(restriction);
      expect(prompt).not.toContain("Fallback preference order");
      expect(prompt).not.toContain("resolve call");
    }
  }

  it("returns a process_lost owner to normal work without an active recovery action", async () => {
    const f = await fixture();
    await expectNormal(f.input);
    expect(await issueRecoveryActionService(db).getActiveForIssue(f.companyId, f.issueId)).toBeNull();
  });

  it("resumes an obsolete recovery wake when no active action or cause remains", async () => {
    const f = await fixture();
    delete f.input.contextSnapshot.recoveryCause;
    f.input.contextSnapshot.recoveryActionId = randomUUID();
    await expectNormal(f.input);
  });

  it("preserves explicit status-only recovery guards", async () => {
    const f = await fixture();
    f.input.contextSnapshot.allowDeliverableWork = false;
    expect((await buildPaperclipWakePayload(f.input))?.recovery).not.toHaveProperty("executionMode");
  });

  it.each([502, 503])("permits source work after callback %s during a self-owned disposition repair", async status => {
    const f = await fixture("adapter_failed");
    await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null,
      resultJson: { summary: `Callback returned HTTP ${status}. The source task remains unfinished.` },
    }).where(eq(heartbeatRuns.id, f.runId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "deliberate_wait_without_target", ownerType: "agent", ownerAgentId: f.agentId,
      previousOwnerAgentId: f.agentId, returnOwnerAgentId: f.agentId, cause: "deliberate_wait_without_target",
      fingerprint: f.runId, evidence: { latestRunId: f.runId }, nextAction: "Record a valid disposition.", maxAttempts: 2 });
    f.input.contextSnapshot.recoveryActionId = action.id;
    await expectNormal(f.input);
    // The prompt must permit the change before the unchanged-source budget expires.
    expect((await issueRecoveryActionService(db).getActiveForIssue(f.companyId, f.issueId))?.attemptCount).toBe(1);
  });

  it.each(["process_lost", "callback_503"])("completes real owner work in one repair turn after %s", async failure => {
    const f = await fixture("process_lost", false);
    const adapterType = `owner_recovery_${failure}`;
    const seen: string[] = [];
    registerServerAdapter({
      type: adapterType,
      execute: async ctx => {
        const prompt = renderPaperclipWakePrompt(ctx.context.paperclipWake, { resumedSession: true });
        seen.push(prompt);
        if (prompt.includes(restriction)) throw new Error("The repair contract forbids the required source change.");
        // The adapter can now perform the source work and record its disposition.
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
        return { exitCode: 0, summary: "The source change and task disposition are complete.", provider: "test", model: "test" };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
    const heartbeat = heartbeatService(db);
    try {
      await db.update(agents).set({ adapterType, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.agentId));
      await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null,
        resultJson: { summary: failure === "callback_503" ? "Callback returned HTTP 503. Source work remains." : "The lost run needs normal owner work." },
        finishedAt: new Date(),
      }).where(eq(heartbeatRuns.id, f.runId));
      await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.drainActiveRunExecutions();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("Owner continuation: resume normal task work from durable progress.");
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("done");
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toHaveLength(0);
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      expect(actions).toHaveLength(1);
      expect(actions[0].attemptCount).toBe(1);
      expect(actions[0].evidence.terminalReason).not.toBe("unchanged_source_state_exhausted");
    } finally {
      await heartbeat.drainActiveRunExecutions();
      unregisterServerAdapter(adapterType);
    }
  }, 30_000);

  it("keeps a real host decision as a pending board card", async () => {
    const f = await fixture("process_lost", false);
    const adapterType = "owner_recovery_host_decision";
    let calls = 0;
    registerServerAdapter({
      type: adapterType,
      execute: async () => {
        calls++;
        await db.insert(issueThreadInteractions).values({
          companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending",
          createdByAgentId: f.agentId, effectiveResolverPolicy: "human_only", requestedResolverPolicy: "human_only",
          payload: { version: 1, prompt: "Approve the required host restart." },
        });
        await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
        return { exitCode: 0, summary: "A host restart needs a board decision.", provider: "test", model: "test" };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
    const heartbeat = heartbeatService(db);
    try {
      await db.update(agents).set({ adapterType, runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, f.agentId));
      await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null }).where(eq(heartbeatRuns.id, f.runId));
      await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.drainActiveRunExecutions();
      await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.drainActiveRunExecutions();
      expect(calls).toBe(1);
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toEqual([
        expect.objectContaining({ status: "pending", effectiveResolverPolicy: "human_only" }),
      ]);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
    } finally {
      await heartbeat.drainActiveRunExecutions();
      unregisterServerAdapter(adapterType);
    }
  });

  it("uses normal owner work after the board resolves the referenced action", async () => {
    const f = await fixture();
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: f.companyId, sourceIssueId: f.issueId, kind: "stranded_assigned_issue", cause: "process_lost",
      ownerType: "board", returnOwnerAgentId: f.agentId, status: "resolved", outcome: "restored",
      fingerprint: f.runId, evidence: {}, nextAction: "Board operator: inspect the stopped run.", resolvedAt: new Date(),
    }).returning();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    f.input.contextSnapshot = { issueId: f.issueId, wakeReason: "issue_recovery_action_restored", recoveryActionId: action.id };
    await expectNormal(f.input);
    expect((await buildPaperclipWakePayload(f.input))?.recovery?.nextAction).toBeNull();
    expect(await issueRecoveryActionService(db).getActiveForIssue(f.companyId, f.issueId)).toBeNull();
  });

  it("does not permit source work without this run's execution lock", async () => {
    const f = await fixture();
    expect((await buildPaperclipWakePayload({ ...f.input, runId: undefined }))?.recovery).not.toHaveProperty("executionMode");
    expect((await buildPaperclipWakePayload({ ...f.input, runId: randomUUID() }))?.recovery).not.toHaveProperty("executionMode");
  });

  it("retains a board-owned credential decision instead of treating it as owner continuation", async () => {
    const f = await fixture("configuration_incomplete");
    const action = await issueRecoveryActionService(db).upsertSourceScoped({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "configuration_incomplete", ownerType: "board", returnOwnerAgentId: f.agentId, cause: "configuration_incomplete",
      fingerprint: f.runId, evidence: {}, nextAction: "Board operator: select the required credential.", maxAttempts: null });
    f.input.contextSnapshot.recoveryActionId = action.id;
    const wake = await buildPaperclipWakePayload(f.input);
    expect(wake?.recovery).not.toHaveProperty("executionMode");
    expect(renderPaperclipWakePrompt(wake)).toContain(restriction);
    expect(await issueRecoveryActionService(db).getActiveForIssue(f.companyId, f.issueId)).toMatchObject({ id: action.id, ownerType: "board" });
  });

  it.each(["restore_failed", "restore_unsafe_archive"])("retains the repair contract for %s", async failure => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreFailure: failure } }).where(eq(heartbeatRuns.id, f.runId));
    const wake = await buildPaperclipWakePayload(f.input);
    expect(wake?.recovery).not.toHaveProperty("executionMode");
    expect(renderPaperclipWakePrompt(wake)).toContain(restriction);
  });

  it("preserves failed restart reconciliation from the existing restart controller", async () => {
    const f = await fixture("server_shutdown_interrupted");
    await db.update(heartbeatRuns).set({ resultJson: { restartRecovery: { outcome: "reconciliation", reason: "restart_remote_stop_unverified" } } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect((await buildPaperclipWakePayload(f.input))?.recovery).not.toHaveProperty("executionMode");
  });

  it("keeps an infrastructure action with a board decision restricted", async () => {
    const f = await fixture();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "stranded_assigned_issue", ownerType: "board", returnOwnerAgentId: f.agentId, cause: "process_lost",
      fingerprint: f.runId, evidence: {}, nextAction: "Choose whether to stop the host process." }).returning();
    f.input.contextSnapshot.recoveryActionId = action.id;
    expect((await buildPaperclipWakePayload(f.input))?.recovery).not.toHaveProperty("executionMode");
  });

  it("checks the current owner and company instead of trusting wake fields", async () => {
    const f = await fixture();
    const other = await fixture();
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    expect((await buildPaperclipWakePayload(f.input))?.recovery).not.toHaveProperty("executionMode");
    await db.update(issues).set({ assigneeAgentId: f.agentId }).where(eq(issues.id, f.issueId));
    expect(await buildPaperclipWakePayload({ ...f.input, companyId: other.companyId })).toBeNull();
    expect((await buildPaperclipWakePayload({ ...f.input, agentId: other.agentId }))?.recovery).not.toHaveProperty("executionMode");
  });

  it("restores the previous recovery contract when the switch is off", async () => {
    const f = await fixture();
    vi.stubEnv("PAPERCLIP_OWNER_RECOVERY_RESUME_ENABLED", "false");
    const wake = await buildPaperclipWakePayload(f.input);
    expect(wake?.recovery).not.toHaveProperty("executionMode");
    expect(renderPaperclipWakePrompt(wake)).toContain(restriction);
    expect(await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.sourceIssueId, f.issueId)))).toHaveLength(0);
  });
});
