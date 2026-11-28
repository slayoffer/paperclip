import { randomUUID } from "node:crypto";
import { agents, companies, createDb, issues, issueThreadInteractions, toolActionRequests, toolInvocations } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("WIP admission for a timed-out tool review", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_WIP_LIMIT", "1");
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-tool-review-expiry-wip-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await db?.$client.end();
      await temporary?.cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("expires the approval authority but defers its card projection until capacity is available", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Tool review WIP fixture", issuePrefix: "TWC" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Owner", adapterType: "process" }).returning();
    const [work] = await db.insert(issues).values({ companyId, title: "Existing slot", status: "todo", assigneeAgentId: agent!.id }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Blocked on review", status: "blocked", assigneeAgentId: agent!.id }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({
      companyId, issueId: issue!.id, kind: "request_confirmation", effectiveResolverPolicy: "human_only",
      requestedResolverPolicy: "human_only", payload: { version: 1, prompt: "Approve the fixture action?" },
    }).returning();
    const [invocation] = await db.insert(toolInvocations).values({
      companyId, issueId: issue!.id, agentId: agent!.id, toolName: "fixture_action", status: "awaiting_approval",
    }).returning();
    const [request] = await db.insert(toolActionRequests).values({
      companyId, invocationId: invocation!.id, issueId: issue!.id, interactionId: card!.id,
      canonicalArgumentsHash: "fixture", canonicalArgumentsSummary: { summary: "No args" },
      expiresAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(),
    }).returning();
    const gateway = createToolGatewayService(db);
    const readCard = async () => (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card!.id)))[0];

    await expect(gateway.sweepExpiredActionReviewsForCompany(companyId)).resolves.toEqual({ scanned: 1 });
    expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, request!.id)))[0]).toMatchObject({ status: "expired" });
    expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, invocation!.id)))[0])
      .toMatchObject({ status: "failed", errorCode: "action_expired" });
    expect(await readCard()).toMatchObject({ status: "pending", result: null, revision: card!.revision });
    await expect(gateway.repairActionReviewProjections(companyId)).resolves.toMatchObject({ scanned: 1, retry: true });
    expect(await readCard()).toMatchObject({ status: "pending", revision: card!.revision });

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, work!.id));
    await expect(gateway.repairActionReviewProjections(companyId)).resolves.toMatchObject({ scanned: 1, retry: false });
    expect(await readCard()).toMatchObject({ status: "expired", result: { toolAction: { status: "expired" } } });
  });
});
