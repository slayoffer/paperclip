import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, createDb, documents, heartbeatRuns, issues, agentWakeupRequests } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { continueRunTokenCap, ownsRunTokenCapContinuation, runTokenCapBaseline } from "./run-token-cap.js";
import { getIssueContinuationSummaryDocument, refreshIssueContinuationSummary } from "./issue-continuation-summary.js";
import { classifyRunLiveness } from "./run-liveness.js";
import { recoveryService } from "./recovery/service.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseTests = support.supported ? describe : describe.skip;

describe("cap stop classification", () => {
  it("keeps the cap out of failure, empty-response, and plan-only recovery", () => {
    const resultJson = { stopReason: "run_token_cap" };
    expect(classifyRunLiveness({ runStatus: "succeeded", issue: null, resultJson }))
      .toMatchObject({ livenessState: "advanced", livenessReason: "run_token_cap" });
    expect(ownsRunTokenCapContinuation({ status: "succeeded", resultJson })).toBe(true);
    expect(ownsRunTokenCapContinuation({ status: "succeeded", contextSnapshot: { runTokenCapSourceRunId: "source" } })).toBe(true);
    expect(ownsRunTokenCapContinuation({ status: "failed", resultJson })).toBe(false);
    expect(ownsRunTokenCapContinuation({ status: "succeeded", resultJson: {} })).toBe(false);
  });
});

