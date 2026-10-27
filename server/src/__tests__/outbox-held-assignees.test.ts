import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, goals, heartbeatRuns,
  interactionResolutionOutbox, issueComments, issueQuestionResponseDeliveries, issues, issueThreadInteractions,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { interactionResolutionOutboxService } from "../services/interaction-resolution-outbox.js";
import { questionResponseDeliveryService } from "../services/question-response-delivery.js";
import { createQuestionResponseSweep } from "../services/question-response-sweep.js";
import { outboxBackoff } from "../services/outbox-backoff.js";
import { seedQuestionResponseDelivery } from "./helpers/question-response-delivery.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("held outbox assignees", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-held-assignees-");
    db = createDb(temporary.connectionString);
  }, 120_000);
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await db.delete(interactionResolutionOutbox); await db.delete(issueQuestionResponseDeliveries);
    await db.delete(issueThreadInteractions); await db.delete(issueComments); await db.delete(activityLog);
    await db.delete(heartbeatRuns); await db.delete(agentWakeupRequests);
    await db.delete(issues); await db.delete(goals); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture(kind: "question" | "resolution", status: "paused" | "terminated") {
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "");
    const f = await seedQuestionResponseDelivery(db);
    await db.update(agents).set({ status }).where(eq(agents.id, f.agentId));
    await db.update(companies).set({ defaultResponsibleUserId: "board-user" }).where(eq(companies.id, f.companyId));
    const key = `${kind === "question" ? "question-response" : "interaction"}:${f.interaction.id}`;
    if (kind === "resolution") await db.insert(interactionResolutionOutbox).values({
      companyId: f.companyId, issueId: f.issueId, interactionId: f.interaction.id,
      wakes: [{ agentId: f.agentId, options: { idempotencyKey: key, requestedByActorType: "user",
        requestedByActorId: "board-user", payload: { issueId: f.issueId } } }],
    });
    const real = heartbeatService(db);
    const wakeupForOutbox = vi.fn(real.wakeupForOutbox);
    const heartbeat = { ...real, wakeupForOutbox };
    let clock = new Date();
    // Recreate the service each time to prove that the delay is persisted.
    const worker = () => kind === "question"
      ? questionResponseDeliveryService(db, { heartbeat, now: () => clock })
      : interactionResolutionOutboxService(db, heartbeat, { now: () => clock });
    const row = async () => kind === "question"
      ? (await db.select().from(issueQuestionResponseDeliveries)
        .where(eq(issueQuestionResponseDeliveries.interactionId, f.interaction.id)))[0]
      : (await db.select().from(interactionResolutionOutbox)
        .where(eq(interactionResolutionOutbox.interactionId, f.interaction.id)))[0];
    const receipts = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
    return { ...f, key, worker, row, receipts, wakeupForOutbox,
      now: () => clock, setTime: (at: Date) => { clock = at; } };
  }

  it.each(["question", "resolution"] as const)("%s holds a paused assignee with growing gaps and delivers once after unpause", async (kind) => {
    const f = await fixture(kind, "paused");
    const delays = [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000];
    for (const [index, delay] of delays.entries()) {
      await f.worker().sweepPending();
      const row = await f.row();
      expect(row).toMatchObject({ holdCount: index + 1, lastErrorCode: "agent.not_invokable" });
      expect(row.nextAttemptAt!.getTime() - f.now().getTime()).toBe(delay);
      expect(await f.receipts()).toHaveLength(0);
      f.setTime(new Date(row.nextAttemptAt!.getTime() - 1));
      await f.worker().sweepPending();
      await f.worker().deliver(f.interaction.id);
      expect(f.wakeupForOutbox).toHaveBeenCalledTimes(index + 1);
      f.setTime(row.nextAttemptAt!);
    }
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    // Stub successful admission only. All paused gate decisions above use the real heartbeat.
    f.wakeupForOutbox.mockImplementation(async (_agentId, options) => {
      expect(options.idempotencyKey).toBe(f.key);
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
        source: "automation", status: "queued", idempotencyKey: f.key }).onConflictDoNothing();
      return { run: null, suppression: null };
    });
    await f.worker().sweepPending();
    await f.worker().sweepPending();
    await f.worker().deliver(f.interaction.id);
    expect(f.wakeupForOutbox).toHaveBeenCalledTimes(delays.length + 1);
    expect(await f.receipts()).toHaveLength(1);
    const row = await f.row();
    if ("status" in row) expect(row).toMatchObject({ status: "fallback_queued", errorCount: 0 });
    else expect(row.deliveredAt).not.toBeNull();
  }, 30_000);

  it.each(["question", "resolution"] as const)("%s fails a terminated assignee with its reason", async (kind) => {
    const f = await fixture(kind, "terminated");
    await f.worker().sweepPending();
    const row = await f.row();
    expect(row.lastErrorCode).toBe("agent.terminated");
    if ("status" in row) expect(row.status).toBe("failed");
    else expect(row.failedAt).not.toBeNull();
    f.setTime(new Date(f.now().getTime() + 3_600_000));
    await f.worker().sweepPending();
    await f.worker().deliver(f.interaction.id);
    expect(f.wakeupForOutbox).toHaveBeenCalledTimes(1);
    expect(await f.receipts()).toHaveLength(0);
  });

  it("continues a question-response page after one row throws", async () => {
    const first = await seedQuestionResponseDelivery(db);
    const second = await seedQuestionResponseDelivery(db);
    const deliver = vi.fn(async (id: string) => {
      if (id === first.interaction.id) throw new Error("Injected row failure");
      return null;
    });
    const sweep = createQuestionResponseSweep(db, deliver, () => new Date(), 60_000);
    expect((await sweep()).scanned).toBe(2);
    expect(deliver.mock.calls.map(([id]) => id)).toEqual([first.interaction.id, second.interaction.id]);
    expect(await db.select().from(issueQuestionResponseDeliveries).where(and(
      eq(issueQuestionResponseDeliveries.companyId, second.companyId), eq(issueQuestionResponseDeliveries.status, "pending"),
    ))).toHaveLength(1);
  });
});

it("caps persisted outbox backoff at thirty minutes", () => {
  const at = new Date();
  expect(outboxBackoff(1000, at).nextAttemptAt.getTime() - at.getTime()).toBe(1_800_000);
});
