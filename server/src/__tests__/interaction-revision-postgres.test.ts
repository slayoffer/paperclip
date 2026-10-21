import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, activityLog, agents, heartbeatRuns, companies, createDb, issueQuestionResponseDeliveries,
  issueThreadInteractions, issues,
} from "@paperclipai/db";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { isInteractionResolutionReplay } from "../services/interaction-revision.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Interaction revision database tests unavailable: ${support.reason}`);
const databaseTests = support.supported ? describe : describe.skip;
const actor = { userId: "revision-board" };
const answers = [{ questionId: "scope", optionIds: ["first"] }];
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

databaseTests("interaction revisions with PostgreSQL transactions", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-interaction-revision-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function seed(kind: "request_confirmation" | "ask_user_questions" = "ask_user_questions") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Revision fixture", issuePrefix: `R${companyId.slice(0, 7)}` });
    const [issue] = await db.insert(issues).values({ companyId, title: "Answer fixture", status: "in_progress" }).returning();
    const service = issueThreadInteractionService(db);
    const interaction = await service.create(issue, kind === "request_confirmation" ? {
      kind, payload: { version: 1, prompt: "Continue?" }, resolverPolicy: "human_only",
    } : {
      kind, resolverPolicy: "human_only", payload: { version: 1, questionSet: {
        schema: "paperclip.question_set.v1", questions: [{ id: "scope", prompt: "Select scope", required: true,
          answerMode: "single_select", options: [{ id: "first", label: "First" }, { id: "second", label: "Second" }] }],
      } },
    }, actor);
    return { issue, interaction, service };
  }

  async function noAnswerEffects(issueId: string) {
    expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).toHaveLength(0);
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(row.resolvedAt).toBeNull();
    expect(row.resolutionRequest).toBeNull();
  }

  // Observe a real PostgreSQL lock wait. No timing delay acts as the race barrier.
  async function waitForBlockedTransaction(blocker: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = await db.execute(sql`select pid from pg_stat_activity where ${blocker} = any(pg_blocking_pids(pid))`);
      if (rows.length) return;
      await setImmediate();
    }
    throw new Error("The competing transaction did not reach the database lock");
  }

  it.each(["accept", "reject", "respond"] as const)("commits %s once and reuses an identical receipt", async (operation) => {
    const { issue, interaction, service } = await seed(operation === "respond" ? "ask_user_questions" : "request_confirmation");
    let effects = 0;
    const options = { afterResolveInTransaction: async () => { effects += 1; } };
    const precondition = { expectedRevision: interaction.revision, idempotencyKey: `retry-${operation}` };
    const resolve = () => operation === "accept"
      ? service.acceptInteraction(issue, interaction.id, precondition, actor, options).then((result) => result.interaction)
      : operation === "reject"
        ? service.rejectInteraction(issue, interaction.id, { ...precondition, reason: "Decline" }, actor, options)
        : service.answerQuestions(issue, interaction.id, { ...precondition, answers }, actor, options);
    const first = await resolve();
    const retry = await resolve();
    expect(retry).toEqual(first);
    expect(isInteractionResolutionReplay(retry)).toBe(true);
    expect(first.revision).not.toBe(interaction.revision);
    expect(first).not.toHaveProperty("resolutionRequest");
    expect(effects).toBe(1);
    expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.issueId, issue.id)))
      .toHaveLength(operation === "respond" ? 1 : 0);
    const changed = { ...precondition, expectedRevision: randomUUID() };
    const promise = operation === "accept" ? service.acceptInteraction(issue, interaction.id, changed, actor)
      : operation === "reject" ? service.rejectInteraction(issue, interaction.id, { ...changed, reason: "Decline" }, actor)
        : service.answerQuestions(issue, interaction.id, { ...changed, answers }, actor);
    await expect(promise).rejects.toMatchObject({ status: 409, details: { code: "interaction_idempotency_conflict" } });
  });

  it.each(["prompt", "options", "resolver", "addressee", "target"])("rejects an old revision after a %s mutation", async (field) => {
    const { issue, interaction, service } = await seed(field === "target" ? "request_confirmation" : "ask_user_questions");
    const patch = field === "resolver" ? { effectiveResolverPolicy: "anyone" as const }
      : field === "addressee" ? { addresseeUserId: actor.userId }
        : field === "target" ? { payload: { ...interaction.payload,
          target: { type: "issue_document" as const, key: "plan", revisionId: randomUUID() } } }
          : interaction.kind === "ask_user_questions" ? { payload: { ...interaction.payload,
            questions: interaction.payload.questions.map((question) => ({ ...question,
              ...(field === "prompt" ? { prompt: "Changed prompt" } : { options: [{ id: "replacement", label: "Replacement" }] }),
            })),
          } } : {} ;
    await db.update(issueThreadInteractions).set(patch).where(eq(issueThreadInteractions.id, interaction.id));
    await expect(field === "target"
      ? service.acceptInteraction(issue, interaction.id, { expectedRevision: interaction.revision }, actor)
      : service.answerQuestions(issue, interaction.id, { answers, expectedRevision: interaction.revision }, actor))
      .rejects.toMatchObject({ status: 409, details: { code: "interaction_revision_conflict" } });
    await noAnswerEffects(issue.id);
  });

  it("advances revisions for two direct writes with the same timestamp", async () => {
    const { interaction } = await seed();
    const instant = new Date("2026-10-19T01:00:00.000Z");
    const [first] = await db.update(issueThreadInteractions).set({ title: "First", updatedAt: instant }).where(eq(issueThreadInteractions.id, interaction.id)).returning();
    const [second] = await db.update(issueThreadInteractions).set({ title: "Second", updatedAt: instant }).where(eq(issueThreadInteractions.id, interaction.id)).returning();
    expect(first.updatedAt).toEqual(second.updatedAt);
    expect(new Set([interaction.revision, first.revision, second.revision]).size).toBe(3);
  });

  it("rejects a stale answer after a competing writer commits", async () => {
    const { issue, interaction, service } = await seed();
    const locked = barrier(); const release = barrier(); let blocker = 0;
    const writer = db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, issue.id)).for("update");
      const [pid] = await tx.execute(sql`select pg_backend_pid() as pid`); blocker = Number(pid.pid);
      await tx.update(issueThreadInteractions).set({ title: "Changed while displayed" }).where(eq(issueThreadInteractions.id, interaction.id));
      locked.release(); await release.promise;
    });
    await locked.promise;
    const answer = service.answerQuestions(issue, interaction.id, { answers, expectedRevision: interaction.revision }, actor);
    const result = expect(answer).rejects.toMatchObject({ details: { code: "interaction_revision_conflict" } });
    try { await waitForBlockedTransaction(blocker); } finally { release.release(); }
    await writer; await result; await noAnswerEffects(issue.id);
  });

  it("permits one Mini App or Attention answer and one delivery", async () => {
    const { issue, interaction, service } = await seed();
    const entered = barrier(); const release = barrier(); let blocker = 0; let effects = 0;
    const first = service.answerQuestions(issue, interaction.id, { answers, expectedRevision: interaction.revision, idempotencyKey: "mini-app" }, actor, {
      beforeResolveInTransaction: async (tx) => {
        const [pid] = await tx.execute(sql`select pg_backend_pid() as pid`); blocker = Number(pid.pid);
        entered.release(); await release.promise;
      }, afterResolveInTransaction: async () => { effects += 1; },
    });
    await entered.promise;
    const second = service.answerQuestions(issue, interaction.id, { answers, expectedRevision: interaction.revision, idempotencyKey: "attention" }, actor);
    const loser = expect(second).rejects.toMatchObject({ details: { code: "interaction_already_resolved" } });
    try { await waitForBlockedTransaction(blocker); } finally { release.release(); }
    expect((await first).status).toBe("answered"); await loser;
    expect(effects).toBe(1);
    expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.issueId, issue.id))).toHaveLength(1);
  });

  it("checks the revision again at the question write boundary", async () => {
    const { issue, interaction, service } = await seed();
    await expect(service.answerQuestions(issue, interaction.id, { answers, expectedRevision: interaction.revision }, actor, {
      beforeResolveInTransaction: async (tx) => {
        await tx.update(issueThreadInteractions).set({ title: "Changed after validation" }).where(eq(issueThreadInteractions.id, interaction.id));
      },
    })).rejects.toMatchObject({ status: 409, details: { code: "interaction_revision_conflict" } });
    await noAnswerEffects(issue.id);
  });

  it.each(["expired", "withdrawn", "closed"])("prevents an answer when %s wins the race", async (state) => {
    const { issue, interaction, service } = await seed();
    const locked = barrier(); const release = barrier(); let blocker = 0;
    const writer = db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, issue.id)).for("update");
      const [pid] = await tx.execute(sql`select pg_backend_pid() as pid`); blocker = Number(pid.pid);
      if (state === "closed") await tx.update(issues).set({ status: "done" }).where(eq(issues.id, issue.id));
      else await tx.update(issueThreadInteractions).set({ status: state }).where(eq(issueThreadInteractions.id, interaction.id));
      locked.release(); await release.promise;
    });
    await locked.promise;
    const answer = service.answerQuestions(issue, interaction.id, { answers, expectedRevision: interaction.revision }, actor);
    const rejected = expect(answer).rejects.toMatchObject({ status: 409, details: { code: state === "closed" ? "interaction_issue_closed" : "interaction_already_resolved" } });
    try { await waitForBlockedTransaction(blocker); } finally { release.release(); }
    await writer; await rejected; await noAnswerEffects(issue.id);
  });

  it("retains company and resolver denials", async () => {
    const { issue, interaction, service } = await seed();
    await expect(service.answerQuestions({ ...issue, companyId: randomUUID() }, interaction.id, { answers, expectedRevision: interaction.revision }, actor)).rejects.toMatchObject({ status: 404 });
    await expect(service.answerQuestions(issue, interaction.id, { answers, expectedRevision: interaction.revision }, { agentId: randomUUID() }))
      .rejects.toMatchObject({ status: 422, details: { code: "interaction_run_attribution_required" } });
    const [agent] = await db.insert(agents).values({ companyId: issue.companyId, name: "Resolver", role: "engineer" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: issue.companyId, agentId: agent.id,
      status: "running", contextSnapshot: { issueId: issue.id } }).returning();
    await expect(service.answerQuestions(issue, interaction.id, { answers, expectedRevision: interaction.revision }, { agentId: agent.id, runId: run.id }))
      .rejects.toMatchObject({ status: 403, details: { code: "interaction_human_only" } });
    await db.update(issueThreadInteractions).set({ addresseeUserId: "another-board-user" }).where(eq(issueThreadInteractions.id, interaction.id));
    const current = await service.getById(interaction.id);
    await expect(service.answerQuestions(issue, interaction.id, { answers, expectedRevision: current!.revision }, actor)).rejects.toMatchObject({ status: 403 });
    await noAnswerEffects(issue.id);
  });

  it.each(["accept", "reject", "respond"] as const)("does not repeat route effects for an identical %s retry", async (operation) => {
    const { issue, interaction } = await seed(operation === "respond" ? "ask_user_questions" : "request_confirmation");
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: actor.userId, companyIds: [issue.companyId],
        memberships: [{ companyId: issue.companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never, {})); app.use(errorHandler);
    const path = `/api/issues/${issue.id}/interactions/${interaction.id}/${operation}`;
    const body = { expectedRevision: interaction.revision, idempotencyKey: `route-${operation}`,
      ...(operation === "respond" ? { answers } : operation === "reject" ? { reason: "Decline" } : {}) };
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const first = await request(server).post(path).send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const firstAudit = await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
      expect(firstAudit.filter((entry) => entry.action === `issue.thread_interaction_${operation === "respond" ? "answered" : operation === "accept" ? "accepted" : "rejected"}`)).toHaveLength(1);
      const retry = await request(server).post(path).send(body);
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id))).toHaveLength(firstAudit.length);
      const changed = await request(server).post(path).send({ ...body, expectedRevision: randomUUID() });
      expect(changed.status).toBe(409);
      expect(changed.body).toMatchObject({ details: { code: "interaction_idempotency_conflict" } });
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id))).toHaveLength(firstAudit.length);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("retains legacy resolution without a precondition", async () => {
    const { issue, interaction, service } = await seed();
    expect((await service.answerQuestions(issue, interaction.id, { answers }, actor)).status).toBe("answered");
  });
});
