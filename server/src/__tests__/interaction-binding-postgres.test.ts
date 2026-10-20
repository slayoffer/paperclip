import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, activityLog, agents, agentWakeupRequests, companies,
  companyMemberships, companySecretProposals, companySecrets, heartbeatRuns, principalPermissionGrants,
  createDb, interactionResolutionOutbox, issues, issueThreadInteractions,
} from "@paperclipai/db";
import * as audit from "../services/activity-log.js";
import * as heartbeats from "../services/heartbeat.js";
import * as interactions from "../services/issue-thread-interactions.js";
import { interactionResolutionOutboxService } from "../services/interaction-resolution-outbox.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) throw new Error(`Binding database tests unavailable: ${support.reason}`);
const userId = "binding-board-user";

describe("binding recovery with PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-binding-recovery-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture(continuationPolicy: "wake_assignee" | "none" = "wake_assignee") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Binding recovery", issuePrefix: `B${companyId.slice(0, 7)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
      permissionKey: "agents:configure" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Fixture target", role: "engineer",
      adapterType: "process", status: "idle" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Binding recovery", status: "in_progress",
      assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "succeeded" }).returning();
    // Synthetic reference only. No secret value, provider call, or live credential exists.
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "TEST_REFERENCE", name: "fixture/reference" }).returning();
    const [proposal] = await db.insert(companySecretProposals).values({ companyId, kind: "binding", justification: "Fixture",
      targetType: "agent", targetId: agent.id, configPath: "env.TEST_REFERENCE", secretId: secret.id,
      proposedByAgentId: agent.id, originIssueId: issue.id, originRunId: run.id,
      bindingTargetPolicySnapshot: "self_and_reports", targetAncestorIdsSnapshot: [],
      expiresAt: new Date(Date.now() + 600_000) }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
      kind: "request_confirmation", status: "pending", continuationPolicy,
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "governed_action", payload: { version: 1, prompt: "Bind the fixture reference?",
        secretProposal: { version: 1, proposalId: proposal.id, configPath: proposal.configPath, targetAgentId: agent.id,
          targetAgentName: agent.name, sourceSecretLabel: secret.name, justification: "Fixture",
          expiresAt: proposal.expiresAt.toISOString() } } }).returning();
    await db.update(companySecretProposals).set({ interactionId: card.id }).where(eq(companySecretProposals.id, proposal.id));
    const realService = interactions.issueThreadInteractionService;
    let interrupt = true;
    vi.spyOn(interactions, "issueThreadInteractionService").mockImplementation((...args) => {
      const service = realService(...args);
      return { ...service, acceptInteraction: async (...input: Parameters<typeof service.acceptInteraction>) => {
        const result = await service.acceptInteraction(...input);
        if (interrupt) { interrupt = false; throw new Error("Process loss after answer commit"); }
        return result;
      } };
    });
    const wakeup = vi.fn(async (agentId: string, options: Record<string, unknown>) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "queued",
        idempotencyKey: options.idempotencyKey as string, payload: options.payload as Record<string, unknown> }).onConflictDoNothing();
      return null;
    });
    vi.spyOn(heartbeats, "heartbeatService").mockReturnValue({ wakeup } as never);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false,
        memberships: [{ companyId, status: "active", membershipRole: "owner" }] }; next();
    });
    app.use("/api", issueRoutes(db, {} as never, {})); app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const post = () => request(server).post(`/api/issues/${issue.id}/interactions/${card.id}/accept`)
      .send({ expectedRevision: card.revision, idempotencyKey: `binding-${card.id}` });
    const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const worker = () => interactionResolutionOutboxService(db, { wakeup });
    const read = async () => ({
      card: (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id)))[0],
      proposal: (await db.select().from(companySecretProposals).where(eq(companySecretProposals.id, proposal.id)))[0],
      target: (await db.select().from(agents).where(eq(agents.id, agent.id)))[0],
      intents: await db.select().from(interactionResolutionOutbox).where(eq(interactionResolutionOutbox.interactionId, card.id)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agent.id)),
      effects: await db.select().from(activityLog).where(and(eq(activityLog.entityId, agent.id), eq(activityLog.action, "agent.updated"))),
    });
    return { companyId, issue, card, proposal, post, close, worker, read, secret, wakeup };
  }

  it.each(["receipt retry", "recovery worker", "concurrent workers"])("resumes execution through %s", async (path) => {
    const f = await fixture();
    try {
      expect((await f.post()).status).toBe(500);
      const pending = await f.read();
      expect(pending.card.status).toBe("accepted"); expect(pending.card.resolvedByUserId).toBe(userId);
      expect(pending.card.resolutionRequest).not.toBeNull(); expect(pending.proposal.status).toBe("pending");
      expect(pending.effects).toHaveLength(0); expect(pending.wakes).toHaveLength(0);
      expect(pending.intents).toHaveLength(1); expect(pending.intents[0].deliveredAt).toBeNull();
      if (path === "receipt retry") expect((await f.post()).status).toBe(200);
      else if (path === "recovery worker") await f.worker().sweepPending();
      else await Promise.all([f.post(), f.worker().sweepPending(), f.worker().deliver(f.card.id)]);
      const done = await f.read();
      expect(done.proposal.status).toBe("approved"); expect(done.proposal.resolvedByUserId).toBe(userId);
      expect(done.card.result).toMatchObject({ secretProposal: { status: "executed" } });
      expect(done.target.adapterConfig).toMatchObject({ env: { TEST_REFERENCE: { type: "secret_ref", secretId: f.secret.id } } });
      expect(done.effects).toHaveLength(1); expect(done.wakes).toHaveLength(1);
      expect(done.wakes[0].payload).toMatchObject({ secretProposal: { executionStatus: "executed" } });
      expect(done.intents[0].deliveredAt).not.toBeNull();
      await f.worker().sweepPending(); expect((await f.post()).status).toBe(200);
      const repeated = await f.read(); expect(repeated.effects).toHaveLength(1); expect(repeated.wakes).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("retries a rolled-back binding without a partial effect", async () => {
    const f = await fixture();
    try {
      expect((await f.post()).status).toBe(500);
      const realLog = audit.logActivity;
      let fail = true;
      vi.spyOn(audit, "logActivity").mockImplementation(async (...args) => {
        if (args[1].action === "secret.proposal.approved" && fail) {
          fail = false;
          throw new Error("Database failure before binding commit");
        }
        return realLog(...args);
      });
      await expect(f.worker().deliver(f.card.id)).rejects.toThrow("Database failure before binding commit");
      const pending = await f.read();
      expect(pending.proposal.status).toBe("pending"); expect(pending.effects).toHaveLength(0);
      expect(pending.target.adapterConfig).not.toHaveProperty("env.TEST_REFERENCE");
      expect(pending.wakes).toHaveLength(0); expect(pending.intents[0].deliveredAt).toBeNull();
      await f.worker().deliver(f.card.id);
      const done = await f.read(); expect(done.proposal.status).toBe("approved");
      expect(done.effects).toHaveLength(1); expect(done.wakes).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("persists binding execution when no continuation wake is requested", async () => {
    const f = await fixture("none");
    try {
      expect((await f.post()).status).toBe(500);
      expect((await f.read()).intents).toHaveLength(1);
      await f.worker().sweepPending();
      const done = await f.read(); expect(done.proposal.status).toBe("approved");
      expect(done.effects).toHaveLength(1); expect(done.wakes).toHaveLength(0);
      expect(done.intents[0].deliveredAt).not.toBeNull();
    } finally { await f.close(); }
  });

  it.each(["closed issue", "expired proposal", "revoked permission"])("refuses execution after %s", async (path) => {
    const f = await fixture();
    try {
      expect((await f.post()).status).toBe(500);
      if (path === "closed issue") await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issue.id));
      if (path === "expired proposal") await db.update(companySecretProposals).set({ expiresAt: new Date(0) })
        .where(eq(companySecretProposals.id, f.proposal.id));
      if (path === "revoked permission") {
        await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, f.companyId));
        await db.delete(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
      }
      await f.worker().sweepPending();
      const failed = await f.read(); expect(failed.proposal.status).not.toBe("approved");
      expect(failed.effects).toHaveLength(0); expect(failed.target.adapterConfig).not.toHaveProperty("env.TEST_REFERENCE");
    } finally { await f.close(); }
  });
});
