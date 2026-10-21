import { and, eq } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import type { SshInPlaceLockHolder } from "./ssh-in-place-lock.js";

/** Lease expiration alone never proves that a host writer stopped. */
export function sshInPlaceLockChecks(db: Db, companyId: string) {
  async function readLease(holder: SshInPlaceLockHolder) {
    const rows = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, holder.leaseId), eq(environmentLeases.companyId, companyId),
    )).limit(1);
    return rows[0];
  }
  return {
    isHolderActive: async (holder: SshInPlaceLockHolder) => (await readLease(holder))?.status === "active",
    isHolderStopped: async (holder: SshInPlaceLockHolder) => {
      const lease = await readLease(holder);
      return Boolean(lease && hasRemoteTerminationReceipt(lease));
    },
  };
}
