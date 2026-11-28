import { randomUUID } from "node:crypto";
import { authUsers, companyMemberships, issues, issueThreadInteractions, toolApplications, toolConnections, toolOauthCardProjections, toolOauthStates } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readIssueWipReason } from "../services/agent-wip-limit.js";
import { boardAuthService } from "../services/board-auth.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { projectOAuthCardOutcome, registerOAuthCardProjectionWork } from "../services/tool-access/oauth/card-projection.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("OAuth callback WIP admission", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_WIP_LIMIT", "1");
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    server = await startRunnerApiTestServer({ deploymentMode: "authenticated" });
  }, 90_000);

  afterAll(async () => {
    try {
      await server?.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  async function fixture(verifier: string) {
    const { companyId, issueId, agentId, blockerId } = await server.fixture({ disableWakeOnDemand: true });
    const userId = randomUUID();
    await server.db.insert(authUsers).values({
      id: userId, name: "Board operator", email: `${userId}@fixture.invalid`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await server.db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner",
    });
    await server.db.update(issues).set({ status: "blocked", executionRunId: null })
      .where(eq(issues.id, issueId));
    const state = randomUUID();
    const target = (flow: string) => ({
      version: 1 as const, prompt: "Connect your account", target: {
        type: "custom" as const, key: `connection:oauth-test:user:${userId}`, revisionId: flow, label: "Authorization",
      },
    });
    const [card] = await server.db.insert(issueThreadInteractions).values({
      companyId, issueId, kind: "request_confirmation",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
      createdByAgentId: agentId,
      payload: target(state),
    }).returning();
    const [app] = await server.db.insert(toolApplications).values({
      companyId, name: "OAuth test", type: "mcp_http",
    }).returning();
    const [connection] = await server.db.insert(toolConnections).values({
      companyId, applicationId: app!.id, name: app!.name, uid: "oauth-test", transport: "mcp_remote",
      authKind: "oauth", createdByUserId: userId,
    }).returning();
    async function insertState(flow: string) {
      await server.db.insert(toolOauthStates).values({
        state: flow, companyId, connectionId: connection!.id, codeVerifier: verifier,
        createdByActorType: "user", createdByActorId: userId, issueId, interactionId: card!.id,
        expiresAt: new Date(Date.now() + 60_000),
      });
    }
    await insertState(state);
    const { token } = await boardAuthService(server.db).createNamedBoardApiKey({
      userId, name: "OAuth WIP fixture",
    });
    return {
      companyId, issueId, blockerId, cardId: card!.id, state, userId,
      async callback(path: string, flow = state) {
        const query = new URLSearchParams({ state: flow, error: "access_denied" });
        const response = await fetch(`${server.apiUrl}/api/${path}?${query}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
        });
        return { status: response.status, body: await response.json() };
      },
      async renew() {
        // New authorization reuses the pending card and advances its target.
        const newerState = randomUUID();
        await insertState(newerState);
        await server.db.update(issueThreadInteractions).set({ payload: target(newerState) })
          .where(eq(issueThreadInteractions.id, card!.id));
        return newerState;
      },
      async card() {
        const [row] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card!.id));
        return row;
      },
    };
  }

  it.each([
    ["tools/oauth/callback", "fixture-verifier"],
    ["tools/oauth/cloud-connector/callback", "fixture-verifier"],
    ["tools/vercel-connect/callback", "vercel-connect"],
  ])("records a %s denial without releasing the last wait for a full owner", async (path, verifier) => {
    const sample = await fixture(verifier);
    expect(await readIssueWipReason(server.db, sample.companyId, sample.issueId)).toBe("human_card");
    const denied = await sample.callback(path);
    expect(denied.status, JSON.stringify(denied.body)).toBe(400);
    expect(denied.body.details.code).toBe("oauth_authorization_denied");
    expect((await sample.card())?.status).toBe("pending");
    expect(await readIssueWipReason(server.db, sample.companyId, sample.issueId)).toBe("human_card");
    expect(await server.db.select().from(toolOauthStates).where(eq(toolOauthStates.state, sample.state))).toEqual([]);
    const projection = () => server.db.select().from(toolOauthCardProjections)
      .where(eq(toolOauthCardProjections.interactionId, sample.cardId));
    expect(await projection()).toEqual([expect.objectContaining({
      companyId: sample.companyId, issueId: sample.issueId, outcome: "rejected",
      actorType: "board", actorSource: "board_key", resolvedByUserId: sample.userId,
    })]);
    expect((await sample.callback(path)).status).toBe(400);
    expect(await projection()).toHaveLength(1);

    // No foreground callback owns the projection any longer. A new worker
    // reconstructs it from persisted work after the slot becomes available.
    await server.db.update(issues).set({ status: "backlog" }).where(eq(issues.id, sample.blockerId));
    const failures: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({
      owner: server.db, canRun: () => true, onError: error => failures.push(error),
    });
    try {
      const worker = registerOAuthCardProjectionWork(server.db, coordinator, () => true);
      await worker.ready;
      await expect.poll(async () => (await sample.card())?.status).toBe("rejected");
      const settled = await sample.card();
      expect(settled?.resolvedByUserId).toBe(sample.userId);
      expect(await readIssueWipReason(server.db, sample.companyId, sample.issueId)).toBe("untyped_blocked");
      expect(await projection()).toEqual([]);
      await projectOAuthCardOutcome(server.db, { companyId: sample.companyId, interactionId: sample.cardId });
      expect(await sample.card()).toEqual(settled);
      await expect.poll(() => coordinator.nextWakeAt()).toBeNull();
      expect(failures).toEqual([]);
    } finally {
      await coordinator.stop();
    }
  });

  it("discards an older deferred denial and delivers the newer callback outcome", async () => {
    const sample = await fixture("fixture-verifier");
    const path = "tools/oauth/callback";
    const projections = () => server.db.select().from(toolOauthCardProjections)
      .where(eq(toolOauthCardProjections.interactionId, sample.cardId));
    expect((await sample.callback(path)).status).toBe(400);
    const [first] = await projections();
    expect(first?.outcome).toBe("rejected");
    const current = await sample.renew();
    expect((await sample.callback(path, current)).status).toBe(400);
    expect(await projections()).toHaveLength(2);
    const latest = (await projections()).find(entry => entry.cardGeneration !== first!.cardGeneration);
    expect(latest?.outcome).toBe("rejected");
    await server.db.update(issues).set({ status: "backlog" }).where(eq(issues.id, sample.blockerId));
    await projectOAuthCardOutcome(server.db, { companyId: sample.companyId, interactionId: sample.cardId });
    expect(await sample.card()).toMatchObject({ status: "rejected", resolvedAt: latest!.createdAt });
    expect(await projections()).toEqual([]);
  });

  it("does not record a consumed denial against a callback target that was renewed", async () => {
    const sample = await fixture("fixture-verifier");
    const current = await sample.renew();
    await server.db.update(issues).set({ status: "backlog" }).where(eq(issues.id, sample.blockerId));
    expect((await sample.callback("tools/oauth/callback")).status).toBe(400);
    expect((await sample.card())?.status).toBe("pending");
    expect(await server.db.select().from(toolOauthStates).where(eq(toolOauthStates.state, sample.state))).toEqual([]);
    expect(await server.db.select().from(toolOauthStates).where(eq(toolOauthStates.state, current))).toHaveLength(1);
    expect(await server.db.select().from(toolOauthCardProjections)
      .where(eq(toolOauthCardProjections.interactionId, sample.cardId))).toEqual([]);
  });
});
