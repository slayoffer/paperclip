import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companySecretProposals, companySecrets, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, issueThreadInteractions } from "@paperclipai/db";
import { secretRoutes } from "../routes/secrets.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createSecretProposalsService } from "../services/secret-proposals.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("secret proposal resolution provenance", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("secret-proposal-provenance-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    const keyId = randomUUID();
    const proposalId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Proposal provenance",
      issuePrefix: `P${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Proposer", role: "engineer",
      adapterType: "process", adapterConfig: {}, status: "idle" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id,
      status: "running" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Approve a binding",
      status: "in_progress" }).returning();
    // The reference has no credential material. Approval only installs its binding.
    const [secret] = await db.insert(companySecrets).values({ companyId, name: "fixture/reference",
      key: "FIXTURE_REFERENCE", provider: "local_encrypted" }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
      kind: "request_confirmation", continuationPolicy: "none",
      payload: { version: 1, prompt: "Bind reference?", secretProposal: { version: 1, proposalId,
        sourceSecretLabel: secret.name, configPath: "env.FIXTURE_REFERENCE", targetAgentId: agent.id,
        targetAgentName: agent.name, justification: "Test reference binding",
        expiresAt: new Date(Date.now() + 60_000).toISOString() } } }).returning();
    await db.insert(companySecretProposals).values({ id: proposalId, companyId, kind: "binding",
      justification: "Test reference binding", proposedByAgentId: agent.id, originRunId: run.id,
      interactionId: card.id, secretId: secret.id, targetType: "agent", targetId: agent.id,
      configPath: "env.FIXTURE_REFERENCE", bindingTargetPolicySnapshot: "self_and_reports",
      proposerAncestorIdsSnapshot: [], targetAncestorIdsSnapshot: [],
      expiresAt: new Date(Date.now() + 60_000) });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "board_key", userId: "resolver-user", keyId,
        companyIds: [companyId], isInstanceAdmin: true };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return { app, companyId, keyId, proposalId, card, agent,
      read: async () => db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, card.id)).then((rows) => rows[0]!),
    };
  }

  it.each(["approve", "reject"] as const)("records the board key on %s despite forged fields", async (operation) => {
    const f = await fixture();
    const response = await request(f.app)
      .post(`/api/companies/${f.companyId}/secret-proposals/${f.proposalId}/${operation}`)
      .send({ reason: "Declined for this test", resolvedVia: "user_session", resolvedViaKeyId: randomUUID() });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await f.read()).toMatchObject({ status: operation === "approve" ? "accepted" : "rejected",
      resolvedVia: "board_api_key", resolvedViaKeyId: f.keyId,
      resolvedByUserId: "resolver-user", resolvedByAgentId: null, resolvedByRunId: null });
  });

  it.each(["user_session", null] as const)("preserves previous %s provenance during late approval synchronization", async (resolvedVia) => {
    const f = await fixture();
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date(),
      resolvedVia, resolvedViaKeyId: null, resolvedByUserId: "resolver-user" })
      .where(eq(issueThreadInteractions.id, f.card.id));
    const response = await request(f.app)
      .post(`/api/companies/${f.companyId}/secret-proposals/${f.proposalId}/approve`).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await f.read()).toMatchObject({ status: "accepted", resolvedVia, resolvedViaKeyId: null,
      resolvedByUserId: "resolver-user", resolvedByAgentId: null, resolvedByRunId: null });
  });

  it("records system provenance when the proposal expiry sweep resolves the card", async () => {
    const f = await fixture();
    await db.update(companySecretProposals).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(companySecretProposals.id, f.proposalId));
    await createSecretProposalsService(db).sweepExpired();
    expect(await f.read()).toMatchObject({ status: "expired", resolvedVia: "system", resolvedViaKeyId: null,
      resolvedByUserId: null, resolvedByAgentId: null, resolvedByRunId: null });
  });
});
