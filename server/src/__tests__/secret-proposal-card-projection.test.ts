import { randomUUID } from "node:crypto";
import { agents, companies, companySecretProposals, createDb, heartbeatRuns, issueThreadInteractions, issues } from "@paperclipai/db";
import { eq, isNull } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { registerSecretProposalExpiryWork } from "../services/secret-proposal-expiry-work.js";
import { createSecretProposalsService } from "../services/secret-proposals.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("secret proposal expiry card projection", () => {
  it("scrubs at capacity and retries its card without delaying another expiry", async () => {
    const database = await startEmbeddedPostgresTestDatabase("secret-proposal-card-projection");
    const db = createDb(database.connectionString);
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    try {
      vi.stubEnv("PAPERCLIP_AGENT_WIP_LIMIT", "1");
      const [company] = await db.insert(companies).values({ name: "Expiry fixture" }).returning();
      const companyId = company!.id;
      const [agent] = await db.insert(agents).values({ companyId, name: "Fixture owner" }).returning();
      const agentId = agent!.id;
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded" }).returning();
      const [waiting, runnable] = await db.insert(issues).values([
        { companyId, title: "Wait for approval", status: "blocked", assigneeAgentId: agentId },
        { companyId, title: "Occupy the runnable slot", status: "todo", assigneeAgentId: agentId },
      ]).returning();
      const firstProposal = randomUUID();
      const expiresAt = new Date(Date.now() - 60_000);
      const [card] = await db.insert(issueThreadInteractions).values({
        companyId, issueId: waiting!.id, kind: "request_confirmation", effectiveResolverPolicy: "human_only",
        payload: { version: 1, prompt: "Approve the proposal?", secretProposal: {
          version: 1, proposalId: firstProposal, sourceSecretLabel: "Fixture", configPath: "env.FIXTURE",
          targetAgentId: agentId, targetAgentName: "Fixture owner", justification: "Fixture", expiresAt: expiresAt.toISOString(),
        } },
      }).returning();
      const proposal = {
        companyId, kind: "secret", proposedName: "Fixture", proposedKey: "fixture", justification: "Fixture",
        valueCiphertext: { placeholder: true }, expiresAt, originRunId: run!.id,
        originIssueId: waiting!.id, proposedByAgentId: agentId,
      };
      await db.insert(companySecretProposals).values({ ...proposal, id: firstProposal, interactionId: card!.id });

      async function proposalState(id: string) {
        const [row] = await db.select({ status: companySecretProposals.status, scrubbed: isNull(companySecretProposals.valueCiphertext) })
          .from(companySecretProposals).where(eq(companySecretProposals.id, id));
        return row;
      }
      async function cardStatus() {
        const [row] = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, card!.id));
        return row?.status;
      }

      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const proposals = createSecretProposalsService(db);
      await registerSecretProposalExpiryWork(coordinator, proposals, () => true).ready;
      await vi.waitFor(async () => {
        expect(await proposalState(firstProposal)).toEqual({ status: "expired", scrubbed: true });
        expect(coordinator.nextWakeAt()).toBeGreaterThan(Date.now() + 20_000);
      });
      expect(await cardStatus()).toBe("pending");

      const secondProposal = randomUUID();
      await db.transaction(async tx => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.secretProposalExpiry, companyId);
        await tx.insert(companySecretProposals).values({ ...proposal, id: secondProposal });
      });
      await vi.waitFor(async () => {
        expect(await proposalState(secondProposal)).toEqual({ status: "expired", scrubbed: true });
      });
      expect(await cardStatus()).toBe("pending");

      await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, runnable!.id));
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(async () => {
        expect(await cardStatus()).toBe("expired");
        expect(coordinator.nextWakeAt()).toBeNull();
      });
      expect(errors).toEqual([]);
    } finally {
      await coordinator.stop();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await db.$client.end({ timeout: 1 });
      await database.cleanup();
    }
  }, 60_000);
});
