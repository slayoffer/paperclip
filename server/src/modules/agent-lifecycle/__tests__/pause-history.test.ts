import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, environmentLeases, heartbeatRuns, createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../../../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";
import { remoteTerminationReceipt } from "../../../services/remote-execution-termination.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("pause stop proof and run history", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-pause-history-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { for (const worker of workers) await worker.stop(); await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pause history", issuePrefix: `P${companyId.slice(0, 7)}` });
  });
  function worker() {
    const driver = createLifecycleDriver(db, {} as never);
    const value = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: driver.runHost });
    workers.push(value); return value;
  }
  async function readyAgent() {
    const [agent] = await db.insert(agents).values({ companyId, name: "Reviewer", status: "idle", lifecycleState: "ready" }).returning();
    return agent!;
  }
  // A remote run cancelled by a driver that wrote no termination receipt (all
  // SSH cancels before 2026-10-19 look like this).
  async function cancelledRemoteRun(agentId: string, endedAt: Date) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "cancelled",
      invocationSource: "on_demand", runtimeMode: "legacy", startedAt: new Date(endedAt.getTime() - 60_000), finishedAt: endedAt }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: run!.id, provider: "ssh",
      providerLeaseId: `ssh-${run!.id}`, status: "released", cleanupStatus: "success", releasedAt: endedAt }).returning();
    return lease!;
  }
  const state = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!.lifecycleState;

  it("finishes a pause when only cancels from before the pause lack a stop receipt", async () => {
    const agent = await readyAgent();
    await cancelledRemoteRun(agent.id, new Date(Date.now() - 86_400_000));
    await createAgentLifecycle(db).pauseAgent(agent.id);
    await worker().process(agent.id);
    expect(await state(agent.id)).toBe("paused");
  });

  it("still waits for the stop receipt of a run cancelled after the pause began", async () => {
    const agent = await readyAgent();
    await createAgentLifecycle(db).pauseAgent(agent.id);
    const lease = await cancelledRemoteRun(agent.id, new Date(Date.now() + 1_000));
    const work = worker();
    await work.process(agent.id);
    expect(await state(agent.id)).toBe("pausing");
    await db.update(environmentLeases).set({ metadata: {
      remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }),
    } }).where(eq(environmentLeases.id, lease.id));
    await createAgentLifecycle(db).retry(agent.id);
    await work.process(agent.id);
    expect(await state(agent.id)).toBe("paused");
  });

  it("keeps a resume given while pausing and returns the agent to ready", async () => {
    const agent = await readyAgent();
    const lifecycle = createAgentLifecycle(db);
    await lifecycle.pauseAgent(agent.id);
    const lease = await cancelledRemoteRun(agent.id, new Date(Date.now() + 1_000));
    const work = worker();
    await work.process(agent.id);
    await lifecycle.resumeAgent(agent.id);
    expect(await state(agent.id)).toBe("pausing");
    await db.update(environmentLeases).set({ metadata: {
      remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }),
    } }).where(eq(environmentLeases.id, lease.id));
    await lifecycle.retry(agent.id);
    await work.process(agent.id);
    expect(await state(agent.id)).toBe("ready");
  });
});
