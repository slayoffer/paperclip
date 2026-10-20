import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRelations, issues,
  issueThreadInteractions, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { issueService } from "../services/issues.js";
import { namesOnlyIssueReferences } from "../services/blocked-state-integrity.js";

// Split from blocked-state-integrity.test.ts to keep each file under the size limit.
const heartbeat = vi.hoisted(() => ({ wakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
    ...actual.heartbeatService(...args), wakeup: heartbeat.wakeup,
  }) };
});

describe("issue-only wait text", () => {
  it.each([
    ["Wait for SYNA-1780", true],
    ["Wait for SYNA-1780 and SYNA-1781 to finish.", true],
    ["Wait for the vendor reply", false],
    ["Wait for the vendor reply on SYNA-1780", false],
    ["Wait for SYNA-1780 build 42", false],
  ])("classifies %j", (action, expected) => {
    expect(namesOnlyIssueReferences(action)).toBe(expected);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("blocked-state holds and stale waits", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof issueService>;
  let companyId: string;
  let agentId: string;
  let source: typeof issues.$inferSelect;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-blocked-holds-");
    db = createDb(database.connectionString);
    svc = issueService(db);
  }, 30_000);
  beforeEach(async () => {
    heartbeat.wakeup.mockReset().mockResolvedValue(null);
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", "true");
    vi.stubEnv("PAPERCLIP_SELF_BLOCK_GUARD", "true");
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Holds", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle" });
    source = await issue("SYNA-1937", "todo", { assigneeAgentId: agentId });
  });
  afterEach(async () => {
    for (const table of [issueThreadInteractions, activityLog, issueComments, issueRelations, heartbeatRuns,
      agentWakeupRequests, issues, agents, companies]) await db.delete(table);
    vi.unstubAllEnvs();
  });
  afterAll(async () => { vi.unstubAllEnvs(); await database?.cleanup(); });

  async function issue(identifier: string, status = "todo", extra: Partial<typeof issues.$inferInsert> = {}) {
    return (await db.insert(issues).values({ companyId, identifier, title: identifier, status, ...extra }).returning())[0]!;
  }
  const external = (action: string): IssueUnblockDescriptor => ({ owner: { agentId }, action, kind: "external" });

  it("refuses a start that drops an open bridge hold until the hold ends", async () => {
    const hold = await issue("SYNA-2024", "backlog", { parentId: source.id,
      title: `Review hold: ${source.identifier} (bridge-owned, do not edit)` });
    await db.insert(issueRelations).values({ companyId, issueId: hold.id, relatedIssueId: source.id, type: "blocks" });
    await expect(svc.update(source.id, { status: "in_progress", blockedByIssueIds: [] }))
      .rejects.toMatchObject({ status: 422, details: { unresolvedBlockerIssueIds: [hold.id] } });
    expect(await svc.getById(source.id)).toMatchObject({ status: "todo" });
    expect((await svc.getRelationSummaries(source.id)).blockedBy.map(row => row.id)).toEqual([hold.id]);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, hold.id));
    await expect(svc.update(source.id, { status: "in_progress", blockedByIssueIds: [] }))
      .resolves.toMatchObject({ status: "in_progress" });
  });

  it("releases a wait that names only its linked blocker when that blocker completes", async () => {
    const blocker = await issue("SYNA-1780");
    await svc.update(source.id, { status: "blocked", blockedByIssueIds: [blocker.id],
      unblockDescriptor: external("Wait for SYNA-1780") });
    expect(await svc.getById(source.id)).toMatchObject({ status: "blocked" });
    await svc.update(blocker.id, { status: "done" });
    expect(await svc.getById(source.id)).toMatchObject({ status: "todo", unblockDescriptor: null });
  });

  it.each(["Wait for the vendor reply", "Wait for the vendor reply on SYNA-1780"])(
    "keeps the outside wait %j when the blocker completes", async action => {
      const blocker = await issue("SYNA-1780");
      const unblockDescriptor = external(action);
      await svc.update(source.id, { status: "blocked", blockedByIssueIds: [blocker.id], unblockDescriptor });
      await svc.update(blocker.id, { status: "done" });
      expect(await svc.getById(source.id)).toMatchObject({ status: "blocked", unblockDescriptor });
    },
  );
});
