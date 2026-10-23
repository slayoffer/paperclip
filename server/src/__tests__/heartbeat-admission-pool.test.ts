import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, createDb, executionWorkspaces,
  heartbeatRuns, issues, projects,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseTests = support.supported ? describe : describe.skip;

databaseTests("heartbeat admission with a saturated connection pool", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const clients: ReturnType<typeof createDb>[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-admission-pool-");
  }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(clients.splice(0).map((db) => db.$client.end({ timeout: 1 })));
  });
  afterAll(async () => { await database?.cleanup(); });

  it.each([
    { poolSize: 1, isolated: true, scoped: true },
    { poolSize: 2, isolated: true, scoped: true },
    { poolSize: 3, isolated: true, scoped: true },
    { poolSize: 1, isolated: false, scoped: true },
    { poolSize: 1, isolated: false, scoped: false },
  ])("admits N+1 candidates with N=$poolSize, isolated=$isolated, scoped=$scoped", async ({ poolSize, isolated, scoped }) => {
    const db = createDb(database.connectionString, { maxConnections: poolSize });
    clients.push(db);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: isolated });
    const companyId = randomUUID();
    const projectId = randomUUID();
    const responsibleUserId = `owner-${companyId}`;
    await db.insert(companies).values({ id: companyId, name: "Pool regression", issuePrefix: `P${companyId.slice(0, 6)}` });
    // Exercise the final identity fallback, including membership reads.
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: responsibleUserId,
      status: "active", membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Pool project" });
    const candidates = Array.from({ length: poolSize + 1 }, () => ({ agentId: randomUUID(), issueId: randomUUID(), workspaceId: randomUUID() }));
    for (const candidate of candidates) {
      await db.insert(agents).values({ id: candidate.agentId, companyId, name: "Pool owner", role: "engineer", status: "running",
        adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
      // Occupy the agent's execution slot so admission cannot start an adapter.
      await db.insert(heartbeatRuns).values({ companyId, agentId: candidate.agentId, invocationSource: "assignment", status: "running" });
      await db.insert(executionWorkspaces).values({ id: candidate.workspaceId, companyId, projectId, name: "Pool workspace",
        mode: "isolated", strategyType: "git_worktree", status: "idle" });
      await db.insert(issues).values({ id: candidate.issueId, companyId, projectId, title: "Pool candidate", status: "todo",
        assigneeAgentId: candidate.agentId, executionWorkspaceId: candidate.workspaceId });
    }

    // Each first-wave admission reserves one real connection before any proceeds.
    // A helper that borrows the outer pool would deadlock even with one candidate.
    const inTransaction = new AsyncLocalStorage<boolean>();
    const select = db.select.bind(db);
    vi.spyOn(db, "select").mockImplementation((...args: Parameters<typeof db.select>) => {
      if (inTransaction.getStore()) throw new Error("Admission borrowed another pool connection");
      return select(...args);
    });
    let entered = 0;
    let release!: () => void;
    const saturated = new Promise<void>((resolve) => { release = resolve; });
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation((callback, config) => transaction(async (tx) => {
      // Bound a regression failure even if a new path bypasses the select guard.
      await tx.execute(sql`set local idle_in_transaction_session_timeout = '5s'`);
      entered += 1;
      if (entered === poolSize) release();
      await saturated;
      return inTransaction.run(true, () => callback(tx));
    }, config));

    const heartbeat = heartbeatService(db);
    const admitted = await Promise.all(candidates.map((candidate) => heartbeat.wakeup(candidate.agentId, {
      source: "automation", reason: "issue_blockers_resolved", requestedByActorType: "system",
      allowRunCoalescing: false,
      ...(scoped ? { payload: { issueId: candidate.issueId }, contextSnapshot: { issueId: candidate.issueId } } : {}),
    })));
    expect(entered).toBeGreaterThanOrEqual(poolSize + 1);
    expect(admitted).toHaveLength(poolSize + 1);
    for (const run of admitted) expect(run).toMatchObject({ status: "queued", responsibleUserId });
    const saved = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(saved.filter((run) => run.status === "queued")).toHaveLength(poolSize + 1);
    const idle = await db.execute(sql`select pid from pg_stat_activity
      where datname = current_database() and state = 'idle in transaction'`);
    expect(idle).toHaveLength(0);
  });
});
