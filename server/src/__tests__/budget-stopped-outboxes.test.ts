import express from "express";
import { randomUUID } from "node:crypto";
import { conflict } from "../errors.js";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, goals, heartbeatRuns, interactionResolutionOutbox,
  issueComments, issueQuestionResponseDeliveries, issues, issueThreadInteractions,
} from "@paperclipai/db";
import * as heartbeats from "../services/heartbeat.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { questionResponseDeliveryService } from "../services/question-response-delivery.js";
import { interactionResolutionOutboxService } from "../services/interaction-resolution-outbox.js";
import { seedQuestionResponseDelivery } from "./helpers/question-response-delivery.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("budget-stopped interaction outboxes", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-budget-outboxes-");
    db = createDb(temporary.connectionString);
  }, 120_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.delete(interactionResolutionOutbox);
    await db.delete(issueQuestionResponseDeliveries);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture() {
    const f = await seedQuestionResponseDelivery(db);
    await db.update(heartbeatRuns).set({
      usageJson: { inputTokens: 100 }, createdAt: new Date(Date.now() - 60_000),
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "50");
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE", new Date(Date.now() - 3_600_000).toISOString());
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET_CARD_AGENT_ID", "");
    const [confirmation] = await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation",
      status: "accepted", payload: { version: 1, prompt: "Continue" },
    }).returning();
    await db.insert(interactionResolutionOutbox).values({
      companyId: f.companyId, issueId: f.issueId, interactionId: confirmation.id,
      wakes: [{ agentId: f.agentId, options: {
        idempotencyKey: `interaction:${confirmation.id}`, payload: { issueId: f.issueId },
      } }],
    });
    const wakeup = vi.fn(async (agentId: string, options: Record<string, unknown>) => {
      await db.insert(agentWakeupRequests).values({
        companyId: f.companyId, agentId, source: "automation", status: "queued",
        idempotencyKey: options.idempotencyKey as string,
        payload: options.payload as Record<string, unknown>,
      }).onConflictDoNothing();
      return null;
    });
    const heartbeat = { wakeup, cancelRun: vi.fn() } as never;
    const questions = questionResponseDeliveryService(db, { heartbeat });
    const resolutions = interactionResolutionOutboxService(db, { wakeup });
    const question = async () => (await db.select().from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.interactionId, f.interaction.id)))[0];
    const resolution = async () => (await db.select().from(interactionResolutionOutbox)
      .where(eq(interactionResolutionOutbox.interactionId, confirmation.id)))[0];
    const receipts = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    return { ...f, confirmationId: confirmation.id, wakeup, heartbeat, questions, resolutions, question, resolution, receipts };
  }

  it.each(["pending", "rejected"])("keeps answers pending without receipts or attempts while the budget card is %s", async (status) => {
    const f = await fixture();
    await f.questions.deliver(f.interaction.id);
    if (status === "rejected") await db.update(issueThreadInteractions).set({ status: "rejected" })
      .where(and(eq(issueThreadInteractions.issueId, f.issueId), eq(issueThreadInteractions.status, "pending")));
    for (let tick = 0; tick < 7; tick += 1) {
      await f.questions.sweepPending();
      await f.resolutions.sweepPending();
    }
    expect(f.wakeup).not.toHaveBeenCalled();
    expect(await f.receipts()).toHaveLength(0);
    expect(await f.question()).toMatchObject({ status: "pending", attemptCount: 0, errorCount: 0, lastAttemptAt: null });
    expect((await f.resolution()).deliveredAt).toBeNull();
    expect(await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.issueId, f.issueId),
      eq(issueThreadInteractions.idempotencyKey, `issue-token-budget:${process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE}`),
    ))).toHaveLength(1);
  });

  it.each([
    { durable: true, failure: null }, { durable: false, failure: null },
    { durable: true, failure: "saved" }, { durable: false, failure: "saved" },
    { durable: true, failure: "grant" },
  ])("budget acceptance isolates pending-row failures (durable=$durable, failure=$failure)", async ({ durable, failure }) => {
    const f = await fixture();
    await f.questions.sweepPending();
    await f.resolutions.sweepPending();
    const [card] = await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.issueId, f.issueId), eq(issueThreadInteractions.status, "pending"),
    ));
    let extraId: string | null = null;
    if (failure) {
      extraId = randomUUID();
      await db.insert(issueThreadInteractions).values({ id: extraId, companyId: f.companyId,
        issueId: f.issueId, kind: "request_confirmation", status: "accepted", payload: { version: 1, prompt: "Continue later row" } });
      await db.insert(interactionResolutionOutbox).values({ interactionId: extraId, companyId: f.companyId,
        issueId: f.issueId, wakes: [{ agentId: f.agentId, options: {
          idempotencyKey: `interaction:${extraId}`, payload: { issueId: f.issueId },
        } }] });
      const admit = f.wakeup.getMockImplementation()!;
      f.wakeup.mockImplementation(async (agentId, options) => {
        const key = String(options.idempotencyKey);
        if (key.includes(failure === "saved" ? f.confirmationId : card.id)) throw conflict("agent.not_invokable");
        return admit(agentId, options);
      });
    }
    const unrelated = await seedQuestionResponseDelivery(db);
    // Also include a different issue in the same company.
    const [otherIssue] = await db.insert(issues).values({ companyId: f.companyId, title: "Unrelated", status: "todo" }).returning();
    const [otherCard] = await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: otherIssue.id, kind: "request_confirmation", status: "accepted",
      payload: { version: 1, prompt: "Unrelated" },
    }).returning();
    await db.insert(interactionResolutionOutbox).values({
      companyId: f.companyId, issueId: otherIssue.id, interactionId: otherCard.id,
      wakes: [{ agentId: f.agentId, options: { idempotencyKey: `interaction:${otherCard.id}` } }],
    });
    vi.spyOn(heartbeats, "heartbeatService").mockReturnValue(f.heartbeat);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "board-user", companyIds: [f.companyId],
        isInstanceAdmin: false, memberships: [{ companyId: f.companyId, status: "active", membershipRole: "operator" }] };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never, {})); app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const body = durable ? { expectedRevision: card.revision, idempotencyKey: "grant-budget" } : {};
      const post = () => request(server).post(`/api/issues/${f.issueId}/interactions/${card.id}/accept`).send(body);
      const response = await post();
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(await f.question()).toMatchObject({ status: "fallback_queued", attemptCount: 1, errorCount: 0 });
      if (failure === "saved") expect((await f.resolution()).deliveredAt).toBeNull();
      else expect((await f.resolution()).deliveredAt).not.toBeNull();
      if (extraId) expect((await db.select().from(interactionResolutionOutbox)
        .where(eq(interactionResolutionOutbox.interactionId, extraId)))[0].deliveredAt).not.toBeNull();
      // One budget-card continuation, one answer, and one saved confirmation continuation.
      expect(await f.receipts()).toHaveLength(3);
      expect(f.wakeup).toHaveBeenCalledTimes(failure ? 4 : 3);
      if (durable && !failure) {
        expect((await post()).status).toBe(200);
        expect(f.wakeup).toHaveBeenCalledTimes(3);
      }
      expect((await db.select().from(issueQuestionResponseDeliveries).where(
        eq(issueQuestionResponseDeliveries.interactionId, unrelated.interaction.id),
      ))[0].status).toBe("pending");
      expect((await db.select().from(interactionResolutionOutbox).where(
        eq(interactionResolutionOutbox.interactionId, otherCard.id),
      ))[0].deliveredAt).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("bounds null wakes without durable receipts to five errors across sweeps", async () => {
    const f = await fixture();
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "");
    f.wakeup.mockResolvedValue(null);
    for (let tick = 0; tick < 7; tick += 1) await f.questions.sweepPending();
    expect(f.wakeup).toHaveBeenCalledTimes(5);
    expect(await f.question()).toMatchObject({ status: "failed", attemptCount: 5, errorCount: 5,
      lastErrorCode: "question_response_wake_skipped" });
    expect(await f.receipts()).toHaveLength(0);
  });
});
