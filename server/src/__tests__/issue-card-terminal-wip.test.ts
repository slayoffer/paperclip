import { randomUUID } from "node:crypto";
import { authUsers, companyMemberships, issues, issueThreadInteractions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { boardAuthService } from "../services/board-auth.js";
import { readIssueWipReason } from "../services/agent-wip-limit.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("WIP admission for card lifecycle routes", () => {
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

  async function setup(atCapacity: boolean, leaveWait = false) {
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
      status: "blocked", executionRunId: null,
      unblockDescriptor: leaveWait ? { owner: "board", action: "Confirm the remaining check" } : null,
    }).where(eq(issues.id, issueId));
    await server.db.update(issues).set({ status: atCapacity ? "todo" : "backlog" }).where(eq(issues.id, blockerId));
    const [card] = await server.db.insert(issueThreadInteractions).values({
      companyId, issueId, kind: "ask_user_questions",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
      createdByAgentId: agentId,
      payload: { version: 1, questions: [{
        id: "scope", prompt: "Choose a scope", selectionMode: "single",
        options: [{ id: "initial", label: "Initial" }],
      }] },
    }).returning();
    const boardKey = (await boardAuthService(server.db).createNamedBoardApiKey({
      userId: boardUserId, name: "Card WIP fixture",
    })).token;
    const agentJwt = createLocalAgentJwt(agentId, companyId, "paperclip_runner", runId, responsibleUserId);
    expect(agentJwt).toBeTruthy();
    return {
      async resolve(operation: "withdraw" | "skip" | "cancel", actor: "board" | "agent") {
        const response = await fetch(`${server.apiUrl}/api/issues/${issueId}/interactions/${card!.id}/${operation}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${actor === "board" ? boardKey : agentJwt}`, "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(5_000),
        });
        return { status: response.status, body: await response.json() };
      },
      async snapshot() {
        const [issue] = await server.db.select().from(issues).where(eq(issues.id, issueId));
        const [interaction] = await server.db.select().from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, card!.id));
        return { issue, interaction, reason: await readIssueWipReason(server.db, companyId, issueId) };
      },
    };
  }

  it.each([
    ["withdraw", "agent"], ["withdraw", "board"], ["skip", "board"], ["cancel", "board"],
  ] as const)("keeps the card and issue unchanged when %s by %s would add WIP at capacity", async (operation, actor) => {
    const fixture = await setup(true);
    const before = await fixture.snapshot();
    expect(before.reason).toBe("human_card");
    const response = await fixture.resolve(operation, actor);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details.code).toBe("agent_wip_limit");
    expect(await fixture.snapshot()).toEqual(before);
  });

  it.each([false, true])("permits skip when the removal can commit (another wait: %s)", async leaveWait => {
    const fixture = await setup(leaveWait, leaveWait);
    const response = await fixture.resolve("skip", "board");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await fixture.snapshot();
    expect(after.interaction?.status).toBe("cancelled");
    expect(after.reason).toBe(leaveWait ? "named_external_wait" : "untyped_blocked");
  });
});
