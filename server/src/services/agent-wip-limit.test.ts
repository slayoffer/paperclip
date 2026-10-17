import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
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
  });
});
