import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, documentRevisions, documents, heartbeatRuns, issueComments, issueDocuments, issueRecoveryActions, issueTreeHolds, issueTreeHoldMembers, issues,
  startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import type { BridgeWait } from "../services/review-bridge-contract.js";
import { assertBlockedIssueUpdate } from "../services/issue-blocked-validation.js";
import { releaseBridgeWait } from "../services/review-bridge-waits.js";
import { dispatchBridgeWakes } from "../services/review-bridge-wakes.js";
import type { heartbeatService } from "../services/heartbeat.js";

export function bridgeFixture() {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issue: typeof issues.$inferSelect;
  let wait: BridgeWait;
  const head = "a".repeat(40);
  const enqueue = vi.fn<ReturnType<typeof heartbeatService>["wakeup"]>();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-bridge-wait-");
    db = createDb(database.connectionString);
  }, 30_000);
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_SELF_BLOCK_GUARD", "true");
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", "false");
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Bridge", issuePrefix: "B" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle" });
    [issue] = await db.insert(issues).values({ companyId, identifier: "B-1", title: "Wait", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    wait = { kind: "review_bridge", owner: { agentId }, action: "Wait for the review bridge verdict.",
      until: new Date(Date.now() + 3_600_000).toISOString(),
      bridge: { waitId: randomUUID(), repo: "slayoffer/paperclip", head, pr: 42, stage: "verdict" } };
    enqueue.mockReset().mockImplementation(async (target, opts) => {
      const durable = opts!.durableBridgeRequest!;
      if (!durable) return null;
      await db.transaction(async tx => {
        await tx.select().from(issues).where(eq(issues.id, issue.id)).for("update");
        if ((await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, durable.id))).length) return;
        await durable.authorize(tx as unknown as ReturnType<typeof createDb>);
        await tx.insert(agentWakeupRequests).values({ id: durable.id, companyId, agentId: target,
          source: "automation", status: "queued", reason: opts!.reason, payload: opts!.payload,
          requestedByActorType: "system", requestedByActorId: durable.requestedByActorId,
          idempotencyKey: durable.idempotencyKey });
      });
      return null;
    });
  });
  afterEach(async () => {
    for (const table of [issueRecoveryActions, activityLog, issueDocuments, documentRevisions, documents, issueComments, issueTreeHoldMembers, issueTreeHolds, heartbeatRuns, agentWakeupRequests, issues, agents, companies]) await db.delete(table);
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await database?.cleanup(); });
  const current = async () => (await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!;
  const handoff = async (sha = head) => db.insert(issueComments).values({ companyId, issueId: issue.id, authorAgentId: agentId,
    body: `\`\`\`handoff\nrepo: slayoffer/paperclip\nbase: ${"b".repeat(40)}\nhead: ${sha}\nbranch: review/B-1\n\`\`\`` });
  const park = async () => db.update(issues).set({ status: "blocked", unblockDescriptor: wait }).where(eq(issues.id, issue.id));
  const eventBody = (change: Partial<BridgeWait["bridge"]> = {}) => `\`\`\`bridge-event\n${JSON.stringify({ ...wait.bridge, ...change })}\n\`\`\``;
  const event = async (change: Partial<BridgeWait["bridge"]> = {}, actor: "user" | "agent" = "user") =>
    db.insert(issueComments).values({ companyId, issueId: issue.id, body: eventBody(change),
      ...(actor === "user" ? { authorUserId: "board" } : { authorAgentId: agentId }) });
  const validate = (descriptor = wait) => assertBlockedIssueUpdate({ db,
    actor: { type: "agent", companyId, agentId, source: "agent_jwt" }, existing: issue,
    updateFields: { status: "blocked", unblockDescriptor: descriptor },
    getDependencyReadiness: async () => ({ unresolvedBlockerCount: 0 }),
  });
  return { get db() { return db; }, get issue() { return issue; }, get wait() { return wait; },
    get companyId() { return companyId; }, get agentId() { return agentId; },
    enqueue, current, handoff, park, event, eventBody, validate,
    release: () => releaseBridgeWait(db, companyId, issue.id),
    dispatch: () => dispatchBridgeWakes(db, enqueue, { companyId }),
  };
}
