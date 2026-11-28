import { randomUUID } from "node:crypto";
import { authUsers, companyMemberships, issueComments, issues, issueThreadInteractions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { countAgentActiveIssues, readIssueWipReason } from "../services/agent-wip-limit.js";
import { boardAuthService } from "../services/board-auth.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("comment-driven WIP admission", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    vi.stubEnv("PAPERCLIP_AGENT_WIP_LIMIT", "1");
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    server = await startRunnerApiTestServer({ deploymentMode: "local_trusted" });
  }, 60_000);

  afterAll(async () => {
    try {
      await server?.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  async function fixture(atCapacity: boolean, keepOtherWait = false, status: "todo" | "blocked" = "blocked") {
    const { companyId, issueId, agentId, blockerId, runId, responsibleUserId } =
      await server.fixture({ disableWakeOnDemand: true });
    const boardUserId = randomUUID();
    await server.db.insert(authUsers).values({
      id: boardUserId, name: "Board operator", email: `${boardUserId}@fixture.invalid`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await server.db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: boardUserId, status: "active", membershipRole: "owner",
    });
    await server.db.update(issues).set({
      status, executionRunId: null,
      unblockDescriptor: keepOtherWait ? { owner: "board", action: "Confirm the remaining requirement" } : null,
    }).where(eq(issues.id, issueId));
    await server.db.update(issues).set({ status: atCapacity ? "todo" : "backlog" }).where(eq(issues.id, blockerId));
    const [card] = await server.db.insert(issueThreadInteractions).values({
      companyId, issueId, kind: "ask_user_questions",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
      createdAt: new Date(Date.now() - 1_000),
      payload: {
        version: 1, supersedeOnUserComment: true,
        questions: [{
          id: "scope", prompt: "Choose a scope", selectionMode: "single",
          options: [{ id: "initial", label: "Initial" }],
        }],
      },
    }).returning({ id: issueThreadInteractions.id });
    const boardKey = (await boardAuthService(server.db).createNamedBoardApiKey({
      userId: boardUserId, name: "Comment WIP fixture",
    })).token;
    const agentJwt = createLocalAgentJwt(agentId, companyId, "paperclip_runner", runId, responsibleUserId);
    expect(agentJwt).toBeTruthy();
    return {
      async block() {
        const response = await fetch(`${server.apiUrl}/api/issues/${issueId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${boardKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ status: "blocked" }),
        });
        return { status: response.status, body: await response.json() };
      },
      async comment(kind: "board" | "agent" = "board", endpoint: "patch" | "post" = "patch") {
        const response = await fetch(`${server.apiUrl}/api/issues/${issueId}${endpoint === "post" ? "/comments" : ""}`, {
          method: endpoint === "post" ? "POST" : "PATCH",
          headers: { Authorization: `Bearer ${kind === "board" ? boardKey : agentJwt}`, "Content-Type": "application/json" },
          body: JSON.stringify(endpoint === "post"
            ? { body: "Here is the decision" }
            : { status: "blocked", comment: "Here is the decision" }),
        });
        return { status: response.status, body: await response.json() };
      },
      async snapshot() {
        const [issue] = await server.db.select({
          status: issues.status, updatedAt: issues.updatedAt, statusVersion: issues.statusVersion,
        }).from(issues).where(eq(issues.id, issueId));
        const [interaction] = await server.db.select({
          status: issueThreadInteractions.status, result: issueThreadInteractions.result,
        }).from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card!.id));
        const comments = await server.db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId));
        const reason = await readIssueWipReason(server.db, companyId, issueId);
        const slots = await countAgentActiveIssues(server.db, { companyId, agentId, excludeIssueId: issueId });
        return { issue, interaction, comments, reason, slots };
      },
    };
  }

  it.each(["patch", "post"] as const)("rolls back the card and comment when a board-key %s would add WIP at capacity", async endpoint => {
    const issue = await fixture(true);
    const before = await issue.snapshot();
    expect(before.interaction?.status).toBe("pending");
    expect(before.reason).toBe("human_card");
    expect(before.slots).toBe(1);
    const { status, body } = await issue.comment("board", endpoint);
    const after = await issue.snapshot();
    expect(status, JSON.stringify({ body, after })).toBe(409);
    expect(body.details.code).toBe("agent_wip_limit");
    expect(after).toEqual(before);
  });

  it("expires the last human-only card when the owner has capacity", async () => {
    const issue = await fixture(false);
    const { status, body } = await issue.comment();
    expect(status, JSON.stringify(body)).toBe(200);
    const after = await issue.snapshot();
    expect(after.issue?.status).toBe("blocked");
    expect(after.interaction?.status).toBe("expired");
    expect(after.comments).toHaveLength(1);
  });

  it("allows the expiry at capacity when another human wait keeps the issue outside WIP", async () => {
    const issue = await fixture(true, true);
    const { status, body } = await issue.comment();
    expect(status, JSON.stringify(body)).toBe(200);
    expect((await issue.snapshot()).interaction?.status).toBe("expired");
  });

  it("keeps a human card pending when the assigned agent comments", async () => {
    const issue = await fixture(true);
    const { status, body } = await issue.comment("agent");
    expect(status, JSON.stringify(body)).toBe(200);
    expect((await issue.snapshot()).interaction?.status).toBe("pending");
  });

  it("allows a runnable issue to enter a human wait at capacity", async () => {
    const issue = await fixture(true, false, "todo");
    const { status, body } = await issue.block();
    expect(status, JSON.stringify(body)).toBe(200);
    const after = await issue.snapshot();
    expect(after.issue?.status).toBe("blocked");
    expect(after.interaction?.status).toBe("pending");
  });
});
