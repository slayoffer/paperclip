import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { isRecoveryIssueTokenBudgetBlocked } from "../services/recovery/issue-token-budget.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping recovery budget tests: ${support.reason}`);

(support.supported ? describe : describe.skip)("recovery issue token budget admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-recovery-token-budget-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Recovery budget", issuePrefix: `B${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "fixture-owner",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local",
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Unfinished work without a wait", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: "fixture-owner",
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "succeeded", invocationSource: "assignment",
      contextSnapshot: { issueId }, usageJson: { inputTokens: 6_000_000 },
      createdAt: new Date(Date.now() - 60_000), finishedAt: new Date(Date.now() - 30_000),
    });
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "5000000");
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE", new Date(Date.now() - 3_600_000).toISOString());
    return { id: issueId, companyId, agentId, runId };
  }

  async function cards(issueId: string) {
    return db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
  }

  async function expectNoRecovery(issue: Awaited<ReturnType<typeof seed>>) {
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id)))
      .toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, issue.companyId)))
      .toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, issue.companyId)))
      .toHaveLength(1);
    const [source] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(source).toMatchObject({ status: "todo", assigneeAgentId: issue.agentId });
  }

  it("keeps repeated sweeps and direct legacy repair quiet after a rejected budget card", async () => {
    const issue = await seed();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    await recovery.reconcileStrandedAssignedIssues();
    const [stop] = await cards(issue.id);
    expect(stop).toMatchObject({ status: "pending", title: "Issue token budget reached" });
    await db.update(issueThreadInteractions).set({ status: "rejected", resolvedAt: new Date() })
      .where(eq(issueThreadInteractions.id, stop!.id));

    for (let tick = 0; tick < 4; tick += 1) {
      await recovery.reconcileStrandedAssignedIssues();
      expect(await recovery.reconcileLegacyContinuation(issue.runId)).toBe("skipped");
    }

    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await cards(issue.id)).toHaveLength(1);
    await expectNoRecovery(issue);
  });

  it("reuses one stop record when the rolling window moves", async () => {
    const issue = await seed();
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE", "");
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let tick = 0; tick < 4; tick += 1) {
      vi.setSystemTime(now + tick * 30_000);
      expect(await isRecoveryIssueTokenBudgetBlocked(db, issue)).toBe(true);
    }
    expect(await cards(issue.id)).toHaveLength(1);
    await expectNoRecovery(issue);
  });

  it("resumes legacy recovery after an accepted budget grant", async () => {
    const issue = await seed();
    expect(await isRecoveryIssueTokenBudgetBlocked(db, issue)).toBe(true);
    const [stop] = await cards(issue.id);
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date() })
      .where(eq(issueThreadInteractions.id, stop!.id));
    expect(await isRecoveryIssueTokenBudgetBlocked(db, issue)).toBe(false);

    const enqueueWakeup = vi.fn(async () => null);
    await recoveryService(db, { enqueueWakeup }).reconcileLegacyContinuation(issue.runId);
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(enqueueWakeup).toHaveBeenCalledWith(issue.agentId, expect.objectContaining({
      reason: "issue_disposition_repair", payload: expect.objectContaining({ issueId: issue.id }),
    }));
  });

  it("creates one stop record for concurrent rolling-window checks", async () => {
    const issue = await seed();
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE", "");
    expect(await Promise.all(Array.from({ length: 5 }, () => isRecoveryIssueTokenBudgetBlocked(db, issue))))
      .toEqual([true, true, true, true, true]);
    expect(await cards(issue.id)).toHaveLength(1);
    await expectNoRecovery(issue);
  });

  it("does not stop recovery when the budget is disabled", async () => {
    const issue = await seed();
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "");
    const enqueueWakeup = vi.fn(async () => null);
    await recoveryService(db, { enqueueWakeup }).reconcileLegacyContinuation(issue.runId);
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(await cards(issue.id)).toHaveLength(0);
  });

  it("does not stop an issue below the budget", async () => {
    const issue = await seed();
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "7000000");
    expect(await isRecoveryIssueTokenBudgetBlocked(db, issue)).toBe(false);
    expect(await cards(issue.id)).toHaveLength(0);
  });

  it("resumes after usage leaves a rolling window", async () => {
    const issue = await seed();
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE", "");
    expect(await isRecoveryIssueTokenBudgetBlocked(db, issue)).toBe(true);
    await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(eq(heartbeatRuns.id, issue.runId));
    expect(await isRecoveryIssueTokenBudgetBlocked(db, issue)).toBe(false);
    expect(await cards(issue.id)).toHaveLength(1);
  });

  it("does not count token usage or grants from another company", async () => {
    const issue = await seed();
    const other = await seed();
    await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 0 } })
      .where(eq(heartbeatRuns.id, issue.runId));
    // Deliberately use the same context issue ID on another company's run.
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: issue.id } })
      .where(eq(heartbeatRuns.id, other.runId));
    expect(await isRecoveryIssueTokenBudgetBlocked(db, issue)).toBe(false);

    await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 6_000_000 } })
      .where(eq(heartbeatRuns.id, issue.runId));
    await db.insert(issueThreadInteractions).values({
      companyId: other.companyId, issueId: issue.id, kind: "request_confirmation", status: "accepted",
      idempotencyKey: "issue-token-budget:foreign-grant", resolvedAt: new Date(),
      payload: { version: 1, prompt: "Foreign grant" },
    });
    expect(await isRecoveryIssueTokenBudgetBlocked(db, issue)).toBe(true);
    expect(await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id),
    ))).toHaveLength(1);
  });
});
