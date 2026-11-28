import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";

export function pullQueueOwnerLockKey(companyId: string, agentId: string): string {
  return `pull-queue:${companyId}:${agentId}`;
}

/** Pass a transaction so the lock remains held through selection or issue creation. */
export async function tryLockPullQueueOwner(
  tx: Pick<Db, "execute">,
  companyId: string,
  agentId: string,
): Promise<boolean> {
  const key = pullQueueOwnerLockKey(companyId, agentId);
  const [lock] = await tx.execute<{ acquired: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`,
  );
  return lock?.acquired === true;
}
