import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, instanceSettings } from "@paperclipai/db";
import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.js";
import { taskDrainBlocksAdmission, taskDrainService } from "../services/task-drain.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Drain persistence tests unavailable: ${support.reason}`);

suite("persistent owned drain", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const audit = vi.fn(async () => {});
  const local = { draining: false, startedAt: null, expiresAt: null, activeRuns: 0, pendingWakes: 0 };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("task-drain-persistence-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    stopTaskDrain();
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
    audit.mockClear();
  });
  afterAll(async () => { await database?.cleanup(); });

  it("blocks first admission after service recreation", async () => {
    const lease = await taskDrainService(db).acquire("operator-a", {}, audit);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Restart test", issuePrefix: "RST" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Restart test", role: "engineer", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued" });
    const fresh = heartbeatService(db, { runtimeEnv: {} });
    expect(await fresh.resolveSchedulingSuppression()).toEqual({ suppressed: true, reason: "task_drain" });
    expect(await fresh.getTaskDrainStatus()).toMatchObject({ draining: true, lease });
    await fresh.resumeQueuedRuns();
    const [stored] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    expect(stored.status).toBe("queued");
    expect(await fresh.resolveSchedulingSuppression()).toMatchObject({ suppressed: true });
  });

  it("allows exactly one concurrent acquisition across separate clients", async () => {
    const other = createDb(database.connectionString);
    const results = await Promise.allSettled([
      taskDrainService(db).acquire("operator-a", {}, audit),
      taskDrainService(other).acquire("operator-b", {}, audit),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(await taskDrainService(other).blocksAdmission()).toBe(true);
  });

  it("rejects competing owners, lease IDs, and repeated acquisition", async () => {
    const drain = taskDrainService(db);
    const lease = await drain.acquire("operator-a", {}, audit);
    await expect(drain.acquire("operator-a", {}, audit)).rejects.toMatchObject({ status: 409 });
    await expect(drain.release("operator-b", lease.leaseId, audit)).rejects.toMatchObject({ status: 409 });
    await expect(drain.release("operator-a", randomUUID(), audit)).rejects.toMatchObject({ status: 409 });
    expect(await drain.blocksAdmission()).toBe(true);
    expect(await drain.release("operator-a", lease.leaseId, audit)).toEqual({ wasActive: true });
    expect(await drain.blocksAdmission()).toBe(false);
  });

  it("expires at the exact boundary and rejects a stale release after replacement", async () => {
    let clock = new Date();
    const drain = taskDrainService(db, () => clock);
    const old = await drain.acquire("operator-a", { ttlMs: 1000 }, audit);
    clock = new Date(Date.parse(old.expiresAt));
    expect(await drain.blocksAdmission()).toBe(false);
    const lease = await drain.acquire("operator-a", {}, audit);
    expect(lease.leaseId).not.toBe(old.leaseId);
    await expect(drain.release("operator-a", old.leaseId, audit)).rejects.toMatchObject({ status: 409 });
    expect(await drain.blocksAdmission()).toBe(true);
  });

  it("rolls back acquisition and release if the audit fails", async () => {
    const drain = taskDrainService(db);
    const fail = async () => { throw new Error("audit failed"); };
    await expect(drain.acquire("operator-a", {}, fail)).rejects.toThrow("audit failed");
    expect(await drain.blocksAdmission()).toBe(false);
    const lease = await drain.acquire("operator-a", {}, audit);
    await expect(drain.release("operator-a", lease.leaseId, fail)).rejects.toThrow("audit failed");
    expect(await taskDrainService(db).blocksAdmission()).toBe(true);
  });

  it("does not acquire or release when the storage write fails", async () => {
    const failedWrites = new Proxy(db, {
      get(target, key) {
        if (key === "transaction") return (run: (tx: unknown) => Promise<unknown>) => target.transaction((tx) => run(new Proxy(tx, {
          get(transaction, field) {
            if (field === "insert") return () => { throw new Error("storage write failed"); };
            return Reflect.get(transaction, field);
          },
        })));
        return Reflect.get(target, key);
      },
    });
    const failed = taskDrainService(failedWrites);
    await expect(failed.acquire("operator-a", {}, audit)).rejects.toThrow("storage write failed");
    const drain = taskDrainService(db);
    expect(await drain.blocksAdmission()).toBe(false);
    const lease = await drain.acquire("operator-a", {}, audit);
    await expect(failed.release("operator-a", lease.leaseId, audit)).rejects.toThrow("storage write failed");
    expect(await drain.blocksAdmission()).toBe(true);
  });

  it("retains the lease through ordinary instance settings writes", async () => {
    const drain = taskDrainService(db);
    await drain.acquire("operator-a", {}, audit);
    await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true });
    expect(await taskDrainService(db).blocksAdmission()).toBe(true);
  });

  it("fails closed on a storage error and on malformed stored state", async () => {
    const failed = taskDrainService({ select() { throw new Error("database unavailable"); }, transaction: async () => { throw new Error("database unavailable"); } } as any);
    expect(await failed.blocksAdmission()).toBe(true);
    await expect(failed.status(local)).rejects.toThrow("database unavailable");
    await db.insert(instanceSettings).values({ singletonKey: "task-drain", general: { invalid: true } });
    expect(await taskDrainService(db).blocksAdmission()).toBe(true);
    await expect(taskDrainService(db).acquire("operator-a", {}, audit)).rejects.toThrow();
  });

  it("does not report quiet while stored runs or wakes remain after recreation", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Drain test", issuePrefix: "DRN" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Drain test", role: "engineer", adapterType: "process" });
    const fresh = heartbeatService(db, { runtimeEnv: {} });
    for (const status of ["running", "queued", "scheduled_retry"]) {
      await db.insert(heartbeatRuns).values({ companyId, agentId, status });
      expect(await fresh.getTaskDrainStatus()).toMatchObject({ activeRuns: 0, pendingWakes: 0, quiescent: false });
      await db.delete(heartbeatRuns);
    }
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "queued" });
    expect(await fresh.getTaskDrainStatus()).toMatchObject({ persistedPendingWakes: 1, quiescent: false });
    await db.delete(agentWakeupRequests);
    expect(await fresh.getTaskDrainStatus()).toMatchObject({ quiescent: true });
  });

  it("preserves an independent operator hold after lease release", async () => {
    startTaskDrain({});
    const drain = taskDrainService(db);
    const lease = await drain.acquire("operator-a", {}, audit);
    await drain.release("operator-a", lease.leaseId, audit);
    const fresh = heartbeatService(db, { runtimeEnv: {} });
    expect(await fresh.resolveSchedulingSuppression()).toEqual({ suppressed: true, reason: "task_drain" });
  });

  it("serializes acquisition behind an in-flight admission transaction", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const released = new Promise<void>((resolve) => { finish = resolve; });
    const admission = db.transaction(async (tx) => {
      expect(await taskDrainBlocksAdmission(tx)).toBe(false);
      entered();
      await released;
    });
    await ready;
    const other = createDb(database.connectionString);
    let acquired = false;
    const acquisition = taskDrainService(other).acquire("operator-a", {}, audit).then(() => { acquired = true; });
    try {
      // Wait for the database to observe the blocked lock, rather than a timer.
      await vi.waitFor(async () => {
        const rows = await db.execute(sql`select 1 from pg_locks where locktype = 'advisory' and classid = 184915 and not granted`);
        expect(rows.length).toBeGreaterThan(0);
      });
      expect(acquired).toBe(false);
    } finally {
      finish();
      await admission;
      await acquisition;
    }
    await db.transaction(async (tx) => {
      expect(await taskDrainBlocksAdmission(tx)).toBe(true);
    });
  });
});
