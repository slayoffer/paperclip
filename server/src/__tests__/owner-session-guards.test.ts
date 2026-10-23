import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentTaskSessions, agents, companies, createDb, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  firstCallerTaskKey,
  isOwnerSessionKey,
  ownerSessionKeyForIssueReset,
  readLatestUsageSample,
  readOwnerSessionInputTokens,
  resolveOwnerSession,
  saveOwnerSessionState,
} from "../services/owner-sessions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("owner session scope guards", () => {
  it("never lets a caller-supplied task key address the reserved owner row", () => {
    expect(isOwnerSessionKey("owner-project:project-a")).toBe(true);
    expect(isOwnerSessionKey(" owner-project:project-a")).toBe(true);
    expect(isOwnerSessionKey("issue-a")).toBe(false);
    expect(isOwnerSessionKey(null)).toBe(false);
    expect(firstCallerTaskKey(["owner-project:project-a", null, "issue-a"])).toBe("issue-a");
    expect(firstCallerTaskKey(["owner-project:project-a", null])).toBeNull();
    expect(firstCallerTaskKey([null, "task-a", "issue-a"])).toBe("task-a");
  });

  it("takes the owner project only from the current issue row", () => {
    vi.stubEnv("PAPERCLIP_OWNER_SESSIONS_ENABLED", "true");
    try {
      const input = { agent: { id: "owner-a", companyId: "company-a", adapterType: "codex_local" }, agentHome: "/owner-a", eligible: true };
      expect(resolveOwnerSession({ ...input, issue: { projectId: "project-a" } })?.key).toBe("owner-project:project-a");
      // An issue removed from its project keeps no owner scope, whatever a queued wake still says.
      expect(resolveOwnerSession({ ...input, issue: { projectId: null } })).toBeNull();
      expect(resolveOwnerSession({ ...input, issue: null })).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("owner session store", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-session-guards-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Owner fixture", issuePrefix: `O${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle", adapterType: "codex_local" });
    let minute = 0;
    const run = async (values: { status?: string; sessionIdAfter?: string; usageJson?: Record<string, unknown> | null } = {}) => {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id, companyId, agentId, status: values.status ?? "running", sessionIdAfter: values.sessionIdAfter ?? null,
        usageJson: values.usageJson ?? null, createdAt: new Date(Date.UTC(2026, 9, 23, 0, minute++)),
      });
      return id;
    };
    const base = { companyId, agentId, adapterType: "codex_local", key: "owner-project:project-a", lastError: null };
    const row = () => db.select().from(agentTaskSessions)
      .where(and(eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.taskKey, base.key)))
      .then((rows) => rows[0] ?? null);
    return { companyId, agentId, run, base, row };
  }

  it("subtracts the latest valid cumulative sample, not a failed zero-usage turn", async () => {
    const { companyId, agentId, run } = await fixture();
    const thread = "thread-a";
    const read = (usage: unknown) => {
      const raw = (usage as Record<string, unknown> | null)?.rawInputTokens;
      return typeof raw === "number" && raw > 0 ? raw : null;
    };
    await run({ status: "succeeded", sessionIdAfter: thread, usageJson: { inputTokens: 100_000, rawInputTokens: 100_000 } });
    await run({ status: "failed", sessionIdAfter: thread, usageJson: { inputTokens: 0, rawInputTokens: 0 } });
    await run({ status: "failed", sessionIdAfter: thread, usageJson: null });
    const current = await run({ sessionIdAfter: thread });
    const previous = await readLatestUsageSample(db, { agentId, sessionId: thread, excludeRunId: current }, read);
    expect(previous).toBe(100_000);
    const delta = 150_000 - previous!;
    await db.update(heartbeatRuns).set({ usageJson: { inputTokens: delta, rawInputTokens: 150_000 } }).where(eq(heartbeatRuns.id, current));
    // Totals 100k, a failed turn, then 150k: the thread used 150k, below a 200k limit.
    expect(await readOwnerSessionInputTokens(db, companyId, agentId, thread)).toBe(150_000);
    expect(await readLatestUsageSample(db, { agentId, sessionId: "thread-b", excludeRunId: current }, read)).toBeNull();
  });

  it("saves owner state only while the run still holds admission and the row has not moved", async () => {
    const { run, base, row } = await fixture();
    const session = { params: { sessionId: "thread-a" }, displayId: "thread-a" };
    const first = await run();
    expect(await saveOwnerSessionState(db, { ...base, runId: first, expectedLastRunId: null, session })).toBe("saved");
    expect((await row())?.lastRunId).toBe(first);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, first));

    const second = await run();
    // A late finalizer of a run that already left `running` is stale.
    expect(await saveOwnerSessionState(db, { ...base, runId: first, expectedLastRunId: null, session })).toBe("stale");
    const rotated = { params: { sessionId: "thread-b" }, displayId: "thread-b" };
    expect(await saveOwnerSessionState(db, { ...base, runId: second, expectedLastRunId: first, session: rotated })).toBe("saved");
    expect((await row())?.sessionDisplayId).toBe("thread-b");

    // A running finalizer whose row moved to another run after it read the row writes nothing.
    const third = await run();
    expect(await saveOwnerSessionState(db, { ...base, runId: third, expectedLastRunId: first, session })).toBe("stale");
    expect(await saveOwnerSessionState(db, { ...base, runId: third, expectedLastRunId: null, session })).toBe("stale");
    expect((await row())?.lastRunId).toBe(second);

    expect(await saveOwnerSessionState(db, { ...base, runId: third, expectedLastRunId: second, session: null })).toBe("cleared");
    expect(await row()).toBeNull();
    // After a reset, a finalizer that read the old row does not bring it back.
    expect(await saveOwnerSessionState(db, { ...base, runId: third, expectedLastRunId: second, session })).toBe("stale");
    expect(await row()).toBeNull();
  });

  it("resolves the owner row that an issue-scoped reset must also clear", async () => {
    const { companyId, agentId } = await fixture();
    const other = await fixture();
    const [project] = await db.insert(projects).values({ companyId, name: "Owner project" }).returning();
    const issueId = randomUUID();
    const identifier = `OWN-${issueId.slice(0, 6)}`.toUpperCase();
    const looseIssueId = randomUUID();
    await db.insert(issues).values([
      { id: issueId, companyId, projectId: project.id, title: "Owned issue", identifier },
      { id: looseIssueId, companyId, title: "Issue without a project" },
    ]);
    const agent = { id: agentId, companyId, adapterType: "codex_local" };
    const key = `owner-project:${project.id}`;
    vi.stubEnv("PAPERCLIP_OWNER_SESSIONS_ENABLED", "true");
    try {
      expect(await ownerSessionKeyForIssueReset(db, { agent, taskKey: issueId })).toBe(key);
      expect(await ownerSessionKeyForIssueReset(db, { agent, taskKey: identifier.toLowerCase() })).toBe(key);
      expect(await ownerSessionKeyForIssueReset(db, { agent, taskKey: looseIssueId })).toBeNull();
      expect(await ownerSessionKeyForIssueReset(db, { agent, taskKey: key })).toBeNull();
      // Company boundary: another company's agent cannot reach this issue's owner row.
      const foreign = { id: other.agentId, companyId: other.companyId, adapterType: "codex_local" };
      expect(await ownerSessionKeyForIssueReset(db, { agent: foreign, taskKey: issueId })).toBeNull();
      vi.stubEnv("PAPERCLIP_OWNER_SESSION_AGENT_IDS", "another-agent");
      expect(await ownerSessionKeyForIssueReset(db, { agent, taskKey: issueId })).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
    // Switch off: the reset keeps its previous scope.
    expect(await ownerSessionKeyForIssueReset(db, { agent, taskKey: issueId })).toBeNull();
  });
});