databaseTests("cap handoff and continuation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let agent: typeof agents.$inferSelect;
  let issue: typeof issues.$inferSelect;
  let run: typeof heartbeatRuns.$inferSelect;
  const wakeup = vi.fn();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-run-cap-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });
  afterEach(() => { vi.unstubAllEnvs(); });
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "");
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Run cap", issuePrefix: `C${companyId.slice(0, 6)}` });
    [agent] = await db.insert(agents).values({ companyId, name: "Owner", role: "engineer",
      status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agent.id,
      title: "Finish work", status: "in_progress" }).returning();
    [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id,
      invocationSource: "assignment", status: "succeeded", contextSnapshot: { issueId: issue.id },
      resultJson: { stopReason: "run_token_cap", summary: "Done: A. Left: B. Next: test B." },
      usageJson: { inputTokens: 101 }, finishedAt: new Date() }).returning();
    await refreshIssueContinuationSummary({ db, issueId: issue.id, run, agent });
    wakeup.mockReset();
    wakeup.mockImplementation(async (agentId, options) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: options.source,
        reason: options.reason, status: "queued", idempotencyKey: options.idempotencyKey, payload: options.payload });
      return null;
    });
  });

  it("writes the handoff first and queues one same-owner continuation across concurrent finalizers and replay", async () => {
    await Promise.all([continueRunTokenCap(db, run, wakeup), continueRunTokenCap(db, run, wakeup)]);
    await continueRunTokenCap(db, run, wakeup);
    expect(wakeup).toHaveBeenCalledOnce();
    expect(wakeup).toHaveBeenCalledWith(agent.id, expect.objectContaining({
      reason: "run_token_cap", issueStateGuard: { statuses: ["todo", "in_progress"], assigneeAgentId: agent.id },
      contextSnapshot: expect.objectContaining({ issueId: issue.id, runTokenCapSourceRunId: run.id }),
    }));
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, run.companyId))).toHaveLength(1);
  });

  it("does not queue a second automatic continuation when the successor also reaches the cap", async () => {
    await continueRunTokenCap(db, run, wakeup);
    await continueRunTokenCap(db, { ...run, id: randomUUID(), contextSnapshot: {
      issueId: issue.id, runTokenCapSourceRunId: run.id,
    } }, wakeup);
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it("respects an exhausted issue budget including this completed run", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "100");
    await continueRunTokenCap(db, run, wakeup);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it.each(["done", "blocked", "in_review", "cancelled"])("does not resume issue status %s", async (status) => {
    await db.update(issues).set({ status }).where(eq(issues.id, issue.id));
    await continueRunTokenCap(db, run, wakeup);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("does not wake a new assignee or cross a company boundary", async () => {
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issue.id));
    await continueRunTokenCap(db, run, wakeup);
    await continueRunTokenCap(db, { ...run, companyId: randomUUID() }, wakeup);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("repairs a missing source-run handoff before it admits the wake", async () => {
    const [next] = await db.insert(heartbeatRuns).values({ companyId: run.companyId, agentId: run.agentId,
      invocationSource: "assignment", status: "succeeded", contextSnapshot: run.contextSnapshot,
      resultJson: run.resultJson }).returning();
    await continueRunTokenCap(db, next, wakeup);
    expect((await getIssueContinuationSummaryDocument(db, issue.id))?.body).toContain(`Last updated by run: ${next.id}`);
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it("leaves ordinary successful runs unchanged", async () => {
    await continueRunTokenCap(db, { ...run, resultJson: {} }, wakeup);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("admits no continuation if the handoff document rejects the write", async () => {
    await db.update(documents).set({ lockedAt: new Date(), lockedByAgentId: agent.id })
      .where(eq(documents.companyId, run.companyId));
    const [next] = await db.insert(heartbeatRuns).values({ companyId: run.companyId, agentId: run.agentId,
      invocationSource: "assignment", status: "succeeded", contextSnapshot: run.contextSnapshot,
      resultJson: run.resultJson }).returning();
    await continueRunTokenCap(db, next, wakeup);
    expect(wakeup).not.toHaveBeenCalled();
    expect((await getIssueContinuationSummaryDocument(db, issue.id))?.body).toContain(`Last updated by run: ${run.id}`);
  });

  it("suppresses legacy repair for the cap and its successor", async () => {
    const recovery = recoveryService(db, { enqueueWakeup: wakeup });
    await continueRunTokenCap(db, run, wakeup);
    wakeup.mockClear();
    expect(await recovery.reconcileLegacyContinuation(run.id)).toBe("skipped");
    await db.update(heartbeatRuns).set({ resultJson: {}, contextSnapshot: {
      issueId: issue.id, runTokenCapSourceRunId: run.id,
    } }).where(eq(heartbeatRuns.id, run.id));
    expect(await recovery.reconcileLegacyContinuation(run.id)).toBe("skipped");
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("recovers one missing continuation after a finalizer restart without opening a recovery issue", async () => {
    const recovery = recoveryService(db, { enqueueWakeup: wakeup });
    await recovery.reconcileLegacyContinuation(run.id);
    await recovery.reconcileLegacyContinuation(run.id);
    expect(wakeup).toHaveBeenCalledOnce();
    expect(await db.select().from(issues).where(eq(issues.companyId, run.companyId))).toHaveLength(1);
  });

  it("does not replay a cap source after a later independent run", async () => {
    await db.insert(heartbeatRuns).values({ companyId: run.companyId, agentId: run.agentId,
      invocationSource: "on_demand", status: "succeeded", contextSnapshot: run.contextSnapshot,
      createdAt: new Date(Date.now() + 1) });
    await continueRunTokenCap(db, run, wakeup);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("loads the last valid cumulative usage for a resumed owner or task session only when enabled", async () => {
    await db.update(heartbeatRuns).set({ sessionIdAfter: "thread-1", usageJson: { rawInputTokens: 900, inputTokens: 101 } })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
    const input = { agentId: agent.id, runId: randomUUID(), adapterType: "codex_local",
      runtime: { sessionId: "thread-1", sessionDisplayId: "thread-1", sessionParams: null, taskKey: issue.id } };
    vi.stubEnv("PAPERCLIP_RUN_TOKEN_CAP_MODE", "off");
    expect(await runTokenCapBaseline(db, input)).toEqual({});
    vi.stubEnv("PAPERCLIP_RUN_TOKEN_CAP_MODE", "enforce");
    vi.stubEnv("PAPERCLIP_RUN_TOKEN_CAP_INPUT_TOKENS", "100");
    expect(await runTokenCapBaseline(db, input)).toEqual({ paperclipRunTokenCapBaseline: { sessionId: "thread-1", inputTokens: 900 } });
  });
});
