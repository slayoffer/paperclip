import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, goals, heartbeatRuns,
  issueComments, issueQuestionResponseDeliveries, issues, issueThreadInteractions, issueTreeHolds, issueTreeHoldMembers,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { conflict } from "../errors.js";
import { questionResponseDeliveryService, questionResponseDeliveryValues } from "../services/question-response-delivery.js";
import * as budgets from "../services/recovery/issue-token-budget.js";
import { seedQuestionResponseDelivery } from "./helpers/question-response-delivery.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("question response holds and fair delivery", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-question-holds-");
    db = createDb(temporary.connectionString);
  }, 120_000);
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await db.delete(issueTreeHoldMembers); await db.delete(issueTreeHolds);
    await db.delete(issueQuestionResponseDeliveries); await db.delete(issueThreadInteractions);
    await db.delete(issueComments); await db.delete(activityLog);
    await db.delete(heartbeatRuns); await db.delete(agentWakeupRequests);
    await db.delete(issues); await db.delete(goals); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture() {
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "");
    const f = await seedQuestionResponseDelivery(db);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await db.update(companies).set({ defaultResponsibleUserId: "board-user" }).where(eq(companies.id, f.companyId));
    const delivery = async () => (await db.select().from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.interactionId, f.interaction.id)))[0];
    const admit = async () => {
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
        source: "automation", status: "queued", idempotencyKey: `question-response:${f.interaction.id}` });
      return { run: null, skipped: null };
    };
    let clock = new Date();
    const now = () => clock;
    const advance = async () => { clock = (await delivery()).nextAttemptAt!; };
    return { ...f, delivery, admit, now, advance };
  }

  it("delivers after wake suppression outlasts the bounded error retry limit", async () => {
    const f = await fixture();
    const wakeupWithDiagnostics = vi.fn().mockResolvedValue({ run: null,
      skipped: { reason: "heartbeat.scheduling_suppressed" } });
    const service = questionResponseDeliveryService(db, { heartbeat: { wakeupWithDiagnostics } as never, now: f.now });
    for (let tick = 0; tick < 7; tick += 1) { await service.sweepPending(); await f.advance(); }
    expect(await f.delivery()).toMatchObject({ status: "pending", attemptCount: 7, errorCount: 0 });
    wakeupWithDiagnostics.mockImplementation(f.admit);
    await service.sweepPending();
    expect(await f.delivery()).toMatchObject({ status: "fallback_queued", attemptCount: 8, errorCount: 0 });
    await service.sweepPending();
    expect(wakeupWithDiagnostics).toHaveBeenCalledTimes(8);
  });

  it("retains an answer through more than five real issue-tree pause admissions", async () => {
    const f = await fixture();
    const control = issueTreeControlService(db);
    const actor = { actorType: "user" as const, actorId: "board-user", userId: "board-user" };
    const { hold } = await control.createHold(f.companyId, f.issueId, { mode: "pause", reason: "Maintenance", actor });
    const real = heartbeatService(db);
    const wakeupForOutbox = vi.fn(real.wakeupForOutbox);
    const service = questionResponseDeliveryService(db, { heartbeat: { wakeupForOutbox } as never, now: f.now });
    for (let tick = 0; tick < 7; tick += 1) { await service.sweepPending(); await f.advance(); }
    expect(await f.delivery()).toMatchObject({ status: "pending", attemptCount: 7, errorCount: 0,
      lastErrorCode: "issue_tree_hold_active" });
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
    expect(receipts).toHaveLength(0);
    expect(receipts.every((row) => row.reason === "issue_tree_hold_active")).toBe(true);
    await control.releaseHold(f.companyId, f.issueId, hold.id, { reason: "Maintenance complete", actor });
    wakeupForOutbox.mockImplementation(async () => { await f.admit(); return { run: null, suppression: null }; });
    await service.sweepPending();
    expect(await f.delivery()).toMatchObject({ status: "fallback_queued", errorCount: 0 });
  });

  it.each(["heartbeat.wakeOnDemand.disabled", "budget.blocked", "agent.not_invokable"])(
    "preserves an answer while exact diagnostics report %s", async (reason) => {
      const f = await fixture();
      const wakeupWithDiagnostics = vi.fn(async () => {
        if (reason === "heartbeat.wakeOnDemand.disabled") return { run: null, skipped: { reason } };
        throw conflict(reason, { wakeup: { reason } });
      });
      const service = questionResponseDeliveryService(db, { heartbeat: { wakeupWithDiagnostics } as never, now: f.now });
      for (let tick = 0; tick < 7; tick += 1) { await service.sweepPending(); await f.advance(); }
      expect(await f.delivery()).toMatchObject({ status: "pending", attemptCount: 7, errorCount: 0, lastErrorCode: reason });
    },
  );

  it("does not consume an error retry when the budget becomes exhausted after the pre-check", async () => {
    const f = await fixture();
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "50");
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE", new Date(Date.now() - 3_600_000).toISOString());
    const real = heartbeatService(db);
    const wakeupForOutbox = vi.fn(async (...args: Parameters<typeof real.wakeupForOutbox>) => {
      await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 100 } }).where(eq(heartbeatRuns.id, f.sourceRunId));
      return real.wakeupForOutbox(...args);
    });
    const service = questionResponseDeliveryService(db, { heartbeat: { wakeupForOutbox } as never, now: f.now });
    await service.deliver(f.interaction.id);
    expect(await f.delivery()).toMatchObject({ status: "pending", attemptCount: 1, errorCount: 0,
      lastErrorCode: "issue.token_budget_exceeded" });
    for (let tick = 0; tick < 7; tick += 1) await service.sweepPending();
    expect(wakeupForOutbox).toHaveBeenCalledTimes(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toHaveLength(0);
  });

  it("bounds unexplained nulls even when an old skipped receipt exists", async () => {
    const f = await fixture();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", status: "skipped", reason: "issue_tree_hold_active",
      idempotencyKey: `question-response:${f.interaction.id}` });
    const wakeupWithDiagnostics = vi.fn().mockResolvedValue({ run: null, skipped: null });
    const service = questionResponseDeliveryService(db, { heartbeat: { wakeupWithDiagnostics } as never, now: f.now });
    for (let tick = 0; tick < 7; tick += 1) await service.sweepPending();
    expect(wakeupWithDiagnostics).toHaveBeenCalledTimes(5);
    expect(await f.delivery()).toMatchObject({ status: "failed", errorCount: 5 });
  });

  it("advances past fifty budget-held answers with equal microsecond timestamps and refreshes each page's budget", async () => {
    const f = await fixture();
    const [template] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.interaction.id));
    const ids = [f.interaction.id, ...Array.from({ length: 49 }, () => randomUUID())];
    await db.insert(issueThreadInteractions).values(ids.slice(1).map((id) => ({
      ...template, id, idempotencyKey: null,
    })));
    await db.insert(issueQuestionResponseDeliveries).values(ids.slice(1).map((id) =>
      questionResponseDeliveryValues({ ...f.interaction, id })));
    const instant = new Date(Date.now() - 60_000).toISOString();
    await db.update(issueQuestionResponseDeliveries).set({ createdAt: sql`${instant}::timestamptz + interval '123 microseconds'` });
    const ready = await seedQuestionResponseDelivery(db);
    let blocked = true;
    const checkBudget = vi.spyOn(budgets, "isRecoveryIssueTokenBudgetBlocked")
      .mockImplementation(async (_db, issue) => issue.id === f.issueId && blocked);
    const wakeup = vi.fn(async (agentId: string, options: Record<string, unknown>) => {
      const companyId = agentId === f.agentId ? f.companyId : ready.companyId;
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "queued",
        idempotencyKey: options.idempotencyKey as string });
      return null;
    });
    const service = questionResponseDeliveryService(db, { heartbeat: { wakeup } as never });
    expect((await service.sweepPending()).scanned).toBe(50);
    expect(checkBudget).toHaveBeenCalledTimes(1);
    expect(wakeup).not.toHaveBeenCalled();
    expect((await service.sweepPending()).scanned).toBe(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    blocked = false;
    expect((await service.sweepPending(1)).scanned).toBe(1);
    expect(checkBudget).toHaveBeenCalledTimes(3);
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.status, "pending")))
      .toHaveLength(49);
  }, 30_000);
});
