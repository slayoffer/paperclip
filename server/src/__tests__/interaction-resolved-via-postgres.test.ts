import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, agents, companies, createDb,
  heartbeatRuns, issues, issueThreadInteractions, toolInvocations, toolActionRequests, statusCards,
} from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { commitToolActionReview } from "../services/tool-action-review.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { statusCardService } from "../services/status-cards.js";
import { defaultStatusCardRefreshPolicy } from "@paperclipai/shared";
import { instanceSettingsService } from "../services/instance-settings.js";
import { prepareConversationTurn } from "../services/agent-conversations.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("authenticated interaction resolution channel", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-resolved-via-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture(source: "session" | "board_key" | "agent_key" | "local_implicit") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Resolution channel", issuePrefix: `V${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({
      companyId, name: "Resolver", role: "engineer", adapterType: "process", status: "idle",
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId, title: "Resolution channel", status: "in_progress", assigneeAgentId: agent.id,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, status: "running", nativeIssueId: issue.id,
      contextSnapshot: { issueId: issue.id },
    }).returning();
    const actor: express.Request["actor"] = source === "agent_key"
      ? { type: "agent", source, agentId: agent.id, companyId, runId: run.id }
      : { type: "board", source, keyId: randomUUID(), userId: "same-user", companyIds: [companyId], isInstanceAdmin: true };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never, {
      approveToolActionRequest: (input) => commitToolActionReview(db, { ...input, decision: "approved" }),
      declineToolActionRequest: (input) => commitToolActionReview(db, { ...input, decision: "rejected" }),
    }));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    return {
      issue, actor, server, run,
      async card(question = false) {
        const [row] = await db.insert(issueThreadInteractions).values({
          companyId, issueId: issue.id, kind: question ? "ask_user_questions" : "request_confirmation",
          continuationPolicy: "none",
          payload: question
            ? { version: 1, questions: [{ id: "scope", prompt: "Scope?", selectionMode: "single", options: [{ id: "first", label: "First" }] }] }
            : { version: 1, prompt: "Continue?" },
        }).returning();
        return row;
      },
      close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
  }

  it.each([
    ["session", "user_session"], ["board_key", "board_api_key"], ["agent_key", "agent_key"],
  ] as const)("records %s as %s for accept, reject, and respond", async (source, expected) => {
    const f = await fixture(source);
    try {
      for (const operation of ["accept", "reject", "respond"] as const) {
        const card = await f.card(operation === "respond");
        const endpoint = `/api/issues/${f.issue.id}/interactions/${card.id}`;
        const body = operation === "respond" ? { answers: [{ questionId: "scope", optionIds: ["first"] }] } : {};
        const result = await request(f.server).post(`${endpoint}/${operation}`).send(body);
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        expect(result.body.resolvedVia).toBe(expected);
        expect(result.body.resolvedByUserId).toBe(source === "agent_key" ? null : "same-user");
        const [stored] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
        expect(stored).toHaveProperty("resolvedVia", expected);
        const single = await request(f.server).get(endpoint);
        expect(single.status).toBe(200);
        expect(single.body.resolvedVia).toBe(expected);
        const listed = await request(f.server).get(`/api/issues/${f.issue.id}/interactions`);
        expect(listed.status).toBe(200);
        expect(listed.body.find((entry: { id: string }) => entry.id === card.id).resolvedVia).toBe(expected);
      }
    } finally { await f.close(); }
  });

  it.each([["session", "user_session"], ["board_key", "board_api_key"]] as const)(
    "leaves deferred %s /new provenance unknown", async (source) => {
      const f = await fixture(source);
      try {
        await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
        await db.update(issues).set({ conversationAgentId: f.run.agentId,
          conversationUserId: "same-user", conversationState: "waiting" }).where(eq(issues.id, f.issue.id));
        const card = await f.card(true);
        const body = { body: "/new", clientRequestId: randomUUID() };
        const response = await request(f.server).post(`/api/issues/${f.issue.id}/comments`).send(body);
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        f.actor.source = source === "session" ? "board_key" : "session";
        const retry = await request(f.server).post(`/api/issues/${f.issue.id}/comments`).send(body);
        expect(retry.status).toBe(201);
        expect(retry.body.id).toBe(response.body.id);
        const run = { ...f.run, contextSnapshot: { issueId: f.issue.id, wakeCommentId: response.body.id } };
        await prepareConversationTurn(db, run);
        const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
        expect(saved.status).toBe("expired");
        expect(saved.resolvedVia).toBeNull();
        expect(saved.resolvedByUserId).toBe("same-user");
      } finally { await f.close(); }
    },
  );

  it("ignores a forged body channel and preserves the first channel on retries", async () => {
    const f = await fixture("board_key");
    try {
      const card = await f.card();
      const endpoint = `/api/issues/${f.issue.id}/interactions/${card.id}/accept`;
      const body = { resolvedVia: "user_session", expectedRevision: card.revision, idempotencyKey: "answer-1" };
      const first = await request(f.server).post(endpoint).send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.resolvedVia).toBe("board_api_key");
      f.actor.source = "session";
      const retry = await request(f.server).post(endpoint).send(body);
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(retry.body.resolvedVia).toBe("board_api_key");
      const repeated = await request(f.server).post(endpoint).send({});
      expect(repeated.status).toBe(409);
      const [stored] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(stored).toHaveProperty("resolvedVia", "board_api_key");
    } finally { await f.close(); }
  });

  it("keeps unverified local actors and historical resolutions unknown", async () => {
    const f = await fixture("local_implicit");
    try {
      const card = await f.card();
      const result = await request(f.server).post(`/api/issues/${f.issue.id}/interactions/${card.id}/accept`).send({});
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.resolvedVia).toBeNull();
      const legacy = await f.card();
      await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date(), resolvedByUserId: "same-user" })
        .where(eq(issueThreadInteractions.id, legacy.id));
      const read = await request(f.server).get(`/api/issues/${f.issue.id}/interactions/${legacy.id}`);
      expect(read.body.resolvedVia).toBeNull();
    } finally { await f.close(); }
  });

  it("prevents database updates from changing a saved resolution channel", async () => {
    const f = await fixture("board_key");
    try {
      const card = await f.card();
      const result = await request(f.server).post(`/api/issues/${f.issue.id}/interactions/${card.id}/accept`).send({});
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      await expect(db.execute(sql`UPDATE issue_thread_interactions SET resolved_via = 'user_session' WHERE id = ${card.id}`))
        .rejects.toThrow();
      const read = await request(f.server).get(`/api/issues/${f.issue.id}/interactions/${card.id}`);
      expect(read.body.resolvedVia).toBe("board_api_key");
      await db.update(issueThreadInteractions).set({ status: "pending", resolvedAt: null })
        .where(eq(issueThreadInteractions.id, card.id));
      await db.execute(sql`UPDATE issue_thread_interactions SET resolved_via = 'user_session' WHERE id = ${card.id}`);
      const [pending] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(pending).toMatchObject({ resolvedAt: null, resolvedVia: null, resolvedViaKeyId: null });
    } finally { await f.close(); }
  });

  it.each(["session", "board_key", "agent_key"] as const)("records %s when issue closure resolves a card", async (source) => {
    const f = await fixture(source);
    try {
      const card = await f.card();
      const result = await request(f.server).patch(`/api/issues/${f.issue.id}`).send({ status: "done" });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body).not.toHaveProperty("actorResolvedVia");
      expect(result.body.changes).not.toHaveProperty("actorResolvedVia");
      const [stored] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(stored).toMatchObject({ status: "expired", resolvedVia: {
        session: "user_session", board_key: "board_api_key", agent_key: "agent_key",
      }[source] });
    } finally { await f.close(); }
  });

  it("records only the final item-verdict resolver channel", async () => {
    const f = await fixture("board_key");
    try {
      const [card] = await db.insert(issueThreadInteractions).values({
        companyId: f.issue.companyId, issueId: f.issue.id, kind: "request_item_verdicts", continuationPolicy: "none",
        payload: { version: 1, prompt: "Review items", items: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] },
      }).returning();
      const endpoint = `/api/issues/${f.issue.id}/interactions/${card.id}/verdicts`;
      const partial = await request(f.server).post(endpoint).send({ verdicts: [{ id: "one", verdict: "approve" }] });
      expect(partial.status, JSON.stringify(partial.body)).toBe(200);
      expect(partial.body).toMatchObject({ status: "pending", resolvedVia: null });
      f.actor.source = "session";
      const complete = await request(f.server).post(endpoint).send({ verdicts: [{ id: "two", verdict: "approve" }] });
      expect(complete.status, JSON.stringify(complete.body)).toBe(200);
      expect(complete.body).toMatchObject({ status: "answered", resolvedVia: "user_session" });
    } finally { await f.close(); }
  });

  it("records the board-key channel when tree cancellation resolves a card", async () => {
    const f = await fixture("board_key");
    try {
      const card = await f.card();
      const service = issueTreeControlService(db);
      const result = await service.createHold(f.issue.companyId, f.issue.id, {
        mode: "cancel", actor: { actorType: "user", actorId: "same-user", userId: "same-user" },
      });
      await service.cancelIssueStatusesForHold(f.issue.companyId, f.issue.id, result.hold.id, { resolvedVia: "board_api_key", resolvedViaKeyId: f.actor.keyId! });
      const [stored] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(stored).toMatchObject({ status: "expired", resolvedVia: "board_api_key" });
    } finally { await f.close(); }
  });

  it("records the board-key channel when status-card archival resolves a card", async () => {
    const f = await fixture("board_key");
    try {
      const interaction = await f.card();
      const service = statusCardService(db);
      const actor = { agentId: null, userId: "same-user", via: { resolvedVia: "board_api_key" as const, resolvedViaKeyId: f.actor.keyId! } };
      const card = await service.create(f.issue.companyId, {
        interestPrompt: "Watch this task", titlePinned: false, refreshPolicy: defaultStatusCardRefreshPolicy,
      }, actor);
      const [generating] = await db.update(statusCards).set({ generatingIssueId: f.issue.id })
        .where(eq(statusCards.id, card.id)).returning();
      await service.update(generating, { archived: true }, actor);
      const [stored] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id));
      expect(stored).toMatchObject({ status: "expired", resolvedVia: "board_api_key" });
    } finally { await f.close(); }
  });

  it("keeps comment-triggered expiry provenance unknown", async () => {
    const f = await fixture("board_key");
    try {
      const card = await f.card();
      await db.update(issueThreadInteractions).set({
        payload: { version: 1, prompt: "Continue?", supersedeOnUserComment: true },
      }).where(eq(issueThreadInteractions.id, card.id));
      const result = await request(f.server).post(`/api/issues/${f.issue.id}/comments`)
        .send({ body: "The earlier request is no longer needed.", resolvedVia: "user_session" });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      const [stored] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(stored).toMatchObject({ status: "expired", resolvedVia: null, resolvedViaKeyId: null });
    } finally { await f.close(); }
  });

  it("clears provenance when an authorization retry reopens the same card", async () => {
    const f = await fixture("board_key");
    const values = {
      companyId: f.issue.companyId, issueId: f.issue.id, kind: "request_confirmation" as const,
      idempotencyKey: "authorization-retry", payload: { version: 1 as const, prompt: "Connect?" },
    };
    const [card] = await db.insert(issueThreadInteractions).values(values).returning();
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const callback = db.transaction(async (tx) => {
      await tx.update(issueThreadInteractions).set({
        status: "accepted", resolvedAt: new Date(), resolvedVia: "user_session",
      }).where(eq(issueThreadInteractions.id, card.id));
      ready();
      await gate;
    });
    await started;
    const retry = db.update(issueThreadInteractions).set({
      status: "pending", result: null, resolvedAt: null,
    }).where(eq(issueThreadInteractions.id, card.id)).returning().then((rows) => rows[0]);
    try {
      const deadline = Date.now() + 10_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const rows = await db.execute(sql`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`);
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally { release(); }
    try {
      await callback;
      const next = await retry;
      expect(next.id).toBe(card.id);
      expect(next).toMatchObject({ status: "pending", resolvedVia: null });
      const [original] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(original).toMatchObject({ status: "pending", resolvedVia: null, resolvedViaKeyId: null });
    } finally { await f.close(); }
  });

  it.each(["accept", "reject"] as const)("forwards board-key attribution through tool review %s", async (operation) => {
    const f = await fixture("board_key");
    try {
      const card = await f.card();
      const [invocation] = await db.insert(toolInvocations).values({
        companyId: f.issue.companyId, issueId: f.issue.id, toolName: "fixture", status: "awaiting_approval",
      }).returning();
      const [action] = await db.insert(toolActionRequests).values({
        companyId: f.issue.companyId, issueId: f.issue.id, interactionId: card.id, invocationId: invocation.id,
        canonicalArgumentsHash: "fixture",
        canonicalArgumentsSummary: { summary: "{}", sha256: "fixture", sizeBytes: 2 },
      }).returning();
      await db.update(issueThreadInteractions).set({ payload: {
        version: 1, prompt: "Review tool action", toolAction: {
          version: 1, actionRequestId: action.id, invocationId: invocation.id,
          toolName: "fixture", toolDisplayName: "Fixture", connectionId: null, applicationId: null,
          appDisplayName: null, risk: "read", previewMarkdown: "Fixture", argumentsSummaryJson: "{}",
          argumentsHash: "fixture", expiresAt: "2099-01-01T00:00:00.000Z",
        },
      } }).where(eq(issueThreadInteractions.id, card.id));
      const endpoint = `/api/issues/${f.issue.id}/interactions/${card.id}/${operation}`;
      const body = { resolvedVia: "user_session", idempotencyKey: "tool-retry" };
      const result = await request(f.server).post(endpoint).send(body);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.resolvedVia).toBe("board_api_key");
      const [stored] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(stored.resolvedVia).toBe("board_api_key");
      expect(stored.resolvedViaKeyId).toBe(f.actor.keyId);
      f.actor.source = "session";
      const retry = await request(f.server).post(endpoint).send(body);
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(retry.body.resolvedVia).toBe("board_api_key");
    } finally { await f.close(); }
  });
});
