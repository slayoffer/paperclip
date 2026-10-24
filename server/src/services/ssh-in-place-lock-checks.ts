import { and, eq } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isSshInPlaceOwnerRunTerminal } from "./ssh-in-place-run-status.js";
import type { SshInPlaceLockHolder } from "./ssh-in-place-lock.js";

/** Lease expiration alone never proves that a host writer stopped. */
export function sshInPlaceLockChecks(db: Db, companyId: string,
  confirmStopped?: (lease: EnvironmentLease) => Promise<EnvironmentLease | null>) {
  async function readLease(holder: SshInPlaceLockHolder) {
    const rows = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, holder.leaseId), eq(environmentLeases.companyId, companyId),
    )).limit(1);
    const lease = rows[0];
    return lease?.heartbeatRunId === holder.runId ? lease : undefined;
  }
  return {
    isHolderActive: async (holder: SshInPlaceLockHolder) => {
      const lease = await readLease(holder);
      return lease?.status === "active" && !(confirmStopped && await isSshInPlaceOwnerRunTerminal(db, companyId, holder.runId));
    },
    isHolderStopped: async (holder: SshInPlaceLockHolder) => {
      const lease = await readLease(holder);
      if (!lease) return false;
      if (hasRemoteTerminationReceipt(lease)) return true;
      if (!confirmStopped || !await isSshInPlaceOwnerRunTerminal(db, companyId, holder.runId)) return false;
      const stopped = await confirmStopped(lease as EnvironmentLease);
      return Boolean(stopped && hasRemoteTerminationReceipt(stopped));
    },
  };
}
