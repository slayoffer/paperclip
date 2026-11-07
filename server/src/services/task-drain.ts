import { randomUUID } from "node:crypto";
import { agentWakeupRequests, heartbeatRuns, instanceSettings, type Db } from "@paperclipai/db";
import { startTaskDrainRequestSchema, taskDrainLeaseSchema, type TaskDrainLease } from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import { conflict } from "../errors.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Pick<Db | Transaction, "select" | "execute">;
type Audit = (tx: Transaction, details: Record<string, unknown>) => Promise<void>;

// This reserved settings row is separate from the editable "default" row.
// General and experimental settings writes cannot erase the lease.
const SETTINGS_KEY = "task-drain";

async function readLease(db: Reader): Promise<TaskDrainLease | null> {
  const [row] = await db.select({ general: instanceSettings.general })
    .from(instanceSettings).where(eq(instanceSettings.singletonKey, SETTINGS_KEY));
  if (!row) return null;
  // Invalid storage must stop admission. It must not silently clear a hold.
  const state = row.general;
  if (state.version !== 1 || !("lease" in state)) throw new Error("Invalid task drain storage");
  return state.lease === null ? null : taskDrainLeaseSchema.parse(state.lease);
}

function isActive(lease: TaskDrainLease | null, now: Date): lease is TaskDrainLease {
  return lease !== null && Date.parse(lease.expiresAt) > now.getTime();
}

/** Hold this shared lock until the transaction commits its run claim. */
export async function taskDrainBlocksAdmission(tx: Reader): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(184915, 1)`);
  return isActive(await readLease(tx), new Date());
}

export function taskDrainService(db: Db, now = () => new Date()) {
  async function writeLease(tx: Transaction, lease: TaskDrainLease | null) {
    const general = { version: 1, lease };
    await tx.insert(instanceSettings).values({ singletonKey: SETTINGS_KEY, general })
      .onConflictDoUpdate({
        target: instanceSettings.singletonKey,
        set: { general, updatedAt: now() },
      });
  }

  return {
    async blocksAdmission() {
      try {
        return isActive(await readLease(db), now());
      } catch {
        // The durable hold has no cache. A failed read always stops admission.
        return true;
      }
    },
    async acquire(ownerId: string, input: unknown, audit: Audit) {
      const request = startTaskDrainRequestSchema.parse(input);
      if (!ownerId.trim()) throw new Error("Drain owner required");
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(184915, 1)`);
        const previous = await readLease(tx);
        const startedAt = now();
        if (isActive(previous, startedAt)) {
          throw conflict("A different drain lease is active");
        }
        const lease = taskDrainLeaseSchema.parse({
          leaseId: randomUUID(),
          ownerId,
          startedAt: startedAt.toISOString(),
          expiresAt: new Date(startedAt.getTime() + request.ttlMs).toISOString(),
        });
        await writeLease(tx, lease);
        await audit(tx, lease);
        return lease;
      });
    },
    async release(ownerId: string, leaseId: string, audit: Audit) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(184915, 1)`);
        const lease = await readLease(tx);
        if (!lease || lease.leaseId !== leaseId || lease.ownerId !== ownerId) {
          throw conflict("Drain lease identity does not match");
        }
        const wasActive = isActive(lease, now());
        await writeLease(tx, null);
        await audit(tx, { leaseId, ownerId, wasActive });
        return { wasActive };
      });
    },
    // Generic so that local fields such as the idle drain ownerId stay visible to callers.
    async status<Local extends { draining: boolean; startedAt: Date | null; expiresAt: Date | null; activeRuns: number; pendingWakes: number }>(local: Local) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock_shared(184915, 1)`);
        const lease = await readLease(tx);
        const activeLease = isActive(lease, now()) ? lease : null;
        const [counts] = await tx.select({
          persistedRunningRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'running')::int`,
          persistedQueuedRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'queued')::int`,
          persistedScheduledRetryRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'scheduled_retry')::int`,
          persistedPendingWakes: sql<number>`(select count(*)::int from ${agentWakeupRequests}
            where ${agentWakeupRequests.status} in ('queued', 'claimed', 'deferred_issue_execution'))`,
        }).from(heartbeatRuns);
        return {
          ...local,
          draining: local.draining || activeLease !== null,
          startedAt: activeLease?.startedAt ?? local.startedAt,
          expiresAt: activeLease?.expiresAt ?? local.expiresAt,
          lease: activeLease,
          ...counts,
          quiescent: local.activeRuns === 0 && local.pendingWakes === 0
            && counts.persistedRunningRuns === 0 && counts.persistedQueuedRuns === 0
            && counts.persistedScheduledRetryRuns === 0
            && counts.persistedPendingWakes === 0,
        };
      });
    },
  };
}
