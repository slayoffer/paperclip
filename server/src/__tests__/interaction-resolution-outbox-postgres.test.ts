import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, activityLog, agents, agentWakeupRequests, companies,
  createDb, interactionResolutionOutbox, issueQuestionResponseDeliveries, issues, issueThreadInteractions,
} from "@paperclipai/db";
import * as audit from "../services/activity-log.js";
import * as heartbeats from "../services/heartbeat.js";
import * as outbox from "../services/interaction-resolution-outbox.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { interactionDeliveryService } from "../services/interaction-deliveries.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseTests = support.supported ? describe : describe.skip;
const userId = "outbox-board-user";
const answers = [{ questionId: "scope", optionIds: ["first"] }];

databaseTests("durable interaction route effects with PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-resolution-outbox-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture(operation: "accept" | "reject" | "respond") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Outbox fixture", issuePrefix: `O${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Assigned agent", role: "engineer",
      adapterType: "process", status: "idle" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Answer fixture", status: "in_progress",
      assigneeAgentId: agent.id }).returning();
    const service = issueThreadInteractionService(db);
    const interaction = await service.create(issue, operation === "respond" ? {
      kind: "ask_user_questions", resolverPolicy: "human_only", continuationPolicy: "wake_assignee", payload: { version: 1,
        questionSet: { schema: "paperclip.question_set.v1", questions: [{ id: "scope", prompt: "Select scope", required: true,
          answerMode: "single_select", options: [{ id: "first", label: "First" }, { id: "second", label: "Second" }] }] } },
    } : { kind: "request_confirmation", resolverPolicy: "human_only", continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Continue?" } }, { userId });
    // Only queue admission is stubbed. Answers, audit, outbox, and durable wake
    // receipts use real PostgreSQL transactions and the actual HTTP routes.
    const wakeup = vi.fn(async (agentId: string, options: Record<string, unknown>) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "queued",
        idempotencyKey: options.idempotencyKey as string, payload: options.payload as Record<string, unknown> }).onConflictDoNothing();
      return null;
    });
    vi.spyOn(heartbeats, "heartbeatService").mockReturnValue({ wakeup } as never);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false,
        memberships: [{ companyId, status: "active", membershipRole: "operator" }] }; next();
    });
    app.use("/api", issueRoutes(db, {} as never, {})); app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const body = { expectedRevision: interaction.revision, idempotencyKey: `outbox-${operation}`,
      ...(operation === "respond" ? { answers } : operation === "reject" ? { reason: "Revise scope" } : {}) };
    const post = () => request(server).post(`/api/issues/${issue.id}/interactions/${interaction.id}/${operation}`).send(body);
    const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const auditRows = () => db.select().from(activityLog).where(and(eq(activityLog.entityId, issue.id),
      eq(activityLog.action, `issue.thread_interaction_${operation === "respond" ? "answered" : operation === "accept" ? "accepted" : "rejected"}`)));
    const wakeRows = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agent.id));
    return { issue, interaction, post, close, auditRows, wakeRows, wakeup };
  }

  it.each(["accept", "reject", "respond"] as const)("rolls back %s when audit persistence fails", async (operation) => {
    const f = await fixture(operation);
    const original = audit.logActivity;
    vi.spyOn(audit, "logActivity").mockImplementationOnce(async () => { throw new Error("Injected audit failure"); });
    try {
      expect((await f.post()).status).toBe(500);
      const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.interaction.id));
      expect(row.status).toBe("pending"); expect(row.revision).toBe(f.interaction.revision);
      expect(row.resolutionRequest).toBeNull(); expect(await f.auditRows()).toHaveLength(0);
      expect(await f.wakeRows()).toHaveLength(0);
      expect(await db.select().from(interactionResolutionOutbox).where(eq(interactionResolutionOutbox.interactionId, row.id))).toHaveLength(0);
      expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.interactionId, row.id))).toHaveLength(0);
      vi.mocked(audit.logActivity).mockImplementation(original);
      expect((await f.post()).status).toBe(200);
      expect((await f.post()).status).toBe(200);
      expect(await f.auditRows()).toHaveLength(1); expect(await f.wakeRows()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(["accept", "reject", "respond"] as const)("recovers %s after commit and before delivery", async (operation) => {
    const realService = outbox.interactionResolutionOutboxService;
    vi.spyOn(outbox, "interactionResolutionOutboxService").mockImplementation((...args) => {
      const service = realService(...args);
      return { ...service, deliver: vi.fn(service.deliver).mockRejectedValueOnce(new Error("Injected process loss after commit")) };
    });
    const f = await fixture(operation);
    try {
      expect((await f.post()).status).toBe(500);
      const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.interaction.id));
      expect(row.status).toBe(operation === "respond" ? "answered" : operation === "accept" ? "accepted" : "rejected");
      expect(row.resolutionRequest).toMatchObject({ key: `outbox-${operation}` });
      expect(await f.auditRows()).toHaveLength(1); expect(await f.wakeRows()).toHaveLength(0);
      if (operation !== "respond") expect(await db.select().from(interactionResolutionOutbox).where(and(
        eq(interactionResolutionOutbox.interactionId, row.id), isNull(interactionResolutionOutbox.deliveredAt)))).toHaveLength(1);
      const retry = await f.post(); expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect((await f.post()).body).toEqual(retry.body);
      expect(await f.auditRows()).toHaveLength(1); expect(await f.wakeRows()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("recovers a lost wake response without another admission", async () => {
    const f = await fixture("accept");
    const admit = f.wakeup.getMockImplementation()!;
    f.wakeup.mockImplementationOnce(async (...args) => { await admit(...args); throw new Error("Lost wake response"); });
    try {
      expect((await f.post()).status).toBe(200);
      expect(await f.auditRows()).toHaveLength(1); expect(await f.wakeRows()).toHaveLength(1);
      expect((await f.post()).status).toBe(200);
      expect(await f.wakeRows()).toHaveLength(1); expect(f.wakeup).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it("delivers a pending continuation through the sweep without a client retry", async () => {
    const f = await fixture("reject");
    f.wakeup.mockRejectedValueOnce(new Error("Queue temporarily unavailable"));
    try {
      expect((await f.post()).status).toBe(500);
      await interactionDeliveryService(db, { heartbeat: { wakeup: f.wakeup } as never }).sweepPending();
      expect(await f.wakeRows()).toHaveLength(1); expect(await f.auditRows()).toHaveLength(1);
      const [entry] = await db.select().from(interactionResolutionOutbox)
        .where(eq(interactionResolutionOutbox.interactionId, f.interaction.id));
      expect(entry.deliveredAt).not.toBeNull();
    } finally { await f.close(); }
  });

  it("keeps suppressed admission pending until the queue accepts it", async () => {
    const f = await fixture("accept");
    f.wakeup.mockResolvedValueOnce(null);
    try {
      expect((await f.post()).status).toBe(200);
      expect(await f.wakeRows()).toHaveLength(0);
      const [pending] = await db.select().from(interactionResolutionOutbox)
        .where(eq(interactionResolutionOutbox.interactionId, f.interaction.id));
      expect(pending.deliveredAt).toBeNull();
      await outbox.interactionResolutionOutboxService(db, { wakeup: f.wakeup }).sweepPending();
      expect(await f.wakeRows()).toHaveLength(1); expect(await f.auditRows()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("deduplicates concurrent replay and sweep workers at the durable queue", async () => {
    const f = await fixture("reject");
    f.wakeup.mockResolvedValueOnce(null);
    try {
      expect((await f.post()).status).toBe(200);
      const worker = outbox.interactionResolutionOutboxService(db, { wakeup: f.wakeup });
      await Promise.all([f.post(), worker.sweepPending(), worker.deliver(f.interaction.id)]);
      expect(await f.wakeRows()).toHaveLength(1); expect(await f.auditRows()).toHaveLength(1);
    } finally { await f.close(); }
  });
});
