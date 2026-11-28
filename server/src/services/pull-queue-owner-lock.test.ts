import { randomUUID } from "node:crypto";
import { agents, companies, createDb, issues, withDedicatedDbConnection } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { issueService } from "./issues.js";
import { createHeartbeatPullQueue } from "./pull-queue.js";
import { pullQueueOwnerLockKey, tryLockPullQueueOwner } from "./pull-queue-owner-lock.js";

it("keeps the shared pull owner key stable", () => {
  expect(pullQueueOwnerLockKey("company", "agent")).toBe("pull-queue:company:agent");
});

const support = await getEmbeddedPostgresTestSupport();

it.skipIf(!support.supported)("defers new runnable work while pull selection holds the assignee lock", async () => {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-pull-queue-owner-lock-");
  const db = createDb(database.connectionString);
  try {
    vi.stubEnv("PAPERCLIP_AGENT_WIP_LIMIT", "1");
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pull queue lock", issuePrefix: "PULLLOCK" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Pull owner", role: "engineer", adapterType: "process",
    });
    const service = issueService(db);
    await withDedicatedDbConnection(db, dedicated => dedicated.transaction(async holder => {
      expect(await tryLockPullQueueOwner(holder, companyId, agentId)).toBe(true);
      const deferred = await service.create(companyId, {
        title: "Contended runnable work",
        assigneeAgentId: agentId,
        status: "todo",
        wipAdmissionActor: { type: "agent", source: "agent_jwt" },
      });
      expect(deferred.status).toBe("backlog");
      const critical = await service.create(companyId, {
        title: "Critical work", assigneeAgentId: agentId, status: "todo", priority: "critical",
        wipAdmissionActor: { type: "agent", source: "agent_jwt" },
      });
      expect(critical.status).toBe("todo");
      const board = await service.create(companyId, {
        title: "Board work", assigneeAgentId: agentId, status: "todo",
        wipAdmissionActor: { type: "board", source: "session" },
      });
      expect(board.status).toBe("todo");
    }));
  } finally {
    vi.unstubAllEnvs();
    await database.cleanup();
  }
}, 30_000);

it.skipIf(!support.supported)("retries selection when the lock holder rolls back without an event", async () => {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-pull-queue-owner-retry-");
  const db = createDb(database.connectionString);
  const wakeup = vi.fn(async () => true);
  const queue = createHeartbeatPullQueue(db, { wakeup, isSuppressed: async () => ({ suppressed: false }) });
  try {
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pull queue retry", issuePrefix: "PULLRETRY" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Pull owner", role: "engineer", adapterType: "process", status: "idle",
    });
    await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, title: "Ready", status: "todo" });

    const rollback = new Error("abort the lock holder");
    let retryAt: number | null = null;
    const startedAt = Date.now();
    await expect(withDedicatedDbConnection(db, dedicated => dedicated.transaction(async holder => {
      expect(await tryLockPullQueueOwner(holder, companyId, agentId)).toBe(true);
      await queue.notify(companyId);
      expect(wakeup).not.toHaveBeenCalled();
      retryAt = await queue.nextReconcileAt();
      throw rollback;
    }))).rejects.toBe(rollback);

    expect(retryAt).toBeGreaterThanOrEqual(startedAt + 30_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 30_000);
    await queue.reconcile(new Date(retryAt!));
    expect(wakeup).toHaveBeenCalledExactlyOnceWith(agentId, expect.objectContaining({
      payload: expect.objectContaining({ issueId }),
    }));
    expect(await queue.nextReconcileAt(retryAt!)).toBeNull();
  } finally {
    await queue.stop();
    vi.unstubAllEnvs();
    await database.cleanup();
  }
}, 30_000);
