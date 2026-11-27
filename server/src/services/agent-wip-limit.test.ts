import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issues, issueRelations, issueThreadInteractions } from "@paperclipai/db";
import { classifyIssueWip } from "./issue-wip-policy.js";
import { companyFlowService } from "./company-flow.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  agentWipFull,
  agentWipLimit,
  countAgentActiveIssues,
  getAgentWipCounts,
  isWipActiveStatus,
  wipLimitAppliesToActor,
} from "./agent-wip-limit.js";

const saved = process.env.PAPERCLIP_AGENT_WIP_LIMIT;
afterEach(() => {
  vi.unstubAllEnvs();
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

  it("requires a named resume condition and rejects expired or self-owned untyped notes", () => {
    const issue = { status: "blocked", assigneeAgentId: randomUUID() };
    const wait = { owner: "board" as const, action: "Resume when the vendor replies", kind: "external" as const };
    expect(classifyIssueWip({ ...issue, unblockDescriptor: wait }).reason).toBe("named_wait");
    for (const unblockDescriptor of [
      { ...wait, action: " " },
      { ...wait, action: "Wait for WIP-123 to finish" },
      { ...wait, until: "2020-01-01T00:00:00Z" },
      { ...wait, action: "Resume after vendor reply deadline: 2020-01-01T00:00:00Z" },
      { owner: { agentId: issue.assigneeAgentId }, action: "Continue my work" },
    ]) {
      expect(classifyIssueWip({ ...issue, unblockDescriptor })).toEqual({ countsTowardWip: true, reason: "untyped_blocked" });
    }
    expect(classifyIssueWip({ ...issue, unblockDescriptor: { ...wait, kind: "date" } }).countsTowardWip).toBe(true);
    expect(classifyIssueWip({ ...issue, unblockDescriptor: {
      ...wait, kind: "date", until: "2099-01-01T00:00:00Z",
    } }).countsTowardWip).toBe(false);
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

  it.each(["false", "true"])("frees typed-wait slots with pull queue %s and exposes the same owner counts", async pullQueue => {
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", pullQueue);
    vi.stubEnv("PAPERCLIP_AGENT_WIP_LIMIT", "1");
    const owner = randomUUID();
    await db.insert(agents).values({ id: owner, companyId, name: "Waiting owner", role: "engineer" });
    const [dependency, card, named, blocker] = await db.insert(issues).values([
      { companyId, assigneeAgentId: owner, title: "External dependency", status: "blocked" },
      { companyId, assigneeAgentId: owner, title: "Human card", status: "blocked" },
      { companyId, assigneeAgentId: owner, title: "Vendor", status: "blocked",
        unblockDescriptor: { owner: "board" as const, action: "Resume when the vendor replies", kind: "external" as const } },
      { companyId, assigneeAgentId: free, title: "Other owner's work", status: "todo" },
    ]).returning();
    await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: dependency.id, type: "blocks" });
    await db.insert(issueThreadInteractions).values({ companyId, issueId: card.id, kind: "request_confirmation",
      effectiveResolverPolicy: "human_only", payload: { version: 1, prompt: "Approve?" } });
    expect(await getAgentWipCounts(db, { companyId, agentId: owner })).toEqual({ runnable: 0, waiting: 3, untypedBlocked: 0 });
    expect(await agentWipFull(db, agentActor, { companyId, agentId: owner, status: "todo" })).toBe(false);
    const report = await companyFlowService(db).report(companyId);
    expect(report.agents.find(row => row.id === owner)).toMatchObject({ wip: 0, runnable: 0, waiting: 3, atWipLimit: false });
    expect(report.scorecard.byOwner.find(row => row.assigneeAgentId === owner)?.counts).toMatchObject({ runnable: 0, waiting: 3 });
    await db.insert(issues).values({ companyId, assigneeAgentId: owner, title: "Untyped block", status: "blocked",
      monitorNextCheckAt: new Date(Date.now() + 60_000) });
    expect(await agentWipFull(db, agentActor, { companyId, agentId: owner, status: "todo" })).toBe(true);
    const after = await companyFlowService(db).report(companyId);
    expect(after.agents.find(row => row.id === owner)).toMatchObject({ wip: 1, runnable: 1, waiting: 3, untypedBlocked: 1 });
    expect(after.ghosts.untypedBlocked.filter(row => row.assigneeAgentId === owner)).toHaveLength(1);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blocker.id));
    await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.issueId, card.id));
    expect(await getAgentWipCounts(db, { companyId, agentId: owner })).toEqual({ runnable: 3, waiting: 1, untypedBlocked: 3 });
  });

  it("keeps self-owned, unassigned, closed, and foreign blocker links in WIP", async () => {
    const owner = randomUUID();
    const foreign = randomUUID();
    await db.insert(companies).values({ id: foreign, name: "Foreign", issuePrefix: `F${foreign.slice(0, 6)}` });
    await db.insert(agents).values({ id: owner, companyId, name: "Self", role: "engineer" });
    const [self, unassigned, done, cancelled, other, source] = await db.insert(issues).values([
      { companyId, assigneeAgentId: owner, title: "Self", status: "todo" },
      { companyId, title: "No owner", status: "todo" },
      { companyId, assigneeAgentId: free, title: "Done", status: "done" },
      { companyId, assigneeAgentId: free, title: "Cancelled", status: "cancelled" },
      { companyId: foreign, assigneeAgentId: free, title: "Foreign", status: "todo" },
      { companyId, assigneeAgentId: owner, title: "Blocked", status: "blocked" },
    ]).returning();
    await db.insert(issueRelations).values([self, unassigned, done, cancelled, other].map(blocker => ({
      companyId, issueId: blocker.id, relatedIssueId: source.id, type: "blocks" as const,
    })));
    await db.insert(issueThreadInteractions).values({ companyId, issueId: source.id, kind: "request_confirmation",
      addresseeAgentId: owner, effectiveResolverPolicy: "anyone", payload: { version: 1, prompt: "Self review" } });
    expect(await getAgentWipCounts(db, { companyId, agentId: owner })).toEqual({ runnable: 2, waiting: 0, untypedBlocked: 1 });
  });
});
