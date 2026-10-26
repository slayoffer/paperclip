import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issues, issueRelations, issueThreadInteractions } from "@paperclipai/db";
import { issueWipReason } from "./agent-wip-policy.js";
import { companyFlowService } from "./company-flow.js";
import { logger } from "../middleware/logger.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  agentWipFull,
  agentWipLimit,
  countAgentActiveIssues,
  isWipActiveStatus,
  wipLimitAppliesToActor,
} from "./agent-wip-limit.js";

const saved = process.env.PAPERCLIP_AGENT_WIP_LIMIT;
afterEach(() => {
  if (saved === undefined) delete process.env.PAPERCLIP_AGENT_WIP_LIMIT;
  else process.env.PAPERCLIP_AGENT_WIP_LIMIT = saved;
});

describe("agent WIP limit helpers", () => {
  it("reads only a positive integer", () => {
    expect(agentWipLimit({})).toBeNull();
    expect(agentWipLimit({ PAPERCLIP_AGENT_WIP_LIMIT: "3" })).toBe(3);
    expect(agentWipLimit({ PAPERCLIP_AGENT_WIP_LIMIT: "0" })).toBeNull();
    expect(agentWipLimit({ PAPERCLIP_AGENT_WIP_LIMIT: "3x" })).toBeNull();
  });

  it("treats todo, in_progress and blocked as active", () => {
    expect(["todo", "in_progress", "blocked"].every(isWipActiveStatus)).toBe(true);
    expect(["backlog", "in_review", "done", "cancelled", undefined].some(isWipActiveStatus)).toBe(false);
  });

  it("exempts only a person in the board UI", () => {
    expect(wipLimitAppliesToActor({ type: "board", source: "session" })).toBe(false);
    expect(wipLimitAppliesToActor({ type: "board", source: "local_implicit" })).toBe(false);
    expect(wipLimitAppliesToActor({ type: "board", source: "board_key" })).toBe(true);
    expect(wipLimitAppliesToActor({ type: "agent", source: "agent_jwt" })).toBe(true);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent WIP limit counts", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), busy = randomUUID(), free = randomUUID(), activeId = randomUUID();
  const agentActor = { type: "agent", source: "agent_jwt" };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-wip-limit-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Wip", issuePrefix: "WIP" });
    await db.insert(agents).values([
      { id: busy, companyId, name: "Busy", role: "engineer", adapterType: "paperclip_runner" },
      { id: free, companyId, name: "Free", role: "engineer", adapterType: "paperclip_runner" },
    ]);
    await db.insert(issues).values([
      { id: activeId, companyId, title: "a", status: "todo", assigneeAgentId: busy },
      { companyId, title: "b", status: "in_progress", assigneeAgentId: busy },
      { companyId, title: "c", status: "blocked", assigneeAgentId: busy },
      { companyId, title: "d", status: "backlog", assigneeAgentId: busy },
      { companyId, title: "e", status: "in_review", assigneeAgentId: busy },
      { companyId, title: "f", status: "done", assigneeAgentId: busy },
      { companyId, title: "g", status: "todo", assigneeAgentId: free },
    ]);
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup();
  });

  it("counts only active statuses and can exclude the issue being changed", async () => {
    expect(await countAgentActiveIssues(db, { companyId, agentId: busy })).toBe(3);
    expect(await countAgentActiveIssues(db, { companyId, agentId: busy, excludeIssueId: activeId })).toBe(2);
  });

  it("is never full while the switch is off", async () => {
    delete process.env.PAPERCLIP_AGENT_WIP_LIMIT;
    expect(await agentWipFull(db, agentActor, { companyId, agentId: busy, status: "todo" })).toBe(false);
  });

  it("defers a new active issue at the limit and lets the board UI through", async () => {
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "3";
    expect(await agentWipFull(db, agentActor, { companyId, agentId: busy, status: "todo" })).toBe(true);
    expect(await agentWipFull(db, agentActor, { companyId, agentId: busy, status: "backlog" })).toBe(false);
    expect(await agentWipFull(db, { type: "board", source: "session" }, { companyId, agentId: busy, status: "todo" })).toBe(false);
    expect(await agentWipFull(db, agentActor, { companyId, agentId: free, status: "todo" })).toBe(false);
    expect(await agentWipFull(db, agentActor, { companyId, agentId: free, status: "todo", pending: 2 })).toBe(true);
    expect(await agentWipFull(db, agentActor, { companyId, agentId: busy, status: "todo", priority: "critical" })).toBe(false);
    expect(await agentWipFull(db, agentActor, { companyId, agentId: busy, status: "todo", priority: "high" })).toBe(true);
  });

  it("frees slots only for live, company-scoped external waits, with either queue setting", async () => {
    const owner = randomUUID();
    await db.insert(agents).values({ id: owner, companyId, name: "Waiting owner", role: "engineer", adapterType: "process" });
    const create = async (values: Partial<typeof issues.$inferInsert> = {}) => {
      const [row] = await db.insert(issues).values({ companyId, title: "Wait", assigneeAgentId: owner,
        status: "blocked", ...values }).returning();
      return row;
    };
    const externalBlocker = await create({ status: "todo", assigneeAgentId: free });
    const external = await create();
    const card = await create();
    const named = await create({ unblockDescriptor: { owner: "board", kind: "external",
      action: "Resume after the vendor response. deadline: 2026-10-27T00:00:00Z" } });
    await db.insert(issueRelations).values({ companyId, issueId: externalBlocker.id, relatedIssueId: external.id, type: "blocks" });
    const [humanCard] = await db.insert(issueThreadInteractions).values({ companyId, issueId: card.id,
      kind: "request_confirmation", effectiveResolverPolicy: "human_only", payload: { version: 1, prompt: "Approve?" } }).returning();
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "3";
    const audit = vi.spyOn(logger, "info");
    try {
      for (const queue of ["false", "true"]) {
        vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", queue);
        expect(await countAgentActiveIssues(db, { companyId, agentId: owner })).toBe(0);
        expect(await agentWipFull(db, agentActor, { companyId, agentId: owner, status: "todo" })).toBe(false);
        const flow = await companyFlowService(db).report(companyId);
        expect(flow.agents.find((agent) => agent.id === owner)).toMatchObject({ wip: 0, runnableWip: 0, waitingWip: 3, atWipLimit: false });
      }
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ agentId: owner, runnable: 0, waiting: 3,
        decisions: expect.arrayContaining([
          { issueId: external.id, reason: "external_blocker" },
          { issueId: card.id, reason: "human_card" },
          { issueId: named.id, reason: "named_external_wait" },
        ]),
      }), expect.any(String));
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, externalBlocker.id));
      await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, humanCard.id));
      expect(await countAgentActiveIssues(db, { companyId, agentId: owner })).toBe(2);
    } finally {
      audit.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("counts untyped, self-owned, stale, agent-card, and cross-company waits", async () => {
    const owner = randomUUID();
    const otherCompany = randomUUID();
    await db.insert(companies).values({ id: otherCompany, name: "Other company", issuePrefix: "OTHERWIP" });
    await db.insert(agents).values({ id: owner, companyId, name: "Untyped owner", role: "engineer", adapterType: "process" });
    const [untyped, self, empty, agentCard, stale, crossCompany, ambiguousCard] = await db.insert(issues).values([
      { monitorNextCheckAt: new Date() },
      { unblockDescriptor: { owner: { agentId: owner }, action: "I will repair this." } },
      { unblockDescriptor: { owner: "board" as const, action: " " } }, {}, {}, {}, {},
    ].map((extra) => ({ companyId, title: "Own work", status: "blocked", assigneeAgentId: owner, ...extra }))).returning();
    const [closed, privateBlocker] = await db.insert(issues).values([
      { companyId, title: "Closed blocker", status: "cancelled", assigneeAgentId: free },
      { companyId: otherCompany, title: "Private blocker", status: "todo", assigneeAgentId: free },
    ]).returning();
    await db.insert(issueRelations).values([
      { companyId, issueId: untyped.id, relatedIssueId: self.id, type: "blocks" },
      { companyId, issueId: closed.id, relatedIssueId: stale.id, type: "blocks" },
      { companyId, issueId: privateBlocker.id, relatedIssueId: crossCompany.id, type: "blocks" },
    ]);
    await db.insert(issueThreadInteractions).values([
      { companyId, issueId: agentCard.id, kind: "ask_user_questions", addresseeAgentId: free, payload: { version: 1, prompt: "Answer?" } },
      { companyId: otherCompany, issueId: crossCompany.id, kind: "request_confirmation", effectiveResolverPolicy: "human_only", payload: { version: 1, prompt: "Approve?" } },
      { companyId, issueId: ambiguousCard.id, kind: "request_confirmation", payload: { version: 1, prompt: "Approve?" } },
    ]);
    expect(await countAgentActiveIssues(db, { companyId, agentId: owner })).toBe(7);
    const reasons = await db.select({ reason: issueWipReason() }).from(issues).where(eq(issues.assigneeAgentId, owner));
    expect(reasons.every(({ reason }) => reason === "untyped_blocked")).toBe(true);
    process.env.PAPERCLIP_AGENT_WIP_LIMIT = "3";
    expect(await agentWipFull(db, agentActor, { companyId, agentId: owner, status: "todo" })).toBe(true);
  });
});
