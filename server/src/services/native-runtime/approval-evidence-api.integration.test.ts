import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueThreadInteractions, issues } from "@paperclipai/db";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";

describe("saved approval evidence through the run API", { timeout: 45_000 }, () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const oldSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (oldSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldSecret;
  });

  async function seed() {
    const f = await server.fixture({ connectionScenario: "fresh", disableWakeOnDemand: true });
    const target = {
      type: "issue_document" as const, key: "plan", issueId: f.issueId,
      revisionId: randomUUID(), revisionNumber: 3,
    };
    const [card] = await server.db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
      createdByAgentId: f.agentId, addresseeUserId: f.userId,
      payload: { version: 1, prompt: "Approve this synthetic revision?", target },
    }).returning();
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.userId);
    const headers = { Authorization: `Bearer ${token}`, "X-Paperclip-Run-Id": f.runId, "Content-Type": "application/json" };
    const read = (interactionId?: string, issueId = f.issueId) => f.authority.execute({
      tool: "call_api", callId: randomUUID(), arguments: {
        operationId: interactionId
          ? "GET /api/issues/{id}/interactions/{interactionId}"
          : "GET /api/issues/{id}/interactions",
        pathParams: { id: issueId, ...(interactionId ? { interactionId } : {}) },
      },
    });
    return { f, card: card!, target, headers, read };
  }

  it.each(["pending", "accepted", "expired"] as const)("returns saved %s evidence without resolving the card", async (status) => {
    const { f, card, target, read } = await seed();
    await server.db.update(issueThreadInteractions).set({
      status,
      ...(status === "accepted" ? {
        resolvedByUserId: f.userId, resolvedAt: new Date(),
        result: { version: 1, outcome: "accepted" },
      } : {}),
    }).where(eq(issueThreadInteractions.id, card.id));
    const evidence = {
      id: card.id, companyId: f.companyId, issueId: f.issueId, status,
      effectiveResolverPolicy: "human_only", addresseeUserId: f.userId,
      resolvedByUserId: status === "accepted" ? f.userId : null,
      resolvedByAgentId: null, payload: { target },
    };
    const before = (await f.snapshot()).activity.length;
    expect(await read()).toMatchObject({ status: 200, data: [evidence] });
    expect(await read(card.id)).toMatchObject({ status: 200, data: evidence });
    expect((await f.snapshot()).activity).toHaveLength(before);
    expect((await server.db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, card.id)))[0]?.status).toBe(status);
  });

  it("hides missing, wrong-issue, and wrong-company evidence", async () => {
    const { f, card, read } = await seed();
    expect(await read(randomUUID())).toMatchObject({ status: 404, ok: false });
    expect(await read(card.id, f.blockerId)).toMatchObject({ status: 404, ok: false });
    const other = await seed();
    expect(await read(other.card.id)).toMatchObject({ status: 404, ok: false });
    expect(await read(other.card.id, other.f.issueId)).toMatchObject({ status: 404, ok: false });
    expect(await read(undefined, other.f.issueId)).toMatchObject({ status: 404, ok: false });
  });

  it("denies unauthenticated reads and preserves the human-only resolution gate", async () => {
    const { f, card, headers, read } = await seed();
    const url = `${server.apiUrl}/api/issues/${f.issueId}/interactions`;
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(`${url}/${card.id}`)).status).toBe(404);
    expect((await fetch(`${url}/${card.id}/accept`, {
      method: "POST", headers, body: "{}",
    })).status).toBe(403);
    expect(await read(card.id)).toMatchObject({ status: 200, data: {
      status: "pending", resolvedByUserId: null, resolvedByAgentId: null,
    } });
  });

  it("permits blocked only while a real issue-scoped card remains pending", async () => {
    const { f, card, headers } = await seed();
    const url = `${server.apiUrl}/api/issues/${f.issueId}`;
    const block = () => fetch(url, { method: "PATCH", headers,
      body: JSON.stringify({ status: "blocked", blockedByIssueIds: [] }),
    });
    const pending = await block();
    expect(await pending.json()).toMatchObject({ status: "blocked" });
    expect(pending.status).toBe(200);
    for (const status of ["accepted", "expired"]) {
      await server.db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
      await server.db.update(issueThreadInteractions).set({ status }).where(eq(issueThreadInteractions.id, card.id));
      expect((await block()).status).toBe(422);
    }
    await server.db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
    expect((await block()).status).toBe(422);
  });

  it("does not count another issue's pending card as a waiting path", async () => {
    const { f, card, headers } = await seed();
    await server.db.update(issueThreadInteractions).set({ issueId: f.blockerId }).where(eq(issueThreadInteractions.id, card.id));
    const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}`, {
      method: "PATCH", headers, body: JSON.stringify({ status: "blocked", blockedByIssueIds: [] }),
    });
    expect(response.status).toBe(422);
  });

  it("keeps the exact lookup scoped in the service", async () => {
    const { f, card } = await seed();
    const service = issueThreadInteractionService(server.db);
    await expect(service.getForIssue({ id: f.blockerId, companyId: f.companyId }, card.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.getForIssue({ id: f.issueId, companyId: f.foreignCompanyId }, card.id)).rejects.toMatchObject({ status: 404 });
  });
});
