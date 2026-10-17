import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  agentIssueCreateLimits,
  agentIssueCreateRefusal,
  loadAgentIssueCreateCounts,
} from "./agent-issue-create-limits.js";

const ON = { childrenPerParent: 3, issuesPerDay: 10, maxDepth: 2 };

describe("agent issue create limits", () => {
  it("is off unless each env var is a positive integer", () => {
    expect(agentIssueCreateLimits({})).toEqual({ childrenPerParent: null, issuesPerDay: null, maxDepth: null });
    expect(agentIssueCreateLimits({
      PAPERCLIP_AGENT_CHILDREN_PER_PARENT: "3", PAPERCLIP_AGENT_ISSUES_PER_DAY: "10", PAPERCLIP_AGENT_ISSUE_MAX_DEPTH: "x",
    })).toEqual({ childrenPerParent: 3, issuesPerDay: 10, maxDepth: null });
    expect(agentIssueCreateLimits({ PAPERCLIP_AGENT_ISSUES_PER_DAY: "0" }).issuesPerDay).toBeNull();
  });

  it("allows a create under every limit", () => {
    expect(agentIssueCreateRefusal(ON, { childrenByAgentUnderParent: 2, createdByAgentLast24h: 9, newIssueDepth: 2 }, "SYNA-1")).toBeNull();
  });

  it("refuses the 11th issue in 24 hours", () => {
    expect(agentIssueCreateRefusal(ON, { childrenByAgentUnderParent: 0, createdByAgentLast24h: 10, newIssueDepth: 1 }, null))
      .toMatch(/created 10 issues in the last 24 hours \(limit 10\)/);
  });

  it("refuses the 4th child under one parent and names the parent", () => {
    expect(agentIssueCreateRefusal(ON, { childrenByAgentUnderParent: 3, createdByAgentLast24h: 0, newIssueDepth: 2 }, "SYNA-7"))
      .toMatch(/3 child issues under SYNA-7 \(limit 3 per parent\).*`plan` document/);
  });

  it("does not apply the per-parent limit to a top-level create", () => {
    expect(agentIssueCreateRefusal(ON, { childrenByAgentUnderParent: 9, createdByAgentLast24h: 0, newIssueDepth: 1 }, null)).toBeNull();
  });

  it("refuses depth 3", () => {
    expect(agentIssueCreateRefusal(ON, { childrenByAgentUnderParent: 0, createdByAgentLast24h: 0, newIssueDepth: 3 }, "SYNA-9"))
      .toMatch(/depth 3 \(limit 2 below a goal\)/);
  });

  it("counts a batch request against both limits", () => {
    expect(agentIssueCreateRefusal(ON, { childrenByAgentUnderParent: 1, createdByAgentLast24h: 0, newIssueDepth: 2 }, "SYNA-3", 2)).toBeNull();
    expect(agentIssueCreateRefusal(ON, { childrenByAgentUnderParent: 1, createdByAgentLast24h: 0, newIssueDepth: 2 }, "SYNA-3", 3))
      .toMatch(/1 child issues under SYNA-3 and this request asks for 3 more/);
    expect(agentIssueCreateRefusal(ON, { childrenByAgentUnderParent: 0, createdByAgentLast24h: 8, newIssueDepth: 1 }, null, 3))
      .toMatch(/limit 10/);
  });

  it("ignores a limit that is off", () => {
    const off = { childrenPerParent: null, issuesPerDay: null, maxDepth: null };
    expect(agentIssueCreateRefusal(off, { childrenByAgentUnderParent: 99, createdByAgentLast24h: 99, newIssueDepth: 9 }, "SYNA-1")).toBeNull();
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent issue create counts", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
  const top = randomUUID(), mid = randomUUID(), leaf = randomUUID();
  const now = new Date("2026-10-17T12:00:00Z");

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-create-limits-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Limits", issuePrefix: "LIM" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Maker", role: "engineer", adapterType: "paperclip_runner" },
      { id: otherAgentId, companyId, name: "Other", role: "engineer", adapterType: "paperclip_runner" },
    ]);
    const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3600_000);
    await db.insert(issues).values([
      { id: top, companyId, title: "top", status: "todo", createdAt: at(48) },
      { id: mid, companyId, title: "mid", status: "todo", parentId: top, createdByAgentId: agentId, createdAt: at(30) },
      { id: leaf, companyId, title: "leaf", status: "todo", parentId: mid, createdAt: at(30) },
      { companyId, title: "c1", status: "done", parentId: top, createdByAgentId: agentId, createdAt: at(2) },
      { companyId, title: "c2", status: "cancelled", parentId: top, createdByAgentId: agentId, createdAt: at(1) },
      { companyId, title: "c3", status: "todo", parentId: top, createdByAgentId: otherAgentId, createdAt: at(1) },
      { companyId, title: "solo", status: "todo", createdByAgentId: agentId, createdAt: at(3) },
    ]);
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup();
  });

  it("counts this agent's non-cancelled children, its last-24h creates and the new depth", async () => {
    const counts = await loadAgentIssueCreateCounts(db, { companyId, agentId, parentId: top, limits: ON, now });
    expect(counts).toEqual({ childrenByAgentUnderParent: 2, createdByAgentLast24h: 3, newIssueDepth: 2 });
  });

  it("computes depth through the parent chain", async () => {
    expect((await loadAgentIssueCreateCounts(db, { companyId, agentId, parentId: leaf, limits: ON, now })).newIssueDepth).toBe(4);
    expect((await loadAgentIssueCreateCounts(db, { companyId, agentId, parentId: null, limits: ON, now })).newIssueDepth).toBe(1);
  });

  it("skips the queries for limits that are off", async () => {
    const off = { childrenPerParent: null, issuesPerDay: null, maxDepth: null };
    expect(await loadAgentIssueCreateCounts(db, { companyId, agentId, parentId: leaf, limits: off, now }))
      .toEqual({ childrenByAgentUnderParent: 0, createdByAgentLast24h: 0, newIssueDepth: 1 });
  });
});
